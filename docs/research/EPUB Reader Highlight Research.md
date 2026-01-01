# **Architectural Analysis of EPUB Rendering: Highlight Persistence and Navigation Strategies for Modular Applications**

## **1\. Introduction: The Reflowable Document Paradigm**

The development of a robust EPUB reader within a modular application environment, such as an Obsidian plugin, necessitates a fundamental departure from the fixed-coordinate paradigms that govern PDF or image-based rendering. Unlike formats where a "page" is a static canvas with immutable dimensions, the EPUB standard relies on reflowable XHTML content. In this context, the visual representation of text—and consequently the spatial coordinates of any user-generated highlights or annotations—is fluid, governed by a complex interplay of viewport dimensions, user-defined font settings, and the rendering engine's pagination logic.

The architectural challenge presented by the user query involves three distinct but deeply interconnected domains: **Highlight Rendering** (how to visualize a selection without breaking the document flow), **Position Persistence** (how to store that location robustly so it survives reflows), and **Navigation** (how to calculate and move between logical positions in a document that has no inherent physical pages). This report provides an exhaustive analysis of industry-standard approaches, synthesizing data from the Readium foundation, the W3C EPUB specifications, and the architectural patterns of open-source readers like Foliate and EPUB.js.

The core tension in building an EPUB reader for a platform like Obsidian—which is built on Electron and heavily reliant on web technologies—is the conflict between the **Document Object Model (DOM)**, which represents the semantic structure of the book, and the **Render Tree**, which represents its visual layout. Highlights exist at the intersection of these two trees: they are semantic markers (data) that require precise visual representation (pixels). When the rendering engine artificially breaks the DOM into "pages" using CSS columns or scroll snapping, the coordinate systems often drift apart, leading to the specific artifact mentioned in the query: highlights that "move" or detach during page turns.

This analysis is structured to first deconstruct the rendering strategies that cause these issues, then to rigorously define the addressing schemes (Locators and CFIs) required to fix position persistence, and finally to propose a modern rendering architecture utilizing the CSS Custom Highlight API to solve the visual stability problem.

## ---

**2\. Rendering Architecture and Pagination Strategies**

To address the instability of highlights during navigation, one must first examine the mechanism by which a browser-based reader constructs a "page." An EPUB file is essentially a compressed website, but the "page" displayed to the user is a synthetic view constructed by the reading system. The choice of pagination strategy is the single most significant determinant of highlight stability.

### **2.1 The DOM Layout Model vs. Paged Media**

In a standard web browsing context, content flows vertically. The "scroll" is the primary navigation mechanic. However, digital books typically emulate the paginated experience of physical codices. To achieve this in a browser engine (like Chromium, which powers Electron and Obsidian), the reader must constrain the reflowable content into a viewport of fixed dimensions.

There are two primary architectural approaches to this constraint, each with distinct implications for highlight rendering: the **CSS Multi-Column Layout** and the **Native Scroll/Snap** model.

### **2.2 Legacy Pagination: CSS Multi-Column Layouts**

Historically, the dominant approach for web-based readers (including Readium 1.x and early versions of EPUB.js) has been the use of CSS Multi-Column Layouts.1 In this architecture, the entire HTML resource (a chapter) is loaded into a container element. The container is assigned a height equal to the viewport height and a column-width equal to the viewport width.

#### **2.2.1 The Mechanism of Columns**

The browser's layout engine automatically fragments the content into columns. Because the column width matches the screen width, only one column is visible at a time. To "turn the page," the reader application modifies the CSS transform property of the container, usually applying a translateX value equivalent to the viewport width multiplied by the current page index.

This approach was favored because it was one of the earliest methods to support pagination natively in CSS without complex JavaScript fragmentation.1 However, it introduces significant coordinate system complexities.

#### **2.2.2 The Coordinate Drift Problem**

The "moving highlight" issue often stems from the disconnect between the visual layer and the logical layer in column-based layouts.

