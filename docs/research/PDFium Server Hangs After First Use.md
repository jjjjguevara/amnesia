# **Systemic Failure Analysis: PDFium Re-initialization Deadlocks within Tokio Runtimes**

## **1\. Executive Summary and Problem Pathology**

This report constitutes a comprehensive, forensic analysis of the "Amnesia" server failure, specifically the deterministic hang observed during sequential PDF parsing operations. The application, an Obsidian plugin backend built with Rust, Axum, and the pdfium-render crate, exhibits a catastrophic failure mode where the first PDF upload processes successfully (\~8ms), while any subsequent upload—regardless of file content or size—results in an indefinite hang, terminating only upon a 120-second timeout.

The investigation identifies the root cause not as a defect in the PDF files or a resource exhaustion issue, but as a fundamental architectural violation regarding the lifecycle management of the legacy C++ PDFium library within a modern asynchronous Rust runtime. The "Amnesia" server treats the Pdfium context as a transient, request-scoped resource, initializing and destroying the global C++ library (libpdfium.dylib) with every HTTP transaction. This usage pattern triggers a race condition or deadlock within the library's global static state—specifically involving the re-acquisition of resources (likely V8 isolates, font mappers, or partition allocators) that were not cleanly released during the previous cycle.

Crucially, the execution of this unstable lifecycle within tokio::spawn\_blocking exacerbates the issue by introducing thread reuse. The Tokio runtime's blocking pool retains threads to optimize performance. A blocking thread that has previously initialized and "destroyed" PDFium retains thread-local storage (TLS) or process-global lock states that conflict with subsequent initialization attempts on the same or different threads, leading to the observed deadlock.

The failure is systemic. It stems from an impedance mismatch between the safety guarantees of Rust's ownership model (RAII) and the fragile, singleton nature of the unmanaged C++ dependency. The application architecture must effectively pivot from a "Stateless Handler" pattern to a "Stateful Singleton" or "Actor" pattern to align with the underlying engine's constraints.

The following sections dissect the technical ecosystem, the precise mechanics of the hang, the failure of the current concurrency model, and the necessary architectural remediation to ensure 99.99% stability.

## ---

**2\. The Technical Ecosystem: Host, Guest, and Bridge**

To understand the pathology of the failure, we must first perform a deep-dive analysis of the three distinct layers of the technology stack: the Host (Rust/Tokio), the Guest (PDFium), and the Bridge (pdfium-render). The failure occurs at the friction points between these layers.

### **2.1 The Host: Asynchronous Rust and the Tokio Scheduler**

The "Amnesia" server operates on **Rust**, utilizing **Tokio** as its asynchronous runtime. This is the industry standard for high-performance network services, but it imposes a strict threading model that differs significantly from traditional blocking web servers (like Apache or synchronous Python/Flask).

Tokio employs a multi-threaded work-stealing scheduler. A fixed number of worker threads (typically equal to the number of logical CPU cores) multiplex thousands of lightweight tasks (Futures). However, PDF parsing is a CPU-bound, blocking operation. It cannot yield control to the scheduler. If a parsing task were run directly on an async worker thread, it would block the event loop, preventing other requests (like health checks or keep-alives) from being processed.

To mitigate this, the developers correctly identified the need to offload this work and utilized tokio::task::spawn\_blocking.1 This function is critical to our analysis.

#### **2.1.1 The Mechanism of spawn\_blocking**

When spawn\_blocking is invoked, Tokio does not spawn a fresh, clean Operating System thread for every call. Instead, it submits the provided closure to a dedicated thread pool specifically optimized for blocking operations.2

This pool is dynamic but conservative. It spawns threads as needed to handle load, but crucially, **it keeps threads alive** for a configurable duration (often seconds or minutes) to service future blocking tasks without the overhead of thread creation.3

The Implication for Amnesia:  
When "Request 1" is processed, spawn\_blocking selects BlockingThread\_1. This thread executes the PDFium initialization. When the task finishes, BlockingThread\_1 is not destroyed; it returns to the pool, dormant but alive. When "Request 2" arrives, the scheduler is highly likely to reuse BlockingThread\_1 for the new task to maximize cache locality and minimize latency.  
If BlockingThread\_1 retains any Thread-Local Storage (TLS) keys, floating point control words, or specific stack configurations from the interaction with Request 1, the execution environment for Request 2 is "dirty." It is not a fresh start. This persistence is a primary vector for the crash/hang when dealing with legacy C libraries that assume a "clean slate" upon initialization.

