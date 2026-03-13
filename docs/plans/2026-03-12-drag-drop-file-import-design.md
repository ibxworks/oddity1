# Design: Drag & Drop File Import

**Date:** March 12, 2026
**Feature:** Drag and drop file upload for Documents page
**Status:** Approved

---

## Overview

Users can drag and drop `.txt` or `.md` files anywhere on the DocumentsPage to create new documents, complementing the existing "Upload" button. This improves discoverability and provides a faster workflow for users with multiple files.

---

## Requirements

- **Drop zone:** Anywhere on the DocumentsPage
- **Supported files:** `.txt` and `.md` only (match upload button)
- **Multiple files:** One at a time (sequential handling)
- **Visual feedback:**
  - Semi-transparent overlay when dragging over page
  - "Drop to import" message displayed during drag
- **Error handling:**
  - Unsupported file types → toast: "Only .txt and .md files are supported"
  - Import failures → existing toast error handling

---

## Architecture

### Data Flow

```
User drags file onto page
    ↓
dragover handler → set isDragging = true, prevent default
    ↓
Overlay renders ("Drop to import")
    ↓
User releases (drop event)
    ↓
drop handler → extract file, validate type
    ↓
importFile(file) → convert to HTML (reuse existing)
    ↓
createDocument({title, content, plain_text})
    ↓
navigate to /documents/:id
```

### Component: DocumentsPage.jsx

**New state:**
- `isDragging: boolean` — tracks active drag-over state

**New handlers:**
- `handleDragOver(e)` — prevent default, set `isDragging = true`
- `handleDragLeave(e)` — clear `isDragging` (check target to avoid false-negatives)
- `handleDrop(e)` — prevent default, extract file, validate extension, call `handleFileChange()` logic

**Markup changes:**
- Wrap page content in `<div onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>`
- Conditionally render overlay when `isDragging` is true

### Visual Feedback

**Overlay styling:**
- Position: fixed or absolute, covers entire page
- Background: semi-transparent dark (e.g., `rgba(0, 0, 0, 0.5)`)
- Content: centered text "Drop files to import"
- Font: match existing UI (size 16-18px, weight 500)
- Uses existing CSS variables for consistency

**Existing toast handling:**
- Reuse `showToast()` for errors: unsupported file type, import failures
- No new toast variants needed

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| Unsupported file type (.pdf, .doc, etc.) | Toast: "Only .txt and .md files are supported" |
| File read error | Toast: "Failed to import file" (existing) |
| Supabase create error | Toast: "Failed to import file" (existing) |
| Empty file | Handled by existing `importFile()` → creates document with empty content |

---

## File Changes

| File | Changes |
|------|---------|
| `Oddity1Dashboard/src/pages/DocumentsPage.jsx` | Add `isDragging` state, three drag/drop handlers, overlay div |
| `Oddity1Dashboard/src/pages/DocumentsPage.css` | Add `.docs-overlay` and `.docs-overlay-text` classes |

No new utilities or hooks needed — reuse `importFile()` and existing `createDocument()` flow.

---

## Testing

- Drag `.txt` file onto page → imports successfully, navigates to document
- Drag `.md` file onto page → imports successfully, navigates to document
- Drag unsupported file (`.pdf`, `.jpg`) → toast error, no navigation
- Drag multiple files quickly → processes one at a time correctly
- Drag file, move mouse outside page boundary → overlay disappears (dragleave fires)
- Drag file outside page and back → overlay reappears (dragover fires again)

---

## Success Criteria

✅ Drag & drop works anywhere on DocumentsPage
✅ Visual feedback (overlay + text) appears during drag
✅ Unsupported files rejected with clear error message
✅ Successfully imported files create documents and navigate correctly
✅ Existing upload button functionality unchanged
