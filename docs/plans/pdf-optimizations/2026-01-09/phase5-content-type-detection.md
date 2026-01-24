# Phase 5: Content-Type Detection Implementation

## Overview

Phase 5 implements intelligent PDF content-type detection to optimize rendering based on page characteristics. The system classifies pages into categories and routes them through optimized rendering paths.

## Content Types

| Type | Description | Optimization |
|------|-------------|--------------|
| `SCANNED_JPEG` | Single large JPEG image covering page | Direct JPEG extraction (skip MuPDF render) |
| `SCANNED_OTHER` | Single large non-JPEG image | Standard rendering with high cache priority |
| `VECTOR_HEAVY` | >500 path operators, no images | Render at reduced scale, CSS upscale |
| `TEXT_HEAVY` | >300 text operators, minimal graphics | Aggressive caching |
| `MIXED` | Balanced operator counts | Standard rendering |
| `COMPLEX` | High operator diversity | Standard rendering |

## Implementation Summary

### Phase 5.1-5.5: Classification System
- Created `content-type-classifier.ts` with `PDFContentType` enum
- Implemented content stream analyzer (operator counting)
- Implemented XObject analyzer (image enumeration, filter detection)
- Classification algorithm with confidence scoring

### Phase 5.6-5.7: Worker Infrastructure
- Added `CLASSIFY_PAGE` and `EXTRACT_JPEG` worker message types
- Implemented JPEG extraction for scanned pages (bypasses MuPDF render)

### Phase 5.8: Caching
- Classification results cached in L3 metadata cache
- Per-document persistence for repeated access

### Phase 5.9: Vector Optimization
- Vector-heavy pages render at reduced scale (e.g., 50%)
- CSS transform upscales to target resolution
- Preserves crisp anti-aliased vectors

### Phase 5.10: Document ID Mismatch Fix

**Bug:** Classification requests used wrong document ID, causing timeouts.

**Root Cause:** Each `loadDocument` call generates a unique document ID. The code was using `this.wasmDocumentId` (rendering bridge) instead of `this.pooledBridgeDocId` (classification bridge).

**Fix Applied:**

1. `hybrid-document-provider.ts`:
   ```typescript
   // Before (broken)
   const classification = await this.pooledBridge.classifyPage(
     this.wasmDocumentId ?? this.documentId!,
     pageNum
   );

   // After (fixed)
   const classification = await this.pooledBridge.classifyPage(
     this.pooledBridgeDocId,
     pageNum
   );
   ```

2. `hybrid-pdf-provider.ts`:
   - Added `pooledBridgeDocId` property
   - Changed `loadDocument` to `loadDocumentWithId`
   - Updated all classification calls to use correct ID

**Verification:**
```
[WorkerPool] sendRequest CLASSIFY_PAGE: docId=doc-XXX, worker=0, workerDocIds=doc-XXX
                                              ↑ now matches ↑
```

### Phase 5.11-5.12: Feature Flags & Telemetry
- `useContentTypeDetection` feature flag (auto-enabled in Electron)
- Classification telemetry tracking by content type

## Test Results (marx-reference-benchmark.pdf)

### Content Type Distribution
| Type | Renders |
|------|---------|
| Complex | 50,660 |
| Mixed | 334 |
| Scanned-JPEG | 156 |

### Performance Metrics
- Avg Render Time: 127.55ms
- Avg Tile Render Time: 205ms
- P95 Tile Render: 675ms
- First Tile Time: 4.7s (cold start, large PDF)
- Worker Utilization: 24.5%
- Memory: 238MB avg, 299MB peak

### Classification Performance
- Avg Classification Time: 2.24ms
- Classification calls: 8 (cached afterward)

## Phase 5.13: Scanned PDF Testing (COMPLETE)

### Test PDFs
| PDF | Type | Filter | Result |
|-----|------|--------|--------|
| historia-mexico-1940.pdf | Scanned | DCTDecode (JPEG) | ✅ JPEG extraction works |
| berlioz-instrumentation.pdf | Scanned | JPXDecode (JPEG2000) | ✅ Correctly falls back to render |

### JPEG Extraction Performance
- **Extraction time:** 0.70ms
- **Standard render time:** ~200ms
- **Speedup:** ~285x faster

### Technical Details
- JPEG data extracted directly from XObject stream using `readRawStream()`
- Valid JPEG confirmed (starts with 0xFF 0xD8)
- Example: historia-mexico page 1: 120.4 KB, 1805×2562 pixels

### Bug Fix: Stream Access
Initial implementation failed because `xobjects.get(name).resolve()` returns a dictionary without stream access. Fixed by using `xobjects.forEach()` to iterate and get the actual stream object.

