# Inference Optimization Plan

> Single source of truth for all Oddity 1 annotation pipeline optimizations.
> Last updated: 2026-03-03

## 1. Current State — Baseline Architecture

The annotation pipeline flows through 9 stages:

1. **Region detection** — Content script detects reading regions (adapter match → Readability → heuristic fallback)
2. **Stability watcher** — Debounce or signal-based stability detection (now 500ms verification window)
3. **Text extraction + hashing** — SHA-256 content hash via Web Crypto API
4. **Message passing** — Content → Service Worker → Backend (Chrome runtime messaging)
5. **DB cache check** — Supabase `annotation_cache` keyed by `content_hash + intensity`
6. **LLM generation** — OpenAI API call with structured JSON output
7. **Annotation filtering** — 5-tier anchor matching cascade (exact → fuzzy → drop)
8. **Response merge** — AI annotations + user annotations + feedback
9. **Rendering** — TextQuoteSelector resolution → DOM anchor injection → overlay + margin notes

**Model:** `gpt-4o-mini` (configurable via `OPENAI_MODEL` env var)
**Cache TTL:** 30 days with model+prompt version gating

---

## 2. Implemented Optimizations

### 2.1 DB Cache (Supabase) — *Original*
- `annotation_cache` table with unique constraint on `(content_hash, intensity)`
- Cache hit skips LLM entirely (~50-100ms total)
- Version-gated: stale entries (model or prompt update) fall through to regeneration
- Write-through on fresh generation

### 2.2 In-Flight Request Deduplication — *Original*
- `inflight-dedup.ts`: if two tabs request the same `content_hash:intensity` simultaneously, only one LLM call fires
- Second caller awaits the same promise
- Map cleaned up on settlement (success or failure)

### 2.3 Prompt Output Token Reduction — *Original + Enhanced*
- Compressed field names in LLM output schema: `t` (type), `a` (anchor), `c` (content), `e` (exact), `p` (prefix), `s` (suffix), `n` (note), `w` (why_it_matters), `q` (question)
- `anchor.type` field removed from LLM output (hardcoded as `TextQuoteSelector` on backend expansion)
- `suggestions` field removed from schema (no longer generated)
- `why_it_matters` omitted for `light` intensity (fewer output tokens)
- Backend expands compressed names after JSON parse, before schema validation

### 2.4 Request Abort on Content Change — *Original*
- Per-`tabId:regionId` AbortController in service worker
- New request for same key aborts previous in-flight request
- Content script stale guard via `activeHashes` Map + `pendingRegions`/`annotatedRegions` Sets

### 2.5 TextQuoteSelector Resolution Cache — *Original*
- `WeakMap<Element, TextNodeIndex>` caches TreeWalker index per root element
- Built once per region, reused across all N annotations (5-10x fewer traversals)
- Invalidated explicitly before batch rendering and on retry

### 2.6 Overlay Batching — *Original*
- Sort annotations: background types first (highlight, insight), line types last
- Single-pass resolve → inject → render per annotation
- Retry with index invalidation on anchor failure

### 2.7 Progressive Chat Rendering — *Original*
- MutationObserver detects streaming AI responses
- Stability signal or debounce triggers annotation
- Stale hash guard handles content changes during streaming

### 2.8 Eliminate Redundant Network Round-Trip — *New (Phase 1)*
- **Before:** 3 network calls per annotation request: POST /api/annotate (response ignored), GET /api/annotations, GET /api/annotations/feedback
- **After:** Single POST /api/annotate returns merged result (AI annotations + user annotations + feedback)
- Merge logic extracted to `backend/lib/merge-annotations.ts` (shared utility)
- Service worker uses POST response directly — no re-fetch
- **Impact:** -100-200ms on every request

### 2.9 Speculative Prefetch Before Stability — *New (Phase 1)*
- **Before:** 1500ms debounce on static pages before any annotation request
- **After:** `handleStableRegion()` fires immediately on detection; stability watcher (now 500ms) runs as verification
- If hash matches speculative request → no-op (already handled via `pendingRegions`/`annotatedRegions` dedup)
- If content changes → stale guard cancels old request, new one fires
- **Impact:** -1000-1500ms on static pages

