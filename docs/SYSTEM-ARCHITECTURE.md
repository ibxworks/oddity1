# Oddity 1 — System Architecture

## 1. Purpose and Scope

Oddity 1 is a Chrome MV3 extension that automatically overlays AI-generated "professor-style" annotations — highlights, underlines, and inline popovers — directly on any long-form text the user is reading. Annotations appear in-place on the text itself with near-zero perceived delay and full user control.

This document is both:

1. A full architecture specification of the system.
2. A step-by-step engineering guide to build the product from scratch.

Unlike client-only extensions, Oddity uses a first-party backend to handle LLM calls, annotation caching, user auth, and a remotely-updateable site adapter registry.

## 2. Product Summary

### Core user workflow

1. User installs extension and signs up (Email/OAuth).
2. User navigates to any page with long-form text.
3. Extension detects main reading regions automatically.
4. Extension sends extracted text to the Oddity backend.
5. Backend calls OpenAI, parses structured annotation JSON, returns annotations.
6. Extension renders annotations in-place: type-adaptive highlights/underlines + hover-activated popovers.
7. As user scrolls, new sections are annotated progressively.
8. User can toggle annotations on/off, adjust intensity, edit/delete annotations, or add manual notes.

### Primary target

AI chatbot pages (ChatGPT, Claude, Perplexity) where users read long AI-generated responses. These require handling streaming/dynamic DOM updates via MutationObserver with stability detection.

### Secondary targets

Long articles, essays, blogs, newsletters, documentation — any page with dense explanatory text.

## 3. Architectural Principles

1. **In-place UX**: Annotations render on the text itself, never in a separate summary panel.
2. **Zero-mutation rendering**: Visual highlights use a transparent overlay layer (not DOM wrapping) to avoid breaking host page frameworks. Minimal invisible DOM anchors handle hover detection only.
3. **Stable-DOM-first**: Annotations appear only after text is confirmed stable (streaming complete), preventing flicker.
4. **Backend-owned intelligence**: LLM calls, prompt logic, and annotation caching live server-side. The extension is a rendering client.
5. **Adaptive by type**: Each annotation type has its own visual treatment (underline, highlight, gutter icon) rather than one-size-fits-all.
6. **Progressive loading**: Short pages annotated eagerly; long pages annotated lazily as content enters viewport proximity.

## 4. Tech Stack

### Extension (Client)

| Layer                | Technology                                            |
| -------------------- | ----------------------------------------------------- |
| Platform             | Chrome MV3 (service worker + content scripts)         |
| Language             | TypeScript                                            |
| Build                | Vite + CRXJS                                          |
| Content Script UI    | Vanilla TS (no framework)                             |
| CSS Isolation        | Shadow DOM for popovers; overlay layer for highlights |
| Content Extraction   | @mozilla/readability + custom heuristic override      |
| Annotation Anchoring | W3C Web Annotation Text-Quote Selectors               |

### Backend (Server)

| Layer           | Technology                                                          |
| --------------- | ------------------------------------------------------------------- |
| Runtime         | Node.js                                                             |
| Framework       | Express                                                             |
| Database & Auth | Supabase (managed Postgres + Auth + Row Level Security)             |
| LLM Provider    | OpenAI (single provider for MVP)                                    |
| Hosting         | Serverless — AWS Lambda                                             |
| Prompt Config   | Server-side config file (JSON), hot-reloadable without redeployment |

### Infrastructure

| Concern               | Technology                                        |
| --------------------- | ------------------------------------------------- |
| Auth                  | Supabase Auth (Email + OAuth — Google, GitHub)    |
| Annotation Cache      | Supabase Postgres with TTL-based invalidation     |
| Site Adapter Registry | Supabase table, fetched by extension periodically |
| Export                | Client-side PDF/Markdown generation               |

## 5. System Context

### External dependencies

- Chrome Extension Platform APIs (`chrome.*` namespace)
- OpenAI Chat Completions API (backend-side only)
- Supabase (Postgres, Auth, REST API)
- Vercel/AWS for serverless hosting
- @mozilla/readability for generic content extraction

### Trust boundaries

```
┌─────────────────────────────────────────────────┐
│  Browser (user machine)                         │
│  ┌──────────────┐  ┌────────────────────────┐   │
│  │ Service Worker│  │ Content Script          │   │
│  │ (background)  │  │ (runs in page context)  │   │
│  │ - orchestrate │  │ - extract text          │   │
│  │ - auth tokens │  │ - render overlay        │   │
│  │ - messaging   │  │ - shadow DOM popovers   │   │
│  └──────┬───────┘  └───────────┬────────────┘   │
│         │                      │                 │
│  ┌──────┴──────┐  ┌───────────┴─────────────┐   │
│  │ Popup UI    │  │ Options UI               │   │
│  │ (dashboard) │  │ (settings page)          │   │
│  └─────────────┘  └─────────────────────────┘   │
└────────────────────────┬────────────────────────┘
                         │ HTTPS
              ┌──────────▼──────────┐
              │  Oddity Backend     │
              │  (Serverless)       │
              │  - /annotate        │
              │  - /auth            │
              │  - /adapters        │
              └──────────┬──────────┘
                   ┌─────┴──────┐
                   ▼            ▼
            ┌──────────┐ ┌──────────┐
            │ OpenAI   │ │ Supabase │
            │ API      │ │ (DB+Auth)│
            └──────────┘ └──────────┘
```

