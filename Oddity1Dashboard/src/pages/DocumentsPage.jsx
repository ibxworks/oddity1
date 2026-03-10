import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import { useDocuments } from '../hooks/useDocuments';
import { importFile } from '../utils/fileImport';
import { formatTimeAgo, groupByTime } from '../utils/mockDocuments';
import './DocumentsPage.css';

export default function DocumentsPage() {
  const showToast = useToast();
  const navigate = useNavigate();
  const { documents, loading, createDocument, deleteDocument } = useDocuments();
  const [search, setSearch] = useState('');
  const fileInputRef = useRef(null);

  const filtered = search
    ? documents.filter((d) => d.title?.toLowerCase().includes(search.toLowerCase()))
    : documents;

  const groups = groupByTime(
    filtered.map((d) => ({
      ...d,
      editedAt: new Date(d.updated_at),
    }))
  );

  async function handleNewDoc() {
    try {
      const id = await createDocument();
      navigate(`/documents/${id}`);
    } catch (err) {
      showToast('Failed to create document');
    }
  }

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so same file can be re-selected
    e.target.value = '';

    try {
      const { content, title } = await importFile(file);
      const id = await createDocument({
        title,
        content: null, // Will be set when editor parses HTML
        plain_text: content, // Store HTML for now; editor will parse on load
      });
      // Store imported HTML separately so editor can load it
      const docs = JSON.parse(localStorage.getItem('oddity_docs') || '{}');
      if (docs[id]) {
        docs[id]._importedHtml = content;
        localStorage.setItem('oddity_docs', JSON.stringify(docs));
      }
      navigate(`/documents/${id}`);
    } catch (err) {
      showToast('Failed to import file');
    }
  }

  async function handleDelete(e, docId) {
    e.stopPropagation();
    if (!confirm('Delete this document?')) return;
    await deleteDocument(docId);
    showToast('Document deleted');
  }

  function renderDocCard(doc) {
    const preview = doc.plain_text
      ? doc.plain_text.slice(0, 120).replace(/<[^>]*>/g, '')
      : 'Empty document';

    return (
      <button key={doc.id} className="doc-card" onClick={() => navigate(`/documents/${doc.id}`)}>
        <h3 className="doc-card-title">{doc.title || 'Untitled'}</h3>
        <p className="doc-card-preview">{preview}</p>
        <div className="doc-card-footer">
          <span className="doc-card-time">{formatTimeAgo(new Date(doc.updated_at))}</span>
          <button
            className="doc-card-delete"
            onClick={(e) => handleDelete(e, doc.id)}
            title="Delete document"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </button>
    );
  }

  return (
    <div className="docs-page">
      <div className="docs-header">
        <h1 className="docs-title">Documents</h1>
        <div className="docs-actions">
          <button className="docs-btn docs-btn--primary" onClick={handleNewDoc}>
            New doc
          </button>
          <button className="docs-btn docs-btn--outlined" onClick={handleUploadClick}>
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
      </div>

      <div className="docs-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          placeholder="Search documents..."
          className="docs-search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading && (
        <p style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 40 }}>
          Loading documents...
        </p>
      )}

      {!loading && documents.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 40 }}>
          No documents yet. Create one to get started.
        </p>
      )}

      {groups.today.length > 0 && (
        <section className="docs-section">
          <h2 className="docs-section-title">Today</h2>
          <div className="docs-grid">
            {groups.today.map(renderDocCard)}
          </div>
        </section>
      )}

      {groups.earlier.length > 0 && (
        <section className="docs-section">
          <h2 className="docs-section-title">Earlier</h2>
          <div className="docs-grid">
            {groups.earlier.map(renderDocCard)}
          </div>
        </section>
      )}
    </div>
  );
}
