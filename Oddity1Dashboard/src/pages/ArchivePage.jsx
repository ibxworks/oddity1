import { useState } from 'react'
import { formatTimeAgo, groupByTime } from '../utils/mockDocuments'
import { useArchive } from '../hooks/useArchive'
import './ArchivePage.css'

export default function ArchivePage() {
  const { pages, loading } = useArchive()
  const [search, setSearch] = useState('')

  const filtered = search
    ? pages.filter((p) =>
        (p.page_title || p.url).toLowerCase().includes(search.toLowerCase())
      )
    : pages

  const groups = groupByTime(
    filtered.map((p) => ({ ...p, editedAt: new Date(p.last_activity) }))
  )

  function getDisplayTitle(page) {
    if (page.page_title) return page.page_title
    try {
      return new URL(page.url).hostname
    } catch {
      return page.url
    }
  }

  function renderCard(page) {
    return (
      <a
        key={page.url}
        className="archive-card"
        href={page.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        <h3 className="archive-card-title">{getDisplayTitle(page)}</h3>
        <p className="archive-card-url">{page.url}</p>
        <div className="archive-card-footer">
          <span className="archive-card-time">{formatTimeAgo(new Date(page.last_activity))}</span>
          <span className="archive-card-count">
            {page.interaction_count} {page.interaction_count === 1 ? 'interaction' : 'interactions'}
          </span>
        </div>
      </a>
    )
  }

  return (
    <div className="archive-page">
      <div className="archive-header">
        <h1 className="archive-title">Archive</h1>
      </div>

      <div className="archive-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          placeholder="Search pages..."
          className="archive-search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading && (
        <p style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 40 }}>
          Loading archive...
        </p>
      )}

      {!loading && pages.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 40 }}>
          No interactions yet. Annotate or react to content on any page to build your archive.
        </p>
      )}

      {groups.today.length > 0 && (
        <section className="archive-section">
          <h2 className="archive-section-title">Today</h2>
          <div className="archive-grid">{groups.today.map(renderCard)}</div>
        </section>
      )}

      {groups.earlier.length > 0 && (
        <section className="archive-section">
          <h2 className="archive-section-title">Earlier</h2>
          <div className="archive-grid">{groups.earlier.map(renderCard)}</div>
        </section>
      )}
    </div>
  )
}
