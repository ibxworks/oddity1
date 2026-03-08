# Oddity 1 Database Schema

Supabase project: `gmmektzvvrtttszdgiai`
Region: us-east-1

---

## Tables

### `profiles`

Stores user account metadata and preferences. Created automatically on first login via a trigger or the `/api/user/preferences` GET endpoint.

| Column         | Type          | Notes                                                                                                         |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`           | `uuid` PK     | References `auth.users.id` (FK)                                                                               |
| `display_name` | `text`        | nullable                                                                                                      |
| `tier`         | `text`        | `'free'` (default) or `'pro'`                                                                                 |
| `preferences`  | `jsonb`       | Default `{}`. Merged (not replaced) on update. Shape: `{ enabled, intensity, visible_types, disabled_sites }` |
| `created_at`   | `timestamptz` | Auto `now()`                                                                                                  |

**RLS policies (enabled):**

- SELECT: `auth.uid() = id`
- INSERT: authenticated users can insert their own row
- UPDATE: `auth.uid() = id`

---

### `annotation_cache`

Stores AI-generated annotations keyed by `(content_hash, intensity)`. Shared across all users — the same content will hit cache regardless of which user requested it first.

| Column           | Type          | Notes                                                       |
| ---------------- | ------------- | ----------------------------------------------------------- |
| `id`             | `uuid` PK     | `gen_random_uuid()`                                         |
| `content_hash`   | `text`        | `sha256:<hex>` of normalized page text                      |
| `url`            | `text`        | Page URL (informational, not part of cache key)             |
| `intensity`      | `text`        | `'light'`, `'default'`, or `'heavy'`                        |
| `annotations`    | `jsonb`       | Array of `Annotation` objects                               |
| `model_version`  | `text`        | nullable. LLM model used                                    |
| `prompt_version` | `text`        | nullable. Prompt config version                             |
| `created_at`     | `timestamptz` | Auto `now()`                                                |
| `expires_at`     | `timestamptz` | 30 days from creation. Backend filters `expires_at > now()` |

**Cache key:** `(content_hash, intensity)` — two different URLs with identical extracted text share the same cache row.

**RLS:** Enabled, no user-facing policies — accessible only by the service-role key (backend).

---

### `user_annotations`

Stores manually created annotations, scoped per user. The AI-generated annotations in `annotation_cache` are separate.

| Column         | Type          | Notes                                             |
| -------------- | ------------- | ------------------------------------------------- |
| `id`           | `uuid` PK     | `gen_random_uuid()`                               |
| `user_id`      | `uuid`        | FK → `profiles.id`                                |
| `url`          | `text`        | Page URL                                          |
| `content_hash` | `text`        | `sha256:<hex>` of page text at time of annotation |
| `annotation`   | `jsonb`       | Single `Annotation` object                        |
| `created_at`   | `timestamptz` | Auto `now()`                                      |
| `updated_at`   | `timestamptz` | Auto `now()`, updated by trigger                  |

**RLS policies (enabled):**

- SELECT: `auth.uid() = user_id`
- INSERT: authenticated users can insert (user_id must match their uid)
- UPDATE: `auth.uid() = user_id`
- DELETE: `auth.uid() = user_id`

**Indexes:**

- `(user_id, url)` — fast lookup of all annotations for a user on a given URL

---

### `annotation_feedback`

Stores user feedback on annotations — thumbs up/down reactions and reply threads.

| Column          | Type          | Notes                                                                     |
| --------------- | ------------- | ------------------------------------------------------------------------- |
| `id`            | `uuid` PK     | `gen_random_uuid()`                                                       |
| `user_id`       | `uuid`        | FK → `profiles.id`                                                        |
| `annotation_id` | `text`        | The JSONB annotation `id` (e.g., `ann_1` or `manual-...`)                |
| `content_hash`  | `text`        | `sha256:<hex>` of page text at time of feedback                          |
| `url`           | `text`        | Page URL                                                                  |
| `feedback_type` | `text`        | `'thumbs_up'`, `'thumbs_down'`, or `'reply'`                            |
| `reply_text`    | `text`        | nullable. Text content for `reply` feedback type                         |
| `created_at`    | `timestamptz` | Auto `now()`                                                              |
| `updated_at`    | `timestamptz` | Auto `now()`, updated by trigger                                         |

**RLS policies (enabled):**

- SELECT: `auth.uid() = user_id`
- INSERT: authenticated users can insert (user_id must match their uid)
- DELETE: `auth.uid() = user_id`

**Indexes:**

- `(user_id, url, content_hash)` — fast lookup of all feedback for a user on a given page

---

### `site_adapters`

Config registry for site-specific extraction rules. Seeded with 6 adapters. The extension fetches this on startup and every 6 hours.

| Column               | Type          | Notes                                                                    |
| -------------------- | ------------- | ------------------------------------------------------------------------ |
| `id`                 | `uuid` PK     | `gen_random_uuid()`                                                      |
| `hostname_pattern`   | `text` UNIQUE | Glob-style: exact hostname or `*.example.com`                            |
| `content_selectors`  | `jsonb`       | Array of CSS selector strings                                            |
| `response_selector`  | `text`        | nullable. CSS selector for individual AI response elements (chat sites)  |
| `stability_signal`   | `jsonb`       | nullable. `{ type, target_selector }` or `{ type, selector, attribute }` |
| `excluded_selectors` | `jsonb`       | Default `[]`. CSS selectors to exclude from extraction                   |
| `extraction_mode`    | `text`        | `'adapter'`, `'readability'`, or `'custom_heuristic'`                    |
| `enabled`            | `bool`        | Default `true`. Only enabled adapters are returned by the API.           |
| `updated_at`         | `timestamptz` | Auto `now()`                                                             |

**RLS:** Enabled, no user-facing policies — backend reads with service-role.

**Seeded adapters:**
| Hostname Pattern | Mode |
|-----------------|------|
| `chatgpt.com` | `adapter` |
| `chat.openai.com` | `adapter` |
| `claude.ai` | `adapter` |
| `medium.com` | `readability` |
| `*.medium.com` | `readability` |
| `*.substack.com` | `readability` |

---

## `preferences` JSONB Shape

The `preferences` column in `profiles` follows this structure:

```json
{
  "enabled": true,
  "intensity": "default",
  "visible_types": [
    "highlight",
    "underline",
    "question",
    "insight",
    "caveat",
    "vocabulary"
  ],
  "disabled_sites": []
}
```

Updates use JSONB merge — you only send the fields you want to change. Missing fields are preserved.

---

## `annotation` JSONB Shape

Used in both `annotation_cache.annotations` (array) and `user_annotations.annotation` (single object):

```json
{
  "id": "ann_1",
  "type": "question",
  "anchor": {
    "type": "TextQuoteSelector",
    "exact": "the exact matched text",
    "prefix": "text before (optional)",
    "suffix": "text after (optional)"
  },
  "content": {
    "note": "Main annotation text",
    "why_it_matters": "Optional elaboration",
    "question": "Optional follow-up question",
    "suggestions": ["Optional", "list", "of", "items"]
  }
}
```

**Annotation types:** `highlight`, `underline`, `question`, `insight`, `caveat`, `vocabulary`

---

## `stability_signal` JSONB Shape

Used in `site_adapters.stability_signal`:

```json
// Wait for a selector to appear
{ "type": "selector_appears", "target_selector": "button[data-testid='copy-turn-action-button']" }

// Wait for a selector to disappear
{ "type": "selector_disappears", "target_selector": ".streaming-indicator" }

// Watch for an attribute change on a selector
{ "type": "attribute_change", "selector": ".response-block", "attribute": "data-complete" }
```

If `stability_signal` is null, the content script falls back to a 1500ms MutationObserver debounce.

---

## Database Functions

### `update_updated_at()`

Auto-trigger that sets `updated_at = now()` before any UPDATE on `user_annotations`, `annotation_feedback`, and `site_adapters`.

```sql
-- Defined with: SET search_path = '' (security hardened)
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
```

---

## Adding a New Site Adapter

Insert directly via Supabase dashboard or SQL:

```sql
INSERT INTO site_adapters (hostname_pattern, content_selectors, stability_signal, excluded_selectors, extraction_mode)
VALUES (
  'example.com',
  '["article.main-content", ".post-body"]',
  '{"type": "selector_appears", "target_selector": ".article-loaded"}',
  '["nav", "footer", ".sidebar"]',
  'adapter'
);
```

Or via Supabase Table Editor → `site_adapters`.
