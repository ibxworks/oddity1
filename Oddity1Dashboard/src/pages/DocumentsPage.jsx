import { useToast } from '../context/ToastContext'
import { mockDocuments, formatTimeAgo, groupByTime } from '../utils/mockDocuments'
import './DocumentsPage.css'

export default function DocumentsPage() {
  const showToast = useToast()
  const groups = groupByTime(mockDocuments)

  function handleComingSoon() {
    showToast('Coming soon')
  }

  return (
    <div className="docs-page">
      <div className="docs-header">
        <h1 className="docs-title">Documents</h1>
        <div className="docs-actions">
          <button className="docs-btn docs-btn--primary" onClick={handleComingSoon}>
            New doc
          </button>
          <button className="docs-btn docs-btn--outlined" onClick={handleComingSoon}>
            Upload
          </button>
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
          onFocus={handleComingSoon}
          readOnly
        />
      </div>

      {groups.today.length > 0 && (
        <section className="docs-section">
          <h2 className="docs-section-title">Today</h2>
          <div className="docs-grid">
            {groups.today.map((doc) => (
              <button key={doc.id} className="doc-card" onClick={handleComingSoon}>
                <h3 className="doc-card-title">{doc.title}</h3>
                <p className="doc-card-preview">{doc.preview}</p>
                <span className="doc-card-time">{formatTimeAgo(doc.editedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {groups.earlier.length > 0 && (
        <section className="docs-section">
          <h2 className="docs-section-title">Earlier</h2>
          <div className="docs-grid">
            {groups.earlier.map((doc) => (
              <button key={doc.id} className="doc-card" onClick={handleComingSoon}>
                <h3 className="doc-card-title">{doc.title}</h3>
                <p className="doc-card-preview">{doc.preview}</p>
                <span className="doc-card-time">{formatTimeAgo(doc.editedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