### **2.2 The Guest: PDFium (The Chromium Engine)**

**PDFium** is the PDF rendering engine extracted from the Google Chromium project. It is a massive, complex C++ codebase designed primarily for the browser context. In Chrome, PDFium typically runs in a highly controlled, process-isolated environment (the "renderer process"). This context is vital: in a browser, if a PDF tab crashes, the process dies, and memory is reclaimed by the OS. PDFium was not originally designed as a general-purpose library for long-running server processes.

#### **2.2.1 Global State and Singletons**

PDFium relies heavily on global static variables to manage its internal state. These include:

* **The Module Manager (CPDF\_ModuleMgr):** Manages the loading of codecs (JPEG, JPEG2000, JBIG2) and color spaces.  
* **Font Mappers:** Global caches mapping PDF font names to system fonts.  
* **V8 Isolates:** If JavaScript support is compiled in (which is common in default builds), PDFium initializes the V8 JavaScript engine.4 V8 is notoriously strictly coupled to the process lifecycle.  
* **PartitionAlloc:** Chromium's custom memory allocator, which may override standard malloc/free and relies on global locks and thread caches.

#### **2.2.2 The "Thread-Hostile" Nature**

The library is explicitly documented as **not thread-safe**.6 The documentation states clearly: *"None of the PDFium APIs are thread-safe. They expect to be called from a single thread."*

While many developers interpret "not thread-safe" to mean "don't access the same document from two threads," PDFium's restriction is more severe. The initialization (FPDF\_InitLibrary) and destruction (FPDF\_DestroyLibrary) affect the **entire process space**. They modify global statics. Calling Init on Thread A and Destroy on Thread A, followed by Init on Thread B, is undefined behavior if the library was not designed to support re-entrant initialization.

#### **2.2.3 The V8 Factor**

The snippet data indicates that pdfium-render can enable V8 support (pdfium\_enable\_v8).4 Even if the user is not actively using JavaScript features in their PDFs, if the linked libpdfium.dylib contains V8 symbols, FPDF\_InitLibrary will attempt to initialize the V8 platform.

V8 has historically had strict limitations on re-initialization. Once the V8 platform is shut down (via FPDF\_DestroyLibrary), attempting to bring it back up in the same process often results in deadlocks or crashes due to the complexity of recreating global platform threads and task runners.

### **2.3 The Bridge: pdfium-render Abstractions**

The Rust crate pdfium-render provides "idiomatic" Rust bindings to this C++ engine. It attempts to map C++ concepts to Rust's ownership model (RAII).

* **Construction:** The user calls Pdfium::new(...). Internally, this triggers the FFI call FPDF\_InitLibraryWithConfig.8  
* **Destruction:** When the Pdfium struct goes out of scope (at the end of the spawn\_blocking closure), the Drop trait implementation is triggered. This calls FPDF\_DestroyLibrary.4

The Architectural Trap:  
In Rust, creating and dropping structs is cheap and safe. A developer naturally assumes Pdfium behaves like a Vec\<u8\>—you make it, use it, and drop it. However, Pdfium is not a container; it is a handle to a global singleton.  
By placing Pdfium::new inside the request handler, the Amnesia server attempts to initialize and destroy the entire PDF engine **per request**.

* Request 1: Init \-\> Render \-\> Destroy.  
* Request 2: Init (Hang).

This cycle demands that FPDF\_DestroyLibrary perfectly cleans up every single byte of global state, every lock, and every TLS slot, returning the process to a pristine state. If it fails to do so—leaving behind a "tombstone" lock or a dangling pointer—the subsequent Init call will walk into a corrupted environment and deadlock.

## ---

**3\. Pathology of the Failure: The "Hang" Analysis**

We will now reconstruct the precise timeline of the failure, mapping the observed server logs to the internal state of the stack. The key observation is that the server "hangs" (deadlocks) rather than crashing (segfaulting), which points to a synchronization primitive (Mutex/Semaphore) rather than a memory access violation.

### **3.1 The "First Request" Success Cycle**

