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
│   ├── lib/                # Auth middleware, rate limiter, schema validator, OpenAI client
│   └── config/prompts.json # System prompts per intensity (currently placeholders!)
│
└── docs/                   # ← you are here
```

---

## Key credentials & where they live

| Secret                        | Where used                                          | Where to get it                             |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------- |
| `SUPABASE_URL`                | `backend/.env`                                      | Supabase Dashboard → Project Settings → API |
| `SUPABASE_ANON_KEY`           | `backend/.env` + `extension/src/background/auth.ts` | Same                                        |
| `SUPABASE_SERVICE_ROLE_KEY`   | `backend/.env` only — never in extension            | Same                                        |
| `OPENAI_API_KEY`              | `backend/.env`                                      | platform.openai.com                         |
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

| Method | Path                    | Auth | Description                               |
| ------ | ----------------------- | ---- | ----------------------------------------- |
| GET    | `/api/health`           | No   | Server status check                       |
| POST   | `/api/annotate`         | Yes  | Generate AI annotations (cached)          |
| GET    | `/api/annotations`      | Yes  | Fetch cached + user annotations for a URL |
| POST   | `/api/annotations`      | Yes  | Save a manual annotation                  |
| DELETE | `/api/annotations/:id`  | Yes  | Delete a user annotation                  |
| GET    | `/api/adapters`         | No   | Get site adapter registry                 |
| GET    | `/api/user/preferences` | Yes  | Get user preferences                      |
| PUT    | `/api/user/preferences` | Yes  | Update preferences (partial JSONB merge)  |

Auth = `Authorization: Bearer <supabase_access_token>`

Rate limits: 50 req/day (free), 500 req/day (pro). Resets at midnight UTC.

Full docs: [docs/api.md](./api.md)

---

## Database tables at a glance

| Table              | Purpose                                              | RLS               |
| ------------------ | ---------------------------------------------------- | ----------------- |
| `profiles`         | User metadata + preferences                          | Own row only      |
| `annotation_cache` | AI annotations, keyed by `(content_hash, intensity)` | Service-role only |
| `user_annotations` | Manual annotations per user                          | Own rows only     |
| `site_adapters`    | Site extraction config (6 seeded)                    | Service-role only |

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

## Auth UI elements

When the user is not signed in or the session expires:

| Element           | Where             | Behavior                                                                                                                                                |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Red "!" badge     | Extension icon    | Set when annotation request fails due to auth. Click to open popup and sign in. Clears automatically after successful auth.                             |
| Dismissible toast | Top-right of page | "Sign in to Oddity 1 to see annotations — click the extension icon". Auto-dismisses after 8 seconds or on click/dismiss. Only shows once per page load. |

---

## Things that need real values before launch

- [ ] `backend/config/prompts.json` — replace `"<<PLACEHOLDER>>"` with actual system prompts
- [ ] Google OAuth credentials in Supabase Dashboard
- [ ] `BACKEND_URL` in `packages/shared/src/constants.ts` — update to Vercel URL after deployment
