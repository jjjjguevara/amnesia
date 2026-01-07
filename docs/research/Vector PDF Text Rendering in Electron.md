# **Architectural Paradigms for High-Fidelity Vector Text Rendering in Electron: A Rust/PDFium Hybrid Approach**

## **1\. Introduction: The Fidelity Gap in Web-Based Document Rendering**

The rendering of Portable Document Format (PDF) files within web technologies has historically suffered from a significant fidelity gap compared to native applications. While native readers such as Adobe Acrobat or Apple’s Preview leverage direct GPU acceleration and operating system-level font rendering to achieve resolution-independent sharpness, web-based viewers—most notably those built on the HTML5 \<canvas\> element like Mozilla’s PDF.js—often exhibit perceptible rasterization artifacts.1 This degradation is particularly acute on high-pixel-density (HiDPI) displays, where the mismatch between logical CSS pixels and physical device pixels necessitates aggressive texture upscaling, resulting in the characteristic "fuzziness" of web-rendered text during zoom operations.3

For professional-grade applications built on the Electron framework, such as the Obsidian knowledge management tool, this visual compromise is unacceptable. Users of such tools demand a "read-on-paper" experience where typography remains crisp at arbitrary magnification levels, a requirement that purely raster-based pipelines struggle to meet without incurring prohibitive memory costs.

This report presents a comprehensive architectural analysis of achieving vector-quality text rendering in an Electron/Obsidian environment. It proposes a **Hybrid Rendering Architecture** that decouples the rendering of graphical content (images, complex shadings) from textual content. By leveraging a high-performance Rust backend binding to Google’s PDFium library, developers can construct a viewing engine that composites a rasterized background tile layer with a resolution-independent Scalable Vector Graphics (SVG) overlay for text.4 This approach combines the performance stability of bitmap rendering with the infinite scalability of vector typography, effectively bridging the fidelity gap.

### **1.1 The Physics of the Rasterization Barrier**

To understand the necessity of a custom Rust/PDFium backend, one must first deconstruct the limitations of current web-standard PDF rendering. The industry standard, PDF.js, interprets PDF binary data and draws commands to an HTML5 Canvas. The canvas element is, fundamentally, a bitmap backing store.1 When a user zooms into a document using the browser's native page zoom or a CSS transform, the browser essentially performs a bicubic upscale of the existing bitmap. This results in immediate blurring because the rendering engine has not yet repopulated the canvas with pixels at the new, higher resolution.2

To mitigate this, canvas-based viewers implement a "stop-and-render" cycle. Upon detecting a zoom event, the viewer debounces the input and triggers a computationally expensive re-rasterization of the PDF page at the new scale factor. This creates a jarring user experience where text momentarily blurs before "snapping" into focus.7 Furthermore, on Retina-class displays, the canvas must be sized at viewport\_width \* devicePixelRatio. A standard A4 page rendered at 200% zoom on a 3x Retina screen requires a canvas texture of enormous dimensions, frequently triggering memory pressure warnings in the browser's compositor process or causing crashes on constrained devices.8

### **1.2 The Vector Alternative: SVG and its Limitations**

The theoretical alternative is to render the entire PDF page as an SVG. Since SVG is a retained-mode vector format, the browser's layout engine handles scaling, ensuring text and paths remain mathematically sharp at any zoom level without re-rendering.10 However, the PDF specification (ISO 32000\) includes graphical primitives that do not map one-to-one with SVG. Complex features such as soft masks, luminosity blend modes, and Type 3 fonts (bitmap fonts) are notoriously difficult to convert to SVG without significant fidelity loss or massive file sizes.1

Moreover, the performance characteristics of the DOM make full-page SVG rendering precarious. A technical drawing or a map in PDF format may contain hundreds of thousands of individual vector path segments. Injecting these as individual DOM nodes (or SVG elements) creates a massive document tree. Research indicates that SVG rendering performance degrades significantly when the element count exceeds 10,000 nodes, causing frame drops during scrolling and interaction.11 Thus, a pure SVG approach trades blurriness for sluggishness, failing to solve the user experience problem.

### **1.3 The Hybrid Imperative**

The optimal solution, therefore, lies in a hybrid architecture that discriminates between content types. The rendering engine must process the document in two distinct layers:

1. **Background Layer (Raster):** Images, gradients, shadings, and complex vector artwork—elements that are computationally expensive to render as vectors but perceptually forgiving of slight scaling artifacts—are rasterized to efficient bitmap tiles.  
2. **Foreground Layer (Vector):** Text and essential linework are extracted as scalable SVG paths or positioned DOM elements. This layer is superimposed over the raster background with precise coordinate mapping.6

