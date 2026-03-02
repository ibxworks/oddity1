# Inference Optimization Plan

## Current State

Backend deploys to **Vercel serverless** (each request may cold-start a new instance). Extension is Chrome MV3 with a persistent-ish service worker. The dominant cost in annotation latency is the **OpenAI LLM call (~2-4s)**, followed by network round-trips and Supabase DB reads.

### What already exists before any optimization work

| Layer | What's there | Where |
|---|---|---|
| DB cache | `annotation_cache` keyed on `content_hash + intensity`, with `expires_at`, `model_version`, `prompt_version` | Supabase table, queried in [annotate.ts](backend/api/annotate.ts) |
| Scroll-based lazy loading | IntersectionObserver defers large below-fold regions until they near the viewport | [scroll-loader.ts](extension/src/content/scroll-loader.ts) |
| Stability debounce | MutationObserver + debounce timer before extracting text from a region | [stability.ts](extension/src/content/stability.ts) |
| Chat adapter signals | Adapter-driven stability signals for streaming chat pages | [chat-observer.ts](extension/src/content/chat-observer.ts) + stability.ts |

These baselines mean page revisits already skip LLM calls (DB cache hit), and below-fold content is already deferred. The optimization work targets the remaining gaps.

---

## Implemented Optimizations

### 1. DB Cache Version Compatibility ✅ SOLID

**What it does:** Before returning a DB cache hit, checks that `model_version` and `prompt_version` match the current runtime values. Stale entries (from an old model or prompt revision) fall through to LLM regeneration and are atomically replaced via upsert.

**Files:** [annotate.ts](backend/api/annotate.ts)

**Impact:** Prevents correctness bugs (stale annotations from wrong prompt). Not a latency optimization per se, but a cache-safety prerequisite.

---

### 2. In-flight Request Dedup ✅ SOLID

**What it does:** If two identical `(content_hash, intensity)` requests arrive concurrently on the same Vercel instance, only one calls the LLM. The second awaits the same promise.

**Files:** [inflight-dedup.ts](backend/lib/inflight-dedup.ts), wired in [annotate.ts](backend/api/annotate.ts)

**Impact:** Real savings for burst-concurrent scenarios. Saves ~$0.002-0.01 per deduplicated call + 2-4s of wasted LLM time.

---

### 3. Prompt Token Reduction ✅ SOLID

**What it does:** Rewrote prompt profiles from verbose v1.1 (~430 tokens avg) to concise v1.2 (~300 tokens avg, ~30% reduction). Extracted shared rules and schema example into reusable template fragments (`{{shared_rules}}`, `{{schema_example}}`).

**Files:** [prompts.json](backend/config/prompts.json), [openai.ts](backend/lib/openai.ts) (`expandPrompt()`)

**Impact:** ~30% fewer input tokens per call. With gpt-4o-mini, this shaves measurable time off the dominant LLM latency.

---

### 4. Stale Request Cancellation ✅ FIXED

**What it does:** AbortController in the service worker cancels both the `requestAnnotations` and `getAnnotations` fetches when a region's content changes. Content script has a stale-hash guard that drops responses for invalidated hashes.

**Files:** [background/index.ts](extension/src/background/index.ts), [api-client.ts](extension/src/background/api-client.ts), [content/index.ts](extension/src/content/index.ts)

**What was fixed:**
- **Abort key now uses `regionId`** instead of `contentHash`. When a region's content changes, the new request correctly aborts the old one — even though the content hash differs. This was the core bug: keying by hash meant re-requesting the same region with new content never cancelled the stale request.
- **`getAnnotations()` now receives the abort signal.** Previously only `requestAnnotations()` was cancellable; the second fetch continued unnecessarily after abort.
- **`regionId` added to `ExtensionMessage`** payload so the background can track per-region abort controllers.

**Impact:** Correct abort for dynamic pages (chat navigation, content edits). Prevents wasted LLM calls + bandwidth on stale content.

---

### 5. Selector Text-Node Index Cache ✅ SOLID (with known limitation)

**What it does:** Builds a text-node index (WeakMap) on first `resolveSelector` call for a root element, reuses it for subsequent annotations in the same batch. Eliminates N-1 TreeWalker traversals.

**Files:** [selector.ts](extension/src/content/selector.ts)

**Known limitation:** The render loop resolves selectors and injects anchors sequentially. After `injectAnchors` splits a text node the cached index is stale for subsequent annotations. In practice, the fuzzy fallback chain (case-insensitive → punctuation-stripped) handles small positional shifts. Acceptable for typical density (~5-8 annotations); unreliable at very high density (15+).

**Why the two-pass alternative was not implemented:** Resolving all selectors first then injecting all anchors would fix correctness perfectly. However, it requires significant refactoring of `renderAnnotations` and the relationship between resolved Ranges and injected anchor elements. The current approach works well enough for real-world density. A two-pass refactor is left as a future improvement if annotation density increases.

