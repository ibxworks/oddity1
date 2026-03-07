# Lessons Learned

## 2026-03-02: isAlreadyComplete() — Eagerness Causes Data Loss

**Pattern**: An optimization shortcut (`isAlreadyComplete` returning `true` too eagerly) silently discarded 98% of content. The function assumed "no streaming CSS class = complete" — but most LLM pages don't use the hardcoded CSS selectors.

**Rule**: Default to the SAFE path (track progressively). The cost of a false negative (300ms delay for truly-static content) is negligible. The cost of a false positive (entire response lost) is catastrophic.

**Fix**: Snapshot pre-existing elements at `start()`. Only those are "already complete." New elements default to progressive tracking.

## 2026-03-02: inflight Map Race Condition

**Pattern**: `finally { inflight.delete(key) }` unconditionally deleted the key. When a new request replaced an old one, the old request's `finally` deleted the NEW controller → new request unabortable.

**Rule**: Always identity-check shared mutable state before cleanup: `if (map.get(key) === myValue) map.delete(key)`.

## 2026-03-02: Overlay redraw/batch Coordination

**Pattern**: `redraw()` (scroll) and `flushBatch()` (new annotations) operated independently. Both could fire in the same rAF frame, producing duplicate DOM elements.

**Rule**: When two code paths write to the same DOM container, the full-redraw path must cancel the incremental-batch path.

## 2026-03-02: AbortError is Not an Error

**Pattern**: `AbortError` from intentional request cancellation was logged as `console.error` and caused the content script to delete pending state.

**Rule**: Always catch `AbortError` separately from real errors in any pipeline that uses `AbortController`.

## 2026-03-03: Streaming Path Must Mirror Non-Streaming Optimizations

**Pattern**: The non-streaming `/api/annotate` path chunked long texts (>1500 words) into parallel LLM calls. The SSE streaming path did NOT — it sent the full text in one call. The LLM hit its output token limit and truncated after ~5 annotations regardless of text length.

**Rule**: When a pipeline has two code paths (batch vs streaming), BOTH must implement the same optimization strategies (chunking, dedup, etc). Test both paths with long inputs.

## 2026-03-03: One-Shot Observers Kill Dynamic Content Detection

**Pattern**: `createDebounceWatcher` disconnected after first fire. This is correct for static pages, but on dynamic pages (LLM chats without adapters), new content appearing after the initial fire was never detected.

**Rule**: For observers that guard dynamic content, provide a `persistent` option that keeps watching. Use a cheap content-change check (e.g., textContent.length) to avoid re-processing unchanged DOM (annotation rendering wraps text without changing textContent).

## 2026-03-03: Static Flow With Early Return Kills Dynamic Pages

**Pattern**: `detectReadingRegions` ran once at init. If it found zero regions (empty chat page), the content script returned early — no watchers set up, no way to detect content appearing later. Even WITH regions, new containers added later were invisible.

**Rule**: Never early-return from init on dynamic pages. Always set up a body-level MutationObserver that periodically re-runs region detection. Use a WeakSet of known elements to avoid re-processing, and a long debounce (1-2s) to avoid excessive re-scans.

## 2026-03-03: LLM Annotation Density Undershooting

**Pattern**: The prompt said "Target ~5 per 1000 chars" but the LLM consistently underproduced, especially on longer inputs. Chunk sizes of 1200 words (~7200 chars) meant the LLM should have produced ~36 annotations per chunk, but it stopped at 5-10 (output laziness / early stopping).

**Rule**: (1) Use dynamic count hints in the user message: "[Input: ~N chars. Produce approximately M annotations.]" — this gives the LLM an explicit numeric target. (2) Reduce chunk sizes (800 words) so each chunk's target count is more achievable. (3) Add anti-laziness instructions: "Do NOT stop early."

## 2026-03-03: Per-Paragraph Firing Kills Annotation Diversity

