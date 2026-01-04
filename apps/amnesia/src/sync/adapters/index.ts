/**
 * Sync Adapters
 *
 * Re-exports all sync adapters for convenient importing.
 */

export {
  CalibreSyncAdapter,
  type CalibreBookSyncData,
  type CoverDownloadResult,
  type ParallelProgress,
  type ParallelCoverOptions,
} from './calibre-adapter';
export { ServerSyncAdapter } from './server-adapter';
export { FileSyncAdapter } from './file-adapter';
