# Calibre-Obsidian Bidirectional Sync Testing Guide

> Testing methodology for Amnesia's Calibre Content Server integration

## Overview

This document covers the testing approach for bidirectional metadata sync between Obsidian frontmatter and Calibre library. The sync supports:

- **Obsidian → Calibre**: Push ratings, tags, and custom fields to Calibre
- **Calibre → Obsidian**: Pull metadata updates to note frontmatter
- **Conflict Detection**: Identify and resolve concurrent modifications

## Prerequisites

### Software Requirements

| Component | Version | Notes |
|-----------|---------|-------|
| Calibre | 6.0+ | With Content Server |
| Obsidian | 1.4+ | With Amnesia plugin |
| macOS/Linux | Any | Windows works with adjusted commands |

### Calibre Library Setup

Ensure your Calibre library has:
- Books with metadata (title, author, rating, tags)
- At least a few books with `calibreId` mapped to Obsidian notes
- Custom columns if testing custom field sync

## Server Setup

### Starting Calibre Content Server

#### Basic Mode (Read-Only)

```bash
calibre-server ~/Libros
```

#### Write-Enabled Mode (Required for Bidirectional Sync)

```bash
calibre-server --enable-local-write ~/Libros
```

#### Verbose Mode (Recommended for Testing)

```bash
calibre-server \
  --log /dev/stdout \
  --access-log /dev/stdout \
  --enable-local-write \
  ~/Libros
```

**Flags explained:**
- `--log /dev/stdout`: Print server logs to terminal
- `--access-log /dev/stdout`: Print HTTP request logs to terminal
- `--enable-local-write`: Allow anonymous write operations (no auth required)

#### Production Mode (With Authentication)

```bash
calibre-server \
  --enable-auth \
  --auth-mode basic \
  --enable-local-write \
  ~/Libros
```

### Default Endpoints

| Endpoint | URL |
|----------|-----|
| Web UI | http://localhost:8080 |
| AJAX API | http://localhost:8080/ajax |
| CDB API | http://localhost:8080/cdb |

## Monitoring Commands

### Live Database Monitoring

Since `watch` is not available on macOS by default, use a shell loop:

```bash
# Monitor last 5 modified books (continuous trace)
while true; do
  echo "=== $(date) ==="
  calibredb list \
    --with-library=http://localhost:8080/#Libros \
    --fields=id,title,rating,tags,last_modified \
    --sort-by=last_modified \
    --limit=5
  echo ""
  sleep 2
done
```

**Important**: Use `--with-library=http://localhost:8080/#LibraryName` to route through the Content Server and avoid database locking conflicts.

### Query Specific Books

```bash
# Get metadata for a specific book ID
calibredb show_metadata \
  --with-library=http://localhost:8080/#Libros \
  966
```

### Search by Field

```bash
# Find books by tag
calibredb list \
  --with-library=http://localhost:8080/#Libros \
  --search="tags:fantasy"
```

## Testing Procedures

### Test 1: Obsidian → Calibre (Rating Sync)

**Objective**: Verify rating changes in Obsidian propagate to Calibre.

**Setup**:
1. Open a book note in Obsidian with `calibreId` in frontmatter
2. Note the current rating in Calibre
3. Start the monitoring loop in terminal

**Steps**:
1. In Obsidian, modify the `rating` field in frontmatter (1-5 scale)
2. Run command: `Calibre: Sync Active Note Only`
3. Observe terminal for API POST request
4. Verify rating in Calibre (should be `rating * 2` for 0-10 scale)

**Expected Output** (terminal):
```
POST /cdb/set-fields/966/Libros
{ changes: { rating: 8 } }
Response: { "966": { "rating": 8, ... } }
```

**Verification**:
```bash
calibredb show_metadata --with-library=http://localhost:8080/#Libros 966 | grep -i rating
```

### Test 2: Obsidian → Calibre (Tag Sync)

**Objective**: Verify tag changes propagate correctly with wiki-link cleanup.

**Setup**:
1. Open a book note with existing tags
2. Tags may include wiki-links: `[[Genre/Fantasy|Fantasy]]`

**Steps**:
1. Modify `tags` array in frontmatter
2. Run sync command
3. Verify tags in Calibre (wiki-link syntax should be stripped)

**Expected Behavior**:
- `[[Genre/Fantasy|Fantasy]]` → `Fantasy`
- `[[non-fiction]]` → `non-fiction`
- Plain tags remain unchanged

### Test 3: Calibre → Obsidian (Metadata Pull)

**Objective**: Verify Calibre changes update Obsidian frontmatter.

**Steps**:
1. Modify book metadata directly in Calibre (web UI or calibredb)
2. In Obsidian, run: `Calibre: Sync Library`
3. Check frontmatter for updated values

**Verification**:
- Open note and inspect frontmatter
- Check `lastSync` timestamp was updated

### Test 4: Single-Note Sync Performance

**Objective**: Compare single-note vs full library sync performance.

