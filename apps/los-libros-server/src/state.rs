//! Application state management

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::config::Config;
use crate::epub::BookCache;
use crate::pdf::PdfCache;
use crate::storage::S3Client;

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    pub config: Config,
    pub s3_client: S3Client,
    pub db: SqlitePool,
    pub book_cache: BookCache,
    pub pdf_cache: PdfCache,
}

impl AppState {
    /// Create a new application state
    pub async fn new(config: Config, s3_client: S3Client, db: SqlitePool) -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                config,
                s3_client,
                db,
                book_cache: BookCache::new(),
                pdf_cache: PdfCache::new(),
            }),
        }
    }

    /// Get the configuration
    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    /// Get the S3 client
    pub fn s3_client(&self) -> &S3Client {
        &self.inner.s3_client
    }

    /// Get the database pool
    pub fn db(&self) -> &SqlitePool {
        &self.inner.db
    }

    /// Get the book cache
    pub fn book_cache(&self) -> &BookCache {
        &self.inner.book_cache
    }

    /// Get the PDF cache
    pub fn pdf_cache(&self) -> &PdfCache {
        &self.inner.pdf_cache
    }
}
