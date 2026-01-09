//! Document Parsing Benchmarks
//!
//! Performance benchmarks for PDF and EPUB document parsing.
//!
//! Targets from MuPDF Migration Remediation Plan:
//! - EPUB Parse (p50): <50ms
//! - PDF Parse (p50): <100ms
//!
//! Run with: `cargo bench --bench document_parsing`

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::time::Duration;

// Import the document parsing modules
use amnesia_server::document::DocumentFormat;
use amnesia_server::formats::epub::EpubDocumentHandler;
use amnesia_server::pdf::PdfParser;

/// Minimal valid PDF for benchmarking
/// This is a small PDF that MuPDF can parse
fn create_minimal_pdf() -> Vec<u8> {
    // Minimal PDF structure (empty page)
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

/// Minimal valid EPUB for benchmarking (ZIP with required structure)
fn create_minimal_epub() -> Vec<u8> {
    use std::io::{Cursor, Write};
    use zip::{write::SimpleFileOptions, ZipWriter};

    let mut buffer = Vec::new();
    {
        let cursor = Cursor::new(&mut buffer);
        let mut zip = ZipWriter::new(cursor);
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

        // mimetype (must be first, uncompressed)
        zip.start_file("mimetype", options).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();

        // META-INF/container.xml
        zip.start_file("META-INF/container.xml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#).unwrap();

        // OEBPS/content.opf
        zip.start_file("OEBPS/content.opf", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">benchmark-epub-001</dc:identifier>
    <dc:title>Benchmark EPUB</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>"#).unwrap();

        // OEBPS/chapter1.xhtml
        zip.start_file("OEBPS/chapter1.xhtml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
<h1>Chapter 1</h1>
<p>This is a benchmark chapter for testing EPUB parsing performance.</p>
</body>
</html>"#).unwrap();

        // OEBPS/nav.xhtml
        zip.start_file("OEBPS/nav.xhtml", options).unwrap();
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Navigation</title></head>
<body>
<nav epub:type="toc">
<ol><li><a href="chapter1.xhtml">Chapter 1</a></li></ol>
</nav>
</body>
</html>"#).unwrap();

        zip.finish().unwrap();
    }
    buffer
}

/// Benchmark PDF parsing
fn bench_pdf_parsing(c: &mut Criterion) {
    let pdf_data = create_minimal_pdf();
    let pdf_size = pdf_data.len();

    let mut group = c.benchmark_group("pdf_parsing");
    group.throughput(Throughput::Bytes(pdf_size as u64));
    group.measurement_time(Duration::from_secs(10));

    group.bench_with_input(
        BenchmarkId::new("minimal_pdf", pdf_size),
        &pdf_data,
        |b, data| {
            b.iter(|| {
                let parser = PdfParser::from_bytes(black_box(data.as_slice()), "bench-pdf".to_string())
                    .expect("Failed to create parser");
                let parsed = parser.parse().expect("Failed to parse PDF");
                black_box(parsed)
            })
        },
    );

    group.finish();
}

/// Benchmark EPUB parsing
fn bench_epub_parsing(c: &mut Criterion) {
    let epub_data = create_minimal_epub();
    let epub_size = epub_data.len();

    let mut group = c.benchmark_group("epub_parsing");
    group.throughput(Throughput::Bytes(epub_size as u64));
    group.measurement_time(Duration::from_secs(10));

    group.bench_with_input(
        BenchmarkId::new("minimal_epub", epub_size),
        &epub_data,
        |b, data| {
            b.iter(|| {
                // EpubDocumentHandler::from_bytes performs initial layout
                // and caches page count, so this benchmarks the full parse
                let handler = EpubDocumentHandler::from_bytes(
                    black_box(data.clone()),
                    "bench-epub".to_string(),
                )
                .expect("Failed to create handler");
                // Construction includes layout - just consume the handler
                black_box(handler)
            })
        },
    );

    group.finish();
}

/// Benchmark format detection from magic bytes
fn bench_format_detection(c: &mut Criterion) {
    let pdf_data = create_minimal_pdf();
    let epub_data = create_minimal_epub();

    let mut group = c.benchmark_group("format_detection");

    group.bench_function("pdf_magic_bytes", |b| {
        b.iter(|| {
            let format = DocumentFormat::from_magic_bytes(black_box(&pdf_data));
            black_box(format)
        })
    });

    group.bench_function("epub_magic_bytes", |b| {
        b.iter(|| {
            let format = DocumentFormat::from_magic_bytes(black_box(&epub_data));
            black_box(format)
        })
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_pdf_parsing,
    bench_epub_parsing,
    bench_format_detection
);
criterion_main!(benches);
