# Oddity 1

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
│       ├── content/        # Content script (detection, rendering, popovers, manual annotations, auth toast)
│       ├── popup/          # Extension popup (dashboard, export, auth form)
│       └── options/        # Options page (preferences, account)
│
├── backend/                # Express API, deployable to Vercel
│   ├── api/                # Route handlers (annotate, annotations, adapters, user/preferences)
│   ├── lib/                # Auth middleware, rate limiter, schema validator, Gemini client
│   └── config/prompts.json # System prompts per intensity (currently placeholders!)
│
└── docs/
```

---

## Key credentials & where they live

| Secret                        | Where used                                          | Where to get it                             |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------- |
| `SUPABASE_URL`                | `backend/.env`                                      | Supabase Dashboard → Project Settings → API |
| `SUPABASE_ANON_KEY`           | `backend/.env` + `extension/src/background/auth.ts` | Same                                        |
| `SUPABASE_SERVICE_ROLE_KEY`   | `backend/.env` only — never in extension            | Same                                        |
| `GEMINI_API_KEY`              | `backend/.env`                                      | aistudio.google.com                         |
| Google OAuth Client ID/Secret | Supabase Dashboard → Auth → Providers               | Google Cloud Console                        |

---

## Running Oddity Locally

### 1. Install dependencies

From the repo root:

```bash
npm install
```

This installs all workspaces (`packages/shared`, `extension`, `backend`) in one step.

---

### 2. Configure the backend

Create `backend/.env`:

```env
SUPABASE_URL=https://gmmektzvvrtttszdgiai.supabase.co
SUPABASE_ANON_KEY=<your anon key>
SUPABASE_SERVICE_ROLE_KEY=<your service role key>
ODDITY_GOOGLE_OAUTH_CLIENT_ID=<your Chrome extension OAuth client id>
GEMINI_API_KEY=AIza...
PORT=3001
```

---

### 3. Configure the extension

The extension connects to the backend and Supabase. Update the constants in:

**`extension/src/background/auth.ts`** — hardcoded Supabase credentials:

```ts
const SUPABASE_URL = "https://gmmektzvvrtttszdgiai.supabase.co";
const SUPABASE_ANON_KEY = "<your anon key>";
```

**`packages/shared/src/constants.ts`** — backend URL used by the extension:

```ts
export const BACKEND_URL =
  process.env.ODDITY_BACKEND_URL ?? "http://localhost:3001";
```

For local dev, the default `http://localhost:3001` works without changes.

---

### 4. Run the backend

```bash
cd backend
npm run dev
```

This uses `tsx watch` — file changes restart the server automatically.

The server runs at `http://localhost:3001`. Test it:

```bash
curl http://localhost:3001/api/health
# → { "status": "ok" }
```

---

### 5. Build the extension

```bash
cd extension
npm run dev   # watch mode (Vite HMR)
# or
npm run build # one-time production build
```

The built extension lands in `extension/dist/`.
The extension build reads `ODDITY_GOOGLE_OAUTH_CLIENT_ID` from `backend/.env`, repo-level env files, or extension-level env files.

---

### 6. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist/` folder

After changes, click the refresh icon on the extension card (or it auto-reloads in `dev` mode with CRXJS).

**Required permissions** (`manifest.config.ts`):

| Permission      | Why it's needed                                                              |
| --------------- | ---------------------------------------------------------------------------- |
| `activeTab`     | Read the current tab's URL and inject scripts on demand                      |
| `storage`       | Persist preferences, auth tokens, and cached data                            |
| `contextMenus`  | "Add Oddity Annotation" right-click menu entry                               |
| `scripting`     | Programmatically inject content scripts (used for PDF tab detection)         |
| `alarms`        | Periodic site adapter registry refresh                                        |
| `identity`      | Chrome identity API for Google OAuth flow                                    |
| `tabs`          | Read `tab.url` in `tabs.onUpdated` to detect PDF tabs for programmatic injection |
| `host_permissions: <all_urls>` | Inject content script on any page the user visits              |

---

### 7. Auth setup

The extension uses Supabase Auth with Google OAuth. To enable it:

