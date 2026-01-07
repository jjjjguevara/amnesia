# PDF Optimization Live Testing Guide

This guide provides procedures for manually testing PDF optimization components using the Obsidian DevTools MCP.

## Prerequisites

### 1. Amnesia Server Running
```bash
cd apps/amnesia-server
cargo run
```
Verify: `curl http://localhost:3000/health`

### 2. Obsidian with Amnesia Plugin
- Plugin installed and enabled
- Remote debugging enabled (start Obsidian with `--remote-debugging-port=9222`)

### 3. Library Configured
In Amnesia settings, configure the library folder path to a directory containing PDF files.

Verify library is loaded:
```javascript
(function() {
  const plugin = app.plugins.plugins['amnesia'];
  let storeValue = null;
  plugin.libraryStore.subscribe(v => storeValue = v)();
  return {
    bookCount: storeValue?.books?.length || 0,
    error: storeValue?.error || null,
    pdfCount: storeValue?.books?.filter(b => b.format === 'pdf').length || 0
  };
})();
```

### 4. DevTools MCP Connected
```javascript
mcp__obsidian-devtools__obsidian_connect()
```

## Testing Procedures

### 1. Verify Plugin Status

```javascript
mcp__obsidian-devtools__obsidian_get_plugin_info({ pluginId: 'amnesia' })
```

Expected:
```json
{
  "id": "amnesia",
  "enabled": true,
  "loaded": true
}
```

### 2. Check PDF Reader State

Open a PDF in Amnesia, then run:

```javascript
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  if (leaves.length === 0) return { error: 'No reader open' };

  const view = leaves[0].view;
  const contentEl = view.contentEl;

  // Count PDF elements
  const pdfPages = contentEl.querySelectorAll('.pdf-page-element').length;
  const textLayers = contentEl.querySelectorAll('.pdf-page-text-layer').length;
  const virtualizedLayers = contentEl.querySelectorAll('.pdf-virtualized-text-layer').length;
  const canvases = contentEl.querySelectorAll('canvas').length;

  return {
    pdfPages,
    textLayers,
    virtualizedLayers,
    canvases,
    hasContent: pdfPages > 0
  };
})();
```

### 3. Get Prefetcher Stats

```javascript
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  if (leaves.length === 0) return { error: 'No reader open' };

  const view = leaves[0].view;
  const component = view.component;
  const ctx = component.$$.ctx;

  // Find the reader with PDF provider
  for (let i = 0; i < ctx.length; i++) {
    const item = ctx[i];
    if (item?.pdfProvider?.prefetcher) {
      return item.pdfProvider.prefetcher.getStats();
    }
    if (item?.provider?.prefetcher) {
      return item.provider.prefetcher.getStats();
    }
  }

  return { error: 'Prefetcher not found' };
})();
```

Expected output:
```json
{
  "strategy": "adaptive",
  "currentDirection": "forward",
  "scrollVelocity": 1.5,
  "queueSize": 0,
  "highPriorityCount": 0,
  "mediumPriorityCount": 0,
  "lowPriorityCount": 0,
  "prefetchedPages": [1, 2, 3, 4, 5]
}
```

### 4. Get Pool Stats

```javascript
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  if (leaves.length === 0) return { error: 'No reader open' };

  const view = leaves[0].view;
  const component = view.component;
  const ctx = component.$$.ctx;

  // Find the multi-page container with pool
  for (let i = 0; i < ctx.length; i++) {
    const item = ctx[i];
    if (item?.multiPageContainer?.elementPool) {
      return item.multiPageContainer.elementPool.getStats();
    }
    if (item?.elementPool) {
      return item.elementPool.getStats();
    }
  }

  return { error: 'Pool not found' };
})();
```

Expected output:
```json
{
  "poolSize": 5,
  "maxPoolSize": 20,
  "acquireCount": 15,
  "releaseCount": 10,
  "createCount": 5
}
```

### 5. Count DOM Nodes (Text Layer)

```javascript
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  if (leaves.length === 0) return { error: 'No reader open' };

  const view = leaves[0].view;
  const contentEl = view.contentEl;

  // Count text layer spans
  const textLayers = contentEl.querySelectorAll('.pdf-page-text-layer, .pdf-virtualized-text-layer');
  let totalSpans = 0;
  let layerDetails = [];

  textLayers.forEach((layer, i) => {
    const spans = layer.querySelectorAll('span').length;
    totalSpans += spans;
    layerDetails.push({ layer: i, spans });
  });

  return {
    textLayerCount: textLayers.length,
    totalSpans,
    layerDetails,
    // Target: < 500 spans for virtualized mode
    meetsTarget: totalSpans < 500
  };
})();
```

### 6. Measure Scroll Performance

