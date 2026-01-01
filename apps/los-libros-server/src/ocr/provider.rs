//! OCR Providers
//!
//! Defines the provider trait and implementations for different OCR backends.

use async_trait::async_trait;

use super::types::{OcrError, OcrProvider, OcrResult};

/// OCR provider trait
#[async_trait]
pub trait OcrProviderTrait: Send + Sync {
    /// Get the provider type
    fn provider_type(&self) -> OcrProvider;

    /// Check if the provider is available
    async fn is_available(&self) -> bool;

    /// Perform OCR on an image
    async fn recognize(&self, image_data: &[u8], language: Option<&str>) -> Result<OcrResult, OcrError>;
}

/// Tesseract OCR provider
#[cfg(feature = "ocr-tesseract")]
pub struct TesseractProvider {
    /// Default language
    default_language: String,
}

#[cfg(feature = "ocr-tesseract")]
impl TesseractProvider {
    pub fn new(default_language: &str) -> Self {
        Self {
            default_language: default_language.to_string(),
        }
    }
}

#[cfg(feature = "ocr-tesseract")]
#[async_trait]
impl OcrProviderTrait for TesseractProvider {
    fn provider_type(&self) -> OcrProvider {
        OcrProvider::Tesseract
    }

    async fn is_available(&self) -> bool {
        // Check if tesseract is installed
        std::process::Command::new("tesseract")
            .arg("--version")
            .output()
            .is_ok()
    }

    async fn recognize(&self, image_data: &[u8], language: Option<&str>) -> Result<OcrResult, OcrError> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let lang = language.unwrap_or(&self.default_language);

        // Create temporary file for image
        let temp_dir = std::env::temp_dir();
        let input_path = temp_dir.join(format!("ocr_input_{}.png", uuid::Uuid::new_v4()));
        let output_path = temp_dir.join(format!("ocr_output_{}", uuid::Uuid::new_v4()));

        // Write image to temp file
        std::fs::write(&input_path, image_data)
            .map_err(|e| OcrError::ProcessingError(format!("Failed to write temp file: {}", e)))?;

        // Run tesseract
        let output = Command::new("tesseract")
            .arg(&input_path)
            .arg(&output_path)
            .arg("-l")
            .arg(lang)
            .arg("--oem")
            .arg("3")
            .arg("--psm")
            .arg("3")
            .output()
            .map_err(|e| OcrError::ProcessingError(format!("Failed to run tesseract: {}", e)))?;

        // Clean up input file
        let _ = std::fs::remove_file(&input_path);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(OcrError::ProcessingError(format!(
                "Tesseract failed: {}",
                stderr
            )));
        }

        // Read output
        let output_file = format!("{}.txt", output_path.display());
        let text = std::fs::read_to_string(&output_file)
            .map_err(|e| OcrError::ProcessingError(format!("Failed to read output: {}", e)))?;

        // Clean up output file
        let _ = std::fs::remove_file(&output_file);

        Ok(OcrResult {
            text: text.trim().to_string(),
            confidence: 80.0, // Tesseract doesn't always provide confidence
            provider: OcrProvider::Tesseract,
            words: None, // Could parse HOCR output for word-level results
        })
    }
}

/// Ollama vision model provider
pub struct OllamaProvider {
    /// Ollama API URL
    base_url: String,
    /// Model name (e.g., "llava", "bakllava")
    model: String,
}

impl OllamaProvider {
    pub fn new(base_url: &str, model: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            model: model.to_string(),
        }
    }

    pub fn default_url() -> Self {
        Self::new("http://localhost:11434", "llava")
    }
}

#[async_trait]
impl OcrProviderTrait for OllamaProvider {
    fn provider_type(&self) -> OcrProvider {
        OcrProvider::Ollama
    }

    async fn is_available(&self) -> bool {
        // Check if Ollama is running
        let client = reqwest::Client::new();
        let url = format!("{}/api/tags", self.base_url);

        match client.get(&url).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    async fn recognize(&self, image_data: &[u8], language: Option<&str>) -> Result<OcrResult, OcrError> {
        use base64::Engine;

        let client = reqwest::Client::new();
        let url = format!("{}/api/generate", self.base_url);

        // Encode image as base64
        let image_base64 = base64::engine::general_purpose::STANDARD.encode(image_data);

        // Build prompt
        let lang_hint = language
            .map(|l| format!(" The text is in {}.", l))
            .unwrap_or_default();

        let prompt = format!(
            "Extract all text from this image exactly as written.{} Return only the extracted text, nothing else.",
            lang_hint
        );

        // Build request
        let request = serde_json::json!({
            "model": self.model,
            "prompt": prompt,
            "images": [image_base64],
            "stream": false
        });

        // Send request
        let response = client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| OcrError::ApiError(format!("Failed to call Ollama: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(OcrError::ApiError(format!(
                "Ollama returned {}: {}",
                status, body
            )));
        }

        // Parse response
        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| OcrError::ApiError(format!("Failed to parse response: {}", e)))?;

        let text = result["response"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();

        Ok(OcrResult {
            text,
            confidence: 75.0, // LLMs don't provide confidence scores
            provider: OcrProvider::Ollama,
            words: None,
        })
    }
}

/// Mock provider for testing
#[cfg(test)]
pub struct MockProvider {
    pub response: OcrResult,
    pub available: bool,
}

#[cfg(test)]
#[async_trait]
impl OcrProviderTrait for MockProvider {
    fn provider_type(&self) -> OcrProvider {
        self.response.provider
    }

    async fn is_available(&self) -> bool {
        self.available
    }

    async fn recognize(&self, _image_data: &[u8], _language: Option<&str>) -> Result<OcrResult, OcrError> {
        Ok(self.response.clone())
    }
}
