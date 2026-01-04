/**
 * File Sync Adapter
 *
 * Wraps ChunkedUploader to provide unified sync interface.
 * Handles large file uploads with chunking, deduplication, and resume.
 *
 * @see docs/plans/unified-sync-architecture-prd.md
 */

import type { App } from 'obsidian';
import type {
  ChunkedUploader,
  UploadSession,
  UploadProgress,
  HandshakeResponse,
} from '../../upload/chunked-uploader';
import type { LibrosSettings } from '../../settings/settings';

import {
  BaseSyncAdapter,
  type AdapterCapabilities,
} from '../sync-adapter';

import type {
  SyncChange,
  SyncManifest,
  ManifestEntry,
  PaginationOptions,
  AsyncResult,
} from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * File upload request
 */
export interface FileUploadRequest {
  file: File | ArrayBuffer;
  fileName: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
}

/**
 * File upload result
 */
export interface FileUploadResult {
  bookId: string;
  isDuplicate: boolean;
  session: UploadSession;
}

// ============================================================================
// File Sync Adapter
// ============================================================================

/**
 * Adapter for file uploads using the chunked uploader
 *
 * Provides:
 * - Chunked upload with progress tracking
 * - Hash-based deduplication
 * - Resume interrupted uploads
 * - Parallel chunk uploads
 */
export class FileSyncAdapter extends BaseSyncAdapter {
  readonly type = 'file' as const;
  readonly name = 'File Uploader';

  readonly capabilities: AdapterCapabilities = {
    incrementalSync: false,
    batchOperations: false,
    contentHashing: true,
    resumable: true,
    bidirectional: false, // Upload only
    parallelRequests: true,
    maxConcurrency: 3,
    entityTypes: ['file'],
  };

  private app: App;
  private uploader: ChunkedUploader | null = null;
  private getSettings: () => LibrosSettings;
  private activeSessions = new Map<string, UploadSession>();

  constructor(
    app: App,
    getSettings: () => LibrosSettings
  ) {
    super();
    this.app = app;
    this.getSettings = getSettings;
  }

  /**
   * Set the uploader instance
   */
  setUploader(uploader: ChunkedUploader): void {
    this.uploader = uploader;
  }

  // ==========================================================================
  // Connection Management
  // ==========================================================================

  async connect(): Promise<void> {
    const settings = this.getSettings();

    if (!settings.serverEnabled || !settings.serverUrl) {
      this.setStatus('disconnected');
      return;
    }

    try {
      this.setStatus('connecting');
      // Test connection via health check
      // The uploader will be created when needed
      this.setStatus('connected');
    } catch (error) {
      this.setStatus('error');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Cancel any active uploads
    for (const [sessionId] of this.activeSessions) {
      await this.cancelUpload(sessionId);
    }
    this.activeSessions.clear();
    this.setStatus('disconnected');
  }

  async testConnection(): Promise<boolean> {
    const settings = this.getSettings();
    return settings.serverEnabled && !!settings.serverUrl;
  }

  // ==========================================================================
  // Change Detection (Not applicable for uploads)
  // ==========================================================================

  async detectChanges(): Promise<SyncChange[]> {
    // File adapter is upload-only, no change detection
    return [];
  }

  async getManifest(): Promise<SyncManifest> {
    return {
      version: 1,
      generatedAt: new Date(),
      source: 'file',
      entries: [],
      totalCount: 0,
      totalSize: 0,
    };
  }

  async compareManifest(): Promise<SyncChange[]> {
    return [];
  }

  // ==========================================================================
  // Data Operations
  // ==========================================================================

  async getEntity(): AsyncResult<null> {
    return this.success(null);
  }

  async getEntities(): AsyncResult<Map<string, unknown>> {
    return this.success(new Map());
  }

  /**
   * Apply a change (upload a file)
   */
  async applyChange(change: SyncChange): AsyncResult<void> {
    if (change.entityType !== 'file') {
      return this.failure(
        this.createError(`Unsupported entity type: ${change.entityType}`)
      );
    }

    if (!this.uploader) {
      return this.failure(
        this.createError('Uploader not initialized')
      );
    }

    if (change.operation !== 'create') {
      return this.failure(
        this.createError(`Unsupported operation: ${change.operation}`)
      );
    }

    try {
      const request = change.data as FileUploadRequest;
      await this.uploadFile(request);
      return this.success(undefined);
    } catch (error) {
      return this.failure(
        this.createError(
          `Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { entityId: change.entityId }
        )
      );
    }
  }

  // ==========================================================================
  // Upload Operations
  // ==========================================================================

  /**
   * Upload a file
   */
  async uploadFile(
    request: FileUploadRequest,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<FileUploadResult> {
    if (!this.uploader) {
      throw new Error('Uploader not initialized');
    }

    // Subscribe to progress events if callback provided
    if (onProgress) {
      this.uploader.on('progress', onProgress);
    }

    try {
      const file =
        request.file instanceof File
          ? request.file
          : new File([request.file], request.fileName, { type: request.mimeType });

      const result = await this.uploader.upload(file);

      this.activeSessions.set(result.sessionId, result);
      this.updateLastSync();

      return {
        bookId: result.bookId || '',
        isDuplicate: result.status === 'duplicate',
        session: result,
      };
    } finally {
      if (onProgress) {
        this.uploader.off('progress', onProgress);
      }
    }
  }

  /**
   * Cancel an active upload
   */
  async cancelUpload(sessionId: string): Promise<void> {
    if (!this.uploader) return;

    const session = this.activeSessions.get(sessionId);
    if (session) {
      await this.uploader.cancel(sessionId);
      this.activeSessions.delete(sessionId);
    }
  }

  /**
   * Resume an interrupted upload
   */
  async resumeUpload(
    sessionId: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<FileUploadResult | null> {
    if (!this.uploader) {
      throw new Error('Uploader not initialized');
    }

    if (onProgress) {
      this.uploader.on('progress', onProgress);
    }

    try {
      const result = await this.uploader.resume(sessionId);
      if (!result) return null;

      this.activeSessions.set(result.sessionId, result);
      this.updateLastSync();

      return {
        bookId: result.bookId || '',
        isDuplicate: result.status === 'duplicate',
        session: result,
      };
    } finally {
      if (onProgress) {
        this.uploader.off('progress', onProgress);
      }
    }
  }

  /**
   * Get active upload sessions
   */
  getActiveSessions(): UploadSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get upload session by ID
   */
  getSession(sessionId: string): UploadSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Check if a file would be a duplicate before uploading
   */
  async checkDuplicate(
    file: File,
    onProgress?: (progress: { phase: string; percentage: number }) => void
  ): Promise<HandshakeResponse | null> {
    if (!this.uploader) {
      throw new Error('Uploader not initialized');
    }

    try {
      return await this.uploader.checkDuplicate(file, onProgress);
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  async getStats() {
    const stats = await super.getStats();

    // Add upload-specific stats
    const activeSessions = this.activeSessions.size;
    const totalUploaded = Array.from(this.activeSessions.values()).reduce(
      (sum, s) => sum + (s.status === 'completed' ? s.fileSize : 0),
      0
    );

    return {
      ...stats,
      totalEntities: activeSessions,
      totalSize: totalUploaded,
    };
  }
}