This separation allows text to remain sharp during optical zoom (CSS scaling) without requiring an immediate, blocking re-rasterization, while the heavy lifting of rendering graphical pixels is handled by the rasterizer.

## **2\. The PDFium Backend: Rust Integration and Capabilities**

PDFium, the open-source engine powering Google Chrome's PDF viewer, offers the industry's most robust and compliant PDF parsing capabilities. Unlike Java-based libraries or pure JavaScript implementations, PDFium is a native C++ library, offering raw performance and direct memory management.14 Integrating PDFium via Rust provides a memory-safe bridge between this low-level power and the high-level Electron environment.

### **2.1 The pdfium-render Ecosystem**

The Rust ecosystem interacts with PDFium primarily through the pdfium-render crate, which provides idiomatic bindings to the underlying C API. This crate abstracts the complexity of the Foreign Function Interface (FFI) while exposing the granular control necessary for hybrid rendering.15

#### **2.1.1 Dynamic Linking and Architecture**

A critical architectural decision in using pdfium-render is the linking strategy. The crate supports dynamic linking to a shared libpdfium library (.dll, .so, .dylib) at runtime. This is particularly advantageous for Electron applications, as it keeps the plugin binary small and allows the PDFium library to be updated independently of the application logic.5 For Obsidian plugins, which must minimize bundle size, dynamic linking allows the heavy PDFium binary to be downloaded on demand or shared across plugin instances.

#### **2.1.2 Thread Safety and Parallelism**

Rendering operations are CPU-intensive. Electron applications run their UI on a single main thread; blocking this thread with PDF rendering leads to interface freezing.17 The pdfium-render crate provides thread\_safe and sync features that wrap the non-thread-safe PDFium library in mutexes, allowing it to be safely shared across Rust threads.5 This enables an architecture where the Electron renderer process offloads page requests to a Rust-based worker thread (or a separate child process), which processes the PDFium rendering queue without impacting the UI frame rate.18

### **2.2 Accessing Low-Level Primitives**

To implement the hybrid model, the backend must do more than simply "render page to image." It must inspect and manipulate the internal object model of the PDF page. pdfium-render exposes the PdfPageObjects API, allowing developers to iterate over every element on a page.20

| Object Type | Description | Handling Strategy |
| :---- | :---- | :---- |
| **FPDF\_PAGEOBJ\_TEXT** | Represents text strings and font references. | **Extract & Hide:** Convert to SVG paths for the overlay, then hide/remove from the page before rasterization.22 |
| **FPDF\_PAGEOBJ\_PATH** | Vector shapes (lines, rectangles, curves). | **Conditional:** Simple paths can be extracted to SVG; complex paths (e.g., clipping masks) are best left to the rasterizer.20 |
| **FPDF\_PAGEOBJ\_IMAGE** | Bitmap data. | **Rasterize:** Leave in the background layer for high-performance bitmap rendering.23 |
| **FPDF\_PAGEOBJ\_SHADING** | Gradient meshes. | **Rasterize:** Almost impossible to replicate perfectly in SVG; must be rasterized.24 |

This granular access is the key differentiator between using a generic library and building a custom rendering engine. By identifying FPDF\_PAGEOBJ\_TEXT elements, the Rust backend can programmatically extract their glyph data and spatial coordinates to generate the vector overlay, and subsequently suppress them during the bitmap generation phase.25

### **2.3 The Skia Backend Opportunity**

Recent developments in PDFium include an experimental Skia backend. Skia, the 2D graphics library used by Chrome and Android, supports an SkSVGCanvas implementation. If PDFium is compiled with the PDF\_USE\_SKIA flag, it is theoretically possible to direct the rendering output not to a bitmap buffer, but to an SVG stream.26

The pdfium-render crate includes a pdfium\_use\_skia feature flag to enable these bindings.16 While this offers a potential "one-click" conversion to SVG, analysis suggests that the Skia SVG backend is not fully feature-complete regarding PDF blend modes and shadings.1 Consequently, utilizing Skia for the *entire* page conversion is risky. A more robust strategy uses Skia (or standard AGG rendering) for the raster background and custom extraction logic for the text, avoiding the pitfalls of experimental SVG export features.

## **3\. Architecture: The Hybrid Overlay Technique**

The proposed architecture involves a composite view consisting of stacked DOM layers. This "Sandwich" model ensures that the user sees the crispness of vectors while the application enjoys the performance benefits of bitmaps.

### **3.1 Layer 1: The Raster Background (The "Base")**

The bottom layer is a standard HTML \<canvas\> or \<img\> element. Its responsibility is to display everything *except* the text.

#### **3.1.1 Implementation Strategy: Text Suppression**

