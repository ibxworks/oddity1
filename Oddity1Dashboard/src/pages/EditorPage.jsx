import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useDocuments } from '../hooks/useDocuments';
import { useAnnotation } from '../hooks/useAnnotation';
import { createAnnotationPlugin, annotationPluginKey } from '../components/AnnotationPlugin';
import MarginNotes from '../components/MarginNotes';
import { exportPdf } from '../utils/exportPdf';
import './EditorPage.css';

export default function EditorPage({ session }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { getDocument, updateDocument } = useDocuments();
  const { annotations, isAnnotating, error: annotateError, annotate, clearAnnotations, cleanup } = useAnnotation();

  const [title, setTitle] = useState('Untitled');
  const [saveStatus, setSaveStatus] = useState('Saved');
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState('edit'); // 'edit' | 'read'
  const [storedAnnotations, setStoredAnnotations] = useState([]);

  const loadedRef = useRef(false);
  const saveTimeoutRef = useRef(null);
  const editorWrapperRef = useRef(null);

  // Read initial content synchronously before editor creation
  const initialContent = useMemo(() => {
    const doc = getDocument(id);
    if (!doc) return '';
    return doc.content || '';
  }, [id, getDocument]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Start typing or paste your text...' }),
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class: 'editor-content-inner',
      },
    },
    onUpdate({ editor }) {
      if (!loadedRef.current) return;
      setSaveStatus('Saving...');
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        const plainText = editor.getText();
        const wordCount = plainText.split(/\s+/).filter(Boolean).length;
        updateDocument(id, {
          content: editor.getJSON(),
          plain_text: plainText,
          word_count: wordCount,
        });
        setSaveStatus('Saved');
      }, 800);
    },
  });

  // Register AnnotationPlugin once editor is ready
  useEffect(() => {
    if (!editor) return;
    const plugin = createAnnotationPlugin();
    // Only register if not already registered
    const existing = editor.view.state.plugins.find(
      (p) => p.spec.key === annotationPluginKey
    );
    if (!existing) {
      editor.registerPlugin(plugin);
    }
    return () => {
      try { editor.unregisterPlugin(annotationPluginKey); } catch { /* already destroyed */ }
    };
  }, [editor]);

  // Load document metadata, handle HTML-to-JSON conversion, restore annotations
  useEffect(() => {
    if (!editor || loaded) return;
    const doc = getDocument(id);
    if (doc) {
      setTitle(doc.title || 'Untitled');

      // If content was stored as HTML string (from file import), convert to JSON
      if (doc.content && typeof doc.content === 'string') {
        editor.commands.setContent(doc.content);
        const plainText = editor.getText();
        const wordCount = plainText.split(/\s+/).filter(Boolean).length;
        updateDocument(id, {
          content: editor.getJSON(),
          plain_text: plainText,
          word_count: wordCount,
        });
      }

      // Restore stored annotations
      if (doc.annotations?.length) {
        setStoredAnnotations(doc.annotations);
      }
    }
    loadedRef.current = true;
    setLoaded(true);
  }, [editor, id, loaded, getDocument, updateDocument]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  // Annotations to display: streaming takes priority over stored
  const displayAnnotations = isAnnotating || annotations.length > 0
    ? annotations
    : storedAnnotations;

  // Push annotations into the ProseMirror plugin whenever they change
  useEffect(() => {
    if (!editor || !displayAnnotations) return;
    const { tr } = editor.view.state;
    tr.setMeta(annotationPluginKey, { annotations: displayAnnotations });
    editor.view.dispatch(tr);
  }, [editor, displayAnnotations]);

  const switchToEdit = useCallback(() => {
    if (editor) {
      // Clear annotations from plugin
      const { tr } = editor.view.state;
      tr.setMeta(annotationPluginKey, { annotations: [] });
      editor.view.dispatch(tr);
      editor.setEditable(true);
    }
    setMode('edit');
    setTimeout(() => editor?.commands.focus(), 50);
  }, [editor]);

  const switchToRead = useCallback(() => {
    if (editor) editor.setEditable(false);
    setMode('read');
  }, [editor]);

  const handleTitleChange = useCallback((e) => {
    setTitle(e.target.value);
  }, []);

  const handleTitleBlur = useCallback(() => {
    updateDocument(id, { title: title || 'Untitled' });
  }, [id, title, updateDocument]);

  const handleTitleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.target.blur();
      editor?.commands.focus();
    }
  }, [editor]);

  const handleAnnotate = useCallback(async () => {
    if (!editor || isAnnotating) return;
    const plainText = editor.getText();
    if (!plainText.trim()) return;

    // Switch to read mode
    editor.setEditable(false);
    setMode('read');

    const wordCount = plainText.split(/\s+/).filter(Boolean).length;
    const result = await annotate(plainText, wordCount, { docId: id });
    if (result?.length) {
      setStoredAnnotations(result);
      updateDocument(id, { annotations: result });
    }
  }, [editor, isAnnotating, annotate, id, updateDocument]);

  const handleExportPdf = useCallback(() => {
    if (!editor) return;
    exportPdf(title, editor.getHTML(), displayAnnotations);
  }, [editor, title, displayAnnotations]);

  if (!editor) return null;

  return (
    <div className="editor-page">
      {/* Top Bar */}
      <div className="editor-topbar">
        <button className="editor-topbar__back" onClick={() => navigate('/documents')} title="Back to documents">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" /><polyline points="12 19 5 12 12 5" />
          </svg>
        </button>

        <input
          className="editor-topbar__title"
          value={title}
          onChange={handleTitleChange}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
          placeholder="Untitled"
        />

        {/* Mode Toggle */}
        <div className="editor-topbar__mode-toggle">
          <button
            className={`mode-toggle-btn ${mode === 'edit' ? 'active' : ''}`}
            onClick={switchToEdit}
          >
            Edit
          </button>
          <button
            className={`mode-toggle-btn ${mode === 'read' ? 'active' : ''}`}
            onClick={switchToRead}
          >
            Read
          </button>
        </div>

        <div className="editor-topbar__actions">
          <span className="editor-topbar__status">{saveStatus}</span>
          <button
            className="editor-topbar__annotate"
            onClick={handleAnnotate}
            disabled={isAnnotating}
          >
            {isAnnotating ? 'Annotating...' : 'Annotate'}
          </button>
          <button className="editor-topbar__export" onClick={handleExportPdf} title="Export PDF">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Toolbar — only in edit mode */}
      {mode === 'edit' && (
        <div className="editor-toolbar">
          <button
            className={`toolbar-btn ${editor.isActive('bold') ? 'active' : ''}`}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold"
          >
            <strong>B</strong>
          </button>
          <button
            className={`toolbar-btn ${editor.isActive('italic') ? 'active' : ''}`}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic"
          >
            <em>I</em>
          </button>
          <span className="toolbar-divider" />
          <button
            className={`toolbar-btn ${editor.isActive('heading', { level: 1 }) ? 'active' : ''}`}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            title="Heading 1"
          >
            H1
          </button>
          <button
            className={`toolbar-btn ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            title="Heading 2"
          >
            H2
          </button>
          <button
            className={`toolbar-btn ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            title="Heading 3"
          >
            H3
          </button>
          <span className="toolbar-divider" />
          <button
            className={`toolbar-btn ${editor.isActive('bulletList') ? 'active' : ''}`}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            title="Bullet List"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
          </button>
          <button
            className={`toolbar-btn ${editor.isActive('orderedList') ? 'active' : ''}`}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            title="Ordered List"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2" y="8" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif">1</text><text x="2" y="14" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif">2</text><text x="2" y="20" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif">3</text></svg>
          </button>
          <button
            className={`toolbar-btn ${editor.isActive('blockquote') ? 'active' : ''}`}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            title="Blockquote"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
          </button>
        </div>
      )}

      {/* Error banner */}
      {annotateError && (
        <div className="editor-error">
          Annotation error: {annotateError}
          <button onClick={() => { clearAnnotations(); setStoredAnnotations([]); }}>Dismiss</button>
        </div>
      )}

      {/* Loading indicator */}
      {isAnnotating && annotations.length === 0 && (
        <div className="editor-annotating-banner">
          Analyzing text...
        </div>
      )}

      {/* Content Area — editor always mounted */}
      <div className="editor-area">
        <div className="editor-wrapper" ref={editorWrapperRef}>
          <EditorContent editor={editor} />
          {mode === 'read' && displayAnnotations.length > 0 && (
            <MarginNotes annotations={displayAnnotations} editorRef={editorWrapperRef} />
          )}
        </div>
      </div>
    </div>
  );
}