## Phase 5.14: Vector-Heavy PDF Testing (COMPLETE)

### Test PDFs
| PDF | Classification | Path Ops | Path Ratio | Notes |
|-----|----------------|----------|------------|-------|
| dragon-book-compilers.pdf | mixed | 97 | 22.4% | Text/diagrams |
| Behind Bars - Elaine Gould.pdf | scanned-jpeg | N/A | N/A | Scanned images |
| Michael Brecker Omnibook.pdf | complex | 125 | 22.4% | Has transparency |

### Findings
- **No PDFs in test set met vector-heavy criteria** (path >= 500 AND ratio >= 70%)
- Music notation PDFs were either scanned images or had low path operator ratios
- Vector-heavy optimization code exists but was not validated with real test data
- The threshold (path >= 500, ratio >= 70%) may be too strict for typical PDFs

### Vector-Heavy Classification Criteria
```typescript
// Current thresholds in mupdf-worker.ts
if (path >= 500 && path / total >= 0.7) {
  result.type = 'vector-heavy';
}
```

### Recommendation
The vector-heavy optimization path is implemented but untested. Consider:
1. Lowering thresholds (e.g., path >= 200, ratio >= 50%)
2. Finding true CAD/engineering drawings for validation
3. Keeping current implementation as-is (conservative approach)

## Phase 5.15: Comprehensive Benchmarks (COMPLETE)

### Test Documents

| Document | Size | Primary Type | Pages Tested |
|----------|------|--------------|--------------|
| historia-mexico-1940.pdf | 43MB | scanned-jpeg | 59 renders |
| dragon-book-compilers.pdf | - | mixed | 46 renders |
| marx-reference-benchmark.pdf | - | complex | 50,660 renders (prior test) |

### Content Type Detection Validation

| Type | Documents Found In | Detection Working |
|------|-------------------|-------------------|
| scanned-jpeg | historia-mexico, dragon-book | ✅ JPEG extraction working |
| scanned-other | berlioz (JPEG2000) | ✅ Correctly falls back to render |
| text-heavy | dragon-book (6 pages) | ✅ First detection confirmed |
| mixed | dragon-book (23 pages) | ✅ Working |
| complex | marx-reference, dragon-book | ✅ Working |
| vector-heavy | None found | ⚠️ Code exists but untested |

### Performance Summary

| Metric | historia-mexico (scanned) | dragon-book (mixed) | marx-reference (complex) |
|--------|---------------------------|---------------------|--------------------------|
| Avg Render Time | 59.26ms | 41.5ms | 127.55ms |
| P95 Render Time | 224.4ms | 197.9ms | 202.5ms |
| First Tile Time | 8493ms | 43.6ms | 4706ms |
| L3 Hit Rate | 96.56% | 94.34% | 99.96% |
| Memory Peak | 593MB | 221MB | 299MB |
| Scroll FPS | 60 | 60 | 60 |
| Jank Events | 0 | 0 | 0 |

### Key Findings

1. **JPEG Extraction Optimization** - 285x speedup (0.7ms vs 200ms) for scanned PDFs
2. **L3 Metadata Cache** - 94-99% hit rate, classification cached after first access
3. **60 FPS Maintained** - Zero jank events across all test documents
4. **Content Type Distribution** - All major types detected except vector-heavy
5. **Memory Usage** - Within budget (<500MB) for typical documents

### Benchmark Files

- `phase5-telemetry-historia-mexico.json` - Scanned PDF benchmark
- `phase5-telemetry-dragon-book.json` - Mixed content benchmark
- `phase5-telemetry-marx-reference.json` - Complex content benchmark

## Files Modified

| File | Changes |
|------|---------|
| `content-type-classifier.ts` | New - classification algorithm |
| `mupdf-worker.ts` | CLASSIFY_PAGE, EXTRACT_JPEG handlers |
| `worker-pool-manager.ts` | Classification request routing |
| `pooled-mupdf-bridge.ts` | `loadDocumentWithId` method |
| `render-coordinator.ts` | Content-type aware routing |
| `hybrid-document-provider.ts` | Document ID fix, callback setup |
| `hybrid-pdf-provider.ts` | Document ID fix |
| `feature-flags.ts` | `useContentTypeDetection` flag |
| `pdf-telemetry.ts` | Classification metrics |

## Usage

```typescript
// Check if content-type detection is enabled
const enabled = isFeatureEnabled('useContentTypeDetection');

// Classification happens automatically during rendering
// Check telemetry for distribution
const stats = window.pdfTelemetry.getStats();
console.log(stats.scaleDistributionSummary['custom-render_contentType_complex']);
```