To prevent visual artifacts such as "double text" (where the vector text slightly misaligns with the raster text, causing a bolding or blurring effect), the text must be removed from the raster layer. PDFium does not provide a simple FPDF\_RENDER\_NO\_TEXT flag in its public API.16 Therefore, the Rust backend must implement a text suppression pass:

1. **Load Page:** Initialize the FPDF\_PAGE object.  
2. **Iterate Objects:** Use FPDFPage\_CountObjects and FPDFPage\_GetObject to traverse the page content.22  
3. **Identify Text:** Check if FPDFPageObj\_GetType(obj) \== FPDF\_PAGEOBJ\_TEXT.25  
4. **Hide/Remove:** There are two approaches to suppression:  
   * *Removal:* Use FPDFPage\_RemoveObject to delete the text object from the page in memory. This is destructive to the loaded page instance.22  
   * *Modification:* Change the render mode of the text object to FPDF\_TEXTRENDERMODE\_INVISIBLE (Mode 3). This keeps the object in the DOM for metrics but prevents it from drawing pixels.30  
5. **Render:** Call FPDF\_RenderPageBitmap to generate the BGRA pixel buffer.  
6. **Restore (Optional):** If the page instance is cached, reload it or undo the changes to restore the text for future operations.

This process yields a bitmap containing images, lines, and background colors, but with "holes" where the text resides.

#### **3.1.2 Handling Text as Clipping Paths**

A critical edge case involves text used as a clipping mask (e.g., an image clipped inside the shape of letters). Simply hiding FPDF\_PAGEOBJ\_TEXT might break the rendering of the underlying image. The Rust logic must inspect the text rendering mode; if the text is acting as a clip, it should be preserved in the raster layer to ensure the image appears correctly.25

### **3.2 Layer 2: The Vector Text Overlay (The "Sharpness")**

The top layer is responsible for displaying the text. There are two primary approaches to constructing this layer in the DOM: HTML Text or SVG Paths.

#### **3.2.1 Approach A: HTML DOM Overlay (The "PDF.js" Style)**

This method involves placing transparent or visible HTML elements (\<span\>) over the canvas using absolute positioning.

* **Mechanism:** Use FPDFText\_GetText and FPDFText\_GetRect to retrieve bounding boxes and Unicode strings.31  
* **Pros:** Native browser text selection is supported automatically.  
* **Cons:** Browser font rendering engines (e.g., HarfBuzz) differ subtly from PDF font engines in kerning and shaping. It is notoriously difficult to align HTML text perfectly with PDF text.33 This misalignment leads to "drifting" text when zooming, breaking the illusion of a solid document.

#### **3.2.2 Approach B: SVG Glyph Path Overlay (The Recommended "High Fidelity" Style)**

To achieve true vector-quality rendering that matches the PDF exactly, we must treat text not as semantic strings but as graphical shapes.

* **Mechanism:**  
  1. Iterate PdfPageTextObject elements in Rust.  
  2. For each character, retrieve the associated font glyph index and the precise transform matrix.  
  3. Extract the vector path data (MoveTo, LineTo, BezierTo) for that glyph using PDFium’s font API or helper functions in pdfium-render.21  
  4. Construct an SVG containing \<path\> elements.  
* **Optimization:** Use SVG \<defs\> and \<use\> tags. Instead of repeating the path data for the letter 'e' every time it appears, define it once in \<defs\> and reference it via \<use href="\#glyph\_e" transform="..." /\>. This dramatically reduces the DOM size and parsing time.36  
* **Result:** The text looks exactly as the PDF author intended, with perfect weight and kerning, and scales infinitely without pixelation.  
* **Selection Support:** To allow text selection, an invisible HTML text layer (Approach A, but with opacity: 0 and color: transparent) is placed *on top* of the SVG layer.37 This separates the visual representation (SVG) from the interaction model (HTML).

### **3.3 Layer 3: Interaction and Highlights**

A third layer, usually utilizing the \<canvas\> or \<div\> elements, handles user interaction such as text highlighting, annotations, and search results. This layer sits between the raster background and the invisible selection layer, ensuring that highlights appear "behind" the text (via blending modes) or clearly on top of the document.6

## **4\. Implementation Details: The Rust/PDFium Pipeline**

The backend implementation requires a carefully orchestrated pipeline between the Electron Main/Worker process and the Rust logic.

### **4.1 Initialization and Worker Architecture**

Given the CPU-bound nature of rendering and the single-threaded nature of Node.js, the Rust binding should be executed within a Node.js Worker Thread or a dedicated child process. This prevents the main UI thread from blocking during the rasterization of complex pages.17

