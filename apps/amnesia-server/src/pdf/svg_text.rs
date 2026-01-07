//! SVG Text Layer Generator
//!
//! Converts PDF text layer data to SVG format for crisp text rendering at any zoom level.
//! The SVG contains transparent text elements positioned to match the PDF layout,
//! enabling text selection while the raster image provides the visual background.

use super::types::TextLayer;

/// Sanitize text for XML/SVG by removing control characters.
/// XML 1.0 only allows: #x9 (tab), #xA (newline), #xD (carriage return), and chars >= #x20.
/// Control characters (ASCII 0-31 except tab/newline/CR) cause XML parse errors.
fn sanitize_for_xml(text: &str) -> String {
    text.chars()
        .filter(|&c| {
            // Allow tab (9), newline (10), carriage return (13), and all chars >= 32
            c == '\t' || c == '\n' || c == '\r' || c >= ' '
        })
        .collect()
}

/// Generate an SVG document from a text layer
///
/// The SVG contains:
/// - A viewBox matching the PDF page dimensions (in points)
/// - Transparent text elements positioned at their original PDF coordinates
/// - Text is selectable but invisible (rendered over the raster image)
///
/// # Arguments
/// * `text_layer` - The text layer data from PDF parsing
///
/// # Returns
/// An SVG document as a String
pub fn generate_svg(text_layer: &TextLayer) -> String {
    let mut svg = String::with_capacity(text_layer.items.len() * 200);

    // SVG header with viewBox matching PDF page dimensions
    svg.push_str(&format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {} {}" preserveAspectRatio="none">"#,
        text_layer.width, text_layer.height
    ));

    // Style for selectable but invisible text
    svg.push_str(r#"<style>text { fill: transparent; user-select: text; cursor: text; }</style>"#);

    // Generate text elements
    for item in &text_layer.items {
        if item.text.trim().is_empty() {
            continue;
        }

        // Sanitize control characters and escape HTML entities
        let sanitized_text = sanitize_for_xml(&item.text);
        let escaped_text = html_escape::encode_text(&sanitized_text);

        // Position: x is from left, y is baseline (add height to convert from top-left origin)
        // Note: SVG text y coordinate is baseline, but our data gives top-left
        // Adding font_size approximates the baseline position
        let baseline_y = item.y + item.font_size * 0.85; // Approximate baseline

        svg.push_str(&format!(
            r#"<text x="{:.2}" y="{:.2}" font-size="{:.2}">{}</text>"#,
            item.x,
            baseline_y,
            item.font_size,
            escaped_text
        ));
    }

    svg.push_str("</svg>");
    svg
}

/// Generate an SVG document with character-level positioning
///
/// This variant uses individual tspan elements for each character when
/// character positions are available, enabling more precise text selection.
pub fn generate_svg_with_chars(text_layer: &TextLayer) -> String {
    let mut svg = String::with_capacity(text_layer.items.len() * 400);

    // SVG header
    svg.push_str(&format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {} {}" preserveAspectRatio="none">"#,
        text_layer.width, text_layer.height
    ));

    svg.push_str(r#"<style>text { fill: transparent; user-select: text; cursor: text; } tspan { white-space: pre; }</style>"#);

    for item in &text_layer.items {
        if item.text.trim().is_empty() {
            continue;
        }

        let baseline_y = item.y + item.font_size * 0.85;

        // Check if we have character-level positions
        if let Some(ref char_positions) = item.char_positions {
            // Use tspan for each character with precise positioning
            svg.push_str(&format!(
                r#"<text y="{:.2}" font-size="{:.2}">"#,
                baseline_y, item.font_size
            ));

            for cp in char_positions {
                let char_str = cp.char.to_string();
                let sanitized_char = sanitize_for_xml(&char_str);
                if sanitized_char.is_empty() {
                    continue; // Skip control characters
                }
                let escaped_char = html_escape::encode_text(&sanitized_char);
                svg.push_str(&format!(
                    r#"<tspan x="{:.2}">{}</tspan>"#,
                    cp.x, escaped_char
                ));
            }

            svg.push_str("</text>");
        } else {
            // Fallback to simple text element
            let sanitized_text = sanitize_for_xml(&item.text);
            let escaped_text = html_escape::encode_text(&sanitized_text);
            svg.push_str(&format!(
                r#"<text x="{:.2}" y="{:.2}" font-size="{:.2}">{}</text>"#,
                item.x, baseline_y, item.font_size, escaped_text
            ));
        }
    }

    svg.push_str("</svg>");
    svg
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::types::TextItem;

    #[test]
    fn test_generate_svg_basic() {
        let text_layer = TextLayer {
            page: 1,
            width: 612.0,
            height: 792.0,
            items: vec![
                TextItem {
                    text: "Hello World".to_string(),
                    x: 72.0,
                    y: 72.0,
                    width: 100.0,
                    height: 12.0,
                    font_size: 12.0,
                    char_positions: None,
                },
            ],
        };

        let svg = generate_svg(&text_layer);

        assert!(svg.contains("viewBox=\"0 0 612 792\""));
        assert!(svg.contains("Hello World"));
        assert!(svg.contains("font-size=\"12.00\""));
    }

    #[test]
    fn test_html_escaping() {
        let text_layer = TextLayer {
            page: 1,
            width: 612.0,
            height: 792.0,
            items: vec![
                TextItem {
                    text: "<script>alert('xss')</script>".to_string(),
                    x: 72.0,
                    y: 72.0,
                    width: 100.0,
                    height: 12.0,
                    font_size: 12.0,
                    char_positions: None,
                },
            ],
        };

        let svg = generate_svg(&text_layer);

        // Ensure the text is escaped
        assert!(!svg.contains("<script>"));
        assert!(svg.contains("&lt;script&gt;"));
    }
}