* **The Dubstep Effect:** When a page turn is triggered via transform: translate3d(...), the browser promotes the container to a new compositing layer. The movement is handled by the GPU. However, if highlights are rendered on a separate overlay (such as an absolute positioned div or \<canvas\>), that overlay must be transformed in perfect synchronization with the text container. If the overlay is updated via a JavaScript animation loop (updating left pixels) while the text moves via CSS transitions, frame mismatch occurs. The text moves instantly, while the highlights "float" or "drift" before snapping into place—a phenomenon sometimes referred to as the "dubstep effect" due to the jittering pixels.2  
* **Column Fragmentation:** CSS columns are notoriously difficult for calculating bounding boxes. A single logical paragraph might be split across two columns (pages). A standard DOM Range object wrapping that paragraph will return a BoundingClientRect that encompasses the *entire* union of the two fragments, often resulting in a highlight box that spans the empty space between columns (the column gap). To render this correctly requires complex logic to detect column breaks and generate multiple Rects, which is computationally expensive and prone to error during window resizing.1

### **2.3 Modern Pagination: CSS Scroll Snap and Native Overflow**

Recognizing the limitations and instability of the multi-column approach, modern reading systems, including the Readium 2 architecture and the Foliate reader, have increasingly shifted toward native scrolling mechanisms combined with **CSS Scroll Snap** or overflow: paged-x (where supported).1

#### **2.3.1 The Scroll Snap Architecture**

In this model, the content is laid out horizontally, but rather than using columns, the container is set to overflow-x: scroll with scroll-snap-type: x mandatory. The browser's native scrolling engine handles the pagination physics.

* **Hardware Acceleration:** Because scrolling is a native operation, the browser's compositor thread handles the movement of both the text and any child elements (including highlights) atomically. This eliminates the synchronization lag seen in the transform approach.1  
* **Coordinate Stability:** In a scroll-based model, the coordinate system is consistent. A highlight at left: 1500px is simply 1500 pixels from the start of the chapter. When the user scrolls to the second page (viewport 1024px to 2048px), the highlight remains at 1500px relative to the container. There is no need for dynamic recalculation of coordinates during the animation; the entire canvas moves as a unit.

**Architectural Insight:** For an Obsidian plugin, the **CSS Scroll Snap** approach is significantly more robust than CSS Columns. It reduces the computational overhead of pagination logic (delegating it to the browser) and ensures that highlights—provided they are children of the scroll container—move in perfect lockstep with the text.

### **2.4 Is Isolation Necessary? Iframes vs. Webviews in Electron**

The environment of an Obsidian plugin places specific constraints on the renderer. The EPUB content must be isolated from the Obsidian application interface to prevent CSS bleeding (e.g., the book's "body" styles overriding the application's UI) and to ensure security.

#### **2.4.1 The Iframe Isolation Model**

Most web-readers (ReadiumJS, EPUB.js) use an \<iframe\> to contain the book content.4

* **Communication:** Interactions between the Obsidian plugin (Main World) and the EPUB (Iframe World) must happen via postMessage.  
* **Highlight Implications:** If highlights are drawn on an overlay *outside* the iframe (to allow them to float above everything), coordinate translation is required (Iframe Offset \+ Element Offset). This introduces fragility. If the iframe scrolls, the external overlay must listen to the scroll event.  
* **Solution:** Highlights should logically exist *inside* the iframe context. This ensures they scroll and reflow with the document automatically.

#### **2.4.2 The Electron Webview Tag**

Electron provides a \<webview\> tag, which runs in a separate process (unlike an iframe, which shares the renderer process). While this offers better security and performance isolation, it complicates the communication channel. The Readium architecture typically abstracts the view (iframe vs webview) behind a "Navigator" interface, treating the communication channel as a generic message bus.4 For an Obsidian plugin, an \<iframe\> is often preferred for tighter integration and lower memory overhead, provided strict sandbox attributes are applied to prevent the EPUB from executing malicious scripts that could access the Node.js API exposed by Electron.

