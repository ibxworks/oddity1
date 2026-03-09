import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Dashboard({ session }) {
  const [profile, setProfile] = useState(null)

  useEffect(() => {
    supabase
      .from('profiles')
      .select('display_name, tier')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => setProfile(data))
  }, [session.user.id])

  const displayName = profile?.display_name || session.user.email
  const tier = profile?.tier || 'free'

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  return (
    <div className="dash-page">
      <nav className="dash-nav">
        <span className="dash-logo">Oddity<sup>1</sup></span>
        <button onClick={handleSignOut} className="dash-signout">
          Sign Out
        </button>
      </nav>

      <main className="dash-main">
        <h1 className="dash-welcome">Welcome, {displayName}!</h1>

        <div className="dash-info-card">
          <div className="dash-info-row">
            <span className="dash-label">Email</span>
            <span>{session.user.email}</span>
          </div>
          <div className="dash-info-row">
            <span className="dash-label">Tier</span>
            <span className={`dash-tier dash-tier--${tier}`}>
              {tier.toUpperCase()}
            </span>
          </div>
        </div>

        <p className="dash-coming-soon">Dashboard features coming soon.</p>

        <a
          href="https://chromewebstore.google.com"
          target="_blank"
          rel="noopener noreferrer"
          className="dash-cta"
        >
          Install Chrome Extension
        </a>
      </main>
    </div>
  )
}
