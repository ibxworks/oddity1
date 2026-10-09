# Oddity 1 Quick Reference

## Project structure

```
oddity1/
├── packages/shared/        # @oddity/shared — types + constants (both workspaces import this)
│   └── src/
│       ├── types.ts        # ALL TypeScript contracts (Annotation, SiteAdapter, ExtensionMessage, ...)
│       └── constants.ts    # Timings, rate limits, colors, BACKEND_URL
│
├── extension/              # Chrome MV3 extension (Vite + CRXJS)
│   └── src/
│       ├── background/     # Service worker (auth, API client, adapter registry, message router)
│       ├── content/        # Content script (detection, rendering, popovers, manual annotations)
│       ├── popup/          # Extension popup (dashboard, export)
│       └── options/        # Options page (preferences, account)
│
├── backend/                # Express API, deployable to Vercel
│   ├── api/                # Route handlers (annotate, annotations, adapters, user/preferences)
│   ├── lib/                # Auth middleware, rate limiter, schema validator, OpenRouter LLM client
│   └── config/prompts.json # System prompts per intensity (currently placeholders!)
│
└── docs/                   # ← you are here
```

---

## Key credentials & where they live

| Secret                        | Where used                                          | Where to get it                             |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------- |
| `SUPABASE_URL`                | `backend/.env`                                      | Supabase Dashboard → Project Settings → API |
| `SUPABASE_ANON_KEY`           | `backend/.env` + `extension/.env`                   | Same                                        |
| `SUPABASE_SERVICE_ROLE_KEY`   | `backend/.env` only — never in extension            | Same                                        |
| `OPENROUTER_API_KEY`          | `backend/.env`                                      | openrouter.ai/keys                          |
| Google OAuth Client ID/Secret | Supabase Dashboard → Auth → Providers               | Google Cloud Console                        |

---

## Common commands

```bash
# Install everything
npm install

# Run backend locally (port 3001)
cd backend && npm run dev

# Build extension (output → extension/dist/)
cd extension && npm run build

# Extension dev mode (watch + hot reload)
cd extension && npm run dev

# Type-check all workspaces
npm run type-check

# Run all tests (23 tests — backend unit tests)
npm test

# Lint
npm run lint
```

---

## API endpoints at a glance

| Method | Path                            | Auth | Description                               |
| ------ | ------------------------------- | ---- | ----------------------------------------- |
| GET    | `/api/health`                   | No   | Server status check                       |
| POST   | `/api/annotate`                 | Yes  | Generate AI annotations (cached)          |
| GET    | `/api/annotations`              | Yes  | Fetch cached + user annotations for a URL |
| POST   | `/api/annotations`              | Yes  | Save a manual annotation                  |
| PUT    | `/api/annotations/:id`          | Yes  | Update a user annotation (edit mode)      |
| DELETE | `/api/annotations/:id`          | Yes  | Delete a user annotation                  |
| GET    | `/api/annotations/feedback`     | Yes  | Fetch feedback on annotations for a URL   |
| POST   | `/api/annotations/feedback`     | Yes  | Save feedback (thumbs up/down, replies)   |
| DELETE | `/api/annotations/feedback/:id` | Yes  | Delete a feedback entry                   |
| GET    | `/api/adapters`                 | No   | Get site adapter registry                 |
| GET    | `/api/user/preferences`         | Yes  | Get user preferences                      |
| PUT    | `/api/user/preferences`         | Yes  | Update preferences (partial JSONB merge)  |

Auth = `Authorization: Bearer <supabase_access_token>`

Rate limits: 50 req/day (free), 500 req/day (pro). Resets at midnight UTC.

Full docs: [docs/api.md](./api.md)

---

## Database tables at a glance