Rust

// Conceptual Rust Structure for the Binding  
use pdfium\_render::prelude::\*;

pub struct RenderContext {  
    pdfium: Pdfium,  
    document: PdfDocument,  
}

impl RenderContext {  
    pub fn render\_page\_hybrid(&self, page\_index: u16, scale: f32) \-\> HybridResult {  
        let page \= self.document.pages().get(page\_index).unwrap();  
          
        // 1\. Generate SVG Text Overlay  
        let svg\_layer \= self.extract\_text\_as\_svg(\&page);  
          
        // 2\. Hide Text Objects  
        self.suppress\_text\_objects(\&page);  
          
        // 3\. Render Raster Background  
        let render\_config \= PdfRenderConfig::new()  
           .scale\_page\_by\_factor(scale)  
           .set\_image\_smoothing(true);  
        let bitmap \= page.render\_with\_config(\&render\_config).unwrap();  
          
        // 4\. Restore/Reload Page State (implied by Drop or reload)  
          
        HybridResult {  
            bitmap\_data: bitmap.as\_bytes().to\_vec(),  
            svg\_data: svg\_layer,  
        }  
    }  
}

### **4.2 Vector Path Extraction Strategies**

Extracting glyph paths via PDFium can be complex due to the intricacies of TrueType and Type1 font parsing.

#### **4.2.1 Direct PDFium Extraction**

The pdfium-render crate (version 0.7.24+) added support for retrieving path segments from page objects.35 However, mapping *text objects* directly to path segments often requires accessing the underlying FPDF\_FONT object and querying glyph outlines. This is the most performant method but requires significant low-level code to handle coordinate transforms (font space to user space).

#### **4.2.2 The mutool Sidecar Strategy (Alternative)**

If pure-Rust extraction proves overly complex, the mutool utility (from the MuPDF suite) offers a robust fallback. The command mutool draw \-o output.svg \-O text=path input.pdf generates an SVG where all text is pre-converted to vector paths.38

* **Workflow:** The Rust backend spawns a mutool process for the specific page. mutool handles the complex font-to-path conversion. The Rust backend captures the SVG output, sanitizes it (removing the raster images which mutool might include), and sends the vector-only SVG to the frontend.40  
* **Sanitization:** Using an XML parser, the backend must strip out \<image\> tags from the mutool output to ensure only the text paths remain, preventing double-rendering of images.41

### **4.3 Coordinate Systems and Transforms**

One of the most challenging aspects of this architecture is coordinating the coordinate systems.

1. **PDF User Space:** The internal coordinate system of the PDF (usually 72 DPI, origin bottom-left).  
2. **Device Space:** The pixel grid of the target bitmap (origin top-left).  
3. **CSS Space:** The layout units of the web browser.

The SVG overlay must be generated with a viewBox that matches the PDF User Space dimensions. The browser's CSS engine will then automatically handle the scaling of these vectors to match the visual size of the raster canvas, provided they are contained in a parent div with consistent dimensions.

## **5\. Advanced Tiled Rendering (Deep Zoom)**

Rendering a full-page bitmap at a zoom level sufficient for crisp reading (e.g., 200% or 300%) results in massive textures. A standard Letter page at 300 DPI is approximately 2550 x 3300 pixels (33 MB raw RGBA). Electron apps managing multiple such pages will quickly exhaust GPU memory.8 The solution is Tiled Rendering, similar to Google Maps.

### **5.1 The Tiling Mathematics**

Instead of rendering the whole page, the Rust backend should support rendering arbitrary rectangular regions (tiles).

* **Grid Logic:** Divide the PDF page space into a grid of fixed-size tiles (e.g., 512x512 pixels).  
* **Viewport Culling:** The frontend calculates which tiles are currently visible in the user's viewport using the IntersectionObserver API.  
* **Demand Paging:** The frontend requests only the visible tiles from the Rust backend.

### **5.2 Dynamic Tile Generation in Rust**

PDFium's FPDF\_RenderPageBitmap allows specifying a "start x", "start y", "size x", and "size y". These parameters define a crop box.42

* **Calculation:** To render tile $(row, col)$ at zoom $Z$:  
  * start\_x \= \-1 \* col \* TileWidth  
  * start\_y \= \-1 \* row \* TileHeight  
  * canvas\_width \= PageWidth \* Z  
  * canvas\_height \= PageHeight \* Z  
    This effectively "moves" the viewport of the renderer to the correct position for the tile.

### **5.3 Vector Virtualization**

While raster tiles are essential for memory management, the SVG text layer can also become heavy. A single page of dense text can contain thousands of path nodes.