1. **State Zero:** The server starts. The process memory is clean. libpdfium.dylib is loaded into the address space, but its symbols are uninitialized.  
2. **Request Ingress:** Axum receives the first PDF upload.  
3. **Task Allocation:** tokio::spawn\_blocking requests a thread. The pool creates BlockingThread\_1.  
4. **Library Initialization:** Pdfium::new() calls FPDF\_InitLibrary.  
   * **Lock Acquisition:** The library acquires a global lock to set up the CPDF\_ModuleMgr.  
   * **Resource Allocation:** Memory allocators are initialized. Font maps are loaded from the macOS system path.  
   * **State Flag:** An internal boolean g\_bLibraryInitialized (hypothetical name based on common C patterns) is set to true.  
5. **Processing:** The application calls load\_pdf\_from\_byte\_slice. The document is parsed. Pages are iterated. This takes \~8ms.  
6. **Cleanup (The Danger Zone):** The closure ends. Pdfium drops. FPDF\_DestroyLibrary is called.  
   * **Tear Down:** The library attempts to free the module manager, unload fonts, and destroy the V8 isolate.  
   * **The Leak:** Critically, it is highly probable that FPDF\_DestroyLibrary **does not release a specific OS-level resource** or fails to reset a thread-local flag on BlockingThread\_1. For example, it might destroy the global mutex object but leave the thread's "I am holding a lock" flag set, or vice versa.

### **3.2 The "Second Request" Hang Cycle**

1. **Request Ingress:** Axum receives the second PDF.  
2. **Task Allocation:** tokio::spawn\_blocking requests a thread.  
   * **Scenario A (Reuse):** The scheduler sees BlockingThread\_1 is idle and assigns the task to it. This thread is "tainted" by the previous execution.  
   * **Scenario B (New Thread):** The scheduler spawns BlockingThread\_2.  
3. **Re-Initialization:** Pdfium::new() calls FPDF\_InitLibrary.  
4. **The Deadlock:** The execution flow enters the C++ library and stops.  
   * **Mechanism:** The Init function checks a global lock or a resource state.  
   * *Possibility 1 (The Zombie Lock):* The destructed library left a Mutex in a locked state (or undefined state). The new Init call waits for this Mutex. Since no other thread is running to release it, it waits forever.  
   * *Possibility 2 (The TLS Trap):* BlockingThread\_1 (reused) checks its Thread Local Storage. It finds a key indicating "I am already initialized." It proceeds to access a global object. However, that global object was deleted by DestroyLibrary. The code enters an infinite loop checking for the object's regeneration, or blocks on a pthread\_cond\_wait for a signal that will never come.  
5. **Timeout:** The external HTTP client (Obsidian) waits 120 seconds and severs the connection. The server thread remains permanently stuck (leaked).

### **3.3 Confirmation via "Restart" Behavior**

The user notes: "Restart server → First PDF works again."  
Restarting the server kills the OS process. This forces the Operating System to reclaim all memory, close all file handles, and destroy all mutexes. The memory space is fresh. This confirms the issue is strictly related to in-process state corruption and not related to the specific PDF file content (since the same file fails on the second try).

### **3.4 Data Support from Research**

* Snippet 9: Discusses how InitLibrary failures lead to subsequent crashes/hangs.  
* Snippet 6: Google engineers explicitly advise against multi-threaded access and suggest multi-process architectures for stability.  
* Snippet 5: Describes race conditions in initialization when multiple plugins attempt to initialize PDFium, leading to "severe race conditions."

### **3.5 Why thread\_local\! didn't work**

The user tried: *"Thread-local PDFium instances: Store separate Pdfium instance per thread using thread\_local\! macro → Same behavior"*

This failed because FPDF\_InitLibrary initializes **Process Global** state, not just thread-local state. Even if Thread A has its own Pdfium handle and Thread B has its own, they both contend for the *same* global C++ variables inside libpdfium.dylib. When Thread A initializes, it sets the global state. If Thread B tries to initialize, it might corrupt Thread A's state or deadlock waiting for Thread A. Thread-local storage in Rust does not isolate the underlying C++ global memory.

## ---

**4\. Architectural Misalignment: Stateless vs. Singleton**

The failure represents a classic architectural pattern mismatch.

| Pattern | Rust/Axum Expectation | PDFium Reality | Result |
| :---- | :---- | :---- | :---- |
| **Lifecycle** | Ephemeral. Created per request. Destroyed immediately. | Long-lived. Initialized once per process. Destroyed at exit. | **Instability.** Stressing the init/destroy paths exposes bugs. |
| **Concurrency** | Shared-Nothing. Tasks move between threads. | Thread-Hostile. Expects single-thread affinity or strict locking. | **Race Conditions.** Thread reuse in Tokio confuses thread-affinity checks. |
| **State** | Owned types (struct). Explicit lifetimes. | Global static variables. Hidden implicit state. | **Corruption.** Rust drops the handle, but C++ globals persist or rot. |

