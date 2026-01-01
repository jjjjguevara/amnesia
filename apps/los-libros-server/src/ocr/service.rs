//! OCR Service
//!
//! Orchestrates OCR providers and handles image extraction from PDFs.

use std::sync::Arc;

use super::{
    provider::{OcrProviderTrait, OllamaProvider},
    types::{OcrError, OcrProvider, OcrRect, OcrResult},
};

/// OCR service configuration
pub struct OcrServiceConfig {
    /// Preferred provider order
    pub providers: Vec<OcrProvider>,
    /// Ollama base URL
    pub ollama_url: String,
    /// Ollama model name
    pub ollama_model: String,
    /// Default OCR language
    pub default_language: String,
}

impl Default for OcrServiceConfig {
    fn default() -> Self {
        Self {
            providers: vec![OcrProvider::Tesseract, OcrProvider::Ollama],
            ollama_url: "http://localhost:11434".to_string(),
            ollama_model: "llava".to_string(),
            default_language: "eng".to_string(),
        }
    }
}

/// OCR service for processing scanned PDF pages
pub struct OcrService {
    config: OcrServiceConfig,
    providers: Vec<Arc<dyn OcrProviderTrait>>,
}

impl OcrService {
    /// Create a new OCR service
    pub fn new(config: OcrServiceConfig) -> Self {
        let mut providers: Vec<Arc<dyn OcrProviderTrait>> = Vec::new();

        // Add Tesseract provider if feature is enabled
        #[cfg(feature = "ocr-tesseract")]
        {
            use super::provider::TesseractProvider;
            if config.providers.contains(&OcrProvider::Tesseract) {
                providers.push(Arc::new(TesseractProvider::new(&config.default_language)));
            }
        }

        // Add Ollama provider
        if config.providers.contains(&OcrProvider::Ollama) {
            providers.push(Arc::new(OllamaProvider::new(
                &config.ollama_url,
                &config.ollama_model,
            )));
        }

        Self { config, providers }
    }

    /// Get available providers
    pub async fn available_providers(&self) -> Vec<OcrProvider> {
        let mut available = Vec::new();
        for provider in &self.providers {
            if provider.is_available().await {
                available.push(provider.provider_type());
            }
        }
        available
    }

    /// Perform OCR on an image region
    pub async fn recognize(
        &self,
        image_data: &[u8],
        preferred_provider: Option<OcrProvider>,
        language: Option<&str>,
    ) -> Result<OcrResult, OcrError> {
        let lang = language.unwrap_or(&self.config.default_language);

        // If a specific provider is requested, try it first
        if let Some(preferred) = preferred_provider {
            for provider in &self.providers {
                if provider.provider_type() == preferred {
                    if provider.is_available().await {
                        return provider.recognize(image_data, Some(lang)).await;
                    } else {
                        return Err(OcrError::ProviderNotAvailable(format!(
                            "{:?} provider is not available",
                            preferred
                        )));
                    }
                }
            }
            return Err(OcrError::ProviderNotAvailable(format!(
                "{:?} provider is not configured",
                preferred
            )));
        }

        // Try providers in order
        for provider in &self.providers {
            if provider.is_available().await {
                match provider.recognize(image_data, Some(lang)).await {
                    Ok(result) => return Ok(result),
                    Err(e) => {
                        tracing::warn!(
                            "OCR provider {:?} failed: {}, trying next",
                            provider.provider_type(),
                            e
                        );
                        continue;
                    }
                }
            }
        }

        Err(OcrError::ProviderNotAvailable(
            "No OCR providers available".to_string(),
        ))
    }

    /// Extract and OCR a region from a PDF page
    pub async fn ocr_pdf_region(
        &self,
        pdf_id: &str,
        page: usize,
        rect: &OcrRect,
        provider: Option<OcrProvider>,
        language: Option<&str>,
        pdf_cache: &crate::pdf::PdfCache,
    ) -> Result<OcrResult, OcrError> {
        // Validate rect
        if rect.x < 0.0
            || rect.y < 0.0
            || rect.width <= 0.0
            || rect.height <= 0.0
            || rect.x + rect.width > 1.0
            || rect.y + rect.height > 1.0
        {
            return Err(OcrError::InvalidRegion(
                "Region must be within 0-1 normalized coordinates".to_string(),
            ));
        }

        // Render the page at high resolution for OCR
        let render_request = crate::pdf::PageRenderRequest {
            page,
            scale: 2.0, // Higher resolution for better OCR
            rotation: 0,
            format: crate::pdf::ImageFormat::Png,
        };

        let page_image = pdf_cache
            .render_page(pdf_id, &render_request)
            .await
            .map_err(|e| {
                OcrError::ImageExtractionError(format!(
                    "Failed to render page {} for PDF {}: {}",
                    page, pdf_id, e
                ))
            })?;

        // Decode image to extract region
        let img = image::load_from_memory(&page_image)
            .map_err(|e| OcrError::ImageExtractionError(format!("Failed to decode page image: {}", e)))?;

        let (width, height) = (img.width(), img.height());
        let pixel_rect = rect.to_pixels(width, height);

        // Crop to region
        let cropped = img.crop_imm(
            pixel_rect.x,
            pixel_rect.y,
            pixel_rect.width,
            pixel_rect.height,
        );

        // Encode cropped region as PNG
        let mut buffer = Vec::new();
        cropped
            .write_to(
                &mut std::io::Cursor::new(&mut buffer),
                image::ImageFormat::Png,
            )
            .map_err(|e| OcrError::ImageExtractionError(format!("Failed to encode region: {}", e)))?;

        // Perform OCR
        self.recognize(&buffer, provider, language).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_ocr_service_creation() {
        let config = OcrServiceConfig::default();
        let service = OcrService::new(config);

        // Service should be created successfully
        assert!(service.providers.len() <= 2); // Tesseract might not be enabled
    }

    #[tokio::test]
    async fn test_invalid_rect_validation() {
        let config = OcrServiceConfig::default();
        let service = OcrService::new(config);

        let invalid_rect = OcrRect {
            x: 0.5,
            y: 0.5,
            width: 0.6, // Would exceed 1.0
            height: 0.3,
        };

        let cache = crate::pdf::PdfCache::with_capacity(10);
        let result = service
            .ocr_pdf_region("test", 1, &invalid_rect, None, None, &cache)
            .await;

        assert!(matches!(result, Err(OcrError::InvalidRegion(_))));
    }
}
