# Design language — light-only vanilla port

Scope: light theme only. Vanilla markup, style, and script. No framework, no
pre-processor. Out of scope: editor-document overlay (skipped).

## 1. Color — Set A light (warm neutral)

| Token | Hex |
|---|---|
| page bg | #FAFAF9 |
| fg | #1C1917 |
| card | #FFFFFF |
| primary | #292524 |
| primary fg | #FAFAF9 |
| secondary | #F5F5F4 |
| muted | #F5F5F4 |
| muted fg | #78716C |
| accent | #F0F0ED |
| accent fg | #1C1917 |
| destructive | #EF4444 |
| alert bg | #FEF2F2 |
| alert fg | #B91C1C |
| alert border | #FECACA |
| border | #E7E5E4 |
| input | #E7E5E4 |
| ring | #1C1917 |
| float chrome | #F0F0ED |
| float panel | #FAFAF9 |
| float border | #DEDAD7 |

## 2. Color — Set B light (cool neutral, sRGB)

| Token | Hex |
|---|---|
| page | #FAFAFB |
| canvas | #F1F2F3 |
| surface | #FFFFFF |
| inset | #F7F8F9 |
| hover | #F4F5F6 |
| hover 2 | #E7E9EB |
| ink | #1F2124 |
| ink 2 | #62656B |
| ink 3 | #9A9DA3 |
| line | #ECEDEF |
| line strong | #E0E2E5 |
| line soft | #F3F4F5 |
| field | #F2F2F3 |
| accent | #0285FF |
| accent ink | #0070DD |
| accent tint | #E9F3FF |
| green | #199A4D |
| green tint | #E8F5ED |
| orange | #EF720D |
| orange tint | #FDF1E5 |
| red | #E3474C |
| red tint | #FCECEC |
| tooltip bg | #25272B |
| tooltip fg | #F6F7F8 |

Dark values exist in the reference sets but are excluded here.

## 3. Opacity

- Scrim: rgba(28, 25, 23, 0.32).
- Key cap shadow: black at 0.10 and 0.15, inset white at 0.8.
- Light status tints are solid hex (see tables above).

## 4. Radius

- Set A: base 8, sm 4, md 6, lg 8, xl 12, panel 20, sheet 24, pill 999.
- Set B: chip 6, control 8, card 10, window 14, pill 999, focus ring 4.
- Port rule: controls 8, cards 10, panels 20, sheets 24, pills 999.

## 5. Motion

- Set A defines no motion. Use Set B motion below.
- Easings: ease-out-strong (0.23, 1, 0.32, 1), ease-in-out-strong
  (0.77, 0, 0.175, 1), ease-link (0.16, 1, 0.3, 1).
- Keyframes: shimmer-text, fade-up 8px, fade-in, pop-in from 0.95,
  eq-bounce, spin, pixel-on, caret-blink.
- Caret blink 1s step-end. Underline 280ms ease-link.
- Hover card: show 200ms, hide 300ms, hover bridge.
- Toasts: sign-in prompt 8s autodismiss, notice 3s.
- Reduced motion: collapse to 0.01ms, freeze theme switch.

## 6. Type

- Set A: largeTitle 34/40/700/-0.7, title 24/30/700/-0.35,
  section 16/22/700, body 15/22/400, bodyStrong 15/20/600,
  label 14/18/600, caption 12/16/400, captionStrong 12/16/600.
- Set B: base 14px, tracking -0.01em, leading 1.5, antialiased.
- Sans: system stack. Mono: system mono stack.
- Tooltip 11.5px tabular-nums.
- Toasts: system stack only.
- User note font: host custom property, options default, serif
  display, hand, grotesque sans, system sans, system serif.
- Port rule: system stacks only, no remote webfont fetch.

## 7. Sizing

- Spacing scale: 0, 4, 8, 12, 16, 24, 32, 40.
- Control heights: 36, 44, 52, 72, 52.
- Card pad 12, bar 10/12, footer 10, table cell 10/12.
- Icon button 28x28, tooltip pad 5/9, gap 12, dot 8.
- Caret 2px wide, 1.05em tall. Sidebar 224, rail 52.

## 8. Shadows (light)