## ---

**3\. Position Persistence: The Science of Robust Locators**

The second major issue identified in the user query is "position persistence." In a reflowable EPUB, spatial coordinates (e.g., "Top: 50px") are ephemeral. They become invalid the moment the window is resized or the font size changes. Therefore, a robust system must define location based on the **Document Structure**, not the **Visual Layout**.

The industry has converged on a hierarchical addressing scheme, starting with the **Canonical Fragment Identifier (CFI)** for precision, and falling back to **Fuzzy Anchoring** for resilience.

### **3.1 The Canonical Fragment Identifier (CFI) Standard**

The Canonical Fragment Identifier is the EPUB standard's answer to the URL fragment identifier. It was developed by the IDPF to allow precise addressing into any part of an EPUB publication, down to the character level.5

#### **3.1.1 CFI Generation Algorithms and Traversal Logic**

A CFI looks like this: epubcfi(/6/4\[chap1ref\]\!/4\[body01\]/10\[para05\]/2/1:5). To understand how to implement this in an Obsidian plugin, one must understand the traversal algorithm.

* **The Indirection Step (\!):** The CFI describes a path through the Package Document (OPF) first, then into the Content Document (HTML). The \! character represents the "indirection" or the jump from the spine to the HTML file.5  
* **The Even/Odd Indexing Rule:** This is the most critical and often misunderstood aspect of CFI implementation.  
  * **Elements (Tags):** Are assigned **even** indices (2, 4, 6...).  
  * **Text Nodes:** Are assigned **odd** indices (1, 3, 5...).  
* **Why Odd/Even?** This scheme allows the CFI to reference a "virtual" text node position even if the text node doesn't physically exist in the DOM (e.g., between two adjacent elements). It ensures that if a text node is empty or contains only whitespace, the indexing of subsequent elements remains consistent. This robustness is essential for XML parsing where whitespace handling varies between parsers.5

Algorithmic Requirement for Persistence:  
When the user creates a highlight, the system must traverse the DOM from the selected node up to the root.

1. Identify the parentNode.  
2. Iterate through parentNode.childNodes.  
3. Maintain two counters: one for elements (incrementing by 2\) and one for text chunks (incrementing by 2).  
4. Construct the path string by prepending the index at each level.  
5. If the node has an id attribute, append it in brackets (e.g., /4\[my-id\]). This adds robustness: if the element moves but keeps its ID, the reader can still find it.6

#### **3.1.2 Handling Mixed Content and Virtual Elements**

A common failure point in "naive" CFI implementations is mixed content. Consider the HTML:  
\<p\>This is \<em\>emphasized\</em\> text.\</p\>  
The DOM structure is:

1. Text Node: "This is "  
2. Element: \<em\>  
3. Text Node: " text."

In CFI Logic:

* "This is " is at index 1\.  
* \<em\> is at index 2\.  
* " text." is at index 3\.

If a script inserts a highlight span: \<p\>This is \<em\>emphasized\</em\> \<span class="highlight"\>text\</span\>.\</p\>  
The DOM structure changes. However, the CFI standard dictates that logic chunks of text are counted. The insertion of a span should ideally not break the addressing of surrounding elements if the reader implementation is strictly compliant. However, in practice, DOM mutation does break standard CFI parsers because the childNode index shifts. This is why Readium 2 and Hypothesis strongly advise against relying solely on CFI for long-term storage.8

### **3.2 Beyond CFI: The Readium Locator Model**

To solve the fragility of CFIs, the Readium project developed the **Locator** model, which is a JSON object that encapsulates multiple ways of finding a location. This is the industry-standard data structure for persistence.9