**Pattern**: Chat observer fired individual `<p>` elements as separate annotation requests (~20-50 words each). With so little context, the LLM could only produce highlights/vocabulary — no provoking questions, insights, caveats, or recall. These need cross-sentence or cross-paragraph context.

**Rule**: ALWAYS fire the complete response element as a single region. Full context is essential for diverse annotation types. The 300ms completion-settle delay is imperceptible vs. the massive quality loss from per-paragraph fragmentation. Backend SSE streaming still provides progressive rendering.

## 2026-03-03: Chat Mode Early Return Prevents Fallback

**Pattern**: When an adapter matched with `response_selector`, the content script entered chat mode and `return`ed early — skipping ALL static flow setup. If the adapter's selector was stale/broken (common with frequently-updated sites like Claude), zero annotations appeared AND no fallback could activate.

**Rule**: Chat mode must include a timed fallback. If the chat observer finds no responses within N seconds, stop it and activate body-level detection. This handles stale adapters gracefully without requiring manual adapter DB updates.

## 2026-03-03: extractText Destroys Paragraph Structure → splitIntoChunks Never Fires

**Pattern**: `extractText()` calls `normalizeWhitespace()` which replaces ALL whitespace (including `\n`) with single spaces. The text sent to the backend has ZERO newlines. Meanwhile, `splitIntoChunks()` splits on `\n\n+` (double newlines). Result: text is NEVER chunked regardless of word count — every request becomes a single LLM call, producing only 5-6 annotations with diverse types frontloaded to the first paragraph.

**Root cause chain**: DOM `textContent` → `normalizeWhitespace` kills `\n` → backend `split(/\n\n+/)` yields 1 segment → no chunking → single lazy LLM call → 5-6 annotations total.

**Rule**: (1) Chunking logic MUST handle text without newlines. Use a multi-strategy approach: try `\n\n`, then `\n`, then sentence boundaries (`/(?<=[.!?])\s+(?=[A-Z])/`), then hard word-count splits. (2) ALWAYS trace test data through the full pipeline when debugging — had we sent "Hello world. Another sentence. Third sentence." through `splitIntoChunks`, the bug would have been immediately obvious. (3) Lower chunk thresholds aggressively (300 words / 250 target) so the model produces diverse annotations per chunk instead of being lazy across a large input.

## 2026-03-03: Chunk Overlap + LLM Front-Loading = Dedup Disaster

**Pattern**: Chunk overlap prepends N words from chunk K to the start of chunk K+1 for "context". But gpt-4o-mini front-loads annotations to the beginning of its input. The LLM for chunk K+1 annotations the overlap text first → those anchors already exist in the `seen` dedup Set from chunk K → the annotations are silently dropped. Result: only chunk 1's annotations survive; all subsequent chunks contribute almost nothing.

**Root cause chain**: overlap_text at start of chunk → LLM annotates overlap first (front-loading bias) → `seen.has(fixed.anchor.exact)` = true → annotation dropped → chunk effectively wasted.

**Rule**: (1) NEVER use overlap in chunk splitting when there's a dedup mechanism downstream. Overlap + dedup = silent data loss from front-loading bias. (2) If context is needed, mark it explicitly as "[CONTEXT - do not annotate]" or pass it separately. (3) The annotation-filter's `fixSingleAnnotation` already re-computes prefix/suffix against the full text, so overlap isn't needed for anchor quality.

## 2026-03-03: LLMs Ignore "approximately N" — Use "at least N" + Section Context

**Pattern**: Dynamic hint said "Produce approximately 17 annotations". gpt-4o-mini produced 6-7 consistently. "Approximately" gives the model permission to undershoot.

**Rule**: (1) Use "You MUST produce at least N annotations" — imperative + floor is stronger than "approximately". (2) For chunked inputs, add section context: "[This is section 2 of 4]" — this prevents the model from thinking it's seen the whole text and stopping early. (3) Explicitly list all annotation types in the hint: "Use ALL six types (highlight, vocabulary, provoking question, recall, insight, caveat)" — prevents the model from sticking to highlight-only.

