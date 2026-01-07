//! PDF Service - Actor Pattern for PDFium
//!
//! This module implements the Actor pattern to properly manage PDFium's lifecycle.
//! PDFium has global C++ state that gets corrupted when FPDF_InitLibrary/FPDF_DestroyLibrary
//! are called multiple times. This actor ensures:
//!
//! 1. PDFium is initialized ONCE at startup
//! 2. All PDF operations happen on the SAME dedicated OS thread (thread affinity)
//! 3. PDFium is only destroyed at server shutdown
//!
//! The key insight is that tokio::spawn_blocking reuses threads from a pool,
//! which causes issues with PDFium's global state. By using std::thread::spawn,
//! we create a dedicated thread that lives for the entire server lifetime.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use pdfium_render::prelude::*;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

use super::parser::{PdfParseError, PdfParser};
use super::types::{
    PageDimensions, PageRenderRequest, ParsedPdf, PdfSearchResult, TextLayer,
};

/// Errors from the PDF service
#[derive(Error, Debug)]
pub enum PdfServiceError {
    #[error("Failed to initialize PDFium: {0}")]
    InitError(String),
    #[error("PDF service actor has stopped")]
    ActorStopped,
    #[error("Failed to send job to actor: {0}")]
    SendError(String),
    #[error("Failed to receive response from actor: {0}")]
    RecvError(String),
    #[error("PDF parse error: {0}")]
    ParseError(#[from] PdfParseError),
}

/// Jobs that can be sent to the PDF actor
enum PdfJob {
    /// Parse a PDF from bytes
    ParseFromBytes {
        data: Vec<u8>,
        book_id: String,
        response: oneshot::Sender<Result<ParsedPdf, PdfParseError>>,
    },
    /// Parse a PDF from a file path
    ParseFromPath {
        path: PathBuf,
        book_id: String,
        response: oneshot::Sender<Result<ParsedPdf, PdfParseError>>,
    },
    /// Render a page to image bytes
    RenderPage {
        book_id: String,
        request: PageRenderRequest,
        response: oneshot::Sender<Result<Vec<u8>, PdfParseError>>,
    },
    /// Render a thumbnail
    RenderThumbnail {
        book_id: String,
        page: usize,
        max_size: u32,
        response: oneshot::Sender<Result<Vec<u8>, PdfParseError>>,
    },
    /// Get text layer for a page
    GetTextLayer {
        book_id: String,
        page: usize,
        response: oneshot::Sender<Result<TextLayer, PdfParseError>>,
    },
    /// Search PDF content
    Search {
        book_id: String,
        query: String,
        limit: usize,
        response: oneshot::Sender<Result<Vec<PdfSearchResult>, PdfParseError>>,
    },
    /// Get page text
    GetPageText {
        book_id: String,
        page: usize,
        response: oneshot::Sender<Result<String, PdfParseError>>,
    },
    /// Get page dimensions
    GetPageDimensions {
        book_id: String,
        page: usize,
        response: oneshot::Sender<Result<PageDimensions, PdfParseError>>,
    },
    /// Check if a PDF is loaded
    HasPdf {
        book_id: String,
        response: oneshot::Sender<bool>,
    },
    /// Remove a PDF from memory
    RemovePdf {
        book_id: String,
        response: oneshot::Sender<()>,
    },
    /// Get list of loaded PDF IDs
    ListPdfs {
        response: oneshot::Sender<Vec<String>>,
    },
    /// Shutdown the actor
    Shutdown {
        response: oneshot::Sender<()>,
    },
}

/// Handle to the PDF service actor
///
/// This is cloneable and can be shared across handlers.
/// All operations are sent to the dedicated actor thread via channels.
#[derive(Clone)]
pub struct PdfService {
    job_tx: mpsc::UnboundedSender<PdfJob>,
}

impl PdfService {
    /// Start the PDF service actor
    ///
    /// This spawns a dedicated OS thread that:
    /// 1. Initializes PDFium ONCE
    /// 2. Processes all PDF jobs serially
    /// 3. Never destroys PDFium until shutdown
    pub fn start() -> Result<Self, PdfServiceError> {
        let (job_tx, job_rx) = mpsc::unbounded_channel();

        // Spawn the actor on a dedicated OS thread (NOT tokio's thread pool)
        // This is critical: tokio's spawn_blocking reuses threads, which causes
        // PDFium's global state to get corrupted
        thread::spawn(move || {
            // Create tokio runtime for this thread to receive from async channels
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create tokio runtime for PDF actor");

            rt.block_on(async move {
                match PdfActor::new(job_rx) {
                    Ok(actor) => {
                        tracing::info!("PDF service actor started successfully");
                        actor.run().await;
                        tracing::info!("PDF service actor stopped");
                    }
                    Err(e) => {
                        tracing::error!("Failed to initialize PDF actor: {}", e);
                    }
                }
            });
        });

        Ok(Self { job_tx })
    }

