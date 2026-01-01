//! PDF parsing module
//!
//! Provides PDF parsing functionality using pdfium-render.
//! Includes types, parsing, caching, and page rendering.

mod cache;
mod parser;
mod types;

pub use cache::PdfCache;
pub use parser::{PdfParseError, PdfParser};
pub use types::{
    CharPosition, ImageFormat, NormalizedPosition, NormalizedRect, PageDimensions,
    PageOrientation, PageRenderRequest, ParsedPdf, PdfMetadata, PdfSearchResult, TextItem,
    TextLayer,
};