### **4.1 The Validity of Server-Side Parsing**

The user correctly identified the need for server-side parsing (Performance, Caching, OCR). However, the implementation treated the *Parsing Engine* as a lightweight utility (like a JSON parser) rather than a heavy Subsystem (like a Database).

A Database connection pool initializes connections once and reuses them. It does not spin up a new Postgres instance for every query. Similarly, the PDFium engine must be treated as a heavy subsystem.

## ---

**5\. Remediation Strategy A: The Singleton Actor (Recommended)**

To resolve the deadlock, the architecture must ensure that FPDF\_InitLibrary is called exactly **once** and FPDF\_DestroyLibrary is never called (until shutdown). Furthermore, all calls to PDFium must happen on the same thread to satisfy thread-affinity constraints.

The **Actor Pattern** is the optimal solution. It creates a dedicated worker thread responsible for all PDF operations.

### **5.1 Architecture Diagram**

Fragmento de código

graph TD  
    User \--\> AxumHandler  
    subgraph Tokio Runtime  
        AxumHandler \-- Async Channel (Send Job) \--\> PdfActor  
        AxumHandler \-- Await Response \--\> AxumHandler  
    end  
    subgraph OS Thread (Dedicated)  
        PdfActor  
        Init \--\> Loop  
        Loop{Wait for Job}  
        Loop \-- New Job \--\> Parse  
        Parse \-- Send Result \--\> Loop  
    end

### **5.2 Implementation Details**

This solution uses std::thread to spawn a non-async thread that lives outside the Tokio pool. This ensures 100% isolation from Tokio's thread stealing behaviors.

Rust

use std::thread;  
use tokio::sync::{mpsc, oneshot};  
use pdfium\_render::prelude::\*;

// 1\. Define the Message Protocol  
struct PdfRequest {  
    file\_bytes: Vec\<u8\>,  
    responder: oneshot::Sender\<Result\<PdfMetadata, String\>\>,  
}

struct PdfMetadata {  
    page\_count: u16,  
    text\_content: Vec\<String\>,  
}

// 2\. The Actor Handle (Shared State)  
\#\[derive(Clone)\]  
pub struct PdfService {  
    sender: mpsc::Sender\<PdfRequest\>,  
}

impl PdfService {  
    pub fn new() \-\> Self {  
        // Create a channel for jobs  
        let (tx, mut rx) \= mpsc::channel::\<PdfRequest\>(100);

        // Spawn the dedicated OS thread (The Actor)  
        thread::spawn(move |

| {  
            // \--- CRITICAL SECTION: INITIALIZATION \---  
            // Initialize PDFium exactly ONCE.  
            // This happens when the server starts, not per request.  
            let pdfium \= match Pdfium::new(  
                Pdfium::bind\_to\_library("libpdfium.dylib")  
               .or\_else(|\_| Pdfium::bind\_to\_system\_library())  
            ) {  
                Ok(p) \=\> p,  
                Err(e) \=\> {  
                    eprintln\!("CRITICAL: Failed to init PDFium: {}", e);  
                    return;  
                }  
            };  
              
            eprintln\!("INFO: PDFium Actor Initialized.");

            // \--- PROCESS LOOP \---  
            // This loop keeps the thread (and PDFium) alive indefinitely.  
            while let Some(req) \= rx.blocking\_recv() {  
                let result \= process\_pdf\_safe(\&pdfium, \&req.file\_bytes);  
                let \_ \= req.responder.send(result);  
            }

            // \--- CLEANUP \---  
            // Only reached if the sender channel is dropped (server shutdown).  
            eprintln\!("INFO: PDFium Actor shutting down.");  
            // Pdfium drops here, calling DestroyLibrary once at exit.  
        });

        Self { sender: tx }  
    }

    // Axum Handler Interface  
    pub async fn parse\_pdf(&self, bytes: Vec\<u8\>) \-\> Result\<PdfMetadata, String\> {  
        let (resp\_tx, resp\_rx) \= oneshot::channel();  
          
        // Send job to actor  
        self.sender.send(PdfRequest {  
            file\_bytes: bytes,  
            responder: resp\_tx,  
        }).await.map\_err(|\_| "PDF Actor died")?;

        // Await result  
        resp\_rx.await.map\_err(|\_| "PDF processing cancelled")?  
    }  
}