## 6. Runtime Components

### 6.1 Service Worker — Background Script

Responsibilities:

- Store and refresh Supabase auth tokens (JWT).
- Relay annotation requests from content script to backend.
- Cache site adapter registry and refresh periodically.
- Manage context menu entries ("Add Oddity annotation").
- Coordinate annotation persistence (read/write cached annotations).
- Handle extension lifecycle events (install, update, wake).

Key runtime events:

- `runtime.onInstalled` → initialize auth state, fetch adapter registry.
- `runtime.onMessage` with `action: "requestAnnotations"` → call backend `/annotate`.
- `runtime.onMessage` with `action: "saveManualAnnotation"` → persist user annotation.
- `storage.onChanged` → sync settings updates.
- `alarms` API → periodic adapter registry refresh.

### 6.2 Content Script

Responsibilities:

- Detect main reading regions using site adapters or generic fallback.
- Monitor DOM stability (MutationObserver + site-specific completion signals for streaming chatbots).
- Extract text from stable regions and send to background for annotation.
- Render annotation overlay layer (highlight/underline rectangles via `getClientRects()`).
- Inject minimal invisible anchor `<span>` elements for hover/click detection.
- Render Shadow DOM popover on hover with annotation details.
- **Render margin notes**: User-added annotations appear in right-side margin of page.
- Handle scroll-based progressive annotation loading.
- Handle manual annotation creation (floating button + context menu).
- Apply annotation-type-adaptive visual styles.
- **Detect and apply dark mode**: Automatically adjusts annotation colors based on page theme (light/dark).
- Track scroll and resize to reposition overlay rectangles.

#### Content Detection Pipeline

```
Page Load / DOM Mutation
        │
        ▼
┌─────────────────────────┐
│ Check adapter registry   │
│ for current hostname     │
│                         │
│ Match found?            │
│  YES → use adapter      │
│         selectors       │
│  NO  → generic fallback │
└────────────┬────────────┘
             │
    ┌────────▼────────┐
    │ Generic Fallback │
    │                  │
    │ 1. Readability   │
    │    extraction    │
    │    (articles)    │
    │                  │
    │ 2. Custom        │
    │    heuristic     │
    │    (chatbots,    │
    │     dynamic)     │
    │    - text density│
    │    - semantic    │
    │      tags        │
    │    - viewport    │
    │      visibility  │
    └────────┬────────┘
             │
             ▼
    Extracted text regions
```

#### DOM Stability Detection (Hybrid)

For known chatbot sites, use site-adapter completion signals to detect streaming completion:

- **ChatGPT**: Monitor response container for appearance of copy/edit/regenerate action buttons (indicates streaming is done).
- **Claude**: Monitor for complete class markers or streaming indicator removal (e.g., `data-is-complete` attribute).
- **Generic sites**: MutationObserver with configurable debounce (default 1500ms of no mutations on the observed subtree).

**Streaming Support**: For chatbots like ChatGPT and Claude, the content script continuously monitors for new message chunks and re-annotates when stability is detected. Adapters include site-specific selectors for response containers and stability signals defined in the `site_adapters` registry.

The stability detector emits a `regionStable` event per detected text region, triggering the annotation pipeline. For streaming pages, this may fire multiple times as chunks are received and stabilize.

#### Annotation Rendering — Hybrid Overlay Model

The rendering engine avoids mutating the host DOM for visual effects:

1. **Overlay Layer**: A transparent, pointer-events-none `<div>` positioned over the page via `position: fixed`. Highlight and underline rectangles are drawn as absolutely-positioned child elements, coordinates derived from `Range.getClientRects()`. Repositioned on scroll/resize via `requestAnimationFrame`.

2. **Invisible Anchor Spans**: Minimal `<span>` elements with zero visual styling injected into text nodes at annotation boundaries. These serve as hover/click targets (`pointer-events: auto` on the overlay at those coordinates). Skipped entirely for `contenteditable` regions.

