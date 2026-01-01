//! OCR Module
//!
//! Provides OCR (Optical Character Recognition) functionality for scanned PDFs.
//!
//! Supports multiple backends:
//! - Tesseract (local, requires installation)
//! - Ollama vision models (local LLM)
//!
//! ## Usage
//!
//! ```rust,ignore
//! use los_libros_server::ocr::{OcrService, OcrServiceConfig, OcrRect};
//!
//! let config = OcrServiceConfig::default();
//! let service = OcrService::new(config);
//!
//! // Check available providers
//! let providers = service.available_providers().await;
//!
//! // OCR a region
//! let result = service.ocr_pdf_region(
//!     "pdf-id",
//!     1,
//!     &OcrRect { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
//!     None, // Use first available provider
//!     Some("eng"),
//!     &pdf_cache
//! ).await?;
//! ```

mod provider;
mod service;
mod types;

pub use provider::{OcrProviderTrait, OllamaProvider};
pub use service::{OcrService, OcrServiceConfig};
pub use types::{OcrError, OcrProvider, OcrRect, OcrRequest, OcrResult, OcrWord, PixelRect};

#[cfg(feature = "ocr-tesseract")]
pub use provider::TesseractProvider;