| Property | Type | Description |
| :---- | :---- | :---- |
| href | URI | The absolute or relative path to the resource (e.g., chapter1.html). |
| type | String | The MIME type of the resource (e.g., application/xhtml+xml). |
| title | String | (Optional) The title of the chapter, useful for UI display. |
| **locations** | Object | The primary addressing data. |
| locations.cfi | String | The Canonical Fragment Identifier. Precise but brittle. |
| locations.cssSelector | String | An optional CSS selector path (e.g., body \> p:nth-child(3)). |
| locations.progression | Float | A value between 0.0 and 1.0 representing the percentage through the resource. |
| **text** | Object | Contextual text data for verification and fuzzy matching. |
| text.highlight | String | The exact text selected by the user. |
| text.before | String | The text immediately preceding the selection. |
| text.after | String | The text immediately following the selection. |

**Architectural Recommendation:** The Obsidian plugin should serialize highlights using this full Locator schema. When reloading a highlight, the system should check locations.cfi first. If that fails (e.g., the DOM has changed), it should fallback to locations.progression to scroll the user to the approximate location, and then use the text object to perform fuzzy anchoring.

### **3.3 Fuzzy Anchoring and Robustness Strategies**

The concept of **Fuzzy Anchoring** is critical for "industry-standard" persistence. Documents evolve; users might update an EPUB file (correcting typos) or the rendering engine might change how it normalizes DOM text. A strict character-offset system will fail if a single character is added to the start of a chapter.

#### **3.3.1 The Tripartite Selector Model**

This model, popularized by the **Hypothesis** annotation standard, utilizes the text object defined in the Locator model above. It relies on the uniqueness of text sequences in natural language.10

* **Prefix (32 chars):** Provides context *before* the match.  
* **Exact Match:** The target text.  
* **Suffix (32 chars):** Provides context *after* the match.

The combination of Prefix \+ Exact Match \+ Suffix creates a "fingerprint" of the location that is statistically highly likely to be unique within a document, even if the structural path (CFI) has changed completely.10

#### **3.3.2 Re-attachment Algorithms and Levenshtein Distance**

When the application loads a highlight and attempts to attach it to the DOM, it should follow a prioritized strategy:

1. **Exact CFI Match:** Attempt to locate the range defined by locations.cfi. If the text content at that range matches text.highlight, render it immediately. This is O(1) and fastest.  
2. **Context Search:** If CFI fails, search the text content of the chapter for the string text.before \+ text.highlight \+ text.after. This handles cases where the element structure changed (e.g., a \<div\> was wrapped around a paragraph) but the text remained constant.10  
3. **Fuzzy Search:** If exact text search fails (e.g., a typo was fixed in the book, changing "the" to "The"), employ a fuzzy matching algorithm.  
   * **Levenshtein Distance:** Calculate the edit distance between the stored quote and the text in the document. A threshold is typically set (e.g., distance \< 10% of string length) to accept a match.11  
   * **Bitap Algorithm:** Libraries like fuse.js or diff-match-patch implement efficient fuzzy search algorithms that can scan large text blocks quickly.

**Implication for Obsidian:** By implementing this recovery logic, the reader ensures that highlights are not "orphaned" when the user updates the EPUB file or when the Obsidian plugin updates its rendering logic. The highlights "heal" themselves by finding their new location based on the text context.

## ---

**4\. Highlight Rendering Technologies**

Once the location of a highlight is determined, the final challenge is rendering it visually. As noted in Section 2, the choice of rendering technology dictates the stability of the highlight during page turns.

### **4.1 DOM Mutation Strategies (The "Span" Approach)**

The traditional method involves using the JavaScript Selection API (range.surroundContents()) to wrap the selected text in a \<span\> with a background color.

* **Pros:** The highlight is physically part of the layout. It reflows naturally.  
* **Cons:**  
  * **Destructive:** It modifies the DOM structure. This invalidates CFIs for other highlights.  
  * **Normalization Issues:** If a highlight spans across multiple block elements (e.g., starts in p and ends in div), the range cannot be simply wrapped. The application must split the range into multiple sub-ranges for each block container, creating multiple span elements. This complexity is a significant source of bugs.13