## 2026-03-03: LLM-Generated annotation IDs Collide Across Regions

**Pattern**: The LLM generates sequential IDs (`ann_1`, `ann_2`, ...) for every API call. When two separate chat responses each trigger their own annotation request, both return `ann_1` through `ann_6`. In `addMarginNote`, the dedup check `notes.some(n => n.id === annotation.id)` causes the second region's margin notes to be silently SKIPPED — because `ann_1` is already registered from the first region. Meanwhile, `injectAnchors` and `renderAnnotation` (overlay) DON'T deduplicate by ID, so underlines STILL render. Result: second paragraph has underlines but zero margin notes. Hovering a second-paragraph underline highlights a FIRST-paragraph margin note (same `ann_3` ID → wrong content).

**Root cause chain**: LLM sequential IDs → two regions share identical IDs → margin note dedup by id drops region 2 → underlines render but margin notes don't → hover cross-links wrong annotation.

**Rule**: (1) NEVER trust LLM-generated IDs for uniqueness across calls. Replace them with `randomUUID()` immediately after validation, before caching or streaming. (2) Any dedup by ID in rendering code must be verified against multi-region scenarios. (3) When debugging "annotations render but margin notes don't", check ID collisions first.

## 2026-03-03: Density Formula Math Must Match Expectations

**Pattern**: 7 per 1000 chars with a floor of 5. A typical ChatGPT paragraph (~150 words ≈ 900 chars): `max(5, round(900/1000 * 7))` = 6. This is why users see "always 6 annotations." The density target was calibrated for long articles, not chat responses.

**Rule**: (1) ALWAYS compute the formula with representative inputs before shipping. ~900 chars at 7/1000 = 6 is obvious in hindsight. (2) Chat responses need higher density than articles — raise to 12/1000 default. (3) The floor must be high enough for meaningful coverage — raise from 5 to 8. (4) After any density formula change, verify: "what does a 500-char input produce? 1000? 2000?" before deploying.

## 2026-03-06: Timed Fallbacks Must Not Destroy In-Progress Work

