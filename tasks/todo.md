# Oddity 1 — Implementation Progress

## Phase 0 — Foundation
- [x] 0.1 Root monorepo scaffold (package.json, .gitignore, tsconfig.base.json)
- [x] 0.2 Shared types workspace (packages/shared/)
- [x] 0.3 Extension workspace scaffold
- [x] 0.4 Backend workspace scaffold
- [x] 0.5 Shared types (types.ts — ALL contracts)
- [x] 0.6 Shared constants + extension utilities
- [x] 0.7 Supabase migration + RLS
- [x] 0.8 Stub entry points
- [x] Gate: npm install, type-check, Vite build, Supabase tables

## Phase 1 — Parallel Build
- [x] Agent B: Backend (11 files — lib/, api/, config/)
- [x] Agent C: Extension Service Worker (5 files)
- [x] Agent D: Content Script Detection (4 files)
- [x] Agent E: QA/Tooling (ESLint, Vitest, 23 tests passing)

## Phase 2 — Rendering + Integration
- [x] Selector resolver (selector.ts)
- [x] Overlay engine (renderer/overlay.ts)
- [x] Styles map (renderer/styles.ts)
- [x] Anchor spans (renderer/anchors.ts)
- [x] Popover component (renderer/popover.ts)
- [x] Scroll loader (scroll-loader.ts)
- [x] Manual annotations (manual.ts)
- [x] Content script wiring (index.ts — full pipeline)
- [x] Seed site adapters in Supabase (ChatGPT, Claude, Medium, Substack)

## Phase 3 — UI + Polish
- [x] Popup dashboard (index.html, index.ts, export.ts)
- [x] Options page (index.html, index.ts)
- [x] Keyboard navigation (Tab between annotations, Enter/Escape for popover)
- [x] Intensity change triggers re-annotation (fixed hardcoded 'default')
- [x] Supabase security hardening (RLS enabled on all tables, fixed function search path)

## 14-Point Validation Checklist (Spec Section 15, Step 11)
1. [x] Extension loads in Chrome — valid dist/manifest.json with MV3 structure
2. [x] Signup/login flow — auth.ts has signIn/signUp/signOut, popup+options have auth UI
3. [x] ChatGPT annotations — adapter seeded (chatgpt.com, chat.openai.com) with stability signal
4. [x] Medium annotations — adapter seeded (medium.com, *.medium.com) with readability mode
5. [x] Unknown site fallback — detector.ts has 3-tier fallback (adapter → readability → heuristic)
6. [x] Hover popover — 200ms show / 300ms hide delays, hover bridge, closed shadow DOM
7. [x] Manual annotations — FAB + shadow DOM editor + context menu handler
8. [x] On/off toggle — settingsUpdated handler with setOverlayVisible
9. [x] Intensity change — re-requests annotations with new intensity (no longer hardcoded)
10. [x] Markdown export — exportAsMarkdown with blockquotes, grouped by type
11. [x] Cached annotations — cache check before OpenAI call, 30-day TTL
12. [x] Lazy loading — IntersectionObserver with 500px rootMargin, EAGER_WORD_LIMIT check
13. [x] No host page breakage — pointer-events:none overlay, shadow DOM popovers
14. [x] contenteditable exclusion — isInsideEditable check in anchors.ts

## Color Consolidation + Delete Fix + AI Annotation Edit/Delete (Feb 28, 2026)

