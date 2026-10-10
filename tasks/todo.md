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

## Fresh Chat First-Prompt Annotation Fix (Mar 6, 2026)

### Problem
On LLM sites (ChatGPT, Claude), loading a fresh chat and generating the first response produced zero annotations. Only after reloading the page and generating a new response did annotations work. Coworker also reported: highlights/underlines appear during streaming but margin note boxes are missing.

### Root Causes
1. **6-second fallback killed the chat observer**: A `setTimeout(6000)` checked `regions.length > 0`. On a fresh chat with no responses yet, this was always 0 → destroyed the chat observer (including any in-progress streaming tracking). Body-level fallback took over but had a 1500ms debounce that kept resetting during streaming.
2. **Margin notes shadow DOM never initialized**: `initMarginNotes()` was only called inside the `onResponse` callback. If the chat observer was killed before `onResponse` fired, the shadow DOM was never created → `addMarginNote()` silently returned → highlights rendered but no margin note boxes.

### Fix
- [x] Removed destructive 6s fallback — chat observer now runs for the entire page lifetime
- [x] Body-level detection runs IN PARALLEL as a safety net (not as a replacement)
- [x] Content-hash dedup prevents double-processing when both paths find the same element
- [x] Added `onTrack` callback to chat observer — fires when an element is first discovered (before completion)
- [x] Body-level detection skips elements tracked by the chat observer (including ancestors) via `isTrackedByChat()`
- [x] Eager `initMarginNotes(document.body)` creates the shadow DOM during init — never silently drops margin notes
- [x] `onResponse` callback updates `regionEl` to the actual response element for accurate margin positioning
- [x] TypeScript compile clean, Vite build clean

### Files Modified
- `extension/src/content/index.ts` — removed 6s fallback, parallel detection, eager margin init, `chatTrackedElements` WeakSet
- `extension/src/content/chat-observer.ts` — added `onTrack` callback to `ChatObserverConfig`

## PDF-to-HTML Upgrade: Datalab Marker API (Apr 4, 2026)

- [x] 1. Create backend route `backend/routes/convert-pdf.ts`
- [x] 2. Register route in `backend/api/index.ts` (with 4.5mb body limit, mounted before global parser)
- [x] 3. Update `backend/.env.example` (FIRECRAWL → MARKER_API_KEY, already done by user)
- [x] 4. Add shared message type in `packages/shared/src/types.ts`
- [x] 5. Add API client function in `extension/src/background/api-client.ts`
- [x] 6. Add background message handler in `extension/src/background/index.ts`
- [x] 7. Update `handlePdfConversion()` in `extension/src/content/index.ts`
- [x] 8. Build & verify no TypeScript errors — all 3 packages clean

## SPA Navigation Fix (Mar 7, 2026)

### Problem
On SPA sites (Claude, ChatGPT), switching between conversations or navigating within the app caused:
1. **Annotations persisted across pages**: Old annotations from the previous conversation remained visible on the new page
2. **Annotations randomly disappeared**: Margin notes vanished (shadow DOM host detached) while anchor underlines survived
3. **Overall bugginess**: Stale observers, duplicate regions, cross-wired state

### Root Causes
1. **No SPA navigation detection**: `init()` ran once at content script load. SPAs use `history.pushState()` to navigate without full page reloads — the content script never re-ran.
2. **Module-level state persisted**: All Maps/Sets/arrays (`annotatedRegions`, `currentAnnotations`, `regionByHash`, `regions`, etc.) survived across navigations.
3. **Observers leaked**: `chatObserver` and body `MutationObserver` were local variables inside `init()` — no way to stop them on navigation.
4. **Shadow DOM host orphaned**: When SPA replaced the page content container, the margin notes shadow DOM host was removed from the DOM → margin notes disappeared but overlay/anchors survived briefly.

### Fix
- [x] Added `watchUrlChanges()` — intercepts `history.pushState`, `history.replaceState`, and `popstate` events
- [x] 300ms debounce on navigation events (SPAs can fire multiple rapid history changes)
- [x] `resetAnnotationState()` — full state teardown: clears all Maps/Sets, stops observers, destroys overlay/margin-notes/arguments-box/manual-annotations/anchors
- [x] Hoisted `chatObserver` and `bodyObserver` to module-level (`activeChatObserver`, `activeBodyObserver`) for cleanup access
- [x] `init()` is re-entrant: safe to call after `resetAnnotationState()` clears everything
- [x] `initKeyboardNav()` guarded against duplicate listener registration
- [x] `lastKnownUrl` synced at start of `init()` to prevent false re-triggers
- [x] TypeScript compile clean, Vite build clean

### Files Modified
- `extension/src/content/index.ts` — all changes above

## Light-only vanilla port

