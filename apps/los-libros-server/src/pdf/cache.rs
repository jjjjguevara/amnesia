//! PDF cache for parsed documents and rendered pages
//!
//! In-memory cache to avoid re-parsing PDFs and re-rendering pages.

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;

use lru::LruCache;
use tokio::sync::RwLock;

use super::parser::{PdfParseError, PdfParser};
use super::types::{ImageFormat, PageRenderRequest, ParsedPdf, TextLayer};

/// Cache key for rendered pages
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct PageCacheKey {
    pub book_id: String,
    pub page: usize,
    pub scale: u32, // Scale * 100 as integer for hashing
    pub rotation: u16,
    pub format: ImageFormat,
}

impl PageCacheKey {
    pub fn new(book_id: &str, request: &PageRenderRequest) -> Self {
        Self {
            book_id: book_id.to_string(),
            page: request.page,
            scale: (request.scale * 100.0) as u32,
            rotation: request.rotation,
            format: request.format,
        }
    }

    pub fn thumbnail(book_id: &str, page: usize, max_size: u32) -> Self {
        Self {
            book_id: book_id.to_string(),
            page,
            scale: max_size,
            rotation: 0,
            format: ImageFormat::Jpeg,
        }
    }
}

impl std::hash::Hash for ImageFormat {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        match self {
            ImageFormat::Png => 0u8.hash(state),
            ImageFormat::Webp => 1u8.hash(state),
            ImageFormat::Jpeg => 2u8.hash(state),
        }
    }
}

/// Thread-safe PDF cache
#[derive(Clone)]
pub struct PdfCache {
    /// Parsed PDF metadata cache
    pdfs: Arc<RwLock<HashMap<String, ParsedPdf>>>,
    /// Active parser instances (for content retrieval)
    parsers: Arc<RwLock<HashMap<String, Arc<PdfParser>>>>,
    /// LRU cache for rendered pages
    page_cache: Arc<RwLock<LruCache<PageCacheKey, Vec<u8>>>>,
    /// Text layer cache
    text_cache: Arc<RwLock<HashMap<(String, usize), TextLayer>>>,
}

impl Default for PdfCache {
    fn default() -> Self {
        Self::new()
    }
}

impl PdfCache {
    /// Create a new empty cache
    pub fn new() -> Self {
        Self::with_capacity(100) // Default to 100 cached pages
    }

