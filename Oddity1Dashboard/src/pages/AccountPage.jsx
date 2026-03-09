import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useProfile } from '../hooks/useProfile'
import { useToast } from '../context/ToastContext'
import './AccountPage.css'

const FONT_OPTIONS = [
  { value: 'system', label: 'System Default' },
  { value: 'Fraunces', label: 'Fraunces' },
  { value: 'Kalam', label: 'Kalam' },
  { value: 'Helvetica Neue', label: 'Helvetica Neue' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Georgia', label: 'Georgia' },
]

export default function AccountPage() {
  const { session } = useOutletContext()
  const { profile, preferences, loading, updatePreferences, updateDisplayName } = useProfile(session)
  const showToast = useToast()

  const [nameInput, setNameInput] = useState('')
  const [nameInitialized, setNameInitialized] = useState(false)
  const [newSite, setNewSite] = useState('')

  // Initialize name input when profile loads
  if (profile?.display_name && !nameInitialized) {
    setNameInput(profile.display_name)
    setNameInitialized(true)
  }

  const nameChanged = nameInitialized && nameInput !== (profile?.display_name || '')
  const tier = profile?.tier || 'free'
  const intensity = preferences.intensity || 'default'
  const annotationFont = preferences.annotation_font || 'system'
  const annotationFontSize = preferences.annotation_font_size || 'medium'
  const enabledSites = preferences.enabled_sites || []

  async function handleSaveName() {
    await updateDisplayName(nameInput.trim())
    showToast('Name updated')
  }

  async function handleIntensity(value) {
    await updatePreferences({ intensity: value })
  }

  async function handleFont(e) {
    await updatePreferences({ annotation_font: e.target.value })
  }

  async function handleFontSize(value) {
    await updatePreferences({ annotation_font_size: value })
  }

  async function handleAddSite() {
    const site = newSite.trim().toLowerCase()
    if (!site || enabledSites.includes(site)) return
    await updatePreferences({ enabled_sites: [...enabledSites, site] })
    setNewSite('')
    showToast('Site added')
  }

  async function handleRemoveSite(site) {
    await updatePreferences({ enabled_sites: enabledSites.filter((s) => s !== site) })
    showToast('Site removed')
  }

  if (loading) return null

  return (
    <div className="account-page">
      {/* Profile Section */}
      <section className="account-section">
        <h2 className="account-section-title">Profile</h2>
        <div className="account-card">
          <div className="account-field">
            <label className="account-label">Display Name</label>
            <div className="account-name-row">
              <input
                type="text"
                className="account-input"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Your name"
              />
              {nameChanged && (
                <button className="account-save-btn" onClick={handleSaveName}>
                  Save
                </button>
              )}
            </div>
          </div>

          <div className="account-field">
            <label className="account-label">Email</label>
            <span className="account-value">{session.user.email}</span>
          </div>

          <div className="account-field">
            <label className="account-label">Tier</label>
            <div className="account-tier-row">
              <span className={`account-tier-badge account-tier-badge--${tier}`}>
                {tier.toUpperCase()}
              </span>
              {tier === 'free' && (
                <a
                  href="https://oddity1.com/plans"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="account-upgrade-link"
                >
                  Get Pro
                </a>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Annotation Settings Section */}
      <section className="account-section">
        <h2 className="account-section-title">Annotation Settings</h2>
        <div className="account-card">
          {/* Density */}
          <div className="account-field">
            <label className="account-label">Density</label>
            <div className="pill-group">
              {['light', 'default', 'heavy'].map((v) => (
                <button
                  key={v}
                  className={`pill ${intensity === v ? 'pill--active' : ''}`}
                  onClick={() => handleIntensity(v)}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Font */}
          <div className="account-field">
            <label className="account-label">Font</label>
            <select className="account-select" value={annotationFont} onChange={handleFont}>
              {FONT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Font Size */}
          <div className="account-field">
            <label className="account-label">Font Size</label>
            <div className="pill-group">
              {['small', 'medium', 'large'].map((v) => (
                <button
                  key={v}
                  className={`pill ${annotationFontSize === v ? 'pill--active' : ''}`}
                  onClick={() => handleFontSize(v)}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Enabled Sites */}
          <div className="account-field">
            <label className="account-label">Enabled Sites</label>
            <div className="sites-list">
              {enabledSites.map((site) => (
                <span key={site} className="site-tag">
                  {site}
                  <button className="site-tag-remove" onClick={() => handleRemoveSite(site)}>
                    &times;
                  </button>
                </span>
              ))}
            </div>
            <div className="sites-add-row">
              <input
                type="text"
                className="account-input"
                value={newSite}
                onChange={(e) => setNewSite(e.target.value)}
                placeholder="example.com"
                onKeyDown={(e) => e.key === 'Enter' && handleAddSite()}
              />
              <button className="account-save-btn" onClick={handleAddSite}>
                Add
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
