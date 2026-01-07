# **Architectural Analysis: Cross-Plugin Svelte Component Sharing in Obsidian**

## **1\. Executive Summary**

The architectural integration of the **Doc Doctor** plugin (serving as a host HUD) and the **Amnesia** plugin (serving as a content provider) within the Obsidian ecosystem presents a complex case study in modular frontend design. The core challenge lies in orchestrating user interface components across isolated build boundaries without adhering to a unified, monolithic build process. The detected runtime error, TypeError: Cannot read properties of undefined (reading 'context'), acts as a critical failure signal indicating a misalignment in the Svelte runtime context management caused by the independent bundling strategies employed by esbuild.

This report provides an exhaustive analysis of the architectural patterns available for resolving this interoperability crisis. It dissects the mechanics of Svelte's compilation model, the constraints of the Electron-based Obsidian environment, and the specific limitations imposed by independent dependency graphs. Through a rigorous evaluation of six distinct integration strategies—ranging from Web Components to Shared Runtimes—the analysis determines that the **Renderer Pattern (Inversion of Control)** offers the superior balance of isolation, stability, and developer ergonomics.

By decoupling the component's *definition* from its *instantiation*, the Renderer Pattern ensures that each plugin manages its own Svelte runtime lifecycle while sharing a neutral DOM interface for visual composition. This approach mitigates the risk of "DLL Hell," prevents global namespace pollution, and maintains strict type safety through shared TypeScript interfaces. The following sections detail the theoretical underpinnings of the runtime conflict, evaluate alternative strategies with granular tradeoff analysis, and provide a comprehensive implementation guide for the recommended architecture.

## **2\. Technical Context: The Obsidian Plugin Runtime Environment**

### **2.1 The Electron Process Model and Plugin Isolation**

To understand the root cause of the context mismatch, one must first analyze the execution environment provided by Obsidian. Obsidian is built on Electron, utilizing a multi-process architecture where the main process handles system-level operations (file system access via Node.js APIs) and the renderer process handles the UI (Chromium). Plugins are loaded into the renderer process.1

Unlike a traditional web application where a single bundle.js contains the application logic and all vendor libraries (including the framework runtime), Obsidian plugins are loaded as separate scripts. Each plugin is required to bundle its own dependencies to ensure it functions autonomously. This architecture, while robust for plugin independence, creates a fragmented dependency landscape. When Plugin A (Doc Doctor) and Plugin B (Amnesia) both utilize Svelte, the esbuild process injects a copy of the Svelte runtime into *each* plugin's main.js file.

This creates a scenario known as the "Dual Package Hazard" or "Double Bundle." In memory, there is not one svelte library; there are two distinct, encapsulated libraries: svelte\_DocDoctor and svelte\_Amnesia. They do not share state, scope, or lifecycle management variables.

### **2.2 Anatomy of the Svelte 4 Runtime Mismatch**

The error TypeError: Cannot read properties of undefined (reading 'context') is non-trivial and points to the specific internal mechanics of Svelte 4's component initialization phase.

Svelte 4 compiles .svelte files into JavaScript classes that extend SvelteComponent. The constructor of these classes calls an internal initialization function, typically init(), imported from svelte/internal. This init function relies on a global variable within the svelte/internal module—often referred to as current\_component—to track which component is currently being set up. This mechanism allows lifecycle functions like onMount, onDestroy, and getContext to register themselves with the correct component instance without needing the component instance to be passed explicitly as an argument.2

**The Failure Sequence:**

1. **Context Establishment**: When Doc Doctor initializes, it sets up its environment using its bundled version of Svelte (Runtime\_A).  
2. **Cross-Boundary Instantiation**: Doc Doctor attempts to instantiate a component class exported by Amnesia (AmnesiaComponent).  
3. **Execution Context Split**: The AmnesiaComponent class definition resides in Amnesia's bundle. Its constructor calls init() from Amnesia's bundled Svelte (Runtime\_B).  
4. **The Void**: Because Runtime\_B has not been "primed" or activated by Doc Doctor (which is operating via Runtime\_A), Runtime\_B's current\_component tracker is likely null or undefined.  
5. **Crash**: When the component constructor attempts to read the context or lifecycle stack from Runtime\_B, it fails to find the expected initialization state, resulting in the property access error on undefined.

This confirms that passing uninstantiated Svelte component classes across bundle boundaries is architecturally unsound in an environment that does not strictly enforce a singleton framework runtime.