| Table                 | Purpose                                              | RLS               |
| --------------------- | ---------------------------------------------------- | ----------------- |
| `profiles`            | User metadata + preferences                          | Own row only      |
| `annotation_cache`    | AI annotations, keyed by `(content_hash, intensity)` | Service-role only |
| `user_annotations`    | Manual annotations per user                          | Own rows only     |
| `annotation_feedback` | User feedback on annotations (thumbs, replies)       | Own rows only     |
| `site_adapters`       | Site extraction config (6 seeded)                    | Service-role only |

Cache key is `content_hash + intensity` — same text on different URLs shares cache.
Cache TTL: 30 days (`expires_at` column).

Full schema: [docs/database.md](./database.md)

---

## Annotation types

| Type         | Visual                      | Use                     | Margin Note |
| ------------ | --------------------------- | ----------------------- | ----------- |
| `highlight`  | Yellow background           | Key phrase              | ✓           |
| `underline`  | Teal underline              | Important statement     | ✓           |
| `question`   | Purple dotted underline + ? | Probing question        | ✓           |
| `insight`    | Blue background             | "Why this matters"      | ✓           |
| `caveat`     | Violet wavy underline       | Counterpoint/limitation | ✓           |
| `vocabulary` | Teal dotted underline       | Term definition         | ✓           |

**Margin notes**: Annotations appear in the right margin as expandable cards.

**User annotations (manual)**:

- Type label + **user name badge** (first name, gray background)
- Preview text (truncated to 2 lines, collapsed)
- Expanded view: full text, Edit button (inline textarea), Delete button
- Delete removes the annotation immediately and persists in backend

**AI annotations**:

- Type label + reaction badge (👍 or 👎 if feedback given)
- Preview text (truncated to 2 lines, collapsed)
- Expanded view includes: full text, "Why it matters", "Question", suggestions, reply thread, feedback buttons, Edit/Delete buttons
- **Reply thread**: Chat-style bubbles with user replies + reply input bar
- **Thumbs feedback (mutually exclusive)**:
  - Click 👍 → activates thumbs up, deactivates thumbs down, saves feedback, shows 👍 badge
  - Click 👎 → activates thumbs down, deactivates thumbs up, saves feedback, shows 👎 badge
  - Click active thumb again → deactivates it, deletes feedback, removes badge
- Badge appears next to type label when collapsed, updates in real-time

---

## Dark mode support

The extension automatically detects the system theme (or page-level dark mode) and adjusts annotation colors for optimal contrast:

- **Light mode**: Yellow highlights, teal underlines, vivid colors
- **Dark mode**: Inverted highlight colors, muted overlays, high-contrast text
- **Per-site detection**: Some sites (e.g., Medium) have built-in dark mode that's automatically detected
- **Respects user preference**: Uses CSS `prefers-color-scheme` media query + DOM inspection for dynamic dark mode

Margin notes also adapt to the detected theme for seamless integration.

---

## Dashboard theme and design

The popup dashboard features a professional, refined aesthetic inspired by Supabase:

**Colors**:

- **Primary accent**: Purple (`#7c3aed`) — toggle switches, buttons, focus rings, avatar background, tier badge
- **Gradient theme**: "Oddity 1" title and Export PDF button feature a purple-to-amber gradient (`linear-gradient(135deg, #c4b5fd, #7c3aed, #f59e0b)`)
- **Background**: Warm light (`#f8f9fa`)
- **Borders**: Subtle (`#dfe3e8`)

**Typography**:

- Smaller, tighter spacing
- Section titles: uppercase, muted color
- Professional, non-toy aesthetic

---

## Extension keyboard shortcuts

| Key         | Action                             |
| ----------- | ---------------------------------- |
| `Tab`       | Move to next annotation            |
| `Shift+Tab` | Move to previous annotation        |
| `Enter`     | Open popover on focused annotation |
| `Escape`    | Close popover                      |

---

## Export features

**PDF Export**: Click "Export PDF" in the popup dashboard to download the current page with all annotations:

- Includes original content + all AI-generated annotations
- User annotations appear in context where they were added
- Works for any page with extracted text (articles, chat responses, etc.)
- PDF subtitle customizable in Standard tier (free tier has fixed subtitle)

**Manual annotations**: Add custom notes anywhere on the page via:

- Floating action button (FAB) in bottom-right
- Context menu (right-click → "Add Oddity Annotation")
- Notes appear as margin notes and persist in browser storage per-page

---

## Supported sites (seeded adapters)

| Site                  | Pattern           | Mode             | Features                                   |
| --------------------- | ----------------- | ---------------- | ------------------------------------------ |
| ChatGPT               | `chatgpt.com`     | adapter (stream) | Real-time annotations, streaming detection |
| ChatGPT (old URL)     | `chat.openai.com` | adapter (stream) | Real-time annotations, streaming detection |
| Claude                | `claude.ai`       | adapter (stream) | Real-time annotations, streaming detection |
| Medium                | `medium.com`      | readability      | Article extraction, margin notes           |
| Medium custom domains | `*.medium.com`    | readability      | Article extraction, margin notes           |
| Substack              | `*.substack.com`  | readability      | Newsletter extraction, margin notes        |

**Streaming adapters**: ChatGPT and Claude have streaming-aware stability signals that detect when AI responses are complete, enabling real-time annotation of streamed text.

To add a new site: insert a row into `site_adapters` (see [docs/database.md](./database.md#adding-a-new-site-adapter)).

---

## Detection fallback chain

When a page is visited:

1. **Adapter match** — checks `site_adapters` by hostname pattern
2. **Readability** — Mozilla Readability detects article-like content
3. **Heuristic** — text-density + semantic tag scoring

If none of the three tiers finds a reading region, no annotations are requested.

---

## PDF support

The content script is injected into PDF tabs in two ways:

1. **Automatic via `<all_urls>` match** — works for most `https://` PDFs.
2. **Programmatic injection via `tabs.onUpdated`** — the service worker watches for URLs ending in `.pdf` (or containing `.pdf?` / `.pdf#`) and calls `chrome.scripting.executeScript` directly. This handles edge cases where the automatic match fires but Chrome's built-in PDF viewer prevents normal injection.

**`file://` PDFs require an extra step:**

1. Go to `chrome://extensions`
2. Click **Details** on the Oddity1 card
3. Enable **Allow access to file URLs**

Without this, `file://` PDFs are silently skipped. `https://` PDFs work without any extra configuration.

---

## Badge & UI states

**Extension icon badge:**

| Badge      | Meaning               | Action                                  |
| ---------- | --------------------- | --------------------------------------- |
| Red "!"    | Not signed in         | Click to open popup and sign in/sign up |
| Gray "OFF" | Extension disabled    | Toggle "On" in popup to re-enable       |
| (none)     | Signed in and enabled | Extension is working normally           |

**Popup dashboard (when signed in):**

| Element           | Where             | Shows                                                         |
| ----------------- | ----------------- | ------------------------------------------------------------- |
| Rotating greeting | Header            | "Welcome, {FirstName}" with random variation each popup open  |
| Profile button    | Bottom-left       | Avatar (first initial) + display name. Click to open popover. |
| Tier badge        | Bottom-right      | "FREE" (gray) or "PRO" (green)                                |
| Profile popover   | Above profile btn | Full name, email, subscription tier, sign-out button          |

**In-page toast (when not signed in):**

| Element    | Where             | Behavior                                                                                                                     |
| ---------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Auth toast | Top-right of page | "Sign in to Oddity 1 to see annotations — click the extension icon". Auto-dismisses after 8 seconds or on click. Shows once. |

---

## Things that need real values before launch

- [ ] `backend/config/prompts.json` — replace `"<<PLACEHOLDER>>"` with actual system prompts
- [ ] Google OAuth credentials in Supabase Dashboard
- [ ] `BACKEND_URL` in `packages/shared/src/constants.ts` — update to Vercel URL after deployment