**Pattern**: A 6-second `setTimeout` fallback checked `regions.length > 0` to decide if the chat observer was working. If no responses had completed yet (fresh chat — user hasn't typed, or first response still streaming), `regions.length === 0` → fallback stopped the chat observer, destroying all in-progress MutationObservers and completion timers for actively-streaming responses. On a fresh ChatGPT chat, the first prompt response was always lost because (a) the user often takes >6s to start typing, or (b) streaming started but hadn't settled, so `onResponse` hadn't fired yet, so `regions.push` hadn't happened.

**Rule**: (1) NEVER destroy an observer as a fallback action — run a supplementary detection path ALONGSIDE the primary one instead. Both paths can coexist with content-hash dedup preventing double-processing. (2) When checking "is this system working?", check the system's actual tracked state (e.g., `responseStates.size > 0`), not downstream side effects (`regions.length`). (3) For dynamic pages where content may not exist at init time, the observer must survive indefinitely — "nothing found yet" ≠ "the selector is broken."

## 2026-03-06: Eager Shadow DOM Initialization Prevents Silent addMarginNote Failures

**Pattern**: `addMarginNote()` has an early return `if (!shadowRoot || !regionEl) return` — silently discards the note if `initMarginNotes` hasn't been called. In chat mode, `initMarginNotes` was only called inside the `onResponse` callback. If the 6s fallback killed the chat observer before `onResponse` fired, the shadow DOM was never created. Subsequent annotations via the fallback body-level path rendered highlights (overlay works without shadow DOM) but margin note boxes were silently dropped. This is the coworker's bug: "highlights appear but annotation boxes don't."

**Rule**: (1) Initialize rendering infrastructure (shadow DOM, containers, overlays) EAGERLY during init, not lazily on first data arrival. The cost of early init is zero; the cost of missing it is silently broken features. (2) Functions that silently return on missing state (guard clauses) should at minimum log a warning in debug mode — silent failures are the hardest bugs to diagnose.

## 2026-03-07: Content Scripts on SPAs Must Detect URL Changes

**Pattern**: `init()` ran once at content script injection. On SPAs (Claude, ChatGPT), `history.pushState()` navigations change the URL and page content without reloading — the content script never re-ran. All module-level state (Maps, Sets, arrays, observers) persisted. Old annotations stayed visible on the new page. Shadow DOM hosts got orphaned when the SPA replaced containers. Observers watched stale DOM.

**Rule**: (1) ALWAYS intercept `history.pushState`, `history.replaceState`, and listen for `popstate` to detect SPA navigation. (2) On URL change: reset ALL annotation state, destroy ALL DOM artefacts, stop ALL observers, then re-init from scratch. (3) Module-level references to observers/timers created inside `init()` are required — local variables can't be cleaned up from outside. (4) Re-init must be idempotent: guards on event listeners, destroy functions that null out their state. (5) Debounce navigation events (300ms) — SPAs often fire multiple rapid history changes during a single navigation. (6) **Content scripts run in an isolated world** — monkey-patching `history.pushState`/`replaceState` only affects the isolated copy, NOT the page's real History API. Use a URL polling interval (e.g. 500ms) instead, combined with `popstate` for instant back/forward detection.

## 2026-03-07: Stale-While-Revalidate Causes Destructive Re-Renders

**Pattern**: The service worker used a stale-while-revalidate strategy: send cached `annotationsReady` immediately, then fall through to a fresh server fetch and send a SECOND `annotationsReady`. The content script's `annotationsReady` handler used `currentAnnotations.has(regionId)` as a proxy for "had streaming" — but this was `true` even when the first render came from the cache (not from progressive streaming). The second `annotationsReady` triggered a global nuke (clear overlay + anchors + margin notes + full re-render), causing margin notes to disappear. The long wait toast also fired for cached content because `annotatedRegions` was cleared on SPA navigation, so the content script didn't know the data was cached.

**Rule**: (1) Use a dedicated tracking mechanism (`streamedRegions` Set) to distinguish progressive streaming renders from cache-first renders — the proxy `currentAnnotations.has()` conflates both. (2) When a region is ALREADY in `annotatedRegions` and NOT in `pendingRegions`, the incoming `annotationsReady` is a revalidation update — silently update state data without visual disruption. (3) Global clear-and-re-render should only happen when progressive streaming annotations actually need replacing with the final complete set.

## 2026-03-07: Global regionEl For Margin Note Positioning Breaks Chat Sites

**Pattern**: Margin notes used a single global `regionEl` for horizontal positioning of ALL notes. In chat mode `regionEl` started as `document.body` (full viewport width) and was updated to the latest response element via `initMarginNotes(element)`. Two fatal bugs: (1) When `regionEl = document.body`, `regionRect.right = viewport width` → right-side notes positioned at `viewportWidth + padding` → completely off-screen. This always happened when cached annotations arrived before any chat response completed (SPA navigation to cached page). (2) All notes used the SAME `regionEl` — when a new response changed it, existing notes from previous responses recalculated positions using the wrong element → drift/overlap.

**Rule**: (1) Store the region reference PER NOTE at creation time, not globally. Each note should know which content region it belongs to. (2) When the region is full-width (body, wrapper divs), derive the content column bounds from the note's own Range — walk up from `range.commonAncestorContainer` until finding a sub-80%-viewport-width block element. (3) NEVER use `document.body` bounds for margin positioning — it's always viewport-wide and useless. (4) For `position: absolute` children, NEVER use `right` CSS — the containing block width varies unpredictably across sites. Use `left` only, computed as `contentLeft - noteWidth` for left-side notes.
