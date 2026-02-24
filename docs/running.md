# Running Oddity 1 Locally

## Prerequisites

- Node.js 20+
- npm 10+
- Chrome (for loading the extension)
- A Supabase project (already provisioned: `gmmektzvvrtttszdgiai`)
- An OpenAI API key

---

## 1. Install dependencies

From the repo root:

```bash
npm install
```

This installs all workspaces (`packages/shared`, `extension`, `backend`) in one step.

---

## 2. Configure the backend

Create `backend/.env`:

```env
SUPABASE_URL=https://gmmektzvvrtttszdgiai.supabase.co
SUPABASE_ANON_KEY=<your anon key>
SUPABASE_SERVICE_ROLE_KEY=<your service role key>
OPENAI_API_KEY=sk-...
PORT=3001
```

---

## 3. Configure the extension

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

## 4. Run the backend

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

## 5. Build the extension

```bash
cd extension
npm run dev   # watch mode (Vite HMR)
# or
npm run build # one-time production build
```

The built extension lands in `extension/dist/`.

---

## 6. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist/` folder

After changes, click the refresh icon on the extension card (or it auto-reloads in `dev` mode with CRXJS).

---

## 7. Auth setup

The extension uses Supabase Auth with Google OAuth. To enable it:

1. Go to [Supabase Dashboard → Authentication → Providers](https://supabase.com/dashboard/project/gmmektzvvrtttszdgiai/auth/providers)
2. Enable **Google**
3. Paste your **Google OAuth Client ID** and **Client Secret**
4. Add the Supabase callback URL to your Google Cloud Console (Credentials → OAuth 2.0 Client → Authorized redirect URIs)

The Supabase callback URL is shown in the Supabase provider settings dialog.

---

## 8. Write real AI prompts

`backend/config/prompts.json` currently has placeholder prompts:

```json
{ "light": { "system_prompt": "<<PLACEHOLDER>>" }, ... }
```

Replace the `<<PLACEHOLDER>>` values with actual system prompts before the annotation feature works. The backend won't crash without them — it'll just pass the placeholder to OpenAI and get garbage back.

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
- If you see `Requesting annotations for region...` but nothing comes back, check the backend logs for errors.

**Supabase auth not working**

- Confirm Google OAuth is enabled in Supabase Dashboard.
- Confirm the Google Cloud Console redirect URI matches the Supabase callback URL exactly.
- Check `chrome://extensions` → your extension → Errors for any auth failures.

**Prompts returning garbage**
The prompts in `backend/config/prompts.json` are placeholders. Write real system prompts and restart the backend.
