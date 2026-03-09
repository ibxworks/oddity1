import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { setAuthCookie, clearAuthCookie } from './utils/authCookie'
import AuthForm from './components/AuthForm'
import Dashboard from './components/Dashboard'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setAuthCookie(); else clearAuthCookie()
      setSession(session)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session) setAuthCookie(); else clearAuthCookie()
        setSession(session)
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  if (loading) return null

  return session ? <Dashboard session={session} /> : <AuthForm />
}
