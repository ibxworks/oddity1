import { NavLink, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useProfile } from '../hooks/useProfile'

export default function Layout({ session }) {
  const { profile } = useProfile(session)
  const tier = profile?.tier || 'free'
  const displayName = profile?.display_name || session.user.email

  async function handleSignOut() {
    await supabase.auth.signOut()
    window.location.href = 'https://oddity1.com'
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-top">
          <h1 className="sidebar-logo">Oddity<sup>1</sup></h1>
          <span className={`sidebar-tier sidebar-tier--${tier}`}>
            {tier.toUpperCase()}
          </span>
        </div>

        <nav className="sidebar-nav">
          <NavLink
            to="/documents"
            className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link--active' : ''}`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            Documents
          </NavLink>
          <NavLink
            to="/account"
            className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link--active' : ''}`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Account
          </NavLink>
        </nav>

        <div className="sidebar-bottom">
          {tier === 'free' && (
            <a
              href="https://oddity1.com/plans"
              target="_blank"
              rel="noopener noreferrer"
              className="sidebar-upgrade"
            >
              Get Pro
            </a>
          )}
          <button onClick={handleSignOut} className="sidebar-signout">
            Sign out
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet context={{ session, profile }} />
      </main>
    </div>
  )
}
