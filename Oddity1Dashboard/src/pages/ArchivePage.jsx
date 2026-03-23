import { useState } from "react";
import { useArchive } from "../hooks/useArchive";
import {
  ANNOTATION_COLORS,
  ANNOTATION_LABELS,
} from "../utils/annotationConstants";
import { formatTimeAgo, groupByTime } from "../utils/mockDocuments";
import "./ArchivePage.css";

export default function ArchivePage() {
  const { pages, loading } = useArchive();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState({});

  const filtered = search
    ? pages.filter((p) =>
        (p.page_title || p.url).toLowerCase().includes(search.toLowerCase()),
      )
    : pages;

  const groups = groupByTime(
    filtered.map((p) => ({ ...p, editedAt: new Date(p.last_activity) })),
  );

  function getDisplayTitle(page) {
    if (page.page_title) return page.page_title;
    try {
      return new URL(page.url).hostname;
    } catch {
      return page.url;
    }
  }

  function getDomain(url) {
    try {
      return new URL(url).hostname.replace("www.", "");
    } catch {
      return url;
    }
  }

  function toggleExpand(url) {
    setExpanded((prev) => ({ ...prev, [url]: !prev[url] }));
  }

  function renderRow(page) {
    const isExpanded = expanded[page.url];
    const domain = getDomain(page.url);
    const annotations = page.annotations || [];

    return (
      <div key={page.url} className="archive-row-wrapper">
        <div className="archive-row" onClick={() => toggleExpand(page.url)}>
          <button
            className={`archive-row-expand ${isExpanded ? "archive-row-expand--open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(page.url);
            }}
            aria-label="Expand"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <div className="archive-row-favicon">
            {domain.charAt(0).toUpperCase()}
          </div>
          <div className="archive-row-content">
            <span className="archive-row-title">{getDisplayTitle(page)}</span>
            <span className="archive-row-url">{domain}</span>
          </div>
          <div className="archive-row-meta">
            {annotations.length > 0 && (
              <span className="archive-row-count">{annotations.length}</span>
            )}
            <span className="archive-row-time">
              {formatTimeAgo(new Date(page.last_activity))}
            </span>
            <a
              className="archive-row-open"
              href={page.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open page"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>
        </div>

        {isExpanded && annotations.length > 0 && (
          <div className="archive-annotations">
            {annotations.map((ann, i) => (
              <div key={ann.id || i} className="archive-annotation">
                <span
                  className="archive-annotation-type"
                  style={{ color: ANNOTATION_COLORS[ann.type] || "#888" }}
                >
                  {ANNOTATION_LABELS[ann.type] || ann.type}
                </span>
                {ann.anchor?.exact && (
                  <span className="archive-annotation-anchor">
                    &ldquo;{ann.anchor.exact.slice(0, 80)}
                    {ann.anchor.exact.length > 80 ? "..." : ""}&rdquo;
                  </span>
                )}
                {ann.content?.note && (
                  <span className="archive-annotation-note">
                    {ann.content.note.slice(0, 120)}
                    {ann.content.note.length > 120 ? "..." : ""}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {isExpanded && annotations.length === 0 && (
          <div className="archive-annotations">
            <div className="archive-annotation archive-annotation--empty">
              No annotation details available
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderSection(title, items) {
    if (items.length === 0) return null;
    return (
      <section className="archive-section" key={title}>
        <h2 className="section-title">{title}</h2>
        <div className="archive-list">{items.map(renderRow)}</div>
      </section>
    );
  }

  return (
    <div className="archive-page">
      <div className="page-header">
        <h1 className="page-title">My Annotations Archive</h1>
        <div className="search-bar">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search pages..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="archive-body">
        {loading && <div className="empty-state">Loading archive...</div>}

        {!loading && pages.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div className="empty-state-title">No activity yet</div>
            <p>
              Annotate or react to content on any page to build your history.
            </p>
          </div>
        )}

        {renderSection("Today", groups.today)}
        {renderSection("Yesterday", groups.yesterday)}
        {renderSection("This Week", groups.thisWeek)}
        {renderSection("Earlier", groups.earlier)}
      </div>
    </div>
  );
}