### **4.2 Overlay Architectures (The "Canvas" Approach)**

Used by foliate-js and epub.js (in some modes), this approach draws the highlight on a separate layer (SVG or Canvas) placed *over* the text.14

* **Mechanism:** Iterate through the text nodes in the Range, calculate getClientRects(), and draw rectangles on the overlay matching those dimensions.  
* **The Synchronization Fallacy:** As discussed in Section 2.2.2, keeping this overlay in sync with the text during accelerated scrolling or transforming is mathematically difficult and computationally expensive. It requires listening to scroll and resize events and repainting the canvas constantly.

### **4.3 The Future: CSS Custom Highlight API**

The **CSS Custom Highlight API** is the emerging W3C standard specifically designed to solve the problems of DOM mutation and overlay synchronization.16 It allows developers to style arbitrary ranges of text without modifying the DOM tree.

#### **4.3.1 Architecture and Registry Management**

The API introduces a HighlightRegistry accessible via CSS.highlights.

* **Creation:**  
  JavaScript  
  // Create a Range object (standard DOM Range)  
  const range \= document.createRange();  
  range.setStart(startNode, startOffset);  
  range.setEnd(endNode, endOffset);

  // Create a Highlight object  
  const userHighlight \= new Highlight(range);

  // Register it  
  CSS.highlights.set("my-highlight-class", userHighlight);

* **Styling:**  
  CSS  
  ::highlight(my-highlight-class) {  
      background-color: yellow;  
      color: black;  
  }

This decouples the *semantic* concept of a highlight from the *structural* DOM. The browser's rendering engine handles the painting of the highlight at the compositor level.18

#### **4.3.2 Performance Characteristics and Layout Independence**

* **Zero Reflow:** Registering a Highlight does not trigger a DOM reflow or layout recalculation, unlike inserting \<span\> elements. This makes it performant enough to render thousands of highlights instantly.18  
* **Visual Integrity:** Because the browser paints the highlight as part of the text rendering pass, it is impossible for the highlight to "drift" or "lag" behind the text during scrolling or paging animations. It effectively solves the "moving highlight" problem at the engine level.  
* **Support Considerations:** As of late 2024/early 2025, this API is supported in Chromium (Electron) and Safari. Firefox support is available in Nightly builds.13 Since Obsidian uses Electron, it is fully available for use.

**Critical Limitation:** The API currently supports a limited subset of CSS properties (mainly color, background-color, text-decoration). It cannot change layout properties like font-size or margin for the highlighted text.21 This is generally acceptable for a reading app highlighter.

## ---

**5\. Navigation and Synthetic Pagination**

The final piece of the architectural puzzle is navigation. Users expect a linear progression (Page 1 of 300), but EPUBs are a collection of separate HTML files (Spine items) with no intrinsic page count.

### **5.1 The Page Number Illusion**

An EPUB reader must "fake" pagination.

* **Spine Item:** The unit of storage (e.g., chapter1.html).  
* **Screen:** The unit of display (what fits in the viewport).  
* **Page:** A synthetic unit for user reference.

### **5.2 The 1024-Byte Heuristic and Position Lists**