// Helper function running inside the Actor Thread  
fn process\_pdf\_safe(pdfium: \&Pdfium, bytes: &\[u8\]) \-\> Result\<PdfMetadata, String\> {  
    let doc \= pdfium.load\_pdf\_from\_byte\_slice(bytes, None)  
       .map\_err(|e| e.to\_string())?;

    let mut pages \= Vec::new();  
    for page in doc.pages().iter() {  
        pages.push(page.text().map(|t| t.all()).unwrap\_or\_default());  
    }

    Ok(PdfMetadata {  
        page\_count: doc.pages().len(),  
        text\_content: pages,  
    })  
}

### **5.3 Why this Fixes the Hang**

1. **Single Initialization:** Pdfium::new is called only once during PdfService::new. The global state is set up and never torn down between requests. The "Resurrection Paradox" is eliminated.  
2. **Thread Affinity:** All FPDF\_\* calls occur on the single thread spawned by std::thread::spawn. Even if PDFium uses Thread Local Storage, it is always accessed from the same thread ID.  
3. **Isolation:** The actor runs independently of tokio::spawn\_blocking. Even if the Tokio pool churns threads, the PDFium thread remains constant.

### **5.4 Performance Considerations**

* **Throughput:** This creates a serial bottleneck. Only one PDF can be parsed at a time.  
* **Mitigation:** Given the performance metric (\~8ms per PDF), a single thread can theoretically handle \~125 requests per second. For a personal Obsidian plugin server, this is overwhelmingly sufficient.  
* **Scaling:** If higher concurrency is needed, you could spawn a *pool* of Actor threads (e.g., 4 threads). However, because PDFium uses *process-global* state, multiple threads in the same process might still contend on global locks. The safest high-scale approach is **Process Isolation** (running a separate binary), but that is likely overkill here.

## ---

**6\. Remediation Strategy B: The Global Mutex (Alternative)**

If the Actor model is deemed too complex to implement immediately, a simpler (though slightly riskier) approach is wrapping the Pdfium instance in a global Mutex.

### **6.1 Concept**

Instead of an actor thread, we create a global singleton Pdfium instance wrapped in Arc\<std::sync::Mutex\<Pdfium\>\>.

### **6.2 Implementation**

Rust

struct AppState {  
    pdfium: Arc\<std::sync::Mutex\<Pdfium\>\>,  
}

// In main:  
let pdfium \= Pdfium::new(...).unwrap();  
let state \= Arc::new(AppState {   
    pdfium: Arc::new(std::sync::Mutex::new(pdfium))   
});

// In handler:  
async fn upload(State(state): State\<Arc\<AppState\>\>,...) {  
    tokio::task::spawn\_blocking(move |

| {  
        let pdfium \= state.pdfium.lock().unwrap(); // Wait for exclusive access  
        let doc \= pdfium.load\_pdf\_from\_byte\_slice(...);  
        // Process...  
        // Lock releases here  
    }).await;  
}

### **6.3 Risk Assessment**

* **Fixes Initialization:** Yes, Init is only called once.  
* **Fixes Thread Affinity:** **No.** The Mutex guarantees exclusive access, but spawn\_blocking might execute the critical section on Thread\_A for Request 1 and Thread\_B for Request 2\. If PDFium caches data in TLS (Thread Local Storage), using it from different threads (even sequentially) could lead to crashes or subtle bugs.  
* **Recommendation:** Use this only if the Actor model is impossible. The Actor model is superior because it guarantees thread consistency.

## ---

**7\. Comparative Analysis of Alternative Libraries**

If the stability of PDFium remains a concern despite architectural fixes, switching libraries is the remaining option.

| Library | Engine | Safety | Rendering | Text Extraction | Recommendation |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **pdfium-render** | C++ (PDFium) | Low (Unsafe FFI) | **Excellent** | **Excellent** | **Keep** (With Actor) |
| **lopdf** | Pure Rust | High (Safe Rust) | **None** | Poor | **Avoid** |
| **pdf-extract** | C (Poppler/MuPDF) | Low (Unsafe FFI) | Good | Good | **Avoid** |
| **tesseract** | C++ (OCR) | Low | N/A | OCR Only | Use as Add-on |

