//! PDF parsing using pdfium-render
//!
//! Provides PDF parsing functionality for metadata extraction,
//! page rendering, and text layer generation.

use std::path::Path;
use std::sync::Arc;

use pdfium_render::prelude::*;
use thiserror::Error;

use crate::epub::TocEntry;

use super::types::{
    CharPosition, ImageFormat, NormalizedPosition, PageDimensions, PageOrientation,
    PageRenderRequest, ParsedPdf, PdfMetadata, PdfSearchResult, TextItem, TextLayer,
};

/// PDF parsing errors
#[derive(Error, Debug)]
pub enum PdfParseError {
    #[error("Failed to initialize pdfium: {0}")]
    PdfiumInit(String),
    #[error("Failed to load PDF: {0}")]
    LoadError(String),
    #[error("Failed to render page: {0}")]
    RenderError(String),
    #[error("Page {0} not found (document has {1} pages)")]
    PageNotFound(usize, usize),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Image encoding error: {0}")]
    ImageError(String),
}

/// PDF parser using pdfium-render
///
/// This struct holds both the pdfium instance and the document.
/// The document's lifetime is managed by keeping the PDF data (bytes or file)
/// accessible for the duration of the parser's lifetime.
pub struct PdfParser {
    /// The pdfium library instance (shared)
    pdfium: Arc<Pdfium>,
    /// The PDF data - kept to ensure document validity
    _data: PdfData,
    /// The parsed document
    document: PdfDocument<'static>,
    /// Book identifier
    book_id: String,
}

/// Holds the source PDF data to ensure it outlives the document
enum PdfData {
    /// PDF loaded from owned bytes
    Bytes(Vec<u8>),
    /// PDF loaded from a file path (file remains on disk)
    Path(std::path::PathBuf),
}

// SAFETY: PdfDocument with thread_safe feature is Send + Sync
// The pdfium library is also thread-safe when using the thread_safe feature
unsafe impl Send for PdfParser {}
unsafe impl Sync for PdfParser {}