    /// Create a cache with specified page cache capacity
    pub fn with_capacity(page_cache_size: usize) -> Self {
        let size = NonZeroUsize::new(page_cache_size).unwrap_or(NonZeroUsize::new(100).unwrap());

        Self {
            pdfs: Arc::new(RwLock::new(HashMap::new())),
            parsers: Arc::new(RwLock::new(HashMap::new())),
            page_cache: Arc::new(RwLock::new(LruCache::new(size))),
            text_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Load and cache a PDF from bytes
    pub async fn load_from_bytes(
        &self,
        data: &[u8],
        book_id: String,
    ) -> Result<ParsedPdf, PdfParseError> {
        let parser = PdfParser::from_bytes(data, book_id.clone())?;
        let pdf = parser.parse()?;
        let id = pdf.id.clone();

        // Cache the parsed metadata
        {
            let mut pdfs = self.pdfs.write().await;
            pdfs.insert(id.clone(), pdf.clone());
        }

        // Cache the parser for content retrieval
        {
            let mut parsers = self.parsers.write().await;
            parsers.insert(id, Arc::new(parser));
        }

        Ok(pdf)
    }

    /// Load and cache a PDF from a file path
    pub async fn load_from_path(
        &self,
        path: impl AsRef<std::path::Path>,
        book_id: String,
    ) -> Result<ParsedPdf, PdfParseError> {
        let parser = PdfParser::from_path(path, book_id.clone())?;
        let pdf = parser.parse()?;
        let id = pdf.id.clone();

        // Cache the parsed metadata
        {
            let mut pdfs = self.pdfs.write().await;
            pdfs.insert(id.clone(), pdf.clone());
        }

        // Cache the parser for content retrieval
        {
            let mut parsers = self.parsers.write().await;
            parsers.insert(id, Arc::new(parser));
        }

        Ok(pdf)
    }

    /// Get cached PDF metadata
    pub async fn get_pdf(&self, id: &str) -> Option<ParsedPdf> {
        let pdfs = self.pdfs.read().await;
        pdfs.get(id).cloned()
    }

    /// Get all cached PDFs
    pub async fn get_all_pdfs(&self) -> Vec<ParsedPdf> {
        let pdfs = self.pdfs.read().await;
        pdfs.values().cloned().collect()
    }

    /// Check if a PDF is cached
    pub async fn contains(&self, id: &str) -> bool {
        let pdfs = self.pdfs.read().await;
        pdfs.contains_key(id)
    }

    /// Render a page (with caching)
    pub async fn render_page(
        &self,
        book_id: &str,
        request: &PageRenderRequest,
    ) -> Result<Vec<u8>, PdfParseError> {
        let cache_key = PageCacheKey::new(book_id, request);

        // Check page cache first
        {
            let mut page_cache = self.page_cache.write().await;
            if let Some(data) = page_cache.get(&cache_key) {
                return Ok(data.clone());
            }
        }

        // Render the page
        let parsers = self.parsers.read().await;
        let parser = parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not cached", book_id)))?;

        let data = parser.render_page(request)?;

        // Cache the result
        {
            let mut page_cache = self.page_cache.write().await;
            page_cache.put(cache_key, data.clone());
        }

        Ok(data)
    }

    /// Render a thumbnail (with caching)
    pub async fn render_thumbnail(
        &self,
        book_id: &str,
        page: usize,
        max_size: u32,
    ) -> Result<Vec<u8>, PdfParseError> {
        let cache_key = PageCacheKey::thumbnail(book_id, page, max_size);

        // Check page cache first
        {
            let mut page_cache = self.page_cache.write().await;
            if let Some(data) = page_cache.get(&cache_key) {
                return Ok(data.clone());
            }
        }

        // Render the thumbnail
        let parsers = self.parsers.read().await;
        let parser = parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not cached", book_id)))?;

        let data = parser.render_thumbnail(page, max_size)?;

        // Cache the result
        {
            let mut page_cache = self.page_cache.write().await;
            page_cache.put(cache_key, data.clone());
        }

        Ok(data)
    }

    /// Get text layer for a page (with caching)
    pub async fn get_text_layer(
        &self,
        book_id: &str,
        page: usize,
    ) -> Result<TextLayer, PdfParseError> {
        let cache_key = (book_id.to_string(), page);

        // Check text cache first
        {
            let text_cache = self.text_cache.read().await;
            if let Some(layer) = text_cache.get(&cache_key) {
                return Ok(layer.clone());
            }
        }

        // Extract text layer
        let parsers = self.parsers.read().await;
        let parser = parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not cached", book_id)))?;

        let layer = parser.get_text_layer(page)?;

        // Cache the result
        {
            let mut text_cache = self.text_cache.write().await;
            text_cache.insert(cache_key, layer.clone());
        }

        Ok(layer)
    }

    /// Search PDF content
    pub async fn search(
        &self,
        book_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<super::types::PdfSearchResult>, PdfParseError> {
        let parsers = self.parsers.read().await;
        let parser = parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not cached", book_id)))?;

        parser.search(query, limit)
    }

    /// Get page text
    pub async fn get_page_text(&self, book_id: &str, page: usize) -> Result<String, PdfParseError> {
        let parsers = self.parsers.read().await;
        let parser = parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not cached", book_id)))?;

        parser.get_page_text(page)
    }

    /// Get page dimensions
    pub async fn get_page_dimensions(
        &self,
        book_id: &str,
        page: usize,
    ) -> Result<super::types::PageDimensions, PdfParseError> {
        let parsers = self.parsers.read().await;
        let parser = parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not cached", book_id)))?;

        parser.get_page_dimensions(page)
    }

    /// Remove a PDF from the cache
    pub async fn remove(&self, id: &str) {
        // Remove metadata
        {
            let mut pdfs = self.pdfs.write().await;
            pdfs.remove(id);
        }

        // Remove parser
        {
            let mut parsers = self.parsers.write().await;
            parsers.remove(id);
        }

        // Remove cached pages (need to iterate through LRU)
        {
            let mut page_cache = self.page_cache.write().await;
            // LruCache doesn't have a filter method, so we collect keys to remove
            let keys_to_remove: Vec<PageCacheKey> = page_cache
                .iter()
                .filter(|(k, _)| k.book_id == id)
                .map(|(k, _)| k.clone())
                .collect();
            for key in keys_to_remove {
                page_cache.pop(&key);
            }
        }

        // Remove cached text layers
        {
            let mut text_cache = self.text_cache.write().await;
            text_cache.retain(|(book_id, _), _| book_id != id);
        }
    }

    /// Clear the entire cache
    pub async fn clear(&self) {
        {
            let mut pdfs = self.pdfs.write().await;
            pdfs.clear();
        }
        {
            let mut parsers = self.parsers.write().await;
            parsers.clear();
        }
        {
            let mut page_cache = self.page_cache.write().await;
            page_cache.clear();
        }
        {
            let mut text_cache = self.text_cache.write().await;
            text_cache.clear();
        }
    }

    /// Get the number of cached PDFs
    pub async fn len(&self) -> usize {
        let pdfs = self.pdfs.read().await;
        pdfs.len()
    }

    /// Check if cache is empty
    pub async fn is_empty(&self) -> bool {
        let pdfs = self.pdfs.read().await;
        pdfs.is_empty()
    }

    /// Get page cache statistics
    pub async fn page_cache_stats(&self) -> (usize, usize) {
        let page_cache = self.page_cache.read().await;
        (page_cache.len(), page_cache.cap().get())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_pdf_cache_creation() {
        let cache = PdfCache::new();
        assert!(cache.is_empty().await);
        assert_eq!(cache.len().await, 0);
    }

    #[tokio::test]
    async fn test_pdf_cache_with_capacity() {
        let cache = PdfCache::with_capacity(50);
        let (_, cap) = cache.page_cache_stats().await;
        assert_eq!(cap, 50);
    }

    #[tokio::test]
    async fn test_page_cache_key() {
        let request = PageRenderRequest {
            page: 1,
            scale: 1.5,
            format: ImageFormat::Png,
            rotation: 0,
        };
        let key = PageCacheKey::new("test-book", &request);
        assert_eq!(key.book_id, "test-book");
        assert_eq!(key.page, 1);
        assert_eq!(key.scale, 150); // 1.5 * 100
    }
}