To generate a consistent "slider" for navigation, the industry standard (derived from Adobe's RMSDK and adopted by Readium) is the **1024-byte heuristic**.22

* **The Algorithm:**  
  1. Parse the manifest to get the size of each resource in bytes.  
  2. Define a "synthetic page" as 1024 bytes of uncompressed content.  
  3. Calculate the total page count: Total Pages \= Sum(ceil(Resource Size / 1024)).  
  4. Generate a **Positions List**: A mapped array where index i corresponds to a specific Locator.  
     * Position 1 \-\> Chapter 1, Progression 0.0  
     * Position 2 \-\> Chapter 1, Progression 0.03  
     * ...  
     * Position N \-\> Chapter 2, Progression 0.0

Why use bytes instead of screens?  
Calculating the number of screens requires rendering the entire book, which is prohibitively slow. Calculating bytes is instant. The 1024-byte rule provides a stable, deterministic coordinate system that works across devices. If User A says "I am on Page 50" (based on bytes), User B will be at the same logical position on their device, even if their screen is smaller and "Page 50" renders as "Screen 120".22

## ---

**6\. Architectural Recommendations for Obsidian Plugin Development**

Based on the synthesis of these industry standards, the following architectural blueprint is recommended for the Obsidian EPUB reader plugin.

### **6.1 State Management and Data Persistence**

* **Storage Format:** Store highlights in a sidecar JSON file (e.g., BookName.epub.data) or within the Obsidian Vault's metadata. Do not modify the EPUB file itself.  
* **Schema:** Use the **Readium Locator** schema (Section 3.2). This ensures that if you later decide to sync with other Readium-compliant apps or export annotations, the data structure is standard-compliant.9  
* **CFI Generator:** Implement a robust CFI generator that handles the odd/even indexing correctly. Use the epub-cfi-resolver library as a reference implementation for handling the traversal logic.25

### **6.2 Recommended Technology Stack**

* **Renderer:** Use an **Iframe** for isolation, but ensure communication handles the postMessage passing of Locator objects.  
* **Pagination:** Use **CSS Scroll Snap** (overflow-x: scroll; scroll-snap-type: x mandatory). Avoid JavaScript-driven translate3d to eliminate highlight drift.  
* **Highlighting:** Use the **CSS Custom Highlight API** (CSS.highlights). This is the "silver bullet" for the rendering performance and stability issues mentioned in the query. It allows you to maintain a clean DOM while providing native-speed rendering of highlights.  
* **Anchoring:** Implement the **Hypothesis Fuzzy Anchoring** strategy (CFI \+ Text Quote Search). This is essential for the long-term persistence of highlights in Obsidian, where users value data longevity.

## **7\. Conclusion**

The construction of an industry-standard EPUB reader requires a sophisticated understanding of the browser's rendering pipeline. The instability of highlights ("moving during page turns") is a symptom of mismatched coordinate systems—typically a conflict between JavaScript overlays and CSS transforms. The solution lies in aligning the highlight rendering with the browser's native layout engine using the **CSS Custom Highlight API** and utilizing **CSS Scroll Snap** for pagination.

Furthermore, "position persistence" is not a single data point but a strategy. By adopting the **Readium Locator Model** and the **1024-byte heuristic**, the Obsidian plugin can provide a robust, persistent, and device-independent navigation experience. This dual-layer approach—modern native APIs for rendering and standard-compliant data structures for persistence—represents the current state-of-the-art in digital reading architectures.

## ---

**Comparative Analysis of Reading Engines**

To contextualize the architectural decisions, it is valuable to compare how existing open-source libraries handle these challenges. This comparison highlights why a custom architectural approach (integrating specific components rather than using a monolith) is often necessary for high-performance plugins.

| Feature | EPUB.js | Readium (R2) | Foliate-js | Recommended for Obsidian |
| :---- | :---- | :---- | :---- | :---- |
| **Pagination** | CSS Columns (Legacy) | CSS Scroll / Paged-X | Scrolled or Paged | **CSS Scroll Snap** |
| **Highlighting** | DOM Mutation (Mark) | Abstracted Interfaces | Overlay (Canvas/Div) | **CSS Custom Highlight API** |
| **Persistence** | CFI (Basic) | Locator (Robust) | CFI \+ Text Quote | **Locator (CFI \+ Fuzzy)** |
| **Isolation** | Iframe | Iframe / Webview | Webview | **Iframe (Sandboxed)** |
| **Page List** | Computed (Slow) | Positions List (1024b) | Computed | **Positions List (1024b)** |

### **7.1 Analysis of EPUB.js**

EPUB.js is the most common library for JavaScript-based readers. However, its reliance on the legacy CSS Columns approach and its basic implementation of CFI (often lacking the robust fallback mechanisms) makes it prone to the exact issues cited by the user.1 Its highlighting module typically modifies the DOM, leading to performance degradation on heavily annotated books.

### **7.2 Analysis of Foliate**

Foliate represents a more modern approach, utilizing native scrolling. However, its use of an overlay for highlights (overlayer.js) requires complex event listeners to keep the overlay synced with the scroll position. While effective in a desktop Linux app (GTK), inside an Electron plugin, the overhead of managing these listeners across the IPC boundary (Process separation) can introduce latency.14

### **7.3 The "Obsidian" Architecture**

The recommended architecture effectively cherry-picks the best patterns:

1. **Readium's Data Models:** For persistence and interoperability.  
2. **Native Web APIs:** (CSS Highlights, Scroll Snap) for rendering performance, bypassing the bloat of legacy compatibility layers.  
3. **Hypothesis's Algorithms:** For recovering lost anchors, ensuring the user's data remains safe even if the book file is modified.

This synthesis provides the optimal balance of performance, stability, and data integrity required for a knowledge-management centric reader.

#### **Works cited**

1. R2 Navigator Design Dilemmas \- Readium Foundation, accessed December 31, 2025, [https://readium.org/technical/r2-navigator-design-dilemmas/](https://readium.org/technical/r2-navigator-design-dilemmas/)  
2. Why moving elements with translate() is better than pos:abs top/left, accessed December 31, 2025, [https://www.paulirish.com/2012/why-moving-elements-with-translate-is-better-than-posabs-topleft/](https://www.paulirish.com/2012/why-moving-elements-with-translate-is-better-than-posabs-topleft/)  
3. What is the pagination strategy in Readium-2? · Issue \#10 \- GitHub, accessed December 31, 2025, [https://github.com/readium/architecture/issues/10](https://github.com/readium/architecture/issues/10)  
4. Readium2 Navigator Architecture \- Readium Foundation, accessed December 31, 2025, [https://readium.org/technical/r2-navigator-architecture/](https://readium.org/technical/r2-navigator-architecture/)  
5. EPUB Canonical Fragment Identifiers 1.1, accessed December 31, 2025, [https://idpf.org/epub/linking/cfi/](https://idpf.org/epub/linking/cfi/)  
6. EPUB Canonical Fragment Identifier (epubcfi) Specification, accessed December 31, 2025, [https://idpf.org/epub/linking/cfi/epub-cfi-20110908.html](https://idpf.org/epub/linking/cfi/epub-cfi-20110908.html)  
7. EPUB Canonical Fragment Identifier (epubcfi) \- Lapiz Digital Services, accessed December 31, 2025, [https://lapizdigi.wordpress.com/2016/01/05/epub-canonical-fragment-identifier-epubcfi/](https://lapizdigi.wordpress.com/2016/01/05/epub-canonical-fragment-identifier-epubcfi/)  
8. Implementation of EPUB CFI FragmentSelector \#2 \- GitHub, accessed December 31, 2025, [https://github.com/readium/annotations/discussions/2](https://github.com/readium/annotations/discussions/2)  
9. Readium2 Locator Architecture \- Readium Foundation, accessed December 31, 2025, [https://readium.org/technical/r2-locator-architecture/](https://readium.org/technical/r2-locator-architecture/)  
10. Fuzzy Anchoring \- Hypothesis, accessed December 31, 2025, [https://web.hypothes.is/blog/fuzzy-anchoring/](https://web.hypothes.is/blog/fuzzy-anchoring/)  
11. How the difference settings work, accessed December 31, 2025, [https://help.highbond.com/helpdocs/analytics/15/en-us/Content/analytics/analyzing\_data/fuzzy\_duplicates/how\_the\_difference\_settings\_work.htm](https://help.highbond.com/helpdocs/analytics/15/en-us/Content/analytics/analyzing_data/fuzzy_duplicates/how_the_difference_settings_work.htm)  
12. Levenshtein distance \- Wikipedia, accessed December 31, 2025, [https://en.wikipedia.org/wiki/Levenshtein\_distance](https://en.wikipedia.org/wiki/Levenshtein_distance)  
13. How to Programmatically Highlight Text with the CSS Custom ..., accessed December 31, 2025, [https://www.freecodecamp.org/news/how-to-programmatically-highlight-text-with-the-css-custom-highlight-api/](https://www.freecodecamp.org/news/how-to-programmatically-highlight-text-with-the-css-custom-highlight-api/)  
14. johnfactotum/foliate-js: Render e-books in the browser \- GitHub, accessed December 31, 2025, [https://github.com/johnfactotum/foliate-js](https://github.com/johnfactotum/foliate-js)  
15. Highlights disappear after scrolling · Issue \#1164 · futurepress/epub.js, accessed December 31, 2025, [https://github.com/futurepress/epub.js/issues/1164](https://github.com/futurepress/epub.js/issues/1164)  
16. CSS Custom Highlight API \- MDN Web Docs, accessed December 31, 2025, [https://developer.mozilla.org/en-US/docs/Web/API/CSS\_Custom\_Highlight\_API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)  
17. CSS Custom Highlight API Module Level 1 \- W3C, accessed December 31, 2025, [https://www.w3.org/TR/css-highlight-api-1/](https://www.w3.org/TR/css-highlight-api-1/)  
18. High-Performance Syntax Highlighting with CSS Highlights API, accessed December 31, 2025, [https://pavi2410.com/blog/high-performance-syntax-highlighting-with-css-highlights-api/](https://pavi2410.com/blog/high-performance-syntax-highlighting-with-css-highlights-api/)  
19. Custom Highlight API causing significant slowdowns with large ..., accessed December 31, 2025, [https://stackoverflow.com/questions/78140011/custom-highlight-api-causing-significant-slowdowns-with-large-amounts-of-nodes](https://stackoverflow.com/questions/78140011/custom-highlight-api-causing-significant-slowdowns-with-large-amounts-of-nodes)  
20. Intent to prototype: CSS Custom Highlight API \- Google Groups, accessed December 31, 2025, [https://groups.google.com/a/mozilla.org/g/dev-platform/c/fE37aJ\_YdA8](https://groups.google.com/a/mozilla.org/g/dev-platform/c/fE37aJ_YdA8)  
21. Consider the CSS Custom Highlight API · Issue \#21 \- GitHub, accessed December 31, 2025, [https://github.com/johnfactotum/foliate-js/issues/21](https://github.com/johnfactotum/foliate-js/issues/21)  
22. Calculating the Publication.positionList · readium architecture \- GitHub, accessed December 31, 2025, [https://github.com/readium/architecture/discussions/151](https://github.com/readium/architecture/discussions/151)  
23. radiation \- Medical Physics Publishing, accessed December 31, 2025, [https://medicalphysics.org/documents/mcdermott\_ch19.pdf](https://medicalphysics.org/documents/mcdermott_ch19.pdf)  
24. Aligning Readium positions with RMSDK pages · Issue \#123 \- GitHub, accessed December 31, 2025, [https://github.com/readium/architecture/issues/123](https://github.com/readium/architecture/issues/123)  
25. fread-ink/epub-cfi-resolver \- GitHub, accessed December 31, 2025, [https://github.com/fread-ink/epub-cfi-resolver](https://github.com/fread-ink/epub-cfi-resolver)  
26. ePUB.js vs Readium.js – A Detailed Comparison (2025) \- Kitaboo, accessed December 31, 2025, [https://kitaboo.com/epub-js-vs-readium-js-comparison-of-epub-readers/](https://kitaboo.com/epub-js-vs-readium-js-comparison-of-epub-readers/)