//! Los Libros Server
//!
//! A self-hosted ebook server with native S3 support, OPDS catalog generation,
//! and multi-device reading progress sync.

use axum::{
    routing::get,
    Router,
    Json,
    extract::State,
};
use serde::Serialize;
use std::net::SocketAddr;
use tokio::signal;
use tower_http::cors::{CorsLayer, Any};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod annotations;
mod cfi;
mod config;
mod db;
mod epub;
mod error;
mod html;
mod library;
mod ocr;
mod opds;
mod pdf;
mod routes;
mod state;
mod storage;
mod sync;

use config::Config;
use library::LibraryScanner;
use routes::opds::LibraryCache;
use state::AppState;
use storage::S3Client;

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

async fn health_check(State(_state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "los_libros_server=debug,tower_http=debug".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load configuration
    dotenvy::dotenv().ok();

    let config = Config::from_env().unwrap_or_else(|e| {
        tracing::warn!("Failed to load config from env: {}, using defaults", e);
        Config::default()
    });

    tracing::info!("Starting Los Libros Server v{}", env!("CARGO_PKG_VERSION"));
    tracing::info!("S3 endpoint: {}", config.storage.endpoint);
    tracing::info!("S3 bucket: {}", config.storage.bucket);

    // Initialize S3 client
    let s3_client = S3Client::new(&config.storage)
        .await
        .expect("Failed to initialize S3 client");

    // Initialize database
    let db_pool = db::create_pool(&config.database.url)
        .await
        .expect("Failed to initialize database");
    tracing::info!("Database initialized at {}", config.database.url);

    // Create application state
    let app_state = AppState::new(config.clone(), s3_client.clone(), db_pool.clone()).await;

    // Create library cache and initial scan
    let library_cache = LibraryCache::new();
    let scanner = LibraryScanner::new(s3_client);
    if let Err(e) = library_cache.refresh(&scanner).await {
        tracing::warn!("Initial library scan failed: {}. Will retry on /opds/refresh", e);
    } else {
        let count = library_cache.get_books().await.len();
        tracing::info!("Library initialized with {} books", count);
    }

    // Build CORS layer
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build router
    let app = Router::new()
        .route("/health", get(health_check))
        .route("/api/v1/health", get(health_check))
        .nest("/api/v1/books", routes::books::router())
        .nest("/api/v1/pdf", routes::pdf::router())
        .nest("/opds", routes::opds::router(library_cache))
        .nest("/files", routes::files::router())
        .nest("/api/v1/progress", routes::progress::router(db_pool.clone()))
        .nest("/api/v1/highlights", routes::highlights::router(db_pool.clone()))
        .nest("/api/v1/annotations", routes::annotations::router())
        .nest("/api/v1/sync", routes::sync::router())
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(app_state);

    // Start server with graceful shutdown
    let addr = SocketAddr::from(([0, 0, 0, 0], config.server.port));
    tracing::info!("Los Libros Server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();

    tracing::info!("Server shutdown complete");
}

/// Graceful shutdown signal handler
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            tracing::info!("Received Ctrl+C, starting graceful shutdown...");
        },
        _ = terminate => {
            tracing::info!("Received SIGTERM, starting graceful shutdown...");
        },
    }
}