Source: prior harvest reports (component inventory, light tokens,
shadow and build notes). See the design language doc in docs/ for
hex, opacity, radius, motion, sizing, layout, inventory, and mapping.
Scope: light theme only, vanilla files, micro-copy only. Skip the
editor-document overlay.

### Port rules (strict)

- [ ] Target files use generic terms only: no reference repo name,
  path, or URL in any new file
- [ ] Light tokens only; no dark values
- [ ] Vanilla markup, style, and script; no framework
- [ ] System font stacks only; no remote font fetch
- [ ] No remote code fetch; bundled re-inject only

### Phase 1 — Tokens and shells

- [ ] 1.1 Add target-relative tokens.css with Set A plus Set B light
  hex, scrim 0.32, radius, motion, sizing
- [ ] 1.2 Port popup shell: header plus toggle, auth block, main
  content, personalities Terry/Jerry/Sally, public-figure row,
  font and size selects, provider section, export action, profile
  popover, export dialog
- [ ] 1.3 Port popup logic: load prefs, apply to UI, auth-state UI,
  provider status, provider change, key save
- [ ] 1.4 Port markdown export helper plus download
- [ ] 1.5 Port options shell: Account card, Auto-Enabled Sites,
  Default Preferences, toast
- [ ] 1.6 Port options logic: prefs, site list, auth status, toast

### Phase 2 — In-page layer

- [ ] 2.1 Port highlight layer: invisible anchors, fixed topmost
  overlay with pointer-events none, per-type style map
- [ ] 2.2 Port margin rail: fixed host, closed shadow, overview path
  plus inline popover path
- [ ] 2.3 Port bottom-right panel: fixed host, closed shadow
- [ ] 2.4 Port hover card: 200ms show, 300ms hide, hover bridge,
  closed shadow
- [ ] 2.5 Port toasts (fixed top-right, topmost z): auth 8s,
  enable-domain, notice 3s, usage, long-wait

### Phase 3 — Chat mode and wiring

- [ ] 3.1 Port chat helpers: display name, prompt label, placeholder,
  helper, loading, error, empty-state, onboarding
- [ ] 3.2 Port chat observer: scan, track, finalize, start, stop
- [ ] 3.3 Port optimize button: closed shadow, "Optimize Prompt",
  paste into input, done event, destroy
- [ ] 3.4 Port prompt pipeline: chat mode flag, gated request,
  paste into chat input
- [ ] 3.5 Port manifest wiring: module worker, early guard plus idle
  entry, popup and options pages, image icons only

### Phase 4 — Verify

- [ ] 4.1 Grep new files for reference names, absolute paths, and
  remote URLs; zero hits
- [ ] 4.2 Render popup plus options light-only; check hex, radius,
  spacing against the design language doc
- [ ] 4.3 Exercise overlay, rail, panel, hover card, all five toasts
- [ ] 4.4 Exercise chat mode on a chatbot host: observer plus
  optimize plus paste
- [ ] 4.5 Reduced-motion pass: motion collapses, no stuck state

### File mapping (new files, target-relative)

- [ ] tokens.css, popup/index.html, popup/app.js, popup/export.js
- [ ] options/index.html, options/app.js
- [ ] content/highlight.js, content/margin-notes.js, content/panel.js
- [ ] content/popover.js, content/toasts.js, content/chat.js
- [ ] manifest config

## Review — light UI unification (branch ui/minimal-elegant)

Delivered in-place unification onto shared light tokens instead of
the from-scratch port sketched above. Dark-theme rules and GDocs
surfaces untouched by scope decision.

Shipped:
- docs/design-language.md — warm/cool hex sets, opacity, radius,
  motion, type, sizing, shadows, layout, inventory, file mapping.
- extension/src/shared/tokens.css + LIGHT_TOKENS TS mirror.
- Popup + options on token vars, system stack, micro-copy only.
- One TOAST_CSS theme shared by all five toasts.
- Popover, overlay, anchors, optimize button, margin rail, and
  bottom-right panel retuned: token colors (light rules), system
  stacks, scale radii, 0.2s motion, reduced-motion guards.
- Note fonts stay Fraunces/Kalam; remote fetch trimmed to those two.

Verified (observed in this worktree):
- tsc clean: extension, shared, backend.
- Tests pass: 45 extension + 22 shared.
- Build passes with dummy OAuth env; manifest valid; tokens CSS
  bundled and linked from popup and options.
- Playwright (extension loaded): popup bg #FAFAF9, system font,
  8px controls; toast white/10px/#E0E2E5/green action; note card
  10px radius, ink body, chip header; zero console errors on
  popup, options, and a live page.
- Aside second route: popup bg token confirmed; options renders
  identically.
- Anonymization scan: zero reference-name hits in docs, code,
  styles, and markup.