## ---

**3\. Detailed Evaluation of Solution Directions**

The following sections analyze six potential architectural patterns to resolve this isolation issue. Each is evaluated against criteria of **Runtime Safety**, **Data Passing Complexity**, **Styling Capabilities**, and **Maintenance Overhead**.

### **3.1 Solution Direction 1: The Renderer Pattern (Inversion of Control)**

The Renderer Pattern acts as the primary recommendation for this integration. It relies on the principle of Inversion of Control (IoC), where the consumer (Doc Doctor) does not attempt to instantiate the producer's (Amnesia's) components. Instead, the consumer provides a container (a DOM element) and delegates the responsibility of rendering to the producer.5

#### **Mechanism of Action**

1. **Registry**: Doc Doctor exposes a ProviderRegistry API.  
2. **Registration**: Amnesia registers a provider object containing a mount function.  
3. **Delegation**: When Doc Doctor wants to display the reader, it calls provider.mount(targetElement, props).  
4. **Internalization**: Inside the mount function—which physically resides within Amnesia's code bundle—Amnesia performs new ReaderComponent({ target: targetElement, props }).  
5. **Runtime Consistency**: Since the new keyword is invoked inside Amnesia's scope, it utilizes Runtime\_B. The component initializes correctly, finds its context, and mounts to the DOM element provided by Runtime\_A. The DOM acts as the framework-agnostic bridge.

#### **Advantages**

* **Absolute Runtime Isolation**: Svelte runtimes never interact. Doc Doctor treats the mounted component as a "black box" handled via a returned interface (the ComponentHandle).  
* **Prop Flexibility**: Unlike HTML attributes, JavaScript function arguments can pass complex types by reference. Doc Doctor can pass a complex object (e.g., an Obsidian TFile or a reactive Store) directly to Amnesia without serialization.7  
* **Styling Integrity**: Svelte's scoped styling (.svelte-hash) functions normally. Global styles from Obsidian (themes, font sizes) cascade naturally into the component, ensuring UI consistency.9

#### **Tradeoffs**

* **Lifecycle Management**: The host must explicitly call a destroy() method on the handle provided by the mounting function. Failure to do so leads to memory leaks, as the host's framework won't automatically clean up the guest's runtime.11

### **3.2 Solution Direction 2: Web Components Bridge (Custom Elements)**

Svelte offers a compiler option \<svelte:options customElement="tag-name" /\> that allows components to be compiled as standard Web Components (Custom Elements).13

#### **Mechanism of Action**

Amnesia compiles its reader not as a standard Svelte class, but as a Custom Element class extending HTMLElement. This element is registered with the browser's customElements registry. Doc Doctor instantiates it via document.createElement('amnesia-reader') or by injecting HTML string.

#### **Analysis of Capabilities**

* **Encapsulation**: Web Components default to using Shadow DOM. This provides hard isolation for CSS. Styles from Doc Doctor will not bleed into Amnesia, and vice-versa.15  
* **Interoperability**: The browser mediates the interaction. Doc Doctor technically doesn't need to know Amnesia uses Svelte; it just sees an HTML tag.

#### **Critical Friction Points**

1. **Prop Serialization**: HTML attributes accept only strings. Passing a generic Javascript object (like the plugin settings or file metadata) requires setting properties on the DOM node imperatively (element.prop \= value). Svelte 4 has specific heuristics for mapping attributes to props that can be fragile if accessors: true is not explicitly set or if naming conventions (kebab-case vs camelCase) are mismatched.17  
2. **Theming Difficulties**: The Shadow DOM blocks global styles. Obsidian's dynamic theming (switching between Light/Dark modes, font updates) relies on CSS variables and global classes on the \<body\>. While CSS variables *do* pierce the Shadow DOM, global utility classes do not. Amnesia would need to implement a complex style injection strategy to look "native" to Obsidian.16  
3. **Event Retargeting**: Events dispatched from within a Shadow DOM are retargeted. Standard Svelte event dispatching (on:event) might behave unexpectedly or require manual event listeners on the DOM node.19

### **3.3 Solution Direction 3: Shared External Runtime**

This strategy attempts to emulate a peer-dependency model by configuring esbuild to exclude Svelte from the bundle and loading it from a shared global source.

#### **Mechanism of Action**

Both plugins mark svelte and svelte/internal as external in their esbuild.config.mjs. A third plugin (or Doc Doctor itself) bundles Svelte and exposes it on window.Svelte.

