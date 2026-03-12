import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useArchive() {
  const [pages, setPages] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadArchive()
  }, [])

  async function loadArchive() {
    setLoading(true)
    try {
      const [{ data: annotations }, { data: feedback }] = await Promise.all([
        supabase
          .from('user_annotations')
          .select('url, page_title, created_at, annotation')
          .order('created_at', { ascending: false }),
        supabase
          .from('annotation_feedback')
          .select('url, page_title, created_at')
          .order('created_at', { ascending: false }),
      ])

      const urlMap = {}

      for (const row of annotations ?? []) {
        // Skip tombstones
        if (row.annotation?.deleted) continue

        if (!urlMap[row.url]) {
          urlMap[row.url] = { url: row.url, page_title: null, last_activity: null, interaction_count: 0 }
        }
        const entry = urlMap[row.url]
        entry.interaction_count++
        if (!entry.last_activity || row.created_at > entry.last_activity) {
          entry.last_activity = row.created_at
          if (row.page_title) entry.page_title = row.page_title
        } else if (!entry.page_title && row.page_title) {
          entry.page_title = row.page_title
        }
      }

      for (const row of feedback ?? []) {
        if (!urlMap[row.url]) {
          urlMap[row.url] = { url: row.url, page_title: null, last_activity: null, interaction_count: 0 }
        }
        const entry = urlMap[row.url]
        entry.interaction_count++
        if (!entry.last_activity || row.created_at > entry.last_activity) {
          entry.last_activity = row.created_at
          if (row.page_title) entry.page_title = row.page_title
        } else if (!entry.page_title && row.page_title) {
          entry.page_title = row.page_title
        }
      }

      const sorted = Object.values(urlMap).sort(
        (a, b) => new Date(b.last_activity) - new Date(a.last_activity)
      )
      setPages(sorted)
    } catch (err) {
      console.error('[useArchive] Error:', err)
    }
    setLoading(false)
  }

  return { pages, loading, refreshArchive: loadArchive }
}
