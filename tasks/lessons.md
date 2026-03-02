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