#### **Risk Assessment: "DLL Hell"**

This approach is highly discouraged in the Obsidian ecosystem for several reasons:

1. **Version Coupling**: If Doc Doctor upgrades to Svelte 5 (which introduces Runes and deprecates many internals), but Amnesia was compiled against Svelte 4, the shared runtime will fail to execute Amnesia's code. This creates a brittle dependency chain where plugins break each other based on update cadence.20  
2. **Namespace Pollution**: Obsidian plugins are expected to be good citizens. Polluting the global window object with a framework runtime risks collisions with other plugins attempting the same strategy or with Obsidian's own internal libraries.21  
3. **Tree Shaking Inefficiency**: Svelte is designed as a compiler that compiles *away* the framework. By forcing a runtime library, you lose the benefits of tree-shaking, potentially loading unused parts of the library into memory.22

### **3.4 Solution Direction 4: Iframe Isolation**

Embedding Amnesia's view inside an \<iframe\> within the Doc Doctor HUD provides the strictest possible isolation.

#### **Mechanism of Action**

Doc Doctor renders an \<iframe\> pointing to a local resource served by Amnesia. Communication occurs via window.postMessage.

#### **Analysis**

* **Security & Stability**: Maximum stability. A crash in Amnesia cannot crash Obsidian or Doc Doctor.  
* **Performance Overhead**: High. Instantiating a full browser context (even a child frame) is resource-intensive.  
* **Data Serialization**: Passing the EPUB file data requires serializing the binary blob and sending it over the postMessage bus. This is asynchronous and CPU intensive for large files. It eliminates the ability to share references to live objects (like the Obsidian App instance), forcing a complete disconnect from the host API capabilities.24  
* **UX Friction**: Iframes often struggle with sizing, scrollbars, and event bubbling (e.g., hotkeys not working when focus is in the iframe).

### **3.5 Solution Direction 5: Data-Only Provider Pattern**

In this pattern, Amnesia does not provide UI components at all. Instead, it provides *data* that Doc Doctor is responsible for rendering.

#### **Mechanism of Action**

Amnesia exports a getEpubData() function. Doc Doctor consumes this data and renders it using its *own* internal EPUB rendering logic (or a generic renderer).

#### **Analysis**

* **Viability**: This defeats the purpose if Amnesia's value proposition is its specialized rendering logic (e.g., custom annotations, PDF highlighting). If Doc Doctor has to implement the renderer, it duplicates effort and creates a tight coupling to the data format.  
* **Use Case**: This is suitable for simple data (e.g., "To-Do items" or "Backlinks"), but unsuitable for complex, interactive views like an EPUB reader.

### **3.6 Solution Direction 6: HUD Takeover (Workspace Leaf Pattern)**

Amnesia ignores Doc Doctor's internal rendering engine and requests its own Obsidian Workspace Leaf, which it then places adjacent to Doc Doctor or manages via Obsidian's native tab system.

#### **Mechanism of Action**

Amnesia registers a View with registerView. Doc Doctor's "HUD" simply contains a link or command to open that View.

#### **Analysis**

* **Alignment**: This aligns best with Obsidian's native API architecture.  
* **UX mismatch**: If the requirement is a *HUD* (Heads-Up Display)—implying a specific overlay or integrated dashboard experience—opening a separate tab breaks the UX requirement. The user specifically requested integration *into* the Doc Doctor HUD.

## ---

**4\. Comprehensive Architecture Recommendation: The Renderer Pattern**

Based on the comparative analysis, the **Renderer Pattern** is the only solution that satisfies the requirements of integration, performance, and stability without introducing brittle dependencies. It treats the DOM as the universal interface layer.

### **4.1 Implementation Strategy: The Contract Interface**

The foundation of this pattern is a shared contract. This should be defined in a TypeScript declaration file (\*.d.ts) included in Doc Doctor's repository and distributed to providers.

TypeScript

// hud-contract.d.ts

/\*\*  
 \* The handle returned by a provider when it mounts a component.  
 \* This allows the host (Doc Doctor) to control the lifecycle of the guest (Amnesia).  
 \*/  
export interface ComponentHandle {  
    /\*\*  
     \* Called by Host when data changes.   
     \* The provider should update its internal component state.  
     \*/  
    update(props: Record\<string, any\>): void;

