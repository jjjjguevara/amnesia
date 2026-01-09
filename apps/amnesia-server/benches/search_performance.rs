//! Search Performance Benchmarks
//!
//! Performance benchmarks for document search operations.
//!
//! Targets from MuPDF Migration Remediation Plan:
//! - Search (100 pages): <500ms
//!
//! Run with: `cargo bench --bench search_performance`

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use std::time::Duration;

use amnesia_server::pdf::PdfParser;

/// Create a PDF with multiple pages containing searchable text
fn create_multipage_pdf(page_count: usize) -> Vec<u8> {
    // Build PDF with multiple pages
    let mut pdf = String::new();
    pdf.push_str("%PDF-1.4\n");

    // Catalog
    pdf.push_str("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    // Build page references
    let mut page_refs = String::new();
    for i in 0..page_count {
        if i > 0 {
            page_refs.push(' ');
        }
        page_refs.push_str(&format!("{} 0 R", 3 + i * 2));
    }

    // Pages object
    pdf.push_str(&format!(
        "2 0 obj\n<< /Type /Pages /Kids [{}] /Count {} >>\nendobj\n",
        page_refs, page_count
    ));

    // Generate pages with content
    let mut obj_num = 3;
    for i in 0..page_count {
        // Page object
        pdf.push_str(&format!(
            "{} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>\nendobj\n",
            obj_num, obj_num + 1
        ));

        // Content stream with searchable text
        let content = format!(
            "BT /F1 12 Tf 72 720 Td (Page {} - This is searchable content with keyword benchmark test) Tj ET",
            i + 1
        );
        let content_len = content.len();
        pdf.push_str(&format!(
            "{} 0 obj\n<< /Length {} >>\nstream\n{}\nendstream\nendobj\n",
            obj_num + 1,
            content_len,
            content
        ));

        obj_num += 2;
    }

    // Calculate xref positions (simplified - real implementation would need actual offsets)
    pdf.push_str("xref\n");
    pdf.push_str(&format!("0 {}\n", obj_num));
    pdf.push_str("0000000000 65535 f\n");

    // Placeholder xref entries (not accurate but sufficient for parsing test)
    let mut offset = 9; // After %PDF-1.4\n
    for i in 1..obj_num {
        pdf.push_str(&format!("{:010} 00000 n\n", offset));
        offset += 100 + (i * 10); // Rough estimate
    }

    pdf.push_str("trailer\n");
    pdf.push_str(&format!("<< /Size {} /Root 1 0 R >>\n", obj_num));
    pdf.push_str("startxref\n");
    pdf.push_str(&format!("{}\n", pdf.len() - 20)); // Approximate
    pdf.push_str("%%EOF");

    pdf.into_bytes()
}

/// Benchmark text search on a PDF
fn bench_pdf_search(c: &mut Criterion) {
    let mut group = c.benchmark_group("pdf_search");
    group.measurement_time(Duration::from_secs(10));
    group.sample_size(50);

    // Benchmark search on 100-page PDF per target requirement (<500ms)
    let pdf_data_100 = create_multipage_pdf(100);

    group.bench_function("search_100_pages", |b| {
        let parser =
            PdfParser::from_bytes(&pdf_data_100, "bench-search-100".to_string()).unwrap();

        b.iter(|| {
            let results = parser.search(black_box("benchmark"), 10);
            black_box(results)
        })
    });

    // Also benchmark single page for comparison
    let pdf_data_1 = create_minimal_pdf_with_text();

    group.bench_function("search_single_page", |b| {
        let parser =
            PdfParser::from_bytes(&pdf_data_1, "bench-search-1".to_string()).unwrap();

        b.iter(|| {
            let results = parser.search(black_box("benchmark"), 10);
            black_box(results)
        })
    });

    group.finish();
}

/// Create a minimal PDF with searchable text
fn create_minimal_pdf_with_text() -> Vec<u8> {
    let content = b"%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>
endobj
4 0 obj
<< /Length 89 >>
stream
BT
/F1 12 Tf
72 720 Td
(This is a benchmark test document with searchable text content) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000268 00000 n
trailer
<< /Size 5 /Root 1 0 R >>
startxref
408
%%EOF";
    content.to_vec()
}

/// Benchmark text extraction (used by search)
fn bench_text_extraction(c: &mut Criterion) {
    let pdf_data = create_minimal_pdf_with_text();

    let mut group = c.benchmark_group("text_extraction");
    group.measurement_time(Duration::from_secs(10));

    group.bench_function("extract_text_page_1", |b| {
        let parser =
            PdfParser::from_bytes(&pdf_data, "bench-text".to_string()).unwrap();

        b.iter(|| {
            // get_text_layer uses 1-indexed page numbers
            let text = parser.get_text_layer(black_box(1));
            black_box(text)
        })
    });

    group.finish();
}

criterion_group!(benches, bench_pdf_search, bench_text_extraction);
criterion_main!(benches);
