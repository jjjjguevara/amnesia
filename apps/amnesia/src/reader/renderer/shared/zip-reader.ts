/**
 * Shared ZIP Reader Utility
 *
 * A minimal ZIP parser for EPUB files using native DecompressionStream.
 * Used by both the main thread (mupdf-epub-bridge.ts) and worker thread
 * (document-worker.ts) for direct EPUB content extraction.
 *
 * Features:
 * - Native browser DecompressionStream for DEFLATE (no external dependencies)
 * - Case-insensitive filename matching for cross-platform EPUBs
 * - Supports both stored (uncompressed) and DEFLATE-compressed entries
 */

interface ZipEntry {
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipReader {
  private data: Uint8Array;
  private view: DataView;
  private entries: Map<string, ZipEntry> = new Map();
  private parsed = false;

  constructor(data: ArrayBuffer) {
    this.data = new Uint8Array(data);
    this.view = new DataView(data);
  }

  /**
   * Read a file from the ZIP as text
   */
  async readText(filename: string): Promise<string> {
    const bytes = await this.read(filename);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /**
   * Read a file from the ZIP as bytes
   */
  async read(filename: string): Promise<Uint8Array> {
    if (!this.parsed) {
      this.parseDirectory();
    }

    // Try exact match first
    let entry = this.entries.get(filename);

    // Try without leading slash
    if (!entry && filename.startsWith('/')) {
      entry = this.entries.get(filename.substring(1));
    }

    // Try case-insensitive match
    if (!entry) {
      const lowerFilename = filename.toLowerCase();
      for (const [name, e] of this.entries) {
        if (name.toLowerCase() === lowerFilename) {
          entry = e;
          break;
        }
      }
    }

    if (!entry) {
      const available = Array.from(this.entries.keys()).slice(0, 10);
      throw new Error(`File not found in ZIP: ${filename}. Available: ${available.join(', ')}...`);
    }

    return this.extractEntry(entry);
  }

  /**
   * Check if a file exists in the ZIP
   */
  has(filename: string): boolean {
    if (!this.parsed) {
      this.parseDirectory();
    }

    if (this.entries.has(filename)) return true;
    if (filename.startsWith('/') && this.entries.has(filename.substring(1))) return true;

    const lowerFilename = filename.toLowerCase();
    for (const name of this.entries.keys()) {
      if (name.toLowerCase() === lowerFilename) return true;
    }

    return false;
  }

  /**
   * Get list of all files in the ZIP
   */
  listFiles(): string[] {
    if (!this.parsed) {
      this.parseDirectory();
    }
    return Array.from(this.entries.keys());
  }

  /**
   * Parse ZIP central directory
   */
  private parseDirectory(): void {
    // Find End of Central Directory record (scan from end)
    let eocdOffset = -1;
    for (let i = this.data.length - 22; i >= 0; i--) {
      if (this.view.getUint32(i, true) === 0x06054b50) { // EOCD signature
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      throw new Error('Invalid ZIP: Could not find End of Central Directory');
    }

    // Read EOCD
    const cdOffset = this.view.getUint32(eocdOffset + 16, true);
    const cdEntries = this.view.getUint16(eocdOffset + 10, true);

    // Parse Central Directory entries
    let offset = cdOffset;
    for (let i = 0; i < cdEntries; i++) {
      if (this.view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error('Invalid ZIP: Bad Central Directory entry signature');
      }

      const compressionMethod = this.view.getUint16(offset + 10, true);
      const compressedSize = this.view.getUint32(offset + 20, true);
      const uncompressedSize = this.view.getUint32(offset + 24, true);
      const nameLength = this.view.getUint16(offset + 28, true);
      const extraLength = this.view.getUint16(offset + 30, true);
      const commentLength = this.view.getUint16(offset + 32, true);
      const localHeaderOffset = this.view.getUint32(offset + 42, true);

      const nameBytes = this.data.slice(offset + 46, offset + 46 + nameLength);
      const filename = new TextDecoder('utf-8').decode(nameBytes);

      // Skip directories
      if (!filename.endsWith('/')) {
        this.entries.set(filename, {
          compressionMethod,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
        });
      }

      offset += 46 + nameLength + extraLength + commentLength;
    }

    this.parsed = true;
  }

  /**
   * Extract a ZIP entry
   */
  private async extractEntry(entry: ZipEntry): Promise<Uint8Array> {
    // Read local file header to find data offset
    const localOffset = entry.localHeaderOffset;

    if (this.view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error('Invalid ZIP: Bad local file header signature');
    }

    const localNameLength = this.view.getUint16(localOffset + 26, true);
    const localExtraLength = this.view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;

    const compressedData = this.data.slice(dataOffset, dataOffset + entry.compressedSize);

    if (entry.compressionMethod === 0) {
      // Stored (no compression)
      return compressedData;
    } else if (entry.compressionMethod === 8) {
      // DEFLATE
      return this.inflate(compressedData);
    } else {
      throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
    }
  }

  /**
   * Decompress DEFLATE data using browser-native DecompressionStream
   */
  private async inflate(data: Uint8Array): Promise<Uint8Array> {
    // Use browser-native DecompressionStream for DEFLATE
    // 'deflate-raw' matches ZIP's raw DEFLATE format (no zlib header)
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    // Write compressed data - create a copy with proper ArrayBuffer type
    const dataBuffer = new Uint8Array(data).buffer;
    writer.write(new Uint8Array(dataBuffer));
    writer.close();

    // Read decompressed data
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }

    // Combine chunks
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }
}