### 2.10 Service Worker Session Cache — *New (Phase 2)*
- `chrome.storage.session` cache keyed by `content_hash:intensity`
- Persists across SW restarts within browser session (10MB limit)
- Checked before any network call → instant hit for revisits
- Populated on every successful annotation response
- **Impact:** Revisits within session: ~0-10ms instead of ~150-400ms

### 2.11 Parallel Chunk Annotation — *New (Phase 3)*
- For texts > 1500 words, split at paragraph boundaries into ~1200-word chunks
- 100-word overlap context prefix from prior chunk
- All chunks fire via `Promise.all` → parallel LLM calls
- Merge results → deduplicate by exact anchor text → run `filterAndFixAnnotations` on full text
- Each chunk independently cached via dedup key
- **Impact:** 3 chunks × 3s = ~3s total vs ~8s sequential for long articles

### 2.12 Streaming JSON with Progressive Rendering — *New (Phase 4)*
- **Backend:** `generateAnnotationsStream()` uses OpenAI streaming API + incremental JSON array parser
- **Backend:** When client sends `Accept: text/event-stream`, responds with SSE events: `data: {"annotation": {...}}\n\n` per annotation, `data: {"done": true, "feedback": [...]}\n\n` at end
- **Service Worker:** `requestAnnotationsStreaming()` reads SSE via `ReadableStream`, forwards each annotation to content script via `annotationReady` message
- **Content Script:** `annotationReady` handler renders single annotation immediately (resolve → inject → render → margin note)
- Final `annotationsReady` re-renders with complete set (includes user annotations + feedback associations)
- Falls back to non-streaming for cached results (sends all at once)
- **Impact:** First annotation visible in ~0.5-1.5s instead of waiting 2-10s for full completion

### 2.13 URL-Hash Prediction for Instant Revisits — *New (Phase 4)*
- `chrome.storage.local` cache: `URL → {content_hash, intensity, annotations, feedback}`
- On page load, before extraction, content script requests prediction via `getUrlPrediction`
- If prediction exists and intensity matches: render immediately
- Normal pipeline runs in parallel; if hash matches (same content), it's a no-op
- If content changed, normal pipeline re-annotates (stale guard handles cleanup)
- LRU eviction at 200 entries
- **Impact:** ~0ms perceived latency on revisited URLs

---

## 3. Planned Optimizations (Future)

### 3.1 Edge Cache for Sub-10ms Cache Hits
**Status:** Requires Vercel Pro deployment

**GET-based CDN approach:**
1. Add `GET /api/annotations/cached/:hash/:intensity` endpoint
2. Set `Cache-Control: public, max-age=2592000` (30 days)
3. Service worker tries GET first (CDN-cached). On 404, falls back to POST
4. Vercel CDN serves cache hits at ~5-15ms, no Supabase query

**Files:**
- `backend/api/annotate.ts` — add GET endpoint
- `extension/src/background/api-client.ts` — GET-first strategy

---

## 4. Removed / Considered & Rejected

- **Service Worker in-memory cache:** Replaced by `chrome.storage.session` (persists across SW restarts)
- **Client-side LLM:** Token budget too high for quality annotations; API latency is the better optimization target
- **WebSocket persistent connection:** SSE is simpler and sufficient; no bidirectional need
- **Speculative LLM pre-generation:** Considered generating annotations for linked pages before click; deferred due to cost concerns

---

## 5. Summary — Projected Latencies

### End-to-End Timing (After All Optimizations)

| Scenario | Before | After |
|----------|--------|-------|
| Revisit, same content (URL cache) | ~150-400ms | **~0ms** (instant) |
| Revisit within session (SW cache) | ~150-400ms | **~0-10ms** |
| First visit, DB cache hit | ~150-400ms | **~50-100ms** |
| First visit, cache miss, short text | ~2,200-5,000ms | **~500-1,500ms** to first annotation |
| First visit, cache miss, long text (3000+ words) | ~5,000-11,000ms | **~500-1,500ms** to first, **~3-4s** to all |
| Future: CDN edge cache hit | ~150-400ms | **~10-30ms** |

### Optimization Stack (Fastest to Slowest Path)

1. URL prediction cache → **0ms** (instant speculative render)
2. SW session cache → **~5ms** (no network)
3. DB cache + merged response → **~50-100ms** (single Supabase query)
4. LLM streaming + parallel chunks → **~500ms to first annotation** (progressive rendering)
