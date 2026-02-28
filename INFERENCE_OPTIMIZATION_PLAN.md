# Annotation Inference Optimization Plan

## Objective

Reduce annotation latency and improve perceived responsiveness without reducing annotation quality.

## Success Metrics

- **TTFA (Time To First Annotation)**: target 40–70% reduction.
- **P95 region annotation latency**: target 30–50% reduction.
- **LLM calls per page revisit**: target 50%+ reduction.
- **Annotation render mismatch/drop rate**: no regression.

## Current Inference Flow (Baseline)

1. Content script detects candidate reading regions.
2. Stability watchers wait for static content (or chatbot completion signals).
3. Region text is extracted and normalized.
4. Region is gated by eager/lazy loading logic.
5. Background sends `/api/annotate` request.
6. Backend checks cache and may call OpenAI.
7. Backend validates/filters annotations.
8. Extension resolves selectors and renders overlays + margin notes.

## What Already Exists (Important Baseline)

- Backend already uses persistent cache in `annotation_cache` for `/api/annotate` lookups.
- Cache lookup currently keys on `content_hash` + `intensity` (+ TTL via `expires_at`).
- Cache entries are written with `model_version` and `prompt_version` metadata.
- Result: refreshes can already avoid new LLM calls when text hash and intensity are unchanged.

## Optimization Workstreams

## 1) Cache Hit-Rate Hardening (Highest ROI)

### Why
Cache exists, so the main gains now come from increasing hit rate and reducing overhead around cache misses/hits.

### How
- Keep hash-based cache lookup in `annotation_cache`, but enforce cache compatibility checks with:
  - `content_hash`
  - `intensity`
  - `model_version`
  - `prompt_version`
- Add a short in-memory hot cache inside backend runtime process to bypass DB for burst duplicate requests.
- Add negative cache (brief TTL) for known-bad inputs (e.g., empty/invalid parse attempts) to reduce repeated waste.

### Implementation
- Update backend annotate read/write path in [backend/api/annotate.ts](backend/api/annotate.ts).
- Add optional process-local cache helper in `backend/lib/`.
- Ensure returned payload includes `cached` source marker (memory/db/new).

### Verification
- Compare cache hit rate before/after.
- Confirm repeated refresh of same page avoids OpenAI calls.
- Confirm prompt/model version changes cannot return stale-incompatible cache entries.

---

## 2) Request Coalescing + In-flight Dedup

### Why
Multiple concurrent requests for identical content can create duplicate LLM calls.

### How
- In backend, maintain an in-flight map keyed by `(content_hash, intensity, model, promptVersion)`.
- If an identical request arrives while one is running, await the same promise.
- On completion/failure, remove key from map.

### Implementation
- Add shared in-flight promise registry in `backend/lib/`.
- Wrap `generateAnnotations` invocation in dedup guard from [backend/api/annotate.ts](backend/api/annotate.ts).

### Verification
- Load test with simultaneous requests; ensure one upstream LLM call per unique key.

---

## 3) Prompt + Token Budget Optimization

### Why
LLM latency is often the largest single cost.

### How
- Compress prompt instructions while preserving schema guarantees.
- Use stricter output constraints (keep `response_format` and add bounded output size).
- Cap annotation count by text length and intensity target.
- Consider reducing verbosity in `content.note` for fast mode.

### Implementation
- Revise prompt profiles in [backend/config/prompts.json](backend/config/prompts.json).
- Tune OpenAI call params in [backend/lib/openai.ts](backend/lib/openai.ts) (`max_tokens`, temperature, timeout/retry policy).

### Verification
- A/B latency and output validity.
- Monitor dropped annotations from filter/validator to ensure quality is retained.

---

## 4) Visible-first Scheduling in Extension

### Why
Perceived speed matters more than full-page completion.

### How
- Annotate only above-the-fold / near-viewport regions first.
- Defer far-off regions using scroll loader.
- Prioritize first stable region for immediate request.

### Implementation
- Adjust region priority and lazy registration flow in:
  - [extension/src/content/index.ts](extension/src/content/index.ts)
  - [extension/src/content/scroll-loader.ts](extension/src/content/scroll-loader.ts)

### Verification
- Measure TTFA from navigation start.
- Confirm lower-priority regions continue annotating in background.

---

## 5) Cancellation of Stale Work

### Why
Dynamic pages can invalidate ongoing extraction/inference quickly.

### How
- Use `AbortController` on annotation request lifecycle.
- Cancel when:
  - region content hash changes before response,
  - page route/URL changes,
  - extension settings disable annotations.