* **SVG Segmentation:** For extreme performance, the SVG overlay should also be tiled. The Rust backend can spatially index the text objects (using an R-Tree). When a tile is requested, the backend returns not just the bitmap, but also a mini-SVG containing only the text paths relevant to that tile's bounding box.43  
* **Optimization:** Using libraries like Leaflet or OpenSeadragon within the Electron renderer can manage this tile lifecycle automatically, treating the PDF page as a map.44

## **6\. Performance Optimization in Electron**

### **6.1 Process Separation and IPC**

Transferring large image buffers from the Rust worker to the Electron renderer process incurs serialization overhead.

* **Shared Memory:** Use SharedArrayBuffer to share the bitmap memory between the Node.js worker (Rust) and the main thread without copying. The Rust backend writes pixels directly to the shared memory, and the frontend creates an ImageData object from it.46  
* **Zero-Copy Buffers:** If using napi-rs, utilize Buffer::from\_raw\_parts to pass ownership of the Rust-allocated memory to V8 without duplication, though this requires careful lifecycle management to avoid use-after-free errors.

### **6.2 Offscreen Rendering**

For high-performance scenarios, Electron's Offscreen Rendering (OSR) can be utilized, but standard hardware-accelerated CSS transforms on \<canvas\> elements are usually sufficient and easier to debug. Ensuring the will-change: transform CSS property is set on the tile container hints the browser to promote the layer to the GPU compositor.47

### **6.3 Caching Strategies**

* **LRU Cache:** The Rust backend should implement a Least Recently Used (LRU) cache for FPDF\_DOCUMENT and FPDF\_PAGE handles. Opening and parsing a PDF page is expensive; keeping the last 5-10 visited pages in memory allows for instant panning and zooming.49  
* **Tile Cache:** The frontend should cache generated tile URLs (Blob URLs) to prevent re-fetching tiles during minor scroll events.

## **7\. Comparative Analysis of Backend Strategies**

The following table summarizes the trade-offs between different rendering architectures:

| Feature | PDF.js (Canvas) | PDFium (Raster) | Hybrid (Raster \+ HTML) | Hybrid (Raster \+ SVG) |
| :---- | :---- | :---- | :---- | :---- |
| **Render Quality (Zoom)** | Low (Blurry) | Low (Blurry) | Medium (Text Drift) | **High (Perfect)** |
| **Memory Footprint** | High (Full Page) | Medium (Tiled) | Medium (DOM overhead) | **Low/Medium** |
| **Text Selection** | Native | None | Native | **Native (Hidden Layer)** |
| **Performance** | Fast (JS Optimized) | Fast (Native) | Medium (Layout Thrashing) | **High (Hardware Accel)** |
| **Implementation Effort** | Low | Medium | High | **Very High** |

**Why Hybrid (Raster \+ SVG) Wins:** Pure SVG conversion 1 fails on complex graphical artifacts (gradients, blends). Pure Raster 1 fails on text sharpness. The Hybrid approach leverages the strengths of both: rasterization for the complex, distinct pixels of images/backgrounds, and vector mathematics for the sharp, resolution-independent geometry of text.

## **8\. Strategic Recommendations for Implementation**

For the Obsidian/Electron project, the following roadmap is recommended:

1. **Phase 1: The Native Module:** Develop a Node.js native addon using napi-rs and pdfium-render. This module must expose methods to:  
   * Open/Close documents.  
   * Render a specific tile (x, y, w, h, zoom) to a buffer.  
   * Extract the page dimensions.  
2. **Phase 2: Text Extraction Logic:** Implement the text-to-SVG-path logic. If direct extraction via pdfium-render proves too laborious due to API surface gaps, implement the mutool draw \-o out.svg text=path sidecar integration immediately as a high-fidelity stopgap.  
3. **Phase 3: The Frontend Viewer:** Build a React/Obsidian view component that implements a "virtual scroll" viewport. It should request tiles from the backend based on scroll position.  
4. **Phase 4: Composition:** Overlay the extracted SVG text on top of the raster tiles. Apply pointer-events: none to the SVG layer and place a transparent text layer (standard HTML) on top for selection, or implement selection logic directly on the SVG nodes if feasible.

## **9\. Conclusion**

Achieving vector-quality PDF rendering in Electron is not a matter of finding the "perfect library" but rather engineering a **Hybrid Rendering Pipeline**. By acknowledging that "text" and "graphics" have different rendering requirements, developers can bypass the inherent limitations of the HTML5 Canvas. The integration of Rust and PDFium provides the necessary low-level control to suppress text during rasterization and extract high-fidelity vector paths, enabling a reading experience that rivals native desktop applications while retaining the flexibility of the web platform.

