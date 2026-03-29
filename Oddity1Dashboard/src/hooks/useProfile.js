import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function useProfile(session) {
  const [profile, setProfile] = useState(null)
  const [preferences, setPreferences] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!session?.user?.id) return

    supabase
      .from('profiles')
      .select('display_name, tier, preferences')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => {
        if (data) {
          setProfile(data)
          setPreferences(data.preferences || {})
        }
        setLoading(false)
      })
  }, [session?.user?.id])

  async function updatePreferences(partial) {
    const merged = { ...preferences, ...partial }
    // Safety net: silently strip app.oddity1.com from enabled_sites
    if (Array.isArray(merged.enabled_sites)) {
      merged.enabled_sites = merged.enabled_sites.filter(s => s !== 'app.oddity1.com')
    }
    setPreferences(merged)
    await supabase
      .from('profiles')
      .update({ preferences: merged })
      .eq('id', session.user.id)
  }

  async function updateDisplayName(name) {
    setProfile((prev) => ({ ...prev, display_name: name }))
    await supabase
      .from('profiles')
      .update({ display_name: name })
      .eq('id', session.user.id)
  }

  async function refetchProfile() {
    if (!session?.user?.id) return
    const { data } = await supabase
      .from('profiles')
      .select('display_name, tier, preferences')
      .eq('id', session.user.id)
      .single()
    if (data) {
      setProfile(data)
      setPreferences(data.preferences || {})
    }
  }

  return { profile, preferences, loading, updatePreferences, updateDisplayName, refetchProfile }
}