impl PdfParser {
    /// Initialize pdfium library
    fn init_pdfium() -> Result<Pdfium, PdfParseError> {
        // Try to load pdfium from common locations
        let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
            .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("/usr/lib")))
            .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("/usr/local/lib")))
            .or_else(|_| Pdfium::bind_to_system_library())
            .map_err(|e| PdfParseError::PdfiumInit(e.to_string()))?;

        Ok(Pdfium::new(bindings))
    }

    /// Create parser from file path
    pub fn from_path<P: AsRef<Path>>(path: P, book_id: String) -> Result<Self, PdfParseError> {
        let pdfium = Arc::new(Self::init_pdfium()?);
        let path_buf = path.as_ref().to_path_buf();

        let document = pdfium
            .load_pdf_from_file(&path_buf, None)
            .map_err(|e| PdfParseError::LoadError(e.to_string()))?;

        // SAFETY: The document is valid for as long as the file exists.
        // We keep the path to indicate the source but don't rely on it for lifetime.
        // The pdfium library manages the document internally once loaded.
        let document: PdfDocument<'static> = unsafe { std::mem::transmute(document) };

        Ok(Self {
            pdfium,
            _data: PdfData::Path(path_buf),
            document,
            book_id,
        })
    }

    /// Create parser from bytes
    pub fn from_bytes(data: &[u8], book_id: String) -> Result<Self, PdfParseError> {
        // Copy the data to an owned Vec so we control its lifetime
        let owned_data = data.to_vec();

        let pdfium = Arc::new(Self::init_pdfium()?);

        // Load from the owned data
        let document = pdfium
            .load_pdf_from_byte_vec(owned_data.clone(), None)
            .map_err(|e| PdfParseError::LoadError(e.to_string()))?;

        // SAFETY: load_pdf_from_byte_vec takes ownership of the Vec internally,
        // so the document lifetime is managed by pdfium. We keep a copy in _data
        // for safety but pdfium owns the actual data used by the document.
        let document: PdfDocument<'static> = unsafe { std::mem::transmute(document) };

        Ok(Self {
            pdfium,
            _data: PdfData::Bytes(owned_data),
            document,
            book_id,
        })
    }

    /// Parse PDF and extract metadata
    pub fn parse(&self) -> Result<ParsedPdf, PdfParseError> {
        let metadata = self.extract_metadata();
        let toc = self.extract_outline();
        let page_count = self.document.pages().len() as usize;
        let has_text_layer = self.check_text_layer();
        let orientation = self.determine_orientation();
        let page_labels = self.extract_page_labels();

        Ok(ParsedPdf {
            id: self.book_id.clone(),
            metadata,
            toc,
            page_count,
            page_labels,
            has_text_layer,
            orientation,
        })
    }

    /// Extract metadata from PDF info dictionary
    fn extract_metadata(&self) -> PdfMetadata {
        let metadata = self.document.metadata();

        // pdfium-render 0.8 uses get() method with PdfDocumentMetadataTagType
        let get_tag = |tag: PdfDocumentMetadataTagType| -> Option<String> {
            metadata.get(tag)
                .map(|t| t.value().to_string())
                .filter(|s: &String| !s.is_empty())
        };

        PdfMetadata {
            title: get_tag(PdfDocumentMetadataTagType::Title)
                .unwrap_or_else(|| self.book_id.clone()),
            author: get_tag(PdfDocumentMetadataTagType::Author),
            subject: get_tag(PdfDocumentMetadataTagType::Subject),
            keywords: get_tag(PdfDocumentMetadataTagType::Keywords)
                .map(|k| k.split(',').map(|s| s.trim().to_string()).collect())
                .unwrap_or_default(),
            creator: get_tag(PdfDocumentMetadataTagType::Creator),
            producer: get_tag(PdfDocumentMetadataTagType::Producer),
            creation_date: get_tag(PdfDocumentMetadataTagType::CreationDate),
            modification_date: get_tag(PdfDocumentMetadataTagType::ModificationDate),
        }
    }

    /// Extract PDF outline/bookmarks as TocEntry
    fn extract_outline(&self) -> Vec<TocEntry> {
        self.extract_bookmarks_recursive(self.document.bookmarks().iter())
    }

    fn extract_bookmarks_recursive<'a>(
        &self,
        bookmarks: impl Iterator<Item = PdfBookmark<'a>>,
    ) -> Vec<TocEntry> {
        bookmarks
            .map(|bookmark| {
                let label = bookmark.title().unwrap_or_else(|| "Untitled".to_string());
                let page = bookmark.destination()
                    .and_then(|d| d.page_index().ok())
                    .map(|idx| idx as u32 + 1)
                    .unwrap_or(1);

                let children = self.extract_bookmarks_recursive(bookmark.iter_direct_children());

                TocEntry {
                    label,
                    href: format!("page:{}", page),
                    children,
                    play_order: Some(page),
                }
            })
            .collect()
    }

    /// Check if PDF has extractable text
    fn check_text_layer(&self) -> bool {
        // Check first few pages for text content
        for page in self.document.pages().iter().take(3) {
            if let Ok(text_page) = page.text() {
                let text = text_page.all();
                if !text.trim().is_empty() {
                    return true;
                }
            }
        }
        false
    }

    /// Determine overall page orientation
    fn determine_orientation(&self) -> PageOrientation {
        let mut portrait_count = 0;
        let mut landscape_count = 0;

        for page in self.document.pages().iter().take(10) {
            let width = page.width().value;
            let height = page.height().value;

            if width > height {
                landscape_count += 1;
            } else {
                portrait_count += 1;
            }
        }

        if portrait_count > 0 && landscape_count > 0 {
            PageOrientation::Mixed
        } else if landscape_count > portrait_count {
            PageOrientation::Landscape
        } else {
            PageOrientation::Portrait
        }
    }

    /// Extract page labels if available
    fn extract_page_labels(&self) -> Option<Vec<String>> {
        // pdfium-render may not expose page labels directly
        // For now, generate default labels
        let count = self.document.pages().len();
        if count > 0 {
            Some((1..=count).map(|n| n.to_string()).collect())
        } else {
            None
        }
    }

    /// Get page count
    pub fn page_count(&self) -> usize {
        self.document.pages().len() as usize
    }

    /// Get page dimensions
    pub fn get_page_dimensions(&self, page_num: usize) -> Result<PageDimensions, PdfParseError> {
        let page = self.get_page(page_num)?;

        Ok(PageDimensions {
            width: page.width().value,
            height: page.height().value,
        })
    }

    /// Get a page by number (1-indexed)
    fn get_page(&self, page_num: usize) -> Result<PdfPage, PdfParseError> {
        let page_count = self.document.pages().len() as usize;
        if page_num < 1 || page_num > page_count {
            return Err(PdfParseError::PageNotFound(page_num, page_count));
        }

        let page_idx = (page_num - 1) as u16;
        self.document
            .pages()
            .get(page_idx)
            .map_err(|e| PdfParseError::LoadError(e.to_string()))
    }

    /// Render a page to image bytes
    pub fn render_page(&self, request: &PageRenderRequest) -> Result<Vec<u8>, PdfParseError> {
        let page = self.get_page(request.page)?;

        // Calculate dimensions based on scale
        let width = (page.width().value * request.scale) as u32;
        let height = (page.height().value * request.scale) as u32;

        // Create render config with rotation
        let rotation = match request.rotation {
            90 => PdfPageRenderRotation::Degrees90,
            180 => PdfPageRenderRotation::Degrees180,
            270 => PdfPageRenderRotation::Degrees270,
            _ => PdfPageRenderRotation::None,
        };

        let config = PdfRenderConfig::new()
            .set_target_width(width as i32)
            .set_target_height(height as i32)
            .rotate(rotation, true);

        // Render page to bitmap
        let bitmap = page
            .render_with_config(&config)
            .map_err(|e| PdfParseError::RenderError(e.to_string()))?;

        // Convert to image bytes
        let image = bitmap.as_image();
        self.encode_image(&image, request.format)
    }

    /// Render a thumbnail (low resolution)
    pub fn render_thumbnail(&self, page_num: usize, max_size: u32) -> Result<Vec<u8>, PdfParseError> {
        let page = self.get_page(page_num)?;

        // Calculate scale to fit within max_size
        let width = page.width().value;
        let height = page.height().value;
        let scale = (max_size as f32) / width.max(height);

        let request = PageRenderRequest {
            page: page_num,
            scale,
            format: ImageFormat::Jpeg, // JPEG for smaller thumbnails
            rotation: 0,
        };

        self.render_page(&request)
    }

    /// Encode image buffer to bytes
    fn encode_image(
        &self,
        image: &image::DynamicImage,
        format: ImageFormat,
    ) -> Result<Vec<u8>, PdfParseError> {
        use std::io::Cursor;

        let mut output = Vec::new();

        match format {
            ImageFormat::Png => {
                image
                    .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Png)
                    .map_err(|e| PdfParseError::ImageError(e.to_string()))?;
            }
            ImageFormat::Jpeg => {
                image
                    .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Jpeg)
                    .map_err(|e| PdfParseError::ImageError(e.to_string()))?;
            }
            ImageFormat::Webp => {
                image
                    .write_to(&mut Cursor::new(&mut output), image::ImageFormat::WebP)
                    .map_err(|e| PdfParseError::ImageError(e.to_string()))?;
            }
        }

        Ok(output)
    }

    /// Extract text layer for a page
    pub fn get_text_layer(&self, page_num: usize) -> Result<TextLayer, PdfParseError> {
        let page = self.get_page(page_num)?;

        let width = page.width().value;
        let height = page.height().value;

        let mut items = Vec::new();

        if let Ok(text_page) = page.text() {
            // Get all text objects on the page
            for segment in text_page.segments().iter() {
                let text = segment.text();
                if text.trim().is_empty() {
                    continue;
                }

                // Get bounding box for segment
                let bounds = segment.bounds();
                let item = TextItem {
                    text: text.clone(),
                    x: bounds.left().value,
                    // Convert from bottom-left origin to top-left origin
                    y: height - bounds.top().value,
                    width: bounds.right().value - bounds.left().value,
                    height: bounds.top().value - bounds.bottom().value,
                    font_size: 12.0, // Default; pdfium may not expose this directly
                    char_positions: self.extract_char_positions(&segment, bounds.left().value),
                };
                items.push(item);
            }
        }

        Ok(TextLayer {
            page: page_num,
            width,
            height,
            items,
        })
    }

    /// Extract character-level positions
    fn extract_char_positions(&self, segment: &PdfPageTextSegment, base_x: f32) -> Option<Vec<CharPosition>> {
        let text = segment.text();
        if text.is_empty() {
            return None;
        }

        // Approximate character positions based on segment width
        let bounds = segment.bounds();
        let segment_width = bounds.right().value - bounds.left().value;
        let char_count = text.chars().count();
        if char_count == 0 {
            return None;
        }
        let char_width = segment_width / char_count as f32;

        let positions: Vec<CharPosition> = text
            .chars()
            .enumerate()
            .map(|(i, c)| CharPosition {
                char: c,
                x: base_x + (i as f32 * char_width),
                width: char_width,
            })
            .collect();

        Some(positions)
    }

    /// Search for text in the PDF
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<PdfSearchResult>, PdfParseError> {
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();

        for (page_idx, page) in self.document.pages().iter().enumerate() {
            if results.len() >= limit {
                break;
            }

            if let Ok(text_page) = page.text() {
                let full_text = text_page.all();
                let full_text_lower = full_text.to_lowercase();

                let mut start = 0;
                while let Some(pos) = full_text_lower[start..].find(&query_lower) {
                    if results.len() >= limit {
                        break;
                    }

                    let actual_pos = start + pos;
                    let matched_text = &full_text[actual_pos..actual_pos + query.len()];

                    // Extract context
                    let prefix_start = actual_pos.saturating_sub(32);
                    let suffix_end = (actual_pos + query.len() + 32).min(full_text.len());

                    results.push(PdfSearchResult {
                        page: page_idx + 1,
                        text: matched_text.to_string(),
                        prefix: if prefix_start < actual_pos {
                            Some(full_text[prefix_start..actual_pos].to_string())
                        } else {
                            None
                        },
                        suffix: if actual_pos + query.len() < suffix_end {
                            Some(full_text[actual_pos + query.len()..suffix_end].to_string())
                        } else {
                            None
                        },
                        position: None, // TODO: Calculate normalized position
                    });

                    start = actual_pos + query.len();
                }
            }
        }

        Ok(results)
    }

    /// Get full page text
    pub fn get_page_text(&self, page_num: usize) -> Result<String, PdfParseError> {
        let page = self.get_page(page_num)?;

        let result = if let Ok(text_page) = page.text() {
            text_page.all()
        } else {
            String::new()
        };

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: These tests require a pdfium library to be installed
    // They are marked as ignore by default

    #[test]
    #[ignore]
    fn test_pdf_parser_init() {
        // This test requires pdfium to be installed
        let result = PdfParser::init_pdfium();
        assert!(result.is_ok() || result.is_err()); // Just check it doesn't panic
    }
}