3. **Shadow DOM Popovers**: On hover over an anchor region, a Shadow DOM container is mounted near the target. The popover renders inside the shadow root, fully isolated from host CSS. Popover includes:
   - Annotation type label with color-coded dot (like Grammarly's category badge)
   - Annotation content (note, question, counterpoint, etc.)
   - Edit / delete actions
   - Dismissal on mouse-out with a small delay to prevent flicker

4. **Margin Notes**: User-created annotations appear in right-side margin of the page as compact note cards. Each card shows the annotation type icon, note preview, and edit/delete buttons. Margin notes auto-scroll to stay visible when corresponding text is in viewport.

5. **Dark Mode Support**: The rendering engine detects system/page theme and applies appropriate text colors and backgrounds. Annotation colors are adjusted for contrast in dark mode — lighter highlights, inverted text colors, and reduced opacity overlays to prevent text obscuration.

### 6.3 Popup UI (Page-Level Dashboard)

Responsibilities:

- **Header**: Show "Oddity 1" title with rotating personalized greeting (e.g., "Welcome, Tony") if signed in. Global on/off toggle on the right.
- **Annotation stats**: Display count by type for current page (highlight, important, question, insight, caveat, vocabulary).
- **Intensity buttons**: Light / Default / Heavy selector.
- **Type filters**: Quick toggles to show/hide specific annotation types.
- **Export button**: Download current page's annotations as PDF. PDF includes original content interleaved with both AI-generated and user-added annotations.
- **Profile bar**: Bottom section showing clickable profile button (avatar initial + first name) and tier badge (FREE / PRO). Click profile → popover with full name, email, subscription tier, and sign-out button.
- **Sign-up/Sign-in form**: When not authenticated, show email/password form (+ name field when signing up). Auto-switches to sign-in mode after successful sign-up confirmation email.
- **Link to settings**: "Settings & Options" footer link opens the options page.

**Visual design**: Refined, professional Supabase-style aesthetic — light background (`#f8f9fa`), subtle borders, pill-shaped buttons, green accent color (`#22c55e`), tighter spacing, smaller typography.

### 6.4 Options UI (Settings Page)

Responsibilities:

- Account management (profile, subscription status, logout).
- Default intensity preference.
- Per-site settings overrides (e.g., disable on specific domains).
- Annotation type visibility toggles (e.g., disable vocabulary annotations globally).
- Keyboard shortcut configuration.
- Data management (clear cached annotations, export all data).

### 6.5 Site Adapter Registry

A Supabase table containing site-specific configurations, fetched by the extension on a periodic schedule (e.g., every 6 hours via `chrome.alarms`).

Schema:

```ts
type SiteAdapter = {
  id: string;
  hostname_pattern: string; // glob: "chat.openai.com", "*.substack.com"
  content_selectors: string[]; // CSS selectors for reading regions
  stability_signal: StabilitySignal | null;
  excluded_selectors: string[]; // regions to never annotate (nav, sidebar, etc.)
  extraction_mode: "adapter" | "readability" | "custom_heuristic";
  updated_at: string;
};

type StabilitySignal = {
  type: "selector_appears" | "selector_disappears" | "attribute_change";
  target_selector: string;
  attribute?: string;
  value?: string;
};
```

The registry is updateable from the backend without shipping extension updates. The extension caches the registry in `chrome.storage.local` and uses a stale-while-revalidate pattern.

## 7. Backend Architecture

### 7.1 API Surface

All endpoints are serverless functions (Vercel Functions or AWS Lambda behind API Gateway).

```
POST   /api/annotate          — Generate annotations for text
GET    /api/annotations       — Retrieve cached annotations by URL+content hash
POST   /api/annotations       — Save user's manual annotations
DELETE /api/annotations/:id   — Delete a specific annotation
GET    /api/adapters          — Fetch site adapter registry
GET    /api/user/preferences  — Get user settings
PUT    /api/user/preferences  — Update user settings
POST   /api/auth/signup       — Supabase auth passthrough
POST   /api/auth/login        — Supabase auth passthrough
POST   /api/auth/refresh      — Token refresh
```

### 7.2 Annotation Generation Pipeline (`/api/annotate`)

```
Request arrives (text, url, content_hash, intensity)
        │
        ▼
┌─────────────────────────┐
│ 1. Auth verification     │
│    (Supabase JWT)        │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ 2. Cache check           │
│    Key: content_hash +   │
│         intensity        │
│                          │
│    HIT  → return cached  │
│    MISS → continue       │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ 3. Load prompt config    │
│    from config file      │
│    (per intensity level) │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ 4. Call OpenAI API       │
│    - JSON mode enabled   │
│    - model: configurable │
│    - prompt: from config │
│    - text: from request  │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ 5. Validate response     │
│    against annotation    │
│    schema                │
│                          │
│    VALID   → continue    │
│    INVALID → retry with  │
│    corrective prompt     │
│    (max 1 retry)         │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ 6. Persist to cache      │
│    (Supabase, TTL-based) │
└────────────┬────────────┘
             │
             ▼
        Return annotations
```

### 7.3 Prompt Configuration

Prompts are stored in a JSON config file on the server, not in code. Structure:

```json
{
  "version": "1.0",
  "intensity_profiles": {
    "light": {
      "system_prompt": "<<PLACEHOLDER>>",
      "annotation_density": "low",
      "max_annotations_per_1000_chars": 2
    },
    "default": {
      "system_prompt": "<<PLACEHOLDER>>",
      "annotation_density": "medium",
      "max_annotations_per_1000_chars": 5
    },
    "heavy": {
      "system_prompt": "<<PLACEHOLDER>>",
      "annotation_density": "high",
      "max_annotations_per_1000_chars": 10
    }
  },
  "annotation_types": [
    "highlight",
    "underline",
    "question",
    "insight",
    "caveat",
    "vocabulary"
  ],
  "output_schema": "<<see section 8.2>>"
}
```

The config file is loaded at function invocation time. To iterate on prompts, update the config file and redeploy the function (or use a file-watching reload mechanism in development).

### 7.4 Rate Limiting & Abuse Prevention

- Per-user rate limiting enforced at the backend (token bucket in Supabase or via middleware).
- Free tier: N annotations/day. Paid tier: higher limits.
- Request size cap: reject text payloads exceeding a configurable max character count.
- Auth required on all `/api/annotate` calls.

## 8. Data Model

### 8.1 Supabase Schema

```sql
-- Users (managed by Supabase Auth, extended with profile)
create table public.profiles (
  id uuid references auth.users primary key,
  display_name text,
  tier text default 'free' check (tier in ('free', 'pro')),
  preferences jsonb default '{}',
  created_at timestamptz default now()
);

-- Cached AI-generated annotations
create table public.annotation_cache (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null,
  url text not null,
  intensity text not null check (intensity in ('light', 'default', 'heavy')),
  annotations jsonb not null,
  model_version text,
  prompt_version text,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  unique(content_hash, intensity)
);

-- User's manual annotations and edits
create table public.user_annotations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) not null,
  url text not null,
  content_hash text not null,
  annotation jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Site adapter registry
create table public.site_adapters (
  id uuid primary key default gen_random_uuid(),
  hostname_pattern text unique not null,
  content_selectors jsonb not null default '[]',
  stability_signal jsonb,
  excluded_selectors jsonb default '[]',
  extraction_mode text default 'adapter',
  enabled boolean default true,
  updated_at timestamptz default now()
);

-- Row Level Security
alter table public.user_annotations enable row level security;
create policy "Users can CRUD own annotations"
  on public.user_annotations for all
  using (auth.uid() = user_id);

alter table public.profiles enable row level security;
create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);
```

### 8.2 Annotation Schema (LLM Output Contract)

```ts
type AnnotationResponse = {
  annotations: Annotation[];
};

type Annotation = {
  id: string; // unique within response
  type: AnnotationType;
  anchor: TextQuoteSelector;
  content: AnnotationContent;
};

type AnnotationType =
  | "highlight" // key phrase emphasis
  | "underline" // important statement
  | "question" // probing question about the text
  | "insight" // "why this matters" note
  | "caveat" // counterpoint or limitation
  | "vocabulary"; // term definition or clarification

type TextQuoteSelector = {
  type: "TextQuoteSelector";
  exact: string; // the exact text span to annotate
  prefix?: string; // ~30 chars before for disambiguation
  suffix?: string; // ~30 chars after for disambiguation
};

type AnnotationContent = {
  note: string; // primary annotation text (1-3 lines)
  why_it_matters?: string; // optional deeper context
  question?: string; // optional question to prompt thinking
  suggestions?: string[]; // optional alternatives (like Grammarly's word suggestions)
};
```

### 8.3 Extension-Backend Message Contracts

#### Request: Generate Annotations

```json
POST /api/annotate
{
  "url": "https://chat.openai.com/...",
  "content_hash": "sha256:abc123...",
  "text": "The extracted text content...",
  "intensity": "default",
  "word_count": 1200
}
```

#### Response: Annotations

```json
{
  "success": true,
  "cached": false,
  "annotations": [
    {
      "id": "ann_1",
      "type": "question",
      "anchor": {
        "type": "TextQuoteSelector",
        "exact": "neural networks learn hierarchical representations",
        "prefix": "fundamental insight is that ",
        "suffix": " of the input data"
      },
      "content": {
        "note": "What makes a representation 'hierarchical' vs flat?",
        "why_it_matters": "This distinction is key to understanding why deep > shallow."
      }
    }
  ]
}
```

### 8.4 Internal Messaging (Extension)

Service Worker ↔ Content Script messaging via `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`:

```ts
// Content → Background: request annotations
{
  action: "requestAnnotations",
  payload: {
    url: string,
    contentHash: string,
    text: string,
    intensity: "light" | "default" | "heavy",
    wordCount: number
  }
}

// Background → Content: annotations ready
{
  action: "annotationsReady",
  payload: {
    regionId: string,
    annotations: Annotation[]
  }
}

// Content → Background: save manual annotation
{
  action: "saveManualAnnotation",
  payload: {
    url: string,
    contentHash: string,
    annotation: Annotation
  }
}

// Background → Content: settings changed
{
  action: "settingsUpdated",
  payload: {
    enabled: boolean,
    intensity: "light" | "default" | "heavy",
    visibleTypes: AnnotationType[]
  }
}

// Popup → Background: get auth status
{
  action: "getAuthStatus",
  payload: {}
}

// Background → Popup: auth status response
{
  action: "authStatusResponse",
  payload: {
    authenticated: boolean,
    user: {
      id: string,
      email: string,
      display_name: string | null,
      tier: "free" | "pro"
    } | null
  }
}

// Popup → Background: sign in
{
  action: "signIn",
  payload: { email: string, password: string }
}

// Popup → Background: sign up
{
  action: "signUp",
  payload: { email: string, password: string, displayName: string }
}

// Popup → Background: sign out
{
  action: "signOut",
  payload: {}
}

// Popup → Background: get profile
{
  action: "getProfile",
  payload: {}
}

// Background → Popup: profile response
{
  payload: {
    display_name: string | null,
    tier: "free" | "pro"
  }
}

// Popup → Background: update profile
{
  action: "updateProfile",
  payload: { display_name: string }
}
```

## 9. End-to-End Flows

### 9.1 First Install Flow

1. User installs extension from Chrome Web Store.
2. Service worker fires `runtime.onInstalled`.
3. Extension opens onboarding tab (options page with signup prompt).
4. User signs up via Supabase Auth (Email or OAuth).
5. Service worker stores JWT in `chrome.storage.session`.
6. Service worker fetches site adapter registry → caches in `chrome.storage.local`.
7. Context menu entries registered.
8. Extension is ready.

### 9.2 Automatic Annotation Flow (Page Load)

1. User navigates to a page.
2. Content script injects and runs.
3. Content script checks adapter registry (from `chrome.storage.local`) for hostname match.
4. If adapter found → use adapter's `content_selectors` to locate reading regions.
5. If no adapter → run Readability extraction; if that fails (non-article layout), fall back to custom heuristic (text density + viewport visibility scoring).
6. For each detected reading region:
   a. Attach MutationObserver.
   b. Wait for stability signal (site-specific signal or debounce timeout).
   c. On `regionStable`, extract text content.
   d. Compute SHA-256 content hash.
   e. Check word count:
   - ≤ 5000 words → annotate immediately (eager).
   - \> 5000 words → register for lazy loading via `registerRegion()` and return. When the lazy loader callback fires, it re-enters `handleStableRegion()` with `fromLazyLoader=true`, which bypasses the word count check and proceeds to request annotations.
     f. Send `requestAnnotations` to service worker.
7. Service worker calls backend `POST /api/annotate`.
8. Backend checks cache → returns cached or generates new annotations.
9. Service worker relays annotations to content script.
10. Content script renders:
    a. Resolve each `TextQuoteSelector` against the page text to find DOM ranges.
    b. Create overlay highlight/underline rectangles from `Range.getClientRects()`.
    c. Inject invisible anchor spans at annotation boundaries (skip `contenteditable`).
    d. Register hover listeners on anchors → show Shadow DOM popover.

### 9.3 Scroll-Based Lazy Loading (Long Pages)

1. During initial processing, regions exceeding `EAGER_WORD_LIMIT` (5000 words) are registered with the scroll loader via `registerRegion()` and skipped for immediate annotation.
2. Content script maintains an IntersectionObserver watching registered regions.
3. When a region enters the proximity threshold (500px ahead of viewport):
   a. The lazy loader callback invokes `handleStableRegion(region, element, true)` with `fromLazyLoader=true`.
   b. This bypasses the word count early-return, extracts text, computes hash, and sends the annotation request.
   c. Render annotations when response arrives.
4. Already-annotated regions are skipped (tracked via `annotatedRegions` and `loadedRegions` sets).

### 9.4 Manual Annotation Flow

1. User selects text on the page.
2. A floating action button appears near the selection.
   - Alternatively, user right-clicks → selects "Add Oddity Annotation" from context menu.
3. A Shadow DOM annotation editor popover opens with fields:
   - Annotation type selector.
   - Note text input.
4. User submits.
5. Content script sends `saveManualAnnotation` to service worker.
6. Service worker persists to Supabase `user_annotations` table.
7. Annotation renders immediately in the overlay.

### 9.5 Export Flow

1. User clicks export button in popup dashboard.
2. Popup sends message to content script requesting full annotation data.
3. Content script collects:
   - Original page text (structured by region).
   - All annotations (AI-generated + user manual) with their anchor positions.
4. Content script generates:
   - **Markdown**: original text interleaved with annotation blocks (blockquotes, inline comments).
   - **PDF**: rendered via browser print-to-PDF or a client-side PDF library (e.g., jsPDF).
5. File download is triggered.

### 9.6 Settings Update Flow

1. User changes intensity/toggle/type visibility in popup or options.
2. Settings saved to `chrome.storage.sync`.
3. Service worker detects `storage.onChanged`, relays `settingsUpdated` to content script.
4. Content script immediately:
   - Shows/hides overlay layer (toggle).
   - Filters visible annotations by type.
   - If intensity changed → re-requests annotations from backend with new intensity parameter.

## 10. Annotation Rendering Engine (Detail)

### 10.1 Visual Treatment by Annotation Type

| Type         | Inline Visual                               | Color       | Popover Header |
| ------------ | ------------------------------------------- | ----------- | -------------- |
| `highlight`  | Background highlight rectangle (overlay)    | Soft yellow | KEY PHRASE     |
| `underline`  | Underline rectangle (overlay)               | Teal/green  | IMPORTANT      |
| `question`   | Dotted underline + small `?` icon in gutter | Purple      | QUESTION       |
| `insight`    | Background highlight rectangle (overlay)    | Soft blue   | INSIGHT        |
| `caveat`     | Wavy underline rectangle (overlay)          | Orange      | CAVEAT         |
| `vocabulary` | Dotted underline (overlay)                  | Green       | VOCABULARY     |

### 10.2 Intensity Levels

- **Light**: Only `highlight` and `underline` types rendered. Minimal density.
- **Default**: All types rendered. Medium density.
- **Heavy**: All types rendered at high density. Additional annotations generated.

### 10.3 Popover Behavior

- **Trigger**: Mouse hover over annotation anchor region (not click).
- **Show delay**: 200ms hover dwell time before popover appears (prevents flicker on casual mouse movement).
- **Hide delay**: 300ms after mouse leaves both anchor and popover (allows mouse to travel to popover for interaction).
- **Position**: Below the annotated span, centered. Falls back to above if insufficient space below.
- **Content**: Rendered inside Shadow DOM. Includes type badge, note, optional fields, edit/delete buttons.
- **Keyboard**: Tab navigates between annotations; Enter opens popover; Escape closes.

## 11. Permissions and Browser Capabilities

### Manifest V3 (Chrome)

```json
{
  "manifest_version": 3,
  "permissions": [
    "activeTab",
    "storage",
    "contextMenus",
    "scripting",
    "alarms"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "src/background.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/index.ts"],
      "css": [],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "src/popup/index.html"
  },
  "options_ui": {
    "page": "src/options/index.html",
    "open_in_tab": true
  }
}
```

Permissions rationale:

- `activeTab` + `<all_urls>`: annotate any page the user visits.
- `storage`: persist settings, adapter registry cache, auth tokens.
- `contextMenus`: "Add Oddity Annotation" right-click action.
- `scripting`: dynamically inject content script if needed (fallback).
- `alarms`: periodic adapter registry refresh.

## 12. Security and Privacy Model

### Data handling

- Page text is sent to the Oddity backend over HTTPS. The backend forwards to OpenAI.
- Auth tokens (Supabase JWT) stored in `chrome.storage.session` (cleared on browser close) with refresh tokens in `chrome.storage.local`.
- User's API keys are never involved — all LLM access is via the Oddity backend.
- User manual annotations stored server-side, scoped by RLS to the owning user.

### Content script safety

- The overlay layer is purely visual and does not modify page content.
- Invisible anchor spans are inert (no event handlers that could interfere with page scripts).
- Shadow DOM isolates popover CSS and DOM from the host page.
- `contenteditable` regions are detected and excluded from anchor span injection.

### Backend security

- All API endpoints require valid Supabase JWT.
- Rate limiting per user to prevent abuse.
- Request payload size limits to prevent exfiltration of excessive content.
- Prompt injection mitigation: user text is treated as data, not instructions, in the prompt template.

## 13. Repository Structure

```
oddity1/
├── extension/                     # Chrome extension (Vite + CRXJS)
│   ├── src/
│   │   ├── background/
│   │   │   ├── index.ts           # Service worker entry
│   │   │   ├── auth.ts            # Supabase auth token management
│   │   │   ├── api-client.ts      # Backend HTTP client
│   │   │   ├── adapter-registry.ts # Site adapter cache + refresh
│   │   │   └── context-menu.ts    # Context menu setup
│   │   ├── content/
│   │   │   ├── index.ts           # Content script entry
│   │   │   ├── detector.ts        # Reading region detection
│   │   │   ├── extractor.ts       # Text extraction (readability + custom)
│   │   │   ├── stability.ts       # DOM stability detection
│   │   │   ├── renderer/
│   │   │   │   ├── overlay.ts     # Highlight/underline overlay layer
│   │   │   │   ├── anchors.ts     # Invisible anchor span injection
│   │   │   │   ├── popover.ts     # Shadow DOM popover component
│   │   │   │   └── styles.ts      # Annotation type → visual style map
│   │   │   ├── selector.ts        # W3C TextQuoteSelector resolver
│   │   │   ├── scroll-loader.ts   # IntersectionObserver lazy loading
│   │   │   └── manual.ts          # Manual annotation UI (FAB + editor)
│   │   ├── popup/
│   │   │   ├── index.html
│   │   │   ├── index.ts           # Dashboard logic
│   │   │   └── export.ts          # Markdown/PDF export
│   │   ├── options/
│   │   │   ├── index.html
│   │   │   └── index.ts           # Settings logic
│   │   ├── shared/
│   │   │   ├── types.ts           # Shared TypeScript types
│   │   │   ├── messaging.ts       # Typed message helpers
│   │   │   ├── constants.ts       # Config constants
│   │   │   └── hash.ts            # SHA-256 content hashing
│   │   └── manifest.json          # Chrome MV3 manifest
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
├── backend/                       # Node.js + Express serverless functions
│   ├── api/
│   │   ├── annotate.ts            # POST /api/annotate
│   │   ├── annotations.ts         # GET/POST/DELETE /api/annotations
│   │   ├── adapters.ts            # GET /api/adapters
│   │   └── user/
│   │       └── preferences.ts     # GET/PUT /api/user/preferences
│   ├── lib/
│   │   ├── openai.ts              # OpenAI client + retry logic
│   │   ├── schema-validator.ts    # Annotation JSON schema validation
│   │   ├── supabase.ts            # Supabase client initialization
│   │   ├── rate-limiter.ts        # Per-user rate limiting
│   │   └── auth-middleware.ts     # JWT verification middleware
│   ├── config/
│   │   └── prompts.json           # Prompt templates (<<PLACEHOLDER>>)
│   ├── vercel.json                # Serverless config
│   ├── tsconfig.json
│   └── package.json
├── supabase/
│   └── migrations/                # Database migration files
│       └── 001_initial_schema.sql
├── PRODUCT.md
├── SYSTEM-ARCHITECTURE.md
├── CLAUDE.md
└── package.json                   # Workspace root (monorepo)
```

## 14. Build and Development

### 14.1 Extension development

```bash
cd extension
npm install
npm run dev          # Vite + CRXJS hot-reload dev server
npm run build        # Production build → extension/dist/
npm run type-check   # TypeScript type checking
```

Load unpacked in Chrome: `chrome://extensions` → Developer Mode → Load Unpacked → `extension/dist/`.

### 14.2 Backend development

```bash
cd backend
npm install
npm run dev          # Local serverless dev (vercel dev or similar)
npm run build        # TypeScript compilation
npm run deploy       # Deploy to Vercel/AWS
```

### 14.3 Database

```bash
npx supabase start             # Local Supabase for development
npx supabase db push           # Apply migrations to remote
npx supabase gen types ts      # Generate TypeScript types from schema
```

## 15. Build-From-Scratch Blueprint

### Step 1: Scaffold monorepo

1. Initialize root `package.json` with npm workspaces (`extension/`, `backend/`).
2. Set up shared TypeScript config.
3. Initialize git, add `.gitignore`.

### Step 2: Set up Supabase

1. Create Supabase project.
2. Write initial migration (`001_initial_schema.sql`) with tables from section 8.1.
3. Configure Auth providers (Email, Google OAuth).
4. Set up Row Level Security policies.
5. Generate TypeScript types.

### Step 3: Build backend API

1. Set up Express with TypeScript in serverless function format.
2. Implement auth middleware (Supabase JWT verification).
3. Implement `POST /api/annotate`:
   - Cache check → OpenAI call → schema validation → retry → cache persist → return.
4. Implement `GET/POST/DELETE /api/annotations` for user manual annotations.
5. Implement `GET /api/adapters` for site adapter registry.
6. Add prompt config file with placeholder prompts.
7. Add rate limiting.
8. Deploy to Vercel.

### Step 4: Build extension — background

1. Scaffold Vite + CRXJS project with MV3 manifest.
2. Implement auth flow: Supabase client in service worker, token management.
3. Implement API client for backend communication.
4. Implement adapter registry fetch + cache (with `chrome.alarms` refresh).
5. Implement context menu registration.
6. Implement message routing between content script and backend.

### Step 5: Build extension — content script (detection + extraction)

1. Implement site adapter matching (hostname → adapter config).
2. Implement Readability-based extraction for generic article pages.
3. Implement custom heuristic extractor for chatbot/dynamic pages.
4. Implement DOM stability detector (MutationObserver + site signals).
5. Implement content hashing (SHA-256).
6. Wire up: region detected → stable → extract → hash → request annotations.

### Step 6: Build extension — content script (rendering)

1. Implement TextQuoteSelector resolver (find DOM ranges from selectors).
2. Implement overlay layer (highlight/underline rectangles from `getClientRects()`).
3. Implement scroll/resize tracking for overlay repositioning.
4. Implement invisible anchor span injection.
5. Implement Shadow DOM popover component (type badge, note, actions).
6. Implement hover behavior (show/hide delays, mouse tracking between anchor and popover).
7. Implement annotation-type-adaptive styling.
8. Implement keyboard navigation (tab between annotations, enter/escape for popover).

### Step 7: Build extension — scroll loader

1. Implement IntersectionObserver for lazy loading on long pages (>5000 words).
2. Implement region tracking (annotated vs pending).
3. Wire up lazy regions to annotation pipeline.

### Step 8: Build extension — manual annotations

1. Implement floating action button on text selection.
2. Implement Shadow DOM annotation editor (type selector, note input).
3. Implement context menu "Add Oddity Annotation" action.
4. Wire up save to backend via service worker.

### Step 9: Build extension — popup dashboard

1. Build popup HTML + TS.
2. Implement page annotation stats display.
3. Implement filter toggles, intensity slider, on/off toggle.
4. Implement export to Markdown.
5. Implement export to PDF.
6. Implement auth status display.

### Step 10: Build extension — options page

1. Build options HTML + TS.
2. Implement account management UI.
3. Implement per-site settings.
4. Implement annotation type visibility toggles.
5. Implement data management (clear cache, export data).

### Step 11: Validation checklist

1. Extension loads in Chrome without errors.
2. Signup/login flow completes successfully.
3. Annotations appear automatically on a ChatGPT conversation page.
4. Annotations appear automatically on a Medium article.
5. Annotations appear on an unknown site via generic fallback.
6. Hover popover shows and hides correctly.
7. Manual annotation can be created and persists across reload.
8. On/off toggle works instantly with no layout shift.
9. Intensity change triggers re-annotation.
10. Export produces valid Markdown with interleaved annotations.
11. Cached annotations load instantly on revisit (same content).
12. Long page (>5000 words) uses lazy loading correctly.
13. Content script does not break host page functionality.
14. `contenteditable` regions are excluded from anchor injection.

## 16. Performance Budget

| Metric                                      | Target                     |
| ------------------------------------------- | -------------------------- |
| Time to first annotation visible (cached)   | < 500ms after page stable  |
| Time to first annotation visible (uncached) | < 3s after page stable     |
| Overlay reposition latency on scroll        | < 16ms (60fps)             |
| Popover show time on hover                  | < 250ms perceived          |
| Content script bundle size                  | < 100KB gzipped            |
| Memory overhead per page                    | < 20MB for 100 annotations |

## 17. Failure Modes and Mitigations

| Failure                         | Detection                         | Mitigation                                                                                            |
| ------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Backend unreachable             | Fetch error/timeout               | Show subtle "offline" badge in overlay. Cache hit still works.                                        |
| OpenAI API error/timeout        | Backend error response            | Return cached if available; otherwise surface "annotations unavailable" in popup. Retry with backoff. |
| Malformed LLM JSON output       | Schema validation failure         | Retry once with corrective prompt. If retry fails, return partial annotations (valid subset).         |
| TextQuoteSelector can't resolve | Fuzzy match score below threshold | Skip that annotation silently. Log for debugging.                                                     |
| Content script killed by page   | Service worker gets no response   | Re-inject content script on next user interaction.                                                    |
| Adapter registry stale          | Version/timestamp check           | Stale-while-revalidate: use cached, fetch fresh in background.                                        |
| User's session expired          | 401 from backend                  | Attempt token refresh. If refresh fails, set red "!" badge on extension icon and show dismissible in-page toast prompting sign-in. Badge clears on successful auth.  |

## 18. Known Constraints and Trade-offs

1. **Wait-for-stable adds latency on chatbot pages**: Users won't see annotations until streaming completes. This is a deliberate trade-off for rendering stability over speed. Future optimization: annotate already-stable earlier messages while the latest message is still streaming.

2. **Overlay rendering vs DOM wrapping**: The overlay approach avoids DOM mutation conflicts but requires continuous scroll/resize tracking. On pages with complex scroll containers (e.g., virtualized lists), `getClientRects()` coordinates may need adjustment relative to the scroll container, not the viewport.

3. **Single LLM provider (OpenAI)**: Simplifies MVP but creates vendor dependency. The backend's annotate pipeline should keep provider logic in a single module (`lib/openai.ts`) to make future provider addition straightforward.

4. **Config-file prompts require redeployment**: Unlike a DB-stored prompt system, changing prompts requires deploying a new function version. Acceptable for MVP iteration speed; can move to Supabase-stored prompts later if A/B testing becomes important.

5. **No offline mode**: Extension requires backend connectivity for new annotations. Cached annotations are available offline (stored in `chrome.storage.local`), but new pages cannot be annotated without network.

## 19. Future Architecture Enhancements

1. **Streaming annotation delivery**: Use SSE or WebSocket from backend to stream annotations as they're generated, reducing time-to-first-annotation.
2. **Provider abstraction layer**: Add Anthropic, Groq, open-source model support behind an adapter interface.
3. **Collaborative annotations**: Share annotation sets with other users on the same content.
4. **Annotation quality feedback loop**: Users rate annotations (helpful/not) → data feeds prompt improvement.
5. **Firefox MV3 support**: When Firefox MV3 stabilizes, add cross-browser build target.
6. **Edge/Brave support**: Chromium-based browsers should work with minimal changes.
7. **Mobile companion**: Read-later queue that syncs annotated content to a mobile-friendly reader.

## 20. Implementation Checklist (Quick Start)

- [ ] Scaffold monorepo with npm workspaces
- [ ] Set up Supabase project + initial migration
- [ ] Configure Supabase Auth (Email + Google OAuth)
- [ ] Build backend: auth middleware + annotate endpoint
- [ ] Build backend: annotation CRUD + adapter registry endpoints
- [ ] Add prompt config file with placeholders
- [ ] Deploy backend to Vercel
- [ ] Scaffold extension with Vite + CRXJS
- [ ] Implement service worker: auth, API client, adapter cache, messaging
- [ ] Implement content script: detection + extraction pipeline
- [ ] Implement content script: DOM stability detector
- [ ] Implement content script: TextQuoteSelector resolver
- [ ] Implement content script: overlay rendering engine
- [ ] Implement content script: Shadow DOM popover
- [ ] Implement content script: scroll-based lazy loader
- [ ] Implement content script: manual annotation (FAB + context menu)
- [ ] Build popup dashboard with stats, controls, export
- [ ] Build options page with settings and account management
- [ ] Seed site adapter registry (ChatGPT, Claude, Medium, Substack)
- [ ] End-to-end validation against checklist (section 15, step 11)
- [ ] Add automated tests for critical paths
- [ ] Chrome Web Store submission

---

If you follow this document in order, you can build Oddity 1's full architecture from scratch — a Chrome MV3 extension with a serverless backend that delivers in-place, AI-generated annotations on any long-form text with near-zero perceived delay.