```javascript
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  if (leaves.length === 0) return { error: 'No reader open' };

  const view = leaves[0].view;
  const contentEl = view.contentEl;

  // Find scroll container
  const scrollContainer = contentEl.querySelector('.pdf-scroll-container, .reader-content');
  if (!scrollContainer) return { error: 'Scroll container not found' };

  // Measure FPS during scroll
  let frameCount = 0;
  let startTime = performance.now();
  let measuring = true;

  const countFrame = () => {
    if (!measuring) return;
    frameCount++;
    requestAnimationFrame(countFrame);
  };

  requestAnimationFrame(countFrame);

  // Simulate scroll
  const scrollStep = 100;
  const scrollInterval = setInterval(() => {
    scrollContainer.scrollTop += scrollStep;
  }, 16);

  // Stop after 2 seconds
  setTimeout(() => {
    measuring = false;
    clearInterval(scrollInterval);

    const duration = (performance.now() - startTime) / 1000;
    const fps = frameCount / duration;

    console.log('Scroll FPS:', fps.toFixed(1));
  }, 2000);

  return { status: 'Measuring... check console in 2s' };
})();
```

### 7. Check Text Layer Mode

```javascript
(function() {
  const leaves = app.workspace.getLeavesOfType('amnesia-reader');
  if (leaves.length === 0) return { error: 'No reader open' };

  const view = leaves[0].view;
  const contentEl = view.contentEl;

  // Check for virtualized text layer containers
  const virtualizedContainers = contentEl.querySelectorAll('.pdf-virtualized-text-layer-container');
  const regularTextLayers = contentEl.querySelectorAll('.pdf-page-text-layer:not(.pdf-virtualized-text-layer)');

  let mode = 'unknown';
  if (virtualizedContainers.length > 0) {
    mode = 'virtualized';
  } else if (regularTextLayers.length > 0) {
    mode = 'full';
  } else {
    mode = 'disabled';
  }

  return {
    mode,
    virtualizedContainers: virtualizedContainers.length,
    regularTextLayers: regularTextLayers.length
  };
})();
```

### 8. Verify Settings Propagation

```javascript
(function() {
  // Get plugin settings
  const plugin = app.plugins.plugins['amnesia'];
  if (!plugin) return { error: 'Plugin not found' };

  const settings = plugin.settings;

  return {
    textLayerMode: settings.pdfTextLayerMode || 'default',
    prefetchStrategy: settings.pdfPrefetchStrategy || 'default',
    enableDomPooling: settings.pdfEnableDomPooling ?? true,
    maxPoolSize: settings.pdfMaxPoolSize || 20
  };
})();
```

## Manual Testing Checklist

### Visual Verification
- [ ] Text selection works in all textLayerMode settings
- [ ] Highlights render correctly on PDF pages
- [ ] Page transitions are smooth (no flickering)
- [ ] No blank pages during scroll
- [ ] Zoom in/out works correctly
- [ ] Rotation works correctly (0°, 90°, 180°, 270°)

### Performance Verification
- [ ] Large PDF (500+ pages) scrolls smoothly
- [ ] No noticeable jank during fast scroll
- [ ] First page loads within 500ms
- [ ] Memory stays under 200MB during normal use
- [ ] DOM node count stays under 500 during scroll

### Feature Verification
- [ ] prefetchStrategy 'adaptive' prefetches in scroll direction
- [ ] prefetchStrategy 'fixed' prefetches equal in both directions
- [ ] prefetchStrategy 'none' doesn't prefetch
- [ ] textLayerMode 'disabled' prevents text selection
- [ ] textLayerMode 'virtualized' has lower DOM count
- [ ] enableDomPooling reuses page elements

## Troubleshooting

### "Failed to parse PDF" Error
1. Check server is running: `curl http://localhost:3000/health`
2. Check server logs for errors
3. Try a different PDF file
4. Verify PDF is not corrupted

### No Prefetcher Stats
1. Ensure PDF is fully loaded
2. Check if HybridPdfProvider is being used
3. Verify prefetchStrategy is not 'none'

### High DOM Count
1. Check textLayerMode setting
2. Verify virtualizationThreshold is reasonable (default: 50)
3. Check if virtualized text layer is properly initialized

### Memory Issues
1. Check pool stats - pool should be reusing elements
2. Verify elements are being released back to pool
3. Check for console errors about failed cleanup

## Performance Targets

| Metric | Target | How to Verify |
|--------|--------|---------------|
| First Page Load | < 500ms | Time from open to first visible page |
| Page Render | < 100ms | Prefetcher queue processing time |
| Scroll FPS | > 55 | Use FPS measurement script above |
| Memory Peak | < 200MB | DevTools Memory tab |
| DOM Nodes | < 500 | Use DOM count script above |
| Cache Hit Rate | > 80% | Check prefetcher stats |
| Pool Reuse Rate | > 50% | `(acquireCount - createCount) / acquireCount` |

## Capturing Screenshots

```javascript
mcp__obsidian-devtools__obsidian_capture_screenshot({
  format: 'png',
  outputPath: '/tmp/pdf-test-screenshot.png'
})
```

## Console Log Monitoring

```javascript
// Get recent errors
mcp__obsidian-devtools__obsidian_get_console_logs({ level: 'error', limit: 20 })

// Get all recent logs
mcp__obsidian-devtools__obsidian_get_console_logs({ level: 'all', limit: 50 })

// Filter for PDF-related logs
mcp__obsidian-devtools__obsidian_get_console_logs({ level: 'all', limit: 100 })
// Then search for "PDF", "Prefetch", "Pool", "TextLayer" in results
```

## Reload Plugin After Code Changes

```javascript
mcp__obsidian-devtools__obsidian_reload_plugin({ pluginId: 'amnesia' })
```
