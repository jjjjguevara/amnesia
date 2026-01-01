//! OCR Types
//!
//! Defines types for OCR processing of scanned PDF pages.

use serde::{Deserialize, Serialize};

/// OCR provider type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OcrProvider {
    /// Tesseract OCR (local)
    Tesseract,
    /// Ollama vision model (local LLM)
    Ollama,
    /// OpenAI Vision API
    OpenAI,
}

impl Default for OcrProvider {
    fn default() -> Self {
        Self::Tesseract
    }
}

/// OCR request for a region of a PDF page
#[derive(Debug, Clone, Deserialize)]
pub struct OcrRequest {
    /// Page number (1-indexed)
    pub page: usize,
    /// Region to OCR (normalized 0-1 coordinates)
    pub rect: OcrRect,
    /// Preferred provider
    #[serde(default)]
    pub provider: Option<OcrProvider>,
    /// Language hint (ISO 639-1 code)
    #[serde(default)]
    pub language: Option<String>,
}

/// Normalized rectangle (0-1 coordinates)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl OcrRect {
    /// Convert to pixel coordinates given page dimensions
    pub fn to_pixels(&self, page_width: u32, page_height: u32) -> PixelRect {
        PixelRect {
            x: (self.x * page_width as f64) as u32,
            y: (self.y * page_height as f64) as u32,
            width: (self.width * page_width as f64) as u32,
            height: (self.height * page_height as f64) as u32,
        }
    }
}

/// Pixel-based rectangle
#[derive(Debug, Clone)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// OCR result
#[derive(Debug, Clone, Serialize)]
pub struct OcrResult {
    /// Recognized text
    pub text: String,
    /// Confidence score (0-100)
    pub confidence: f64,
    /// Provider used
    pub provider: OcrProvider,
    /// Individual word results (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<OcrWord>>,
}

/// Single word OCR result
#[derive(Debug, Clone, Serialize)]
pub struct OcrWord {
    /// Word text
    pub text: String,
    /// Confidence for this word
    pub confidence: f64,
    /// Bounding box (normalized coordinates)
    pub bounds: OcrRect,
}

/// OCR error types
#[derive(Debug, thiserror::Error)]
pub enum OcrError {
    #[error("OCR provider not available: {0}")]
    ProviderNotAvailable(String),

    #[error("Failed to extract image region: {0}")]
    ImageExtractionError(String),

    #[error("OCR processing failed: {0}")]
    ProcessingError(String),

    #[error("Invalid region: {0}")]
    InvalidRegion(String),

    #[error("API error: {0}")]
    ApiError(String),
}

impl OcrError {
    pub fn status_code(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
            Self::ProviderNotAvailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::InvalidRegion(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}