    /// Parse a PDF from bytes
    pub async fn parse_from_bytes(
        &self,
        data: Vec<u8>,
        book_id: String,
    ) -> Result<ParsedPdf, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::ParseFromBytes {
                data,
                book_id,
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))?
            .map_err(PdfServiceError::ParseError)
    }

    /// Parse a PDF from a file path
    pub async fn parse_from_path(
        &self,
        path: PathBuf,
        book_id: String,
    ) -> Result<ParsedPdf, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::ParseFromPath {
                path,
                book_id,
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))?
            .map_err(PdfServiceError::ParseError)
    }

    /// Render a page to image bytes
    pub async fn render_page(
        &self,
        book_id: &str,
        request: PageRenderRequest,
    ) -> Result<Vec<u8>, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::RenderPage {
                book_id: book_id.to_string(),
                request,
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))?
            .map_err(PdfServiceError::ParseError)
    }

    /// Render a thumbnail
    pub async fn render_thumbnail(
        &self,
        book_id: &str,
        page: usize,
        max_size: u32,
    ) -> Result<Vec<u8>, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::RenderThumbnail {
                book_id: book_id.to_string(),
                page,
                max_size,
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))?
            .map_err(PdfServiceError::ParseError)
    }

    /// Get text layer for a page
    pub async fn get_text_layer(
        &self,
        book_id: &str,
        page: usize,
    ) -> Result<TextLayer, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::GetTextLayer {
                book_id: book_id.to_string(),
                page,
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))?
            .map_err(PdfServiceError::ParseError)
    }

    /// Search PDF content
    pub async fn search(
        &self,
        book_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<PdfSearchResult>, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::Search {
                book_id: book_id.to_string(),
                query: query.to_string(),
                limit,
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))?
            .map_err(PdfServiceError::ParseError)
    }

    /// Get page text
    pub async fn get_page_text(
        &self,
        book_id: &str,
        page: usize,
    ) -> Result<String, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::GetPageText {
                book_id: book_id.to_string(),
                page,
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))?
            .map_err(PdfServiceError::ParseError)
    }

    /// Get page dimensions
    pub async fn get_page_dimensions(
        &self,
        book_id: &str,
        page: usize,
    ) -> Result<PageDimensions, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::GetPageDimensions {
                book_id: book_id.to_string(),
                page,
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))?
            .map_err(PdfServiceError::ParseError)
    }

    /// Check if a PDF is loaded
    pub async fn has_pdf(&self, book_id: &str) -> Result<bool, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::HasPdf {
                book_id: book_id.to_string(),
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))
    }

    /// Remove a PDF from memory
    pub async fn remove_pdf(&self, book_id: &str) -> Result<(), PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::RemovePdf {
                book_id: book_id.to_string(),
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))
    }

    /// Get list of loaded PDF IDs
    pub async fn list_pdfs(&self) -> Result<Vec<String>, PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::ListPdfs {
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))
    }

    /// Shutdown the PDF service actor
    ///
    /// This will:
    /// 1. Stop accepting new jobs
    /// 2. Wait for the current job to complete
    /// 3. Drop PDFium (calling FPDF_DestroyLibrary)
    /// 4. Terminate the actor thread
    pub async fn shutdown(&self) -> Result<(), PdfServiceError> {
        let (response_tx, response_rx) = oneshot::channel();

        self.job_tx
            .send(PdfJob::Shutdown {
                response: response_tx,
            })
            .map_err(|e| PdfServiceError::SendError(e.to_string()))?;

        response_rx
            .await
            .map_err(|e| PdfServiceError::RecvError(e.to_string()))
    }
}

