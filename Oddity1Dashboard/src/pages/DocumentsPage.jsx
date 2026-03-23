import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import { useDocuments } from '../hooks/useDocuments';
import { importFile, SUPPORTED_EXTENSIONS } from '../utils/fileImport';
import { formatTimeAgo, groupByTime } from '../utils/mockDocuments';
import './DocumentsPage.css';

export default function DocumentsPage() {
  const showToast = useToast();
  const navigate = useNavigate();
  const { documents, loading, createDocument, deleteDocument } = useDocuments();
  const [search, setSearch] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [converting, setConverting] = useState(false);
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

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  }

  async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      showToast('Unsupported file type. Use PDF, DOCX, PPTX, TXT, or MD.');
      return;
    }

    const fakeEvent = { target: { files: [file], value: '' } };
    await handleFileChange(fakeEvent);
  }

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setConverting(true);
    try {
      const { content, title } = await importFile(file);
      const id = await createDocument({
        title,
        content,
        plain_text: content,
      });
      navigate(`/documents/${id}`);
    } catch (err) {
      showToast(err.message || 'Failed to import file');
    } finally {
      setConverting(false);
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
      ? doc.plain_text.slice(0, 100).replace(/<[^>]*>/g, '')
      : 'Empty document';

    const annotationCount = doc.annotations?.length || 0;

    return (
      <button key={doc.id} className="doc-card" onClick={() => navigate(`/documents/${doc.id}`)}>
        <div className="doc-card-header">
          {annotationCount > 0 ? (
            <span className="doc-card-badge">{annotationCount} annotations</span>
          ) : (
            <span />
          )}
          <button
            className="doc-card-menu"
            onClick={(e) => handleDelete(e, doc.id)}
            title="Delete document"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
        <h3 className="doc-card-title">{doc.title || 'Untitled'}</h3>
        <p className="doc-card-preview">{preview}</p>
        <div className="doc-card-footer">
          <span className="doc-card-time">Edited {formatTimeAgo(new Date(doc.updated_at))}</span>
        </div>
      </button>
    );
  }

  const acceptExtensions = SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(',');

  function renderSection(title, items) {
    if (items.length === 0) return null;
    return (
      <section className="docs-section" key={title}>
        <h2 className="section-title">{title}</h2>
        <div className="docs-grid">{items.map(renderDocCard)}</div>
      </section>
    );
  }

  return (
    <div
      className="docs-page"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="docs-drop-overlay">
          <div className="docs-drop-overlay-text">Drop files to import</div>
        </div>
      )}
      {converting && (
        <div className="docs-converting-overlay">
          <div className="docs-converting-spinner" />
          <div className="docs-converting-text">Converting document...</div>
        </div>
      )}

      <div className="page-header">
        <h1 className="page-title">Documents</h1>
        <div className="page-actions">
          <div className="search-bar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search docs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="docs-upload-wrapper">
            <button
              className="btn btn--secondary"
              onClick={handleUploadClick}
              disabled={converting}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Upload
            </button>
            <div className="docs-upload-tooltip">PDF, DOCX, PPTX, TXT, MD</div>
          </div>
          <button className="btn btn--primary" onClick={handleNewDoc}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New doc
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptExtensions}
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
      </div>

      <div className="docs-body">
        {loading && (
          <div className="empty-state">Loading documents...</div>
        )}

        {!loading && documents.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </div>
            <div className="empty-state-title">No documents yet</div>
            <p>Create a new document or upload a file to get started.</p>
          </div>
        )}

        {renderSection('Today', groups.today)}
        {renderSection('Yesterday', groups.yesterday)}
        {renderSection('This Week', groups.thisWeek)}
        {renderSection('Earlier', groups.earlier)}
      </div>
    </div>
  );
}