1. Go to [Supabase Dashboard → Authentication → Providers](https://supabase.com/dashboard/project/gmmektzvvrtttszdgiai/auth/providers)
2. Enable **Google**
3. Paste your **Google OAuth Client ID** and **Client Secret**
4. Add the Supabase callback URL to your Google Cloud Console (Credentials → OAuth 2.0 Client → Authorized redirect URIs)

The Supabase callback URL is shown in the Supabase provider settings dialog.

---

### 8. Write real AI prompts

`backend/config/prompts.json` currently has placeholder prompts:

```json
{ "light": { "system_prompt": "<<PLACEHOLDER>>" }, ... }
```

Replace the `<<PLACEHOLDER>>` values with actual system prompts before the annotation feature works. The backend won't crash without them — it'll just pass the placeholder to Gemini and get garbage back.

---

## Type-check and test

```bash
# From repo root — runs all workspaces
npm run type-check   # zero-error TypeScript check
npm test             # 23 tests (backend only)
npm run lint         # ESLint flat config
```

---

## Production deployment

### Backend (Vercel)

1. Push the repo to GitHub
2. Import the project in [Vercel](https://vercel.com)
3. Set the root directory to `backend/` (or configure via `vercel.json` at root)
4. Add environment variables in Vercel dashboard (same as `backend/.env`)
5. Deploy — Vercel picks up the `vercel.json` rewrite rules automatically

After deployment, update `BACKEND_URL` in `packages/shared/src/constants.ts` to your Vercel URL, then rebuild the extension.

### Extension (Chrome Web Store)

1. Run `npm run build` in `extension/`
2. Zip the `extension/dist/` folder
3. Upload to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)

---

## Key Features

### Core Annotation Engine

- **Smart text extraction** via Readability, site-specific adapters, or custom heuristics
- **Streaming support** for real-time chatbot pages (ChatGPT, Claude) with stability detection
- **Programmatic PDF injection**: Service worker detects PDF tabs via `tabs` permission and injects the content script programmatically, handling both `https://` and `file://` PDFs
- **Tier initialized at startup**: `dashUserTier` is set immediately from `getAuthStatus` when the content script loads, so tier-gated features (Sketch Pad, Sally personality, etc.) work without requiring the user to open the dashboard first
- **In-place overlays**: highlights, underlines, and margin-note annotations with type-specific visuals
- **Dark mode support**: Automatically detects system theme; annotations adapt colors for readability
- **Margin notes system**: All annotations (AI + user) appear in right-side margin as expandable cards
- **Popover details**: Hover annotations to see full notes with "why it matters" and follow-up questions
- **Rich annotation interactions**:
  - **User annotations**: Edit (inline textarea) + Delete buttons
  - **AI annotations**: Thumbs up/down feedback (mutually exclusive, radio-button style), reply threads with chat bubbles, reply input bar
  - **Feedback tracking**: Feedback persists in backend; clicking active thumb again undoes the feedback
- **User name badges**: Manual annotations show user's first name next to the type label

### User Control

- **Per-page stats**: See count of each annotation type for current page
- **Intensity levels**: Light / Default / Heavy — controls annotation density
- **Type filtering**: Toggle specific annotation types on/off
- **Global toggle**: On/Off switch to disable extension instantly
- **Manual annotations**: Add custom notes anywhere with context menu or floating action button

### Export & Sharing

- **PDF export**: Download page with annotations, preserving original content + AI insights
- **User preferences**: Intensity, visible types, and site-specific settings saved
- **Subscription tiers**: Free (basic features) and Standard (custom export subtitles, advanced analytics)

### User Experience

- **Rotating greetings**: Personalized welcome in dashboard (name-based)
- **Profile management**: Clickable profile popover showing account info and tier
- **Auth feedback**: Red "!" badge when not signed in, gray "OFF" badge when disabled
- **In-page toast**: Gentle reminder to sign in when annotations aren't available
- **Gradient theme**: Purple-to-amber gradient on dashboard title and Export PDF button
- **Refined design**: Warm light backgrounds with purple accents, professional styling (Supabase-inspired)

---

## Troubleshooting Auth Issues

**Badge states on the extension icon:**

- **Red "!" badge**: Not signed in — click to open popup and sign in
- **Gray "OFF" badge**: Extension is disabled — toggle "On" in popup to enable
- **No badge**: Signed in and enabled — extension is working normally

If you see a red "!" badge or the extension is disabled:

- Click the extension icon to open the popup
- Sign in/sign up via the form, or toggle the "On" switch
- The badge will clear automatically, and the page will reload with annotations

If you see an in-page toast saying "Sign in to Oddity to see annotations":

- Click the extension icon and sign in
- The toast auto-dismisses after 8 seconds or when you click it

---

## Common issues

**`npm install` fails with workspace errors**
Make sure you're running from the repo root (`oddity1/`), not inside a workspace directory.

**Extension can't reach the backend**

- Is `npm run dev` running in `backend/`?
- Check that `BACKEND_URL` in `constants.ts` matches where your backend is running.
- Check Chrome DevTools → Network for CORS or 401 errors.

**Annotations don't appear**

- Open DevTools on the page → Console → look for `[Oddity]` logs.
- If you see `[Oddity] No reading regions detected`, the site isn't supported yet — add an adapter.
- If you see a red "!" badge on the extension icon, you're not signed in — click it to sign in.
- If you see `Requesting annotations for region...` but nothing comes back, check the backend logs for errors.
- Long articles are requested immediately. If generation is slow, a top-right "generating annotations" toast appears until the first result arrives.

**Annotations don't appear on local PDF files (`file://`)**

The content script cannot auto-inject into `file://` URLs unless you explicitly allow it:

1. Go to `chrome://extensions`
2. Click **Details** on the Oddity1 card
3. Enable **Allow access to file URLs**

Without this, `file://` PDFs will silently skip injection. `https://` PDFs (served over the web) work without any extra step.

**Supabase auth not working**

- Confirm Google OAuth is enabled in Supabase Dashboard.
- Confirm the Google Cloud Console redirect URI matches the Supabase callback URL exactly.
- Check `chrome://extensions` → your extension → Errors for any auth failures.

**Prompts returning garbage**
The prompts in `backend/config/prompts.json` are placeholders. Write real system prompts and restart the backend.

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
| GET    | `/api/annotations/feedback`     | Yes  | Get feedback on annotations for a URL     |
| POST   | `/api/annotations/feedback`     | Yes  | Save feedback (thumbs up/down/reply)      |
| DELETE | `/api/annotations/feedback/:id` | Yes  | Delete feedback entry                     |
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

| Type         | Visual                      | Use                     |
| ------------ | --------------------------- | ----------------------- |
| `highlight`  | Yellow background           | Key phrase              |
| `underline`  | Teal underline              | Important statement     |
| `question`   | Purple dotted underline + ? | Probing question        |
| `insight`    | Blue background             | "Why this matters"      |
| `caveat`     | Orange wavy underline       | Counterpoint/limitation |
| `vocabulary` | Green dotted underline      | Term definition         |

---

## Extension keyboard shortcuts

| Key         | Action                             |
| ----------- | ---------------------------------- |
| `Tab`       | Move to next annotation            |
| `Shift+Tab` | Move to previous annotation        |
| `Enter`     | Open popover on focused annotation |
| `Escape`    | Close popover                      |

---

## Supported sites (seeded adapters)

| Site                  | Pattern           | Mode        |
| --------------------- | ----------------- | ----------- |
| ChatGPT               | `chatgpt.com`     | adapter     |
| ChatGPT (old URL)     | `chat.openai.com` | adapter     |
| Claude                | `claude.ai`       | adapter     |
| Medium                | `medium.com`      | readability |
| Medium custom domains | `*.medium.com`    | readability |
| Substack              | `*.substack.com`  | readability |

To add a new site: insert a row into `site_adapters` (see [docs/database.md](./database.md#adding-a-new-site-adapter)).

---

## Detection fallback chain

When a page is visited:

1. **Adapter match** — checks `site_adapters` by hostname pattern
2. **Readability** — Mozilla Readability detects article-like content
3. **Heuristic** — text-density + semantic tag scoring

If none of the three tiers finds a reading region, no annotations are requested.

---

## Things that need real values before launch

- [ ] `backend/config/prompts.json` — replace `"<<PLACEHOLDER>>"` with actual system prompts
- [ ] Google OAuth credentials in Supabase Dashboard
- [ ] `BACKEND_URL` in `packages/shared/src/constants.ts` — update to Vercel URL after deployment
