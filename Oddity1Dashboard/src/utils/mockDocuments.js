const now = Date.now()
const HOUR = 3600000
const DAY = 86400000

export const mockDocuments = [
  { id: '1', title: 'Research Notes: LLM Hallucinations', preview: 'An overview of common hallucination patterns in large language models, including factual errors, reasoning failures, and attribution issues.', editedAt: new Date(now - HOUR * 2) },
  { id: '2', title: 'Weekly Team Standup Summary', preview: 'Key updates from the engineering standup: deployment pipeline improvements, new monitoring dashboards, and Q2 planning kickoff.', editedAt: new Date(now - HOUR * 5) },
  { id: '3', title: 'Product Requirements: Settings Sync', preview: 'Requirements for syncing extension settings across devices via Supabase. Covers conflict resolution, offline support, and migration strategy.', editedAt: new Date(now - HOUR * 8) },
  { id: '4', title: 'API Design Review', preview: 'Review of the annotation API endpoints. Suggestions for pagination, rate limiting, and response format standardization.', editedAt: new Date(now - DAY * 1.2) },
  { id: '5', title: 'Competitive Analysis: Grammarly', preview: 'Feature comparison between Grammarly, LanguageTool, and ProWritingAid. Focus on browser extension UX and pricing models.', editedAt: new Date(now - DAY * 2) },
  { id: '6', title: 'Bug Report: Annotation Overlap', preview: 'When multiple annotations target overlapping text ranges, the highlight colors blend incorrectly on dark-mode pages.', editedAt: new Date(now - DAY * 3) },
  { id: '7', title: 'Onboarding Flow Draft', preview: 'Proposed 3-step onboarding: install extension, sign in, annotate first page. Includes wireframes and copy suggestions.', editedAt: new Date(now - DAY * 5) },
  { id: '8', title: 'Meeting Notes: Investor Update', preview: 'Summary of key metrics presented: MAU growth, retention rates, conversion funnel, and runway projections through Q4.', editedAt: new Date(now - DAY * 7) },
  { id: '9', title: 'Technical Spec: PDF Export v2', preview: 'Enhanced PDF export with custom headers, annotation filtering, and multi-page layout support. Estimated 2-week implementation.', editedAt: new Date(now - DAY * 10) },
  { id: '10', title: 'Style Guide: Annotation Colors', preview: 'Finalized color palette for annotation types: factual (blue), reasoning (purple), caveat (amber), source (teal), bias (red).', editedAt: new Date(now - DAY * 14) },
]

export function formatTimeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days}d ago`
  return date.toLocaleDateString()
}

export function groupByTime(docs) {
  const now = new Date()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 7)

  return docs.reduce(
    (groups, doc) => {
      if (doc.editedAt >= today) {
        groups.today.push(doc)
      } else if (doc.editedAt >= yesterday) {
        groups.yesterday.push(doc)
      } else if (doc.editedAt >= weekAgo) {
        groups.thisWeek.push(doc)
      } else {
        groups.earlier.push(doc)
      }
      return groups
    },
    { today: [], yesterday: [], thisWeek: [], earlier: [] }
  )
}
