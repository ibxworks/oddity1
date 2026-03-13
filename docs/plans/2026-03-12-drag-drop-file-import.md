# Drag & Drop File Import Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable users to drag and drop `.txt` and `.md` files anywhere on the DocumentsPage to create new documents with visual feedback.

**Architecture:** Add three drag/drop event handlers (`dragover`, `dragleave`, `drop`) to the DocumentsPage container. Track dragging state to show/hide an overlay. Reuse existing `importFile()` utility and `createDocument()` flow for file processing.

**Tech Stack:** React (DocumentsPage component), HTML drag/drop API, existing toast notification system

---

## Task 1: Add CSS for Drag Overlay

**Files:**
- Modify: `Oddity1Dashboard/src/pages/DocumentsPage.css`

**Step 1: Add overlay styles**

Append to the end of `DocumentsPage.css`:

```css
.docs-drop-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  pointer-events: none;
}

.docs-drop-overlay-text {
  font-size: 18px;
  font-weight: 500;
  color: white;
}
```

**Step 2: Verify styles compile**

Run: `cd /Users/realtonypark/Developer/oddity1/Oddity1Dashboard && npm run build`
Expected: Build succeeds with no errors

**Step 3: Commit**

```bash
cd /Users/realtonypark/Developer/oddity1
git add Oddity1Dashboard/src/pages/DocumentsPage.css
git commit -m "style: add drag & drop overlay styles"
```

---

## Task 2: Add Drag & Drop Handlers to DocumentsPage

**Files:**
- Modify: `Oddity1Dashboard/src/pages/DocumentsPage.jsx` (lines 1-60, add state and handlers)

**Step 1: Add isDragging state**

In `DocumentsPage()` component, after line 14 (`const fileInputRef = useRef(null);`), add:

```javascript
  const [isDragging, setIsDragging] = useState(false);
```

**Step 2: Add dragover handler**

Before `handleUploadClick()` (around line 36), add:

```javascript
  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }
```

**Step 3: Add dragleave handler**

After `handleDragOver()`, add:

```javascript
  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    // Only set to false if leaving the entire container
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  }
```

**Step 4: Add drop handler**

After `handleDragLeave()`, add:

```javascript
  async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    // Validate file type
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['txt', 'md'].includes(ext)) {
      showToast('Only .txt and .md files are supported');
      return;
    }

    // Reuse existing file change handler
    const fakeEvent = { target: { files: [file], value: '' } };
    await handleFileChange(fakeEvent);
  }
```

**Step 5: Verify syntax**

Run: `cd /Users/realtonypark/Developer/oddity1/Oddity1Dashboard && npm run build`
Expected: Build succeeds with no errors (may show TypeScript warnings for unused state initially)

**Step 6: Commit**

```bash
cd /Users/realtonypark/Developer/oddity1
git add Oddity1Dashboard/src/pages/DocumentsPage.jsx
git commit -m "feat: add drag & drop event handlers"
```

---

## Task 3: Render Drag & Drop Overlay

**Files:**
- Modify: `Oddity1Dashboard/src/pages/DocumentsPage.jsx` (lines 92-157, wrap return JSX)

**Step 1: Wrap page content and add event handlers**

Replace the `return (` on line 92 and wrap the entire JSX tree (lines 93-157) with a container div that has drag event handlers. Change from:

```javascript
  return (
    <div className="docs-page">
      {/* existing content */}
    </div>
  );
```

To:

```javascript
  return (
    <div
      className="docs-page"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* existing content unchanged */}
      {isDragging && (
        <div className="docs-drop-overlay">
          <div className="docs-drop-overlay-text">Drop files to import</div>
        </div>
      )}
    </div>
  );
```

**Important:** Keep all existing content inside the `docs-page` div unchanged. Just add the event handlers to the div and the conditional overlay.

**Step 2: Verify component renders**

Run: `cd /Users/realtonypark/Developer/oddity1/Oddity1Dashboard && npm run build`
Expected: Build succeeds with no errors

**Step 3: Test in browser (manual)**

1. Start dev server: `cd /Users/realtonypark/Developer/oddity1/Oddity1Dashboard && npm run dev`
2. Open app, navigate to Documents page
3. Drag any file onto the page → overlay should appear with "Drop files to import" text
4. Drag file out of page → overlay should disappear
5. Drag `.txt` or `.md` file and drop → should import file and navigate
6. Drag `.pdf` file and drop → should show toast "Only .txt and .md files are supported"

**Step 4: Commit**

```bash
cd /Users/realtonypark/Developer/oddity1
git add Oddity1Dashboard/src/pages/DocumentsPage.jsx
git commit -m "feat: render drag & drop overlay and handle drop events"
```

---

## Task 4: Full Build and Integration Test

**Files:**
- No changes, verification only

**Step 1: Build all packages**

Run:
```bash
cd /Users/realtonypark/Developer/oddity1
npm run build
```

Expected: All three packages build successfully:
- ✅ packages/shared
- ✅ Oddity1Dashboard
- ✅ extension (if applicable)

**Step 2: Manual integration test**

1. Start dev server: `cd /Users/realtonypark/Developer/oddity1/Oddity1Dashboard && npm run dev`
2. Create a test `.txt` file locally with sample content
3. Navigate to Documents page
4. Test drag & drop:
   - **Valid file (.txt):** Drag and drop → document created, navigated to editor, content visible ✅
   - **Valid file (.md):** Drag and drop → document created, markdown converted to HTML ✅
   - **Invalid file (.pdf/.jpg):** Drag and drop → toast error shown, no navigation ✅
   - **Drag in/out:** Overlay appears/disappears correctly ✅
5. Test existing upload button still works:
   - Click "Upload" → file input opens → select file → imports correctly ✅

**Step 3: Verify no regressions**

- All existing documents still visible ✅
- Search filter still works ✅
- Document delete still works ✅
- "New doc" button still works ✅
- Navigation to document editor works ✅

**Step 4: Commit (if any fixes needed)**

```bash
cd /Users/realtonypark/Developer/oddity1
git commit -am "test: verify drag & drop integration and no regressions"
```

---

## Summary of Changes

| File | Changes |
|------|---------|
| `Oddity1Dashboard/src/pages/DocumentsPage.css` | Add `.docs-drop-overlay` and `.docs-drop-overlay-text` styles |
| `Oddity1Dashboard/src/pages/DocumentsPage.jsx` | Add `isDragging` state, three event handlers, overlay JSX |

**Total Lines Changed:** ~40 lines

**Reused Components:** `importFile()`, `createDocument()`, `showToast()` — no new utilities created

**No Breaking Changes:** Existing upload button and all features unchanged
