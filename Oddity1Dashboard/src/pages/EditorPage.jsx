import { useEffect, useState, useRef, useCallback } from 'react';
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
  const editorContainerRef = useRef(null);
  const saveTimeoutRef = useRef(null);

  const annotationPlugin = useRef(createAnnotationPlugin());

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Start typing or paste your text...' }),
    ],
    editorProps: {
      attributes: {
        class: 'editor-content-inner',
      },
    },
    onUpdate({ editor }) {
      if (!loaded) return;
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

  // Register annotation plugin
  useEffect(() => {
    if (!editor) return;
    // Add plugin on editor creation
    const { state } = editor.view;
    if (!annotationPluginKey.getState(state)) {
      editor.registerPlugin(annotationPlugin.current);
    }
  }, [editor]);

  // Load document content
  useEffect(() => {
    if (!editor || loaded) return;
    const doc = getDocument(id);
    if (doc) {
      setTitle(doc.title || 'Untitled');
      if (doc.content) {
        editor.commands.setContent(doc.content);
      } else if (doc._importedHtml) {
        // File import: HTML stored temporarily, load into editor and clear
        editor.commands.setContent(doc._importedHtml);
        // Save as TipTap JSON and remove temp HTML
        const plainText = editor.getText();
        const wordCount = plainText.split(/\s+/).filter(Boolean).length;
        updateDocument(id, {
          content: editor.getJSON(),
          plain_text: plainText,
          word_count: wordCount,
        });
        const local = JSON.parse(localStorage.getItem('oddity_docs') || '{}');
        if (local[id]) { delete local[id]._importedHtml; localStorage.setItem('oddity_docs', JSON.stringify(local)); }
      }
      if (doc.annotations) {
        // Restore previous annotations
        editor.view.dispatch(
          editor.state.tr.setMeta(annotationPluginKey, { annotations: doc.annotations })
        );
      }
    }
    setLoaded(true);
  }, [editor, id, loaded, getDocument, updateDocument]);

  // Push streaming annotations into the plugin
  useEffect(() => {
    if (!editor || !annotations.length) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(annotationPluginKey, { annotations })
    );
  }, [editor, annotations]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const handleTitleChange = useCallback((e) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
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
    const wordCount = plainText.split(/\s+/).filter(Boolean).length;
    const result = await annotate(plainText, wordCount);
    if (result?.length) {
      updateDocument(id, { annotations: result });
    }
  }, [editor, isAnnotating, annotate, id, updateDocument]);

  const handleExportPdf = useCallback(() => {
    if (!editor) return;
    const currentAnnotations = annotationPluginKey.getState(editor.state)?.annotations || [];
    exportPdf(title, editor.getHTML(), currentAnnotations);
  }, [editor, title]);

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

      {/* Toolbar */}
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

      {/* Error banner */}
      {annotateError && (
        <div className="editor-error">
          Annotation error: {annotateError}
          <button onClick={clearAnnotations}>Dismiss</button>
        </div>
      )}

      {/* Editor Area */}
      <div className="editor-area">
        <div className="editor-wrapper" ref={editorContainerRef}>
          <EditorContent editor={editor} />
          <MarginNotes annotations={annotations} editorRef={editorContainerRef} />
        </div>
      </div>
    </div>
  );
}
