# Oddity API Reference

Base URL: `http://localhost:3001` (dev) or your deployed Vercel URL (prod).

All protected endpoints require a Supabase JWT in the `Authorization` header:
```
Authorization: Bearer <access_token>
```

---

## Health

### `GET /api/health`
No auth required. Returns server status.

**Response**
```json
{ "status": "ok" }
```

---

## Annotations

### `POST /api/annotate`
Generate AI annotations for a block of text. Returns cached results instantly if the same content has been annotated before at the same intensity.

**Auth:** Required
**Rate limit:** 50 requests/day (free), 500/day (pro). Resets at midnight UTC.

**Request body**
```json
{
  "url": "https://chat.openai.com/...",
  "content_hash": "sha256:abc123...",
  "text": "The extracted text to annotate...",
  "intensity": "default",
  "word_count": 1200
}
```

| Field | Type | Notes |
|-------|------|-------|
| `url` | string (URL) | Page URL, stored for debugging/cache association |
| `content_hash` | string | `sha256:<hex>` of the normalized text — this is the cache key |
| `text` | string | Extracted reading region text, max 100,000 chars |
| `intensity` | `"light" \| "default" \| "heavy"` | Controls annotation density |
| `word_count` | integer | Used for rate-estimation; does not affect caching |

**Response**
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

`cached: true` means the result came from the database, not a fresh OpenAI call.

**Annotation types**

| Type | Visual | Description |
|------|--------|-------------|
| `highlight` | Yellow background | Key phrase emphasis |
| `underline` | Teal underline | Important statement |
| `question` | Purple dotted underline + ? gutter | Probing question about the text |
| `insight` | Blue background | "Why this matters" note |
| `caveat` | Orange wavy underline | Counterpoint or limitation |
| `vocabulary` | Green dotted underline | Term definition or clarification |

**Error responses**
```json
// 400 — validation failed
{ "error": "Invalid request", "details": [...] }

// 401 — missing/invalid token
{ "error": "Invalid or expired token" }

// 429 — rate limit
{ "error": "Rate limit exceeded", "limit": 50, "retry_after": 43200 }
```

---

### `GET /api/annotations`
Retrieve all annotations for a URL + content hash. Returns AI-cached annotations merged with the user's manual annotations.

**Auth:** Required
**Query params:** `url` (required), `content_hash` (required)

```
GET /api/annotations?url=https%3A%2F%2F...&content_hash=sha256%3Aabc123
```

**Response**
```json
{
  "success": true,
  "cached": true,
  "annotations": [...]
}
```

---

### `POST /api/annotations`
Save a user-created manual annotation. Stored in `user_annotations`, scoped to the requesting user via RLS.

**Auth:** Required

**Request body**
```json
{
  "url": "https://example.com/article",
  "content_hash": "sha256:abc123...",
  "annotation": {
    "id": "manual_1",
    "type": "insight",
    "anchor": {
      "type": "TextQuoteSelector",
      "exact": "the selected text"
    },
    "content": {
      "note": "My note about this"
    }
  }
}
```

**Response** — `201 Created`, returns the saved annotation object.

---

### `DELETE /api/annotations/:id`
Delete a user-owned annotation. Only the owning user can delete (enforced by RLS).

**Auth:** Required
**URL param:** `:id` — UUID of the annotation row

**Response**
```json
{ "success": true }
```

---

## Adapters

### `GET /api/adapters`
Returns the site adapter registry. **No auth required** — public endpoint. The extension calls this on startup and every 6 hours.

**Response**
```json
[
  {
    "id": "uuid",
    "hostname_pattern": "chatgpt.com",
    "content_selectors": ["div[data-message-author-role='assistant'] .markdown"],
    "stability_signal": {
      "type": "selector_appears",
      "target_selector": "button[data-testid='copy-turn-action-button']"
    },
    "excluded_selectors": ["nav", "header"],
    "extraction_mode": "adapter",
    "enabled": true,
    "updated_at": "2026-02-23T..."
  }
]
```

---

## User Preferences

### `GET /api/user/preferences`
Fetch the authenticated user's preferences. Auto-creates a profile row on first call.

**Auth:** Required

**Response**
```json
{
  "enabled": true,
  "intensity": "default",
  "visible_types": ["highlight", "underline", "question", "insight", "caveat", "vocabulary"],
  "disabled_sites": []
}
```

---

### `PUT /api/user/preferences`
Update preferences. Uses **JSONB merge** — you only need to send the fields you want to change. Existing fields are preserved.

**Auth:** Required

**Request body** — any subset of the preferences object:
```json
{ "intensity": "heavy" }
```

**Response** — the full merged preferences object.

---

## Common Error Shapes

| Status | Meaning |
|--------|---------|
| 400 | Validation error — check `details` field |
| 401 | Missing or expired `Authorization` header |
| 429 | Rate limit exceeded — check `Retry-After` header (seconds until reset) |
| 500 | Internal server error |
