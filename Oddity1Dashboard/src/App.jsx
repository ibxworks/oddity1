import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { setAuthCookie, clearAuthCookie } from './utils/authCookie'
import AuthForm from './components/AuthForm'
import Layout from './components/Layout'
import DocumentsPage from './pages/DocumentsPage'
import AccountPage from './pages/AccountPage'
import EditorPage from './pages/EditorPage'
import ArchivePage from './pages/ArchivePage'

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

  if (!session) return <AuthForm />

  return (
    <Routes>
      <Route path="/documents/:id" element={<EditorPage session={session} />} />
      <Route element={<Layout session={session} />}>
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/" element={<Navigate to="/documents" replace />} />
        <Route path="*" element={<Navigate to="/documents" replace />} />
      </Route>
    </Routes>
  )
}