/// The PDF actor that runs on a dedicated thread
struct PdfActor {
    /// The PDFium library instance - initialized ONCE, never destroyed until shutdown
    pdfium: Arc<Pdfium>,
    /// Loaded PDF parsers, keyed by book_id
    parsers: HashMap<String, PdfParser>,
    /// Parsed PDF metadata, keyed by book_id
    pdfs: HashMap<String, ParsedPdf>,
    /// Channel to receive jobs
    job_rx: mpsc::UnboundedReceiver<PdfJob>,
}

impl PdfActor {
    /// Create a new PDF actor
    ///
    /// This initializes PDFium ONCE. The actor holds the Pdfium instance
    /// for its entire lifetime, ensuring FPDF_InitLibrary is only called once.
    fn new(job_rx: mpsc::UnboundedReceiver<PdfJob>) -> Result<Self, PdfServiceError> {
        // Initialize PDFium - this calls FPDF_InitLibrary internally
        // We try multiple paths to find the library
        let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
            .or_else(|_| {
                Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("/usr/lib"))
            })
            .or_else(|_| {
                Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(
                    "/usr/local/lib",
                ))
            })
            .or_else(|_| Pdfium::bind_to_system_library())
            .map_err(|e| PdfServiceError::InitError(e.to_string()))?;

        let pdfium = Arc::new(Pdfium::new(bindings));

        Ok(Self {
            pdfium,
            parsers: HashMap::new(),
            pdfs: HashMap::new(),
            job_rx,
        })
    }

    /// Run the actor's main loop
    ///
    /// This loop processes jobs until a Shutdown job is received.
    /// All operations happen on this single thread, ensuring thread affinity.
    async fn run(mut self) {
        while let Some(job) = self.job_rx.recv().await {
            match job {
                PdfJob::ParseFromBytes {
                    data,
                    book_id,
                    response,
                } => {
                    let result = self.handle_parse_from_bytes(data, book_id);
                    let _ = response.send(result);
                }
                PdfJob::ParseFromPath {
                    path,
                    book_id,
                    response,
                } => {
                    let result = self.handle_parse_from_path(path, book_id);
                    let _ = response.send(result);
                }
                PdfJob::RenderPage {
                    book_id,
                    request,
                    response,
                } => {
                    let result = self.handle_render_page(&book_id, &request);
                    let _ = response.send(result);
                }
                PdfJob::RenderThumbnail {
                    book_id,
                    page,
                    max_size,
                    response,
                } => {
                    let result = self.handle_render_thumbnail(&book_id, page, max_size);
                    let _ = response.send(result);
                }
                PdfJob::GetTextLayer {
                    book_id,
                    page,
                    response,
                } => {
                    let result = self.handle_get_text_layer(&book_id, page);
                    let _ = response.send(result);
                }
                PdfJob::Search {
                    book_id,
                    query,
                    limit,
                    response,
                } => {
                    let result = self.handle_search(&book_id, &query, limit);
                    let _ = response.send(result);
                }
                PdfJob::GetPageText {
                    book_id,
                    page,
                    response,
                } => {
                    let result = self.handle_get_page_text(&book_id, page);
                    let _ = response.send(result);
                }
                PdfJob::GetPageDimensions {
                    book_id,
                    page,
                    response,
                } => {
                    let result = self.handle_get_page_dimensions(&book_id, page);
                    let _ = response.send(result);
                }
                PdfJob::HasPdf { book_id, response } => {
                    let result = self.parsers.contains_key(&book_id);
                    let _ = response.send(result);
                }
                PdfJob::RemovePdf { book_id, response } => {
                    self.parsers.remove(&book_id);
                    self.pdfs.remove(&book_id);
                    let _ = response.send(());
                }
                PdfJob::ListPdfs { response } => {
                    let ids: Vec<String> = self.parsers.keys().cloned().collect();
                    let _ = response.send(ids);
                }
                PdfJob::Shutdown { response } => {
                    tracing::info!("PDF actor received shutdown signal");
                    let _ = response.send(());
                    break;
                }
            }
        }

        // Actor loop ended - drop everything
        // This will drop self.pdfium, which calls FPDF_DestroyLibrary
        tracing::info!(
            "PDF actor shutting down, releasing {} parsers",
            self.parsers.len()
        );
    }

    /// Handle parsing a PDF from bytes
    fn handle_parse_from_bytes(
        &mut self,
        data: Vec<u8>,
        book_id: String,
    ) -> Result<ParsedPdf, PdfParseError> {
        // Create parser using our shared pdfium instance
        let parser = PdfParser::from_bytes_with_pdfium(&data, book_id.clone(), self.pdfium.clone())?;
        let pdf = parser.parse()?;

        // Store both parser and metadata
        self.parsers.insert(book_id.clone(), parser);
        self.pdfs.insert(book_id, pdf.clone());

        Ok(pdf)
    }

    /// Handle parsing a PDF from a file path
    fn handle_parse_from_path(
        &mut self,
        path: PathBuf,
        book_id: String,
    ) -> Result<ParsedPdf, PdfParseError> {
        // Create parser using our shared pdfium instance
        let parser = PdfParser::from_path_with_pdfium(&path, book_id.clone(), self.pdfium.clone())?;
        let pdf = parser.parse()?;

        // Store both parser and metadata
        self.parsers.insert(book_id.clone(), parser);
        self.pdfs.insert(book_id, pdf.clone());

        Ok(pdf)
    }

    /// Handle rendering a page
    fn handle_render_page(
        &self,
        book_id: &str,
        request: &PageRenderRequest,
    ) -> Result<Vec<u8>, PdfParseError> {
        let parser = self
            .parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not loaded", book_id)))?;

        parser.render_page(request)
    }

    /// Handle rendering a thumbnail
    fn handle_render_thumbnail(
        &self,
        book_id: &str,
        page: usize,
        max_size: u32,
    ) -> Result<Vec<u8>, PdfParseError> {
        let parser = self
            .parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not loaded", book_id)))?;

        parser.render_thumbnail(page, max_size)
    }

    /// Handle getting text layer
    fn handle_get_text_layer(&self, book_id: &str, page: usize) -> Result<TextLayer, PdfParseError> {
        let parser = self
            .parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not loaded", book_id)))?;

        parser.get_text_layer(page)
    }

    /// Handle search
    fn handle_search(
        &self,
        book_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<PdfSearchResult>, PdfParseError> {
        let parser = self
            .parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not loaded", book_id)))?;

        parser.search(query, limit)
    }

    /// Handle getting page text
    fn handle_get_page_text(&self, book_id: &str, page: usize) -> Result<String, PdfParseError> {
        let parser = self
            .parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not loaded", book_id)))?;

        parser.get_page_text(page)
    }

    /// Handle getting page dimensions
    fn handle_get_page_dimensions(
        &self,
        book_id: &str,
        page: usize,
    ) -> Result<PageDimensions, PdfParseError> {
        let parser = self
            .parsers
            .get(book_id)
            .ok_or_else(|| PdfParseError::LoadError(format!("PDF {} not loaded", book_id)))?;

        parser.get_page_dimensions(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_service_start() {
        // This test requires pdfium to be installed
        let result = PdfService::start();
        // Just check it doesn't panic on start
        if let Ok(service) = result {
            // Give the actor thread time to initialize
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            let _ = service.shutdown().await;
        }
    }
}
