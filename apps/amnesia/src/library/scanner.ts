/**
 * Library scanner for EPUB files in the vault
 *
 * NOTE: This scanner requires server infrastructure that was removed.
 * Scanning will fail until reimplemented with HybridDocumentProvider.
 * Use the Library service's metadata extraction instead.
 */
import { App, TFile, TFolder } from 'obsidian';
import { Book, BookStatus } from './types';
import { v4 as uuidv4 } from 'uuid';

// Stub - server infrastructure removed, scanner non-functional
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiClient = any;
const createApiClient = (_config: unknown): ApiClient => null;

export interface ScanResult {
  books: Book[];
  errors: ScanError[];
}

export interface ScanError {
  path: string;
  error: string;
}

export class LibraryScanner {
  private apiClient: ApiClient | null = null;

  constructor(
    private app: App,
    private serverUrl?: string,
    private deviceId?: string
  ) {
    if (serverUrl && deviceId) {
      this.apiClient = createApiClient({ baseUrl: serverUrl, deviceId });
    }
  }

  /**
   * Set or update the API client
   */
  setServerConfig(serverUrl: string, deviceId: string): void {
    this.serverUrl = serverUrl;
    this.deviceId = deviceId;
    this.apiClient = createApiClient({ baseUrl: serverUrl, deviceId });
  }

  /**
   * Check if server is available
   */
  async isServerAvailable(): Promise<boolean> {
    if (!this.apiClient) return false;
    try {
      return await this.apiClient.healthCheck();
    } catch {
      return false;
    }
  }

  /**
   * Scan a folder for EPUB files
   */
  async scanFolder(folderPath: string): Promise<ScanResult> {
    const books: Book[] = [];
    const errors: ScanError[] = [];

    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder || !(folder instanceof TFolder)) {
      errors.push({ path: folderPath, error: 'Folder not found' });
      return { books, errors };
    }

    // Check if server is available
    const serverAvailable = await this.isServerAvailable();
    if (!serverAvailable) {
      errors.push({
        path: folderPath,
        error: 'Amnesia server is not available. Please start the server to scan books.'
      });
      return { books, errors };
    }

    // Recursively find all EPUB files
    const epubFiles = this.findEpubFiles(folder);

    for (const file of epubFiles) {
      try {
        const book = await this.extractMetadata(file);
        books.push(book);
      } catch (e) {
        errors.push({
          path: file.path,
          error: e instanceof Error ? e.message : 'Unknown error'
        });
      }
    }

    return { books, errors };
  }

  /**
   * Find all EPUB files in a folder recursively
   */
  private findEpubFiles(folder: TFolder): TFile[] {
    const epubFiles: TFile[] = [];

    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'epub') {
        epubFiles.push(child);
      } else if (child instanceof TFolder) {
        epubFiles.push(...this.findEpubFiles(child));
      }
    }

    return epubFiles;
  }

  /**
   * Extract metadata from an EPUB file using the server
   */
  async extractMetadata(file: TFile): Promise<Book> {
    if (!this.apiClient) {
      throw new Error('Server not configured. Enable Amnesia server in settings.');
    }

    // Read the file as binary
    const data = await this.app.vault.readBinary(file);

    // Upload to server - returns just id and title
    const uploadResult = await this.apiClient.uploadBook(data, file.name);

    // Fetch full book details with metadata
    const parsedBook = await this.apiClient.getBook(uploadResult.id);
    const metadata = parsedBook.metadata;

    // Extract cover if available
    let coverUrl: string | undefined;
    if (metadata.coverHref) {
      try {
        coverUrl = await this.apiClient.getResourceAsDataUrl(parsedBook.id, metadata.coverHref);
      } catch (e) {
        console.warn('Failed to extract cover:', e);
      }
    }

    const book: Book = {
      id: uuidv4(),
      title: metadata.title || file.basename,
      author: metadata.creators[0]?.name || undefined,
      localPath: file.path,
      status: 'to-read' as BookStatus,
      progress: 0,
      publisher: metadata.publisher || undefined,
      language: metadata.language || undefined,
      description: metadata.description || undefined,
      formats: ['epub'],
      addedAt: new Date(file.stat.ctime),
      highlightCount: 0,
      readingSessions: 0,
      coverUrl,
      // Store server book ID for future reference
      serverId: parsedBook.id,
    };

    // Use identifier as ISBN if available
    if (metadata.identifier) {
      book.isbn = metadata.identifier;
    }

    return book;
  }

  /**
   * Watch for changes in a folder
   */
  watchFolder(
    folderPath: string,
    onChange: (event: 'added' | 'removed' | 'modified', path: string) => void
  ): () => void {
    // Register file event handlers
    const createHandler = this.app.vault.on('create', (file) => {
      if (file instanceof TFile &&
          file.extension === 'epub' &&
          file.path.startsWith(folderPath)) {
        onChange('added', file.path);
      }
    });

    const deleteHandler = this.app.vault.on('delete', (file) => {
      if (file instanceof TFile &&
          file.extension === 'epub' &&
          file.path.startsWith(folderPath)) {
        onChange('removed', file.path);
      }
    });

    const renameHandler = this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'epub') {
        if (oldPath.startsWith(folderPath) && !file.path.startsWith(folderPath)) {
          onChange('removed', oldPath);
        } else if (!oldPath.startsWith(folderPath) && file.path.startsWith(folderPath)) {
          onChange('added', file.path);
        } else if (file.path.startsWith(folderPath)) {
          onChange('modified', file.path);
        }
      }
    });

    // Return cleanup function
    return () => {
      this.app.vault.offref(createHandler);
      this.app.vault.offref(deleteHandler);
      this.app.vault.offref(renameHandler);
    };
  }
}
