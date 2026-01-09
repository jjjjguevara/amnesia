//! Memory Usage Benchmarks
//!
//! Tests memory consumption when loading multiple documents.
//!
//! Target from MuPDF Migration Remediation Plan:
//! - Memory (50 docs): <50MB
//!
//! Run with: `cargo bench --bench memory_usage`
//!
//! Note: This benchmark measures RSS (Resident Set Size) which includes
//! all memory used by the process, not just document data.

use criterion::{criterion_group, criterion_main, Criterion};
use std::io::{Cursor, Write};
use std::time::Duration;

use amnesia_server::formats::epub::EpubDocumentHandler;
use amnesia_server::pdf::PdfParser;

/// Get current process memory usage in bytes (RSS)
fn get_memory_usage() -> usize {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let output = Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .expect("Failed to execute ps");
        let rss_kb: usize = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .unwrap_or(0);
        rss_kb * 1024 // Convert KB to bytes
    }

    #[cfg(target_os = "linux")]
    {
        use std::fs;
        let status = fs::read_to_string("/proc/self/status").unwrap_or_default();
        for line in status.lines() {
            if line.starts_with("VmRSS:") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let rss_kb: usize = parts[1].parse().unwrap_or(0);
                    return rss_kb * 1024;
                }
            }
        }
        0
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        0 // Memory measurement not supported on this platform
    }
}

/// Create a minimal PDF for memory testing
fn create_minimal_pdf() -> Vec<u8> {
    let pdf_content = b"%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>
endobj
4 0 obj
<< /Length 0 >>
stream
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000226 00000 n
trailer
<< /Size 5 /Root 1 0 R >>
startxref
276
%%EOF";
    pdf_content.to_vec()
}

/// Create a minimal EPUB for memory testing
fn create_minimal_epub() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, ZipWriter};

    let mut buffer = Vec::new();
    {
        let cursor = Cursor::new(&mut buffer);
        let mut zip = ZipWriter::new(cursor);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

        zip.start_file("mimetype", options).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();

        zip.start_file("META-INF/container.xml", options).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        )
        .unwrap();

        zip.start_file("OEBPS/content.opf", options).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">memory-test-epub</dc:identifier>
    <dc:title>Memory Test EPUB</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>"#,
        )
        .unwrap();

        zip.start_file("OEBPS/chapter1.xhtml", options).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
<h1>Chapter 1</h1>
<p>This is test content for memory benchmarking.</p>
</body>
</html>"#,
        )
        .unwrap();

        zip.finish().unwrap();
    }
    buffer
}

/// Benchmark memory usage when loading 50 PDF documents
fn bench_memory_50_pdfs(c: &mut Criterion) {
    let pdf_data = create_minimal_pdf();

    let mut group = c.benchmark_group("memory_usage");
    group.measurement_time(Duration::from_secs(30));
    group.sample_size(10);

    group.bench_function("load_50_pdfs", |b| {
        b.iter_custom(|iters| {
            let mut total_duration = std::time::Duration::ZERO;

            for _ in 0..iters {
                // Measure baseline memory
                let baseline = get_memory_usage();

                let start = std::time::Instant::now();

                // Load 50 PDF documents
                let parsers: Vec<_> = (0..50)
                    .map(|i| {
                        PdfParser::from_bytes(&pdf_data, format!("memory-test-pdf-{}", i))
                            .expect("Failed to create PDF parser")
                    })
                    .collect();

                // Parse all documents
                let _parsed: Vec<_> = parsers
                    .iter()
                    .map(|p| p.parse().expect("Failed to parse PDF"))
                    .collect();

                total_duration += start.elapsed();

                // Measure memory after loading
                let after = get_memory_usage();
                let memory_used = after.saturating_sub(baseline);

                // Log memory usage (visible in benchmark output)
                if memory_used > 0 {
                    let memory_mb = memory_used as f64 / (1024.0 * 1024.0);
                    eprintln!("Memory used for 50 PDFs: {:.2} MB", memory_mb);

                    // Target: <50MB for 50 docs
                    if memory_mb > 50.0 {
                        eprintln!("WARNING: Memory usage exceeds 50MB target!");
                    }
                }

                // Keep parsers alive until measurement is complete
                drop(_parsed);
                drop(parsers);
            }

            total_duration
        })
    });

    group.finish();
}

/// Benchmark memory usage when loading 50 EPUB documents
fn bench_memory_50_epubs(c: &mut Criterion) {
    let epub_data = create_minimal_epub();

    let mut group = c.benchmark_group("memory_usage");
    group.measurement_time(Duration::from_secs(30));
    group.sample_size(10);

    group.bench_function("load_50_epubs", |b| {
        b.iter_custom(|iters| {
            let mut total_duration = std::time::Duration::ZERO;

            for _ in 0..iters {
                let baseline = get_memory_usage();

                let start = std::time::Instant::now();

                // Load 50 EPUB documents
                let handlers: Vec<_> = (0..50)
                    .map(|i| {
                        EpubDocumentHandler::from_bytes(
                            epub_data.clone(),
                            format!("memory-test-epub-{}", i),
                        )
                        .expect("Failed to create EPUB handler")
                    })
                    .collect();

                total_duration += start.elapsed();

                let after = get_memory_usage();
                let memory_used = after.saturating_sub(baseline);

                if memory_used > 0 {
                    let memory_mb = memory_used as f64 / (1024.0 * 1024.0);
                    eprintln!("Memory used for 50 EPUBs: {:.2} MB", memory_mb);

                    if memory_mb > 50.0 {
                        eprintln!("WARNING: Memory usage exceeds 50MB target!");
                    }
                }

                drop(handlers);
            }

            total_duration
        })
    });

    group.finish();
}

/// Benchmark memory usage with mixed document types
fn bench_memory_mixed_docs(c: &mut Criterion) {
    let pdf_data = create_minimal_pdf();
    let epub_data = create_minimal_epub();

    let mut group = c.benchmark_group("memory_usage");
    group.measurement_time(Duration::from_secs(30));
    group.sample_size(10);

    group.bench_function("load_25_pdfs_25_epubs", |b| {
        b.iter_custom(|iters| {
            let mut total_duration = std::time::Duration::ZERO;

            for _ in 0..iters {
                let baseline = get_memory_usage();

                let start = std::time::Instant::now();

                // Load 25 PDFs
                let pdf_parsers: Vec<_> = (0..25)
                    .map(|i| {
                        PdfParser::from_bytes(&pdf_data, format!("memory-test-pdf-{}", i))
                            .expect("Failed to create PDF parser")
                    })
                    .collect();

                // Load 25 EPUBs
                let epub_handlers: Vec<_> = (0..25)
                    .map(|i| {
                        EpubDocumentHandler::from_bytes(
                            epub_data.clone(),
                            format!("memory-test-epub-{}", i),
                        )
                        .expect("Failed to create EPUB handler")
                    })
                    .collect();

                total_duration += start.elapsed();

                let after = get_memory_usage();
                let memory_used = after.saturating_sub(baseline);

                if memory_used > 0 {
                    let memory_mb = memory_used as f64 / (1024.0 * 1024.0);
                    eprintln!("Memory used for 25 PDFs + 25 EPUBs: {:.2} MB", memory_mb);

                    if memory_mb > 50.0 {
                        eprintln!("WARNING: Memory usage exceeds 50MB target!");
                    }
                }

                drop(pdf_parsers);
                drop(epub_handlers);
            }

            total_duration
        })
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_memory_50_pdfs,
    bench_memory_50_epubs,
    bench_memory_mixed_docs
);
criterion_main!(benches);