- Ignore stale responses that do not match current hash.

### Implementation
- Add abort/stale guards in [extension/src/content/index.ts](extension/src/content/index.ts).
- Add cancellable fetch path in [extension/src/background/api-client.ts](extension/src/background/api-client.ts) if needed.

### Verification
- Confirm fewer wasted requests on streaming/chat pages.
- Ensure no stale overlays render after content updates.

---

## 6) Faster Selector Resolution + Render Throughput

### Why
Heavy annotation sets can spend significant time in DOM range resolution and redraw.

### How
- Build per-region text-node index once, reuse for multiple selector resolutions.
- Batch redraws with one `requestAnimationFrame` cycle.
- Avoid full rerender when only one annotation changes.

### Implementation
- Optimize:
  - [extension/src/content/selector.ts](extension/src/content/selector.ts)
  - [extension/src/content/renderer/overlay.ts](extension/src/content/renderer/overlay.ts)
  - [extension/src/content/index.ts](extension/src/content/index.ts)

### Verification
- Profile CPU time in large annotated documents.
- Ensure no positioning regressions on scroll/resize.

---

## 7) Progressive Delivery Strategy (Optional Fast Mode)

### Why
Two-phase inference can improve perceived responsiveness on very long pages.

### How
- Phase 1: quick low-density pass (`light`) for immediate feedback.
- Phase 2: upgrade to selected intensity (`default`/`heavy`) in background.
- Replace or merge annotations deterministically.

### Implementation
- Add opt-in preference and request orchestration in content/background flow.
- Keep cache separated by intensity to avoid collisions.

### Verification
- Compare TTFA and user satisfaction against single-pass flow.

## Instrumentation Plan

Add timing marks and structured logs for:
- region detection time
- stability wait time
- extraction/hash time
- backend round-trip time
- cache hit/miss reason
- model call duration
- selector resolve/render duration

Collect in both extension console logs and backend logs, then summarize P50/P95.

## Rollout Plan

1. Add instrumentation first.
2. Implement in-flight dedup + cache compatibility checks + hot cache.
3. Implement visible-first + cancellation.
4. Tune prompt/token budget.
5. Optimize selector/render performance.
6. Gate optional fast mode behind feature flag.

## Risks and Mitigations

- **Risk:** Lower-quality annotations from aggressive prompt trimming.
  - **Mitigation:** A/B tests and quality spot checks before rollout.
- **Risk:** Stale responses painting wrong regions.
  - **Mitigation:** Strict hash checks before render.
- **Risk:** Over-caching across prompt/model changes.
  - **Mitigation:** Include `prompt_version` + `model_version` in cache logic.

## Implementation Checklist

- [x] Add baseline instrumentation to extension + backend. *(inference-benchmark.test.ts — auto-measuring benchmark with frozen baseline)*
- [x] Add backend in-flight request dedup map. *(lib/inflight-dedup.ts — promise coalescing, 5→1 concurrent calls)*
- [x] Add/verify strong cache-key behavior and source markers. *(lib/hot-cache.ts — LRU+TTL; annotate.ts — 3-layer cache with model/prompt version compat)*
- [x] Add extension request cancellation + stale response guard. *(background/index.ts — AbortController per tab+hash; content/index.ts — activeHashes stale guard)*
- [x] Prioritize visible-first region scheduling. *(content/index.ts — sortByViewportProximity)*
- [x] Optimize selector indexing and redraw batching. *(selector.ts — WeakMap text-node index; overlay.ts — DocumentFragment + rAF batching)*
- [x] Tune prompts and OpenAI token budget. *(prompts.json v1.2 — shared templates, ~30% token reduction)*
- [x] Run latency benchmark and compare against baseline. *(26/26 tests pass — see benchmark summary below)*
- [ ] ~~Progressive delivery (workstream 7)~~ — skipped (complexity vs. benefit tradeoff).

### Benchmark Summary (auto-measured)

| Optimization | Result |
|---|---|
| Hot Cache | read p50=0.0ms (saves ~25ms/req vs DB) |
| Inflight Dedup | 1/5 calls (saves 4 LLM calls/burst) |
| Prompt Trimmed | -131 tokens (-30.0% avg) |
| TTFA cold start | 3.02s (-0.8% from 3.05s baseline) |
| Warm revisit TTFA | 200ms (-11.1% from 225ms baseline) |
| Full page revisit total | 824ms (-8.3% from 899ms baseline) |