- [x] Color consolidation: caveat → violet (#7C3AED), vocabulary → teal (#0D9488)
- [x] Fix delete not disappearing: onDelete callback for immediate DOM cleanup
- [x] Remove thumbs-down hide behavior (annotation stays visible, badge toggles)
- [x] Backend: upsert (PUT) + tombstone (DELETE) + dedup (GET)
- [x] AI annotation edit/delete buttons (shared helper, url/contentHash in payloads)
- [x] Reaction badge in collapsed margin notes (👍/👎 emoji next to label)

## Build Verification
- [x] `npm install` succeeds
- [x] `npm run type-check` passes (all 3 workspaces, zero errors)
- [x] `npm run build` — extension produces valid dist/ (content script 19KB gzipped, well under 100KB budget)
- [x] `npm test` — 23/23 tests pass (8 shared + 9 schema-validator + 6 rate-limiter)
- [x] Supabase security advisors — zero errors (INFO-only for intentional no-policy tables)
- [x] 6 site adapters seeded (chatgpt.com, chat.openai.com, claude.ai, medium.com, *.medium.com, *.substack.com)

## Optimization Pass
- [x] Deleted in-memory hot cache (backend/lib/hot-cache.ts) — marginal on serverless
- [x] Removed hot cache references from annotate.ts — DB cache + dedup remain
- [x] Fixed abort key: now uses regionId instead of contentHash — stale requests actually cancel
- [x] Added abort signal to getAnnotations() — both fetches now cancellable
- [x] Added regionId to ExtensionMessage type + content script payload
- [x] Removed sortByViewportProximity + distanceToViewport — cosmetic, zero real impact
- [x] Removed dead onFrame rAF loop + rafId from overlay.ts
- [x] Rewrote chat-observer for progressive paragraph annotation (sibling-progression trigger)
- [x] Updated INFERENCE_OPTIMIZATION_PLAN.md with current state

## Inference Speed Optimization (Mar 3, 2026)

### Phase 1: Quick Wins
- [x] Eliminate redundant network round-trip (3 calls → 1 POST with merged response)
- [x] Speculative prefetch before stability (fire immediately, 500ms verification window)
- [x] Prompt output optimization (compressed fields, remove suggestions, intensity-dependent fields)

### Phase 2: Caching Layer
- [x] Service worker session cache (chrome.storage.session, instant revisits)

### Phase 3: Parallel Processing
- [x] Parallel chunk annotation (1200-word chunks, Promise.all, deduplicate)

### Phase 4: Streaming + Prediction
- [x] Streaming JSON with progressive rendering (SSE, incremental parsing, annotationReady)
- [x] URL-hash prediction for instant revisits (chrome.storage.local, speculative render)

### Phase 5: Production (Future)
- [ ] Edge cache via CDN GET endpoint (requires Vercel Pro)

### Files Created
- `backend/lib/merge-annotations.ts` — shared merge utility
- `extension/src/background/sw-cache.ts` — session cache module
- `extension/src/background/url-cache.ts` — URL prediction cache module
- `docs/INFERENCE_OPTIMIZATION_PLAN.md` — rewritten optimization docs

### Review
- `npm run build` — zero errors
- `npm test` — all 16 tests pass (8 shared + 10 schema-validator + 6 rate-limiter)
- Projected latency: 0ms revisits, ~500ms first annotation on cache miss

## PDF Export Fix (Mar 5, 2026)

- [x] Replaced html2pdf.js (html2canvas + jsPDF) with browser native `iframe.print()`
- [x] Content extraction: live region DOM clone instead of Readability (works on ChatGPT/Claude)
- [x] Oddity anchor spans stripped from clones (preserves original text flow)
- [x] Relative image URLs resolved to absolute in export
- [x] Print-optimized CSS: `@page A4`, `@media print`, `break-inside: avoid`, `print-color-adjust: exact`
- [x] Google Fonts (Lora + Caveat) with `doc.fonts.ready` gate + system fallbacks
- [x] Promise resolves before blocking `print()` call to prevent message channel timeout
- [x] Popup message updated to "Print dialog opened — choose Save as PDF"
- [x] Build verified: `npx tsc --noEmit` + `npx vite build` clean

### PDF Export v2 — Production Fixes (Mar 5, 2026)
- [x] HTML sanitization: strip inline styles, CSS classes, data attributes, non-content elements (buttons, SVGs, nav, forms, etc.)
- [x] Replaced 3-column grid + `position: absolute` notes → Tufte-style float sidenotes (`float: left/right; clear: left/right`)
- [x] Sidenotes injected inline after `<mark>` anchors — stay in document flow, participate in page breaks
- [x] No more overlap: `clear` stacks same-side notes; no more cutoff: floats paginate correctly
- [x] Unmatched annotations (text not found on page) now shown in "Additional Annotations" section at bottom
- [x] Main text neutralization CSS: host-page wrapper divs constrained with `max-width: 100%; overflow-wrap: break-word`
- [x] Headings, blockquotes, code blocks, tables, hr all get `clear: both` to avoid float interference
- [x] Build verified clean