* **lopdf:** This is a PDF *parser*, not a renderer. It can read the object tree (dictionaries, streams), but it cannot render pages to images (required for your "PDF rendering" feature). Its text extraction is rudimentary and often fails on complex encodings or layout-based text.  
* **pdf-extract:** Relies on Poppler or MuPDF. These libraries have similar thread-safety issues to PDFium and often stricter licensing (GPL vs PDFium's Apache 2.0). You would likely trade one set of FFI headaches for another.

**Conclusion:** For an application requiring both rendering (visuals) and accurate text extraction (search/highlights), **PDFium is the industry standard**. The issue is not the tool, but the handling of the tool.

## ---

**8\. Final Recommendations and Implementation Plan**

The "Amnesia" server must pivot from a stateless request architecture to a stateful actor architecture for its PDF processing subsystem.

### **Step 1: Refactor to Actor Model**

Implement the **PdfService** struct defined in Section 5.2.

* Move pdfium-render dependency to PdfService.  
* Remove Pdfium::new() from the Axum handler.  
* Ensure PdfService is initialized in main() and passed to Axum via .with\_state().

### **Step 2: Configure Dependencies**

Ensure your Cargo.toml enables the thread\_safe and static features for pdfium-render to ensure the bindings generated are as robust as possible, even though the Actor model enforces safety externally.

Ini, TOML

pdfium-render \= { version \= "0.8", features \= \["thread\_safe", "static"\] }

### **Step 3: Library Management**

* Ensure libpdfium.dylib matches your architecture (Apple Silicon / arm64). Using an x86\_64 dylib on M1 via Rosetta can sometimes cause obscure linkage hangs, though the logs suggest the code runs initially, ruling this out as the primary cause.  
* If possible, use a build of PDFium that **disables V8** (JavaScript) if you do not strictly need to support PDF forms with JS logic. This removes a massive source of global state complexity.

### **Step 4: Verification**

After refactoring, verify the fix by running the reproduction steps:

1. Start Server.  
2. Upload PDF A (Success).  
3. Upload PDF B (Success).  
4. Upload PDF A again (Success).

By isolating the "thread-hostile" PDFium library into a dedicated, single-threaded Actor, the "Amnesia" server will achieve the stability required for a production-grade reading tool, eliminating the deadlock and ensuring consistent performance.

#### **Obras citadas**

1. spawn\_blocking in tokio::task \- Rust, fecha de acceso: enero 6, 2026, [https://jabber-tools.github.io/google\_cognitive\_apis/doc/0.2.0/tokio/task/fn.spawn\_blocking.html](https://jabber-tools.github.io/google_cognitive_apis/doc/0.2.0/tokio/task/fn.spawn_blocking.html)  
2. spawn\_blocking in tokio::task \- Rust \- Docs.rs, fecha de acceso: enero 6, 2026, [https://docs.rs/tokio/latest/tokio/task/fn.spawn\_blocking.html](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)  
3. Do tokio reuse spawn\_blocking threads? \#3251 \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/tokio-rs/tokio/discussions/3251](https://github.com/tokio-rs/tokio/discussions/3251)  
4. pdfium-render \- crates.io: Rust Package Registry, fecha de acceso: enero 6, 2026, [https://crates.io/crates/pdfium-render](https://crates.io/crates/pdfium-render)  
5. PDFium initialization conflict across isolates · Issue \#474 \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/espresso3389/pdfrx/issues/474](https://github.com/espresso3389/pdfrx/issues/474)  
6. PDFium thread safety \- Google Groups, fecha de acceso: enero 6, 2026, [https://groups.google.com/g/pdfium/c/HeZSsM\_KEUk](https://groups.google.com/g/pdfium/c/HeZSsM_KEUk)  
7. public/fpdfview.h \- pdfium \- Git at Google, fecha de acceso: enero 6, 2026, [https://pdfium.googlesource.com/pdfium/+/main/public/fpdfview.h](https://pdfium.googlesource.com/pdfium/+/main/public/fpdfview.h)  
8. ajrcarey/pdfium-render: A high-level idiomatic Rust wrapper ... \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/ajrcarey/pdfium-render](https://github.com/ajrcarey/pdfium-render)  
9. FPDF\_InitLibrary not getting called · Issue \#4 · pvginkel/PdfiumViewer, fecha de acceso: enero 6, 2026, [https://github.com/pvginkel/PdfiumViewer/issues/4](https://github.com/pvginkel/PdfiumViewer/issues/4)