    /\*\*  
     \* Called by Host when the tab is closed or switched.  
     \* The provider MUST destroy the Svelte instance to prevent memory leaks.  
     \*/  
    destroy(): void;  
}

/\*\*  
 \* The interface for the mounting function exported by the Provider.  
 \*/  
export type MountFunction \= (  
    target: HTMLElement,   
    props: Record\<string, any\>  
) \=\> ComponentHandle;

/\*\*  
 \* The Registry entry object.  
 \*/  
export interface HUDProviderDefinition {  
    id: string;  
    label: string;  
    icon?: string;  
    mount: MountFunction;  
}

### **4.2 Provider Implementation (Amnesia Plugin)**

Amnesia implements the MountFunction. It imports its own Svelte component and manually instantiates it using the client-side API. Note that this code runs within Amnesia's bundle context.

TypeScript

// src/integration/hud-provider.ts  
import ReaderView from '../components/ReaderView.svelte';  
import type { MountFunction, ComponentHandle } from './hud-contract';

export const mountReader: MountFunction \= (target, props) \=\> {  
    // 1\. Instantiation: Uses Amnesia's bundled Svelte runtime.  
    // 'target' is a real DOM node passed from Doc Doctor.  
    const component \= new ReaderView({  
        target: target,  
        props: props,  
        intro: true // Optional: plays transition animations on mount  
    });

    // 2\. Return the control handle  
    return {  
        update: (newProps) \=\> {  
            // Svelte 4 Client-side API for updates  
            component.$set(newProps);  
        },  
        destroy: () \=\> {  
            // CRITICAL: Cleanup listeners and DOM nodes  
            component.$destroy();  
        }  
    };  
};

### **4.3 Host Implementation (Doc Doctor Plugin)**

Doc Doctor creates the DOM container and manages the active provider.

TypeScript

// src/ui/HUDView.ts  
import { ItemView, WorkspaceLeaf } from 'obsidian';  
import type { ComponentHandle, HUDProviderDefinition } from './hud-contract';

export class HUDView extends ItemView {  
    private activeComponent: ComponentHandle | null \= null;  
    private currentContainer: HTMLElement;

    constructor(leaf: WorkspaceLeaf) {  
        super(leaf);  
    }

    //... standard Obsidian view setup...