**Benchmark Procedure**:
```bash
# Time full library sync
time obsidian-cli run-command "calibre-sync-library"

# Time single note sync
time obsidian-cli run-command "calibre-sync-active-note"
```

**Expected Results**:

| Operation | Time (100 books) | Time (1000 books) |
|-----------|------------------|-------------------|
| Full Sync | 2-5s | 15-30s |
| Single Note | <500ms | <500ms |

### Test 5: Conflict Detection

**Objective**: Verify conflicts are detected when both sides modify the same field.

**Setup**:
1. Sync a book to establish baseline
2. Note the `lastSync` timestamp

**Steps**:
1. Modify rating in Obsidian (don't sync yet)
2. Modify rating in Calibre
3. Run sync
4. Observe conflict detection

**Expected Behavior**:
- Conflict modal should appear
- Shows both values (local vs remote)
- Offers resolution options (keep local, keep remote, merge)

## API Endpoints Reference

### Read Operations

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ajax/books/{library}` | GET | List all books |
| `/ajax/book/{id}/{library}` | GET | Get book metadata |
| `/ajax/search/{library}?query=` | GET | Search books |
| `/get/cover/{id}/{library}` | GET | Get book cover |

### Write Operations

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/cdb/set-fields/{id}/{library}` | POST | Update metadata fields |
| `/cdb/add-books/{library}` | POST | Add new books |
| `/cdb/delete-books/{library}` | POST | Delete books |

### Set Fields Request Format

```json
POST /cdb/set-fields/966/Libros
Content-Type: application/json

{
  "changes": {
    "rating": 8,
    "tags": ["fantasy", "epic", "favorites"],
    "series": "The Stormlight Archive",
    "series_index": 1
  }
}
```

### Set Fields Response Format

```json
{
  "966": {
    "rating": 8,
    "tags": ["fantasy", "epic", "favorites"],
    "series": "The Stormlight Archive",
    "series_index": 1.0,
    "last_modified": "2026-01-04T15:30:00Z"
  }
}
```

## Rating Conversion

Calibre uses a 0-10 rating scale; Obsidian typically uses 1-5 stars.

| Obsidian | Calibre | Display |
|----------|---------|---------|
| 1 | 2 | ★☆☆☆☆ |
| 2 | 4 | ★★☆☆☆ |
| 3 | 6 | ★★★☆☆ |
| 4 | 8 | ★★★★☆ |
| 5 | 10 | ★★★★★ |

**Conversion formulas**:
```typescript
// Obsidian → Calibre
const calibreRating = obsidianRating * 2;

// Calibre → Obsidian
const obsidianRating = Math.round(calibreRating / 2);
```

## Troubleshooting

### Common Errors

#### HTTP 403: Anonymous users not allowed

**Cause**: Server started without `--enable-local-write`

**Solution**:
```bash
# Restart with write access
calibre-server --enable-local-write ~/Libros
```

#### Database Locking Error

**Cause**: Direct `calibredb` access while server is running

**Error**:
```
sqlite3.OperationalError: database is locked
```

**Solution**: Always use `--with-library=http://localhost:8080/#LibraryName`

#### Response Parsing Error

**Cause**: Code expects `{ ok: true }` but Calibre returns `{ bookId: metadata }`

**Solution**: Check response for bookId key, not `ok` property

### Debug Logging

Enable verbose logging in Amnesia:
1. Open DevTools (Cmd+Opt+I)
2. Look for `[CalibreContentServer]` prefixed logs
3. API calls show request/response details

## Benchmark Results

### Environment

| Spec | Value |
|------|-------|
| Machine | MacBook Pro M1 |
| RAM | 16GB |
| Calibre Version | 7.x |
| Library Size | 1,200 books |

### Sync Performance

| Operation | Cold Start | Warm |
|-----------|------------|------|
| Connect to Server | 120ms | 50ms |
| Fetch Single Book | 45ms | 25ms |
| Set Fields (single) | 80ms | 60ms |
| Full Library Scan | 8.5s | 6.2s |
| Single Note Sync | 180ms | 120ms |

### Memory Usage

| State | Memory |
|-------|--------|
| Idle (connected) | +12MB |
| During full sync | +45MB |
| After sync complete | +15MB |

## Test Checklist

Before releasing sync features:

- [ ] Obsidian → Calibre rating sync works
- [ ] Obsidian → Calibre tag sync works (wiki-link cleanup)
- [ ] Calibre → Obsidian metadata pull works
- [ ] Single-note sync completes in <500ms
- [ ] Conflict detection triggers on concurrent edits
- [ ] Server restart doesn't break connection
- [ ] Error messages are user-friendly
- [ ] `lastSync` timestamp updates correctly
- [ ] Custom columns sync (if configured)
- [ ] Offline graceful degradation

## Related Documentation

- [API Specification](../specifications/API/api-v1.0.md) - Full Calibre API docs
- [Live Testing Guide](./live-testing-guide.md) - General plugin testing
- [DevTools MCP Guide](./devtools-mcp-guide.md) - Debugging with MCP

---

*Last updated: January 2026*
*Amnesia v0.3.0*