This architecture represents a significant engineering investment but offers the only viable path to truly professional, resolution-independent document visualization in an Electron environment. The resulting system will deliver the "magic" of deep zoom—instant clarity at any magnification—that users have come to expect from high-end tools.

#### **Obras citadas**

1. PDF.js Rendering Quality the Complete Guide | Apryse, fecha de acceso: enero 6, 2026, [https://apryse.com/blog/pdf-js/guide-to-pdf-js-rendering](https://apryse.com/blog/pdf-js/guide-to-pdf-js-rendering)  
2. Blurry Rendering on High DPI Display \#10509 \- mozilla/pdf.js \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/mozilla/pdf.js/issues/10509](https://github.com/mozilla/pdf.js/issues/10509)  
3. font rendering blurry with custom scaling level in windows \#7630, fecha de acceso: enero 6, 2026, [https://github.com/mozilla/pdf.js/issues/7630](https://github.com/mozilla/pdf.js/issues/7630)  
4. LibreOffice now uses pdfium to render inserted PDF images, fecha de acceso: enero 6, 2026, [https://vmiklos.hu/blog/pdfium.html](https://vmiklos.hu/blog/pdfium.html)  
5. pdfium-render \- crates.io: Rust Package Registry, fecha de acceso: enero 6, 2026, [https://crates.io/crates/pdfium-render](https://crates.io/crates/pdfium-render)  
6. Understanding PDF.js Layers and How to Use them in React.js, fecha de acceso: enero 6, 2026, [https://blog.react-pdf.dev/understanding-pdfjs-layers-and-how-to-use-them-in-reactjs](https://blog.react-pdf.dev/understanding-pdfjs-layers-and-how-to-use-them-in-reactjs)  
7. Text in the PDF appears blurry \- Technical Support \- PDF.js Express, fecha de acceso: enero 6, 2026, [https://pdfjs.community/t/text-in-the-pdf-appears-blurry/2931](https://pdfjs.community/t/text-in-the-pdf-appears-blurry/2931)  
8. pdf.js eats a lot of memory | Firefox Support Forum, fecha de acceso: enero 6, 2026, [https://support.mozilla.org/en-US/questions/972366](https://support.mozilla.org/en-US/questions/972366)  
9. Why does pdf.js run slowly and use a lot of memory? \- Google Groups, fecha de acceso: enero 6, 2026, [https://groups.google.com/g/mozilla.dev.pdf-js/c/aKfuJqS\_4RI](https://groups.google.com/g/mozilla.dev.pdf-js/c/aKfuJqS_4RI)  
10. Convert PDF to clean SVG? \[closed\] \- Stack Overflow, fecha de acceso: enero 6, 2026, [https://stackoverflow.com/questions/10288065/convert-pdf-to-clean-svg](https://stackoverflow.com/questions/10288065/convert-pdf-to-clean-svg)  
11. Comparing Rendering Performance of Common Web Technologies ..., fecha de acceso: enero 6, 2026, [https://imld.de/cnt/uploads/Horak-2018-Graph-Performance.pdf](https://imld.de/cnt/uploads/Horak-2018-Graph-Performance.pdf)  
12. SVG vs Canvas: Choosing the Right Tool for Your Graphics \- Medium, fecha de acceso: enero 6, 2026, [https://medium.com/@kedari.mahesh/svg-vs-canvas-choosing-the-right-tool-for-your-graphics-bd584a22e3c0](https://medium.com/@kedari.mahesh/svg-vs-canvas-choosing-the-right-tool-for-your-graphics-bd584a22e3c0)  
13. fecha de acceso: enero 6, 2026, [https://blog.vue-pdf-viewer.dev/what-are-pdfjs-layers-and-how-you-can-use-them-in-vuejs\#:\~:text=Canvas%20Layer%3A%20Renders%20the%20static,text%20is%20selectable%20and%20searchable.](https://blog.vue-pdf-viewer.dev/what-are-pdfjs-layers-and-how-you-can-use-them-in-vuejs#:~:text=Canvas%20Layer%3A%20Renders%20the%20static,text%20is%20selectable%20and%20searchable.)  
14. How to config PDFium for PDF with complex vector drawings?, fecha de acceso: enero 6, 2026, [https://groups.google.com/g/pdfium/c/5oUo0g0HDDw](https://groups.google.com/g/pdfium/c/5oUo0g0HDDw)  
15. pdfium-render \- crates.io: Rust Package Registry, fecha de acceso: enero 6, 2026, [https://crates.io/crates/pdfium-render/0.8.27](https://crates.io/crates/pdfium-render/0.8.27)  
16. ajrcarey/pdfium-render: A high-level idiomatic Rust wrapper ... \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/ajrcarey/pdfium-render](https://github.com/ajrcarey/pdfium-render)  
17. Performance | Electron, fecha de acceso: enero 6, 2026, [https://electronjs.org/docs/latest/tutorial/performance](https://electronjs.org/docs/latest/tutorial/performance)  
18. pdfium \- Rust \- Docs.rs, fecha de acceso: enero 6, 2026, [https://docs.rs/pdfium](https://docs.rs/pdfium)  
19. How to build an Electron PDF viewer with PDF.js \- Nutrient iOS, fecha de acceso: enero 6, 2026, [https://www.nutrient.io/blog/how-to-build-an-electron-pdf-viewer-with-pdfjs/](https://www.nutrient.io/blog/how-to-build-an-electron-pdf-viewer-with-pdfjs/)  
20. pdfium path segment API for LibreOffice's test needs \- vmiklos.hu, fecha de acceso: enero 6, 2026, [https://vmiklos.hu/blog/pdfium-pathsegment.html](https://vmiklos.hu/blog/pdfium-pathsegment.html)  
21. Add bindings and functions to access segments of page path objects ..., fecha de acceso: enero 6, 2026, [https://github.com/ajrcarey/pdfium-render/issues/55](https://github.com/ajrcarey/pdfium-render/issues/55)  
22. public/fpdf\_edit.h \- pdfium \- Git at Google, fecha de acceso: enero 6, 2026, [https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf\_edit.h](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_edit.h)  
23. Pdfium.Net SDK: The C\# PDF Library, fecha de acceso: enero 6, 2026, [https://pdfium.patagames.com/](https://pdfium.patagames.com/)  
24. Raster vs Vector: Navigating the Digital Image Landscape \- Cloudinary, fecha de acceso: enero 6, 2026, [https://cloudinary.com/guides/image-formats/raster-vs-vector-navigating-the-digital-image-landscape](https://cloudinary.com/guides/image-formats/raster-vs-vector-navigating-the-digital-image-landscape)  
25. How to avoid extracting hidden text \- Google Groups, fecha de acceso: enero 6, 2026, [https://groups.google.com/g/pdfium/c/FJEdQTm2fPE](https://groups.google.com/g/pdfium/c/FJEdQTm2fPE)  
26. PDF to QPainter calls or SVG? · Issue \#18 · paulovap/qtpdfium, fecha de acceso: enero 6, 2026, [https://github.com/paulovap/qtpdfium/issues/18](https://github.com/paulovap/qtpdfium/issues/18)  
27. SVG via QWebEngine \+ PDFium \+ Skia \+ SkCanvas \+ ... \- Mailing Lists, fecha de acceso: enero 6, 2026, [https://lists.qt-project.org/pipermail/qtwebengine/2018-August/000488.html](https://lists.qt-project.org/pipermail/qtwebengine/2018-August/000488.html)  
28. pdfium\_render \- Rust \- Docs.rs, fecha de acceso: enero 6, 2026, [https://docs.rs/pdfium-render](https://docs.rs/pdfium-render)  
29. Issue 533 in pdfium: FPDF\_RenderPage clips images for certain ..., fecha de acceso: enero 6, 2026, [https://groups.google.com/g/pdfium-bugs/c/DLGC9KSRCbc/m/oQf759bUCAAJ](https://groups.google.com/g/pdfium-bugs/c/DLGC9KSRCbc/m/oQf759bUCAAJ)  
30. public/fpdfview.h \- pdfium \- Git at Google, fecha de acceso: enero 6, 2026, [https://pdfium.googlesource.com/pdfium/+/main/public/fpdfview.h](https://pdfium.googlesource.com/pdfium/+/main/public/fpdfview.h)  
31. FPDFText\_LoadPage \- EmbedPDF, fecha de acceso: enero 6, 2026, [https://www.embedpdf.com/docs/pdfium/functions/FPDFText\_LoadPage](https://www.embedpdf.com/docs/pdfium/functions/FPDFText_LoadPage)  
32. pdfium/public/fpdf\_text.h at master \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/documentcloud/pdfium/blob/master/public/fpdf\_text.h](https://github.com/documentcloud/pdfium/blob/master/public/fpdf_text.h)  
33. Rendering Text To Canvas With Adjusted X,Y Offsets For Better ..., fecha de acceso: enero 6, 2026, [https://www.bennadel.com/blog/4320-rendering-text-to-canvas-with-adjusted-x-y-offsets-for-better-cross-browser-consistency.htm](https://www.bennadel.com/blog/4320-rendering-text-to-canvas-with-adjusted-x-y-offsets-for-better-cross-browser-consistency.htm)  
34. the position of words render by textlayer are not the same with canvas, fecha de acceso: enero 6, 2026, [https://github.com/mozilla/pdf.js/discussions/18068](https://github.com/mozilla/pdf.js/discussions/18068)  
35. pdfium-render \- crates.io: Rust Package Registry, fecha de acceso: enero 6, 2026, [https://crates.io/crates/pdfium-render/0.7.26](https://crates.io/crates/pdfium-render/0.7.26)  
36. Can I convert SVG text to path but reuse glyphs?, fecha de acceso: enero 6, 2026, [https://graphicdesign.stackexchange.com/questions/79618/can-i-convert-svg-text-to-path-but-reuse-glyphs](https://graphicdesign.stackexchange.com/questions/79618/can-i-convert-svg-text-to-path-but-reuse-glyphs)  
37. How to make addField text transparent or push it behind image, fecha de acceso: enero 6, 2026, [https://community.adobe.com/t5/acrobat-sdk-discussions/how-to-make-addfield-text-transparent-or-push-it-behind-image/td-p/10573205](https://community.adobe.com/t5/acrobat-sdk-discussions/how-to-make-addfield-text-transparent-or-push-it-behind-image/td-p/10573205)  
38. manual-mutool-convert.html \- Joffrey Wallaart / mupdf \- TU Delft Gitlab, fecha de acceso: enero 6, 2026, [https://gitlab.tudelft.nl/joffreywallaar/mupdf/-/blob/master/docs/manual-mutool-convert.html](https://gitlab.tudelft.nl/joffreywallaar/mupdf/-/blob/master/docs/manual-mutool-convert.html)  
39. mutool convert \- MuPDF 1.26.1 documentation, fecha de acceso: enero 6, 2026, [https://mupdf.readthedocs.io/en/1.26.1/mutool-convert.html](https://mupdf.readthedocs.io/en/1.26.1/mutool-convert.html)  
40. How to extract drawing from PDF file to SVG \- Stack Overflow, fecha de acceso: enero 6, 2026, [https://stackoverflow.com/questions/79664954/how-to-extract-drawing-from-pdf-file-to-svg](https://stackoverflow.com/questions/79664954/how-to-extract-drawing-from-pdf-file-to-svg)  
41. svgfilters \- Rust \- Docs.rs, fecha de acceso: enero 6, 2026, [https://docs.rs/svgfilters/](https://docs.rs/svgfilters/)  
42. Rendering PDFs on Android the easy way | by Fred Porciúncula, fecha de acceso: enero 6, 2026, [https://proandroiddev.com/rendering-pdfs-on-android-the-easy-way-c05635b2c3a8](https://proandroiddev.com/rendering-pdfs-on-android-the-easy-way-c05635b2c3a8)  
43. kurtraschke/L.GridLayer.PDFLayer: A Leaflet layer for ... \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/kurtraschke/L.GridLayer.PDFLayer](https://github.com/kurtraschke/L.GridLayer.PDFLayer)  
44. Creating a tiled zoomable image with OpenSeadragon and vips, fecha de acceso: enero 6, 2026, [https://til.simonwillison.net/javascript/openseadragon](https://til.simonwillison.net/javascript/openseadragon)  
45. Mastering OpenSeadragon Tilesources: A Guide \- Newline.co, fecha de acceso: enero 6, 2026, [https://www.newline.co/@iangilman/mastering-openseadragon-tilesources-a-guide--d224a3f7](https://www.newline.co/@iangilman/mastering-openseadragon-tilesources-a-guide--d224a3f7)  
46. A slimmer and faster pdf.js – Nicholas Nethercote \- The Mozilla Blog, fecha de acceso: enero 6, 2026, [https://blog.mozilla.org/nnethercote/2014/02/07/a-slimmer-and-faster-pdf-js/](https://blog.mozilla.org/nnethercote/2014/02/07/a-slimmer-and-faster-pdf-js/)  
47. CanvasRenderingContext2D: scale() method \- Web APIs | MDN, fecha de acceso: enero 6, 2026, [https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/scale](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/scale)  
48. Canvas From Scratch: Transformations and Gradients \- Web Design, fecha de acceso: enero 6, 2026, [https://webdesign.tutsplus.com/canvas-from-scratch-transformations-and-gradients--net-19637t](https://webdesign.tutsplus.com/canvas-from-scratch-transformations-and-gradients--net-19637t)  
49. PDF rendering performance with JavaScript viewer \- Nutrient iOS, fecha de acceso: enero 6, 2026, [https://www.nutrient.io/guides/web/best-practices/performance/](https://www.nutrient.io/guides/web/best-practices/performance/)