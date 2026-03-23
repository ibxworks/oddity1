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
      const [annResult, fbResult] = await Promise.all([
        supabase
          .from('user_annotations')
          .select('url, created_at, annotation')
          .order('created_at', { ascending: false }),
        supabase
          .from('annotation_feedback')
          .select('url, created_at')
          .order('created_at', { ascending: false }),
      ])

      const annotations = annResult.data ?? []
      const feedback = fbResult.data ?? []

      if (annResult.error) console.warn('[useArchive] user_annotations error:', annResult.error.message)
      if (fbResult.error) console.warn('[useArchive] annotation_feedback error:', fbResult.error.message)

      const urlMap = {}

      for (const row of annotations) {
        if (row.annotation?.deleted) continue

        if (!urlMap[row.url]) {
          urlMap[row.url] = {
            url: row.url,
            page_title: null,
            last_activity: null,
            interaction_count: 0,
            annotations: [],
          }
        }
        const entry = urlMap[row.url]
        entry.interaction_count++
        if (row.annotation && !row.annotation.deleted) {
          entry.annotations.push(row.annotation)
        }
        // Extract page_title from annotation JSONB if available
        const title = row.annotation?.page_title || row.annotation?.label
        if (!entry.last_activity || row.created_at > entry.last_activity) {
          entry.last_activity = row.created_at
          if (title) entry.page_title = title
        } else if (!entry.page_title && title) {
          entry.page_title = title
        }
      }

      for (const row of feedback) {
        if (!urlMap[row.url]) {
          urlMap[row.url] = {
            url: row.url,
            page_title: null,
            last_activity: null,
            interaction_count: 0,
            annotations: [],
          }
        }
        const entry = urlMap[row.url]
        entry.interaction_count++
        if (!entry.last_activity || row.created_at > entry.last_activity) {
          entry.last_activity = row.created_at
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