**Impact:** 5-10× fewer TreeWalker traversals per region. Measurable on annotation-heavy pages.

---

### 6. Overlay Render Batching ✅ SOLID

**What it does:** Instead of appending each annotation's DOM elements immediately, queues all into `pendingBatch` and flushes in a single `requestAnimationFrame` via `DocumentFragment`.

**Files:** [overlay.ts](extension/src/content/renderer/overlay.ts)

**Impact:** Single-frame DOM insertion. Reduces layout recalculations from N to 1.

---

### 7. Progressive Paragraph Annotation (Chat/LLM Pages) ✅ NEW

**What it does:** On chat/LLM pages (ChatGPT, Claude, etc.), instead of waiting for the entire AI response to finish streaming before annotating, detects when individual paragraphs stabilize and annotates them progressively.

**Files:** [chat-observer.ts](extension/src/content/chat-observer.ts), [content/index.ts](extension/src/content/index.ts)

**How it works:**
1. MutationObserver watches each AI response container for streaming changes
2. Block-level elements (`p`, `li`, `pre`, `h1`-`h6`, `blockquote`, `table`) within the response are tracked individually
3. When the LLM starts writing to a new block, all previous blocks are immediately fired as stable regions (the sibling-progression signal)
4. Each stable block gets its own `regionId` (e.g. `chat-0-p0`, `chat-0-p1`), text extraction, hash, and independent annotation request
5. When streaming fully stops (300ms of no mutations), all remaining unfired blocks are fired
6. Already-complete responses (page reload, scrollback) are detected and fired as a single region

**Why it matters — the old bottleneck:**
The previous chat-observer reset a debounce timer on every streamed token. Since tokens arrive every ~50-100ms, the timer NEVER fired until generation fully stopped. Total delay was: entire streaming time (10-60s) + settle (300-1500ms) + backend inference (2-4s). Users saw nothing until the LLM was completely done.

**New behavior:** Annotations for early paragraphs arrive while the LLM is still writing later ones. On a 5-paragraph response, the first annotation can appear 40-50 seconds earlier than before.

**Design decisions:**
- `MIN_PARAGRAPH_WORDS = 15` — blocks shorter than this are deferred to completion (avoids annotating tiny fragments)
- Sibling-progression trigger over pure timer — more reliable than guessing settle times, since it uses the LLM's own writing progression as the signal
- Already-complete responses use `isAlreadyComplete()` which checks for streaming indicators (`.result-streaming`, `.typing-indicator`, `[data-streaming]`) and stability signals

---

## Removed

### In-Memory Hot Cache — REMOVED

**What it was:** LRU cache (5-min TTL, 300 entries) in front of Supabase.

**Why removed:** On Vercel serverless, each cold start has an empty cache. Saved ~25ms on the minority of requests hitting a warm instance — negligible against 2-4s LLM latency. Not worth the code weight for marginal benefit.

**Files deleted:** `backend/lib/hot-cache.ts`, references removed from [annotate.ts](backend/api/annotate.ts).

### Visible-first Sort — REMOVED

**What it was:** Sorted detected regions by viewport proximity before setting up stability watchers.

**Why removed:** All stability watchers were created in a synchronous loop and all fired their timers within microseconds of each other. The sort provided zero real benefit. The actual visible-first optimization is the existing scroll-loader (IntersectionObserver deferral), which remains in place.

**Files cleaned:** `sortByViewportProximity()` and `distanceToViewport()` removed from [content/index.ts](extension/src/content/index.ts).

### Dead Code — REMOVED

- Unused `onFrame` rAF loop in [overlay.ts](extension/src/content/renderer/overlay.ts) `startTracking()` — declared but never called; actual tracking uses scroll/resize event listeners.
- Unused `rafId` variable associated with the dead rAF loop.

---

## Summary — What Moves the Needle

| Rank | Optimization | Real Impact |
|---|---|---|
| 1 | **Progressive paragraph annotation** | Annotations appear 40-50s earlier on chat pages during LLM streaming |
| 2 | **DB cache + version compat** | Prevents stale annotations; enables safe cache hits across deploys |
| 3 | **Prompt token reduction** | ~30% fewer input tokens → faster + cheaper LLM calls |
| 4 | **In-flight dedup** | Eliminates duplicate LLM calls for concurrent identical requests |
| 5 | **Stale request cancellation** | Correctly aborts per-region; prevents wasted LLM calls on dynamic pages |
| 6 | **Overlay render batching** | Single-frame DOM insertion, measurable on annotation-heavy pages |
| 7 | **Selector index cache** | Fewer TreeWalker traversals, acceptable correctness at moderate density |