- Levels: hairline, button, card, raised, overlay, inset field.
- Light recipe: line-color ring plus smooth stack.

## 9. Layout

- Popup: header with logo plus enabled toggle, auth block, main
  content, personality picker, public-figure row, font and size
  selects, provider section, export action, profile popover,
  export dialog.
- Options page: Account card, Auto-Enabled Sites, Default
  Preferences, toast.
- In-page highlight layer: full-viewport fixed, topmost z,
  pointer-events none, invisible anchor spans.
- Margin rail: fixed host, closed shadow.
- Bottom-right panel: fixed, closed shadow.
- Hover card: closed shadow, delayed show and hide.
- Toast stack: fixed top-right, topmost z.
- Chat optimize button: closed shadow overlay near chat input.

## 10. Component inventory

1. Popup shell and logic.
2. Markdown export helper.
3. Options shell and logic.
4. Highlight layer: anchors, overlay, style map.
5. Margin rail renderer.
6. Bottom-right panel.
7. Hover card.
8. Toasts: auth, enable-domain, notice, usage, long-wait.
9. Chat helpers: display name, prompt labels, placeholders.
10. Chat observer: scan, track, finalize, start, stop.
11. Optimize button: init, paste, done event, destroy.
12. Prompt pipeline: chat mode, paste into input, gated request.
13. Manifest wiring: worker, content scripts, popup, options, icons.

## 11. File mapping (paths relative to extension/src)

| Component | File |
|---|---|
| Light tokens (CSS) | shared/tokens.css |
| Light tokens (TS mirror) | ../../packages/shared/src/constants.ts (LIGHT_TOKENS) |
| Popup shell | popup/index.html |
| Popup logic | popup/index.ts |
| Export helper | popup/export.ts |
| Options shell | options/index.html |
| Options logic | options/index.ts |
| Highlight layer | content/renderer/anchors.ts, content/renderer/overlay.ts |
| Margin rail | content/renderer/margin-notes.ts |
| Bottom-right panel | content/renderer/arguments-box.ts |
| Hover card | content/renderer/popover.ts |
| Toasts (shared theme) | content/toast-theme.ts |
| Toasts (variants) | content/notice-toast.ts, auth-toast.ts, usage-toast.ts, long-wait-toast.ts, enable-domain-toast.ts |
| Chat optimize button | content/renderer/optimize-button.ts |
| Chat helpers | content/chatbot-ui.ts |
| Manifest wiring | ../manifest.config.ts |

Palette allocation: extension pages (popup, options) use the warm
neutral set; in-page surfaces (notes, hover card, toasts, chat
controls) use the cool neutral set. Error text uses the destructive
or red of its own surface set. Dark-theme rules in content scripts
are out of scope and untouched; only light rules ship the new
tokens. GDocs surfaces are out of scope and untouched.

## 12. Micro-copy

- "Optimize Prompt"
- "Optimize Prompt with [product]"
- "Export PDF"
- "AI Provider"
- "Account"
- "Auto-Enabled Sites"
- "Default Preferences"
- Personalities: "Terry", "Jerry", "Sally"
- Auth: "Continue with [provider]", email field, sign-in prompt
- Toasts: sign-in prompt, enable-domain prompt, notice, usage
  title plus message plus action, long-wait note
- Chat: display name per host, build-prompt label, placeholder,
  helper, loading, error, empty-state, onboarding

## 13. Vanilla rules

- Closed shadow plus assigned style text for panel, rail, hover
  card, optimize button.
- Open shadow with inline markup for toasts.
- Inline cssText only for overlay host and anchor spans.
- Host isolation: reset plus keydown stop.
- No adopted style sheets. No bundled fonts.
- Extension pages: vanilla markup plus inline style blocks.
- Content scripts: one early main-world guard plus one idle
  isolated entry, all hosts.
- Worker: module type, minimal permissions, bundled re-inject only.
- Port ships no remote code fetch and no remote font fetch.

## 14. Gaps

- Set B hex is computed sRGB, not author-published; verify in a
  color-managed renderer.
- Base shadow scale xs through 2xl lives in an external
  dependency and was not harvested.
- Registry items beyond the foundation style item were not harvested.
- Built manifest output was not verifiable; only source config.