    /\*\*  
     \* Renders a specific provider into the view.  
     \*/  
    async switchTab(provider: HUDProviderDefinition, data: any) {  
        // 1\. Cleanup existing component  
        if (this.activeComponent) {  
            this.activeComponent.destroy();  
            this.activeComponent \= null;  
        }

        // 2\. Prepare Container  
        const contentEl \= this.contentEl;  
        contentEl.empty(); // Obsidian helper to clear DOM  
          
        // 3\. Create a dedicated container for isolation  
        this.currentContainer \= contentEl.createDiv({ cls: 'hud-provider-container' });

        // 4\. Invoke the Mount Function (Cross-Plugin Call)  
        // This hands execution over to Amnesia, but passes the DOM node.  
        try {  
            this.activeComponent \= provider.mount(this.currentContainer, data);  
        } catch (e) {  
            console.error("Failed to mount provider", e);  
            this.currentContainer.createEl('div', { text: \`Error loading ${provider.label}\` });  
        }  
    }

    /\*\*  
     \* Propagate updates (e.g., window resize, theme change)  
     \*/  
    onResize() {  
        if (this.activeComponent) {  
            this.activeComponent.update({ width: this.contentEl.clientWidth });  
        }  
    }  
}

### **4.4 Data Synchronization & State Management**

A distinct advantage of the Renderer Pattern in Svelte is the ability to pass **Stores** as props. Svelte Stores are technically framework-agnostic objects that adhere to a specific contract (subscribe). They do not depend on the internal Svelte runtime to function, making them the perfect bridge for cross-bundle reactivity.

**Pattern:**

1. **Doc Doctor** creates a shared store: activeFile.  
2. **Doc Doctor** passes the store in props: mount(target, { fileStore: this.activeFile }).  
3. **Amnesia** accepts the store prop: export let fileStore;.  
4. **Amnesia** subscribes using the $ syntax: \<h1\>{$fileStore.basename}\</h1\>.

This works seamlessly because the $ syntax compiles to a generic .subscribe() call on the object. It does not perform an instanceof check against a Svelte Store class, thus bypassing the context mismatch completely.8

## **5\. Comparative Tradeoff Analysis Table**

| Feature | Renderer Pattern (Recommended) | Web Components | Shared Runtime |
| :---- | :---- | :---- | :---- |
| **Isolation** | High (Closure-based) | High (Shadow DOM) | Low (Global Namespace) |
| **Prop Complexity** | High (Native JS Objects) | Low (Strings only) | High (Native JS Objects) |
| **Styling** | Scoped \+ Global Cascade | Shadow Isolation (Hard to theme) | Scoped \+ Global Cascade |
| **Dependencies** | Zero (Decoupled) | Polyfills (if targeting old engines) | Strict Version Coupling |
| **Svelte Versioning** | Agnostic (Mix v4 & v5) | Agnostic | Locked (Must match host) |
| **Debugging** | Easy (Standard Stack trace) | Moderate (Shadow DOM boundaries) | Hard (Minified global bundles) |

## **6\. Svelte-Specific Implementation Details**

### **6.1 Styles and Theming (Scoped vs Global)**

In the Renderer Pattern, styles defined in Amnesia's .svelte files are scoped using a hash class (e.g., .svelte-xyz123). When mounted into Doc Doctor's DOM:

* **Isolation:** Amnesia's styles will *not* leak out to Doc Doctor because of the hash class.9  
* **Theming:** Obsidian's global styles (e.g., .theme-dark, \--font-text-size) will cascade *into* Amnesia's component because it is in the light DOM. This is highly desirable for maintaining a native look and feel.  
* **Conflict Resolution:** If specific CSS resets are needed, Amnesia can use the :global() modifier within its styles to target its specific container wrapper: .hud-provider-container :global(h1) {... }.27

### **6.2 Handling Svelte 5 Migration**

While the current requirement is Svelte 4, the ecosystem is moving to Svelte 5\. The Renderer Pattern future-proofs the application.

* **Svelte 4 Provider:** Uses new Component(...) and $set.  
* **Svelte 5 Provider:** Uses mount(...) and direct state mutation.  
* **The Interface:** The ComponentHandle interface (update/destroy) remains constant. Doc Doctor does not need to know which version of Svelte Amnesia uses internally, as long as Amnesia wraps the implementation in the standard mount function returned to the registry.

## **7\. Examples from the Obsidian Ecosystem**

### **7.1 The Kanban Plugin Strategy**

The **Obsidian Kanban** plugin exemplifies the Renderer Pattern. It registers a custom View (the container). When the view loads, it instantiates a complex React application (conceptually identical to Svelte in this context) into the view's contentEl. It handles the bridge between Obsidian's file/metadata cache updates and the internal React state manually, ensuring that the React runtime is isolated within the plugin bundle.28

### **7.2 Excalidraw's "Automate" API**

**Excalidraw** implements an advanced Inversion of Control pattern. It exposes the ExcalidrawAutomate API on the window object. Other plugins (like Templater or QuickAdd) do not try to import Excalidraw components directly. Instead, they call methods on the API (ea.addRect, ea.create) to instruct Excalidraw to render content. This effectively creates a stable contract over the runtime implementation details.30

### **7.3 Inter-Plugin Communication**

Plugins like **Meta Bind** and **Buttons** utilize the global plugin registry (app.plugins.plugins) to locate API endpoints exposed by other plugins. This confirms the feasibility of Doc Doctor exposing a window.DocDoctorAPI or simply attaching its API to its plugin instance for Amnesia to discover during the onload lifecycle phase.21

## **8\. Conclusion**

The TypeError: Cannot read properties of undefined (reading 'context') is a structural barrier inherent to the isolated bundling architecture of Obsidian plugins. Attempting to share component definitions directly is an anti-pattern in this environment.

To successfully integrate Doc Doctor and Amnesia, the architecture must shift from **Component Sharing** to **Mounting Delegation**. By adopting the **Renderer Pattern**, you utilize the DOM as the neutral integration layer, respecting the runtime boundaries of Svelte while allowing for rich, reactive, and integrated user experiences.

**Recommended Action Plan:**

1. **Host (Doc Doctor):** Define and export the HUDProvider and ComponentHandle interfaces. Implement the registry system.  
2. **Provider (Amnesia):** Create a factory function that instantiates the Reader.svelte component using new ReaderComponent(...) and maps the $set/$destroy methods to the ComponentHandle.  
3. **Integration:** Use Svelte Stores passed via props to synchronize state (current file, theme) across the plugin boundary.  
4. **Cleanup:** Ensure strict adherence to calling destroy() on tab switching to prevent memory leaks in the long-running Obsidian process.

#### **Obras citadas**

1. obsidian-api/README.md at master \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/obsidianmd/obsidian-api/blob/master/README.md](https://github.com/obsidianmd/obsidian-api/blob/master/README.md)  
2. injecting Svelte-generated nodes into static DOM \- Stack Overflow, fecha de acceso: enero 6, 2026, [https://stackoverflow.com/questions/58471812/injecting-svelte-generated-nodes-into-static-dom](https://stackoverflow.com/questions/58471812/injecting-svelte-generated-nodes-into-static-dom)  
3. Svelte Lifecycle Method \- onMount \- Newline.co, fecha de acceso: enero 6, 2026, [https://www.newline.co/@kchan/svelte-lifecycle-method-onmount--5b84654f](https://www.newline.co/@kchan/svelte-lifecycle-method-onmount--5b84654f)  
4. The Component Lifecycle in Svelte \- Better Programming, fecha de acceso: enero 6, 2026, [https://betterprogramming.pub/the-component-lifecycle-in-svelte-1784ecab5862](https://betterprogramming.pub/the-component-lifecycle-in-svelte-1784ecab5862)  
5. Inversion of Control through Compound Components \- iO tech\_hub, fecha de acceso: enero 6, 2026, [https://techhub.iodigital.com/articles/inversion-of-control-through-compound-components](https://techhub.iodigital.com/articles/inversion-of-control-through-compound-components)  
6. Inversion of Control \- Kent C. Dodds, fecha de acceso: enero 6, 2026, [https://kentcdodds.com/blog/inversion-of-control](https://kentcdodds.com/blog/inversion-of-control)  
7. Dynamic behavior in Svelte: working with variables and props, fecha de acceso: enero 6, 2026, [https://developer.mozilla.org/en-US/docs/Learn\_web\_development/Core/Frameworks\_libraries/Svelte\_variables\_props](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Frameworks_libraries/Svelte_variables_props)  
8. Is it possible to pass a Svelte store as a property on a component?, fecha de acceso: enero 6, 2026, [https://stackoverflow.com/questions/59351139/is-it-possible-to-pass-a-svelte-store-as-a-property-on-a-component](https://stackoverflow.com/questions/59351139/is-it-possible-to-pass-a-svelte-store-as-a-property-on-a-component)  
9. Styling in Svelte: Scoped, Component, and Global Styles \- CodeSignal, fecha de acceso: enero 6, 2026, [https://codesignal.com/learn/courses/styling-transitions-in-svelte/lessons/styling-in-svelte-scoped-component-and-global-styles](https://codesignal.com/learn/courses/styling-transitions-in-svelte/lessons/styling-in-svelte-scoped-component-and-global-styles)  
10. How Svelte scopes component styles \- Geoff Rich, fecha de acceso: enero 6, 2026, [https://geoffrich.net/posts/svelte-scoped-styles/](https://geoffrich.net/posts/svelte-scoped-styles/)  
11. Svelte Lifecycle Method \- onDestroy \- Newline.co, fecha de acceso: enero 6, 2026, [https://www.newline.co/@kchan/svelte-lifecycle-method-ondestroy--03dc7512](https://www.newline.co/@kchan/svelte-lifecycle-method-ondestroy--03dc7512)  
12. Handling Lifecycle Effects with onMount and onDestroy \- CodeSignal, fecha de acceso: enero 6, 2026, [https://codesignal.com/learn/courses/svelte-advanced-concepts/lessons/handling-lifecycle-effects-with-onmount-and-ondestroy-1](https://codesignal.com/learn/courses/svelte-advanced-concepts/lessons/handling-lifecycle-effects-with-onmount-and-ondestroy-1)  
13. Svelte Components as Web Components | by Matias Simon \- Medium, fecha de acceso: enero 6, 2026, [https://medium.com/@yesmeno/svelte-components-as-web-components-b400d1253504](https://medium.com/@yesmeno/svelte-components-as-web-components-b400d1253504)  
14. Custom elements • Svelte Docs, fecha de acceso: enero 6, 2026, [https://svelte.dev/docs/custom-elements-api](https://svelte.dev/docs/custom-elements-api)  
15. render Svelte components inside shadow dom · Issue \#5869 \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/sveltejs/svelte/issues/5869](https://github.com/sveltejs/svelte/issues/5869)  
16. Component style exposure mechanism · Issue \#8538 · sveltejs/svelte, fecha de acceso: enero 6, 2026, [https://github.com/sveltejs/svelte/issues/8538](https://github.com/sveltejs/svelte/issues/8538)  
17. Using Custom Elements in Svelte \- CSS-Tricks, fecha de acceso: enero 6, 2026, [https://css-tricks.com/using-custom-elements-in-svelte/](https://css-tricks.com/using-custom-elements-in-svelte/)  
18. Svelte for Web Components development: Pitfalls and workarounds, fecha de acceso: enero 6, 2026, [https://dev.to/tnzk/svelte-for-web-components-development-pitfalls-and-workarounds-as-of-july-2021-3lii](https://dev.to/tnzk/svelte-for-web-components-development-pitfalls-and-workarounds-as-of-july-2021-3lii)  
19. Svelte 4 migration guide, fecha de acceso: enero 6, 2026, [https://svelte.dev/docs/v4-migration-guide](https://svelte.dev/docs/v4-migration-guide)  
20. Svelte 5 migration guide, fecha de acceso: enero 6, 2026, [https://svelte.dev/docs/svelte/v5-migration-guide](https://svelte.dev/docs/svelte/v5-migration-guide)  
21. Inter-plugin Communication (Expose API to Other Plugins), fecha de acceso: enero 6, 2026, [https://forum.obsidian.md/t/inter-plugin-communication-expose-api-to-other-plugins/23618](https://forum.obsidian.md/t/inter-plugin-communication-expose-api-to-other-plugins/23618)  
22. Is there a way to programmatically mount Svelte components? \- Reddit, fecha de acceso: enero 6, 2026, [https://www.reddit.com/r/sveltejs/comments/so20mz/is\_there\_a\_way\_to\_programmatically\_mount\_svelte/](https://www.reddit.com/r/sveltejs/comments/so20mz/is_there_a_way_to_programmatically_mount_svelte/)  
23. How can I manually compile a svelte component down to the final ..., fecha de acceso: enero 6, 2026, [https://stackoverflow.com/questions/65484019/how-can-i-manually-compile-a-svelte-component-down-to-the-final-javascript-and-c](https://stackoverflow.com/questions/65484019/how-can-i-manually-compile-a-svelte-component-down-to-the-final-javascript-and-c)  
24. Step-by-Step Guide to Building the “Iframe Renderer” Obsidian Plugin, fecha de acceso: enero 6, 2026, [https://natarslan.blot.im/step-by-step-guide-to-building-the-iframe-renderer-obsidian-plugin](https://natarslan.blot.im/step-by-step-guide-to-building-the-iframe-renderer-obsidian-plugin)  
25. CSS in Micro Frontends \- DEV Community, fecha de acceso: enero 6, 2026, [https://dev.to/florianrappl/css-in-micro-frontends-4jai](https://dev.to/florianrappl/css-in-micro-frontends-4jai)  
26. Stores • Svelte Docs, fecha de acceso: enero 6, 2026, [https://svelte.dev/docs/svelte/stores](https://svelte.dev/docs/svelte/stores)  
27. Styling in Svelte (Scoped CSS, :global, and Class Directives), fecha de acceso: enero 6, 2026, [https://dev.to/a1guy/styling-in-svelte-scoped-css-global-and-class-directives-1mna](https://dev.to/a1guy/styling-in-svelte-scoped-css-global-and-class-directives-1mna)  
28. Kanban plugin \- Obsidian, fecha de acceso: enero 6, 2026, [https://obsidian.md/plugins?search=Kanban](https://obsidian.md/plugins?search=Kanban)  
29. Kanban \- Create markdown-backed Kanban boards in Obsidian., fecha de acceso: enero 6, 2026, [https://www.obsidianstats.com/plugins/obsidian-kanban](https://www.obsidianstats.com/plugins/obsidian-kanban)  
30. A plugin to edit and view Excalidraw drawings in Obsidian \- GitHub, fecha de acceso: enero 6, 2026, [https://github.com/zsviczian/obsidian-excalidraw-plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin)  
31. Excalidraw Automate How To | obsidian-excalidraw-plugin, fecha de acceso: enero 6, 2026, [https://zsviczian.github.io/obsidian-excalidraw-plugin/API/introduction.html](https://zsviczian.github.io/obsidian-excalidraw-plugin/API/introduction.html)