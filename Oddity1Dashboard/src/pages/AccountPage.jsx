import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useToast } from "../context/ToastContext";
import { useProfile } from "../hooks/useProfile";
import { supabase } from "../lib/supabase";
import {
  ALL_DEPTH_TYPES,
  ALL_OVERVIEW_TYPES,
  ANNOTATION_COLORS,
  ANNOTATION_LABELS,
  BACKEND_URL,
} from "../utils/annotationConstants";
import "./AccountPage.css";

const BLOCKED_DOMAINS = ["app.oddity1.com"];

export default function AccountPage() {
  const { session } = useOutletContext();
  const {
    profile,
    preferences,
    loading,
    updatePreferences,
    updateDisplayName,
  } = useProfile(session);
  const showToast = useToast();

  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [newSite, setNewSite] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleting, setDeleting] = useState(false);

  const tier = profile?.tier || "free";
  const displayName =
    profile?.display_name ||
    session.user.email.split("@")[0] ||
    session.user.email;
  const depthPersonality = preferences.depth_personality || "terry";
  const visibleTypes = preferences.visible_types || [
    ...ALL_OVERVIEW_TYPES,
    "user_written",
  ];
  const enabledSites = preferences.enabled_sites || [];

  function handleStartEditName() {
    setNameInput(displayName);
    setEditingName(true);
  }

  function handleCancelEditName() {
    setEditingName(false);
  }

  async function handleSaveName() {
    const name = nameInput.trim();
    if (!name) return;
    await updateDisplayName(name);
    setEditingName(false);
    showToast("Name updated");
  }

  async function handlePersonality(value) {
    await updatePreferences({ depth_personality: value });
  }

  async function handleToggleType(type) {
    const current = [...visibleTypes];
    const idx = current.indexOf(type);
    if (idx >= 0) {
      current.splice(idx, 1);
    } else {
      current.push(type);
    }
    await updatePreferences({ visible_types: current });
  }

  async function handleAddSite() {
    const site = newSite.trim().toLowerCase();
    if (!site) return;
    if (
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(
        site,
      )
    ) {
      showToast("Enter a valid domain (e.g. example.com)");
      return;
    }
    if (enabledSites.includes(site)) {
      showToast("Site already enabled");
      return;
    }
    if (BLOCKED_DOMAINS.includes(site)) {
      showToast("Cannot enable — annotations are built into the dashboard");
      return;
    }
    await updatePreferences({ enabled_sites: [...enabledSites, site] });
    setNewSite("");
    showToast("Site added");
  }

  async function handleRemoveSite(site) {
    await updatePreferences({
      enabled_sites: enabledSites.filter((s) => s !== site),
    });
    showToast("Site removed");
  }

  async function handleDeleteAccount() {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    if (deleteInput.toLowerCase() !== 'delete') {
      showToast('Type "delete" to confirm');
      return;
    }
    setDeleting(true);
    try {
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      const res = await fetch(`${BACKEND_URL}/api/user/account`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${currentSession.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to delete account');
      }
      await supabase.auth.signOut();
      window.location.href = 'https://oddity1.com';
    } catch (err) {
      showToast(err.message);
      setDeleting(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = "https://oddity1.com";
  }

  if (loading) return null;

  const allTypes = [...ALL_OVERVIEW_TYPES, ...ALL_DEPTH_TYPES];

  return (
    <div className="account-page">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      <div className="account-body">
        {/* Account Card */}
        <div className="card">
          <div className="card-title">Account</div>
          <div className="field">
            <span className="field-label">Name</span>
            {!editingName ? (
              <div className="auth-info">
                <span className="auth-email">{displayName}</span>
                <button className="btn btn-sm" onClick={handleStartEditName}>
                  Change Name
                </button>
              </div>
            ) : (
              <>
                <div className="auth-info">
                  <span className="auth-email">{displayName}</span>
                </div>
                <div className="site-input-row" style={{ marginTop: 8 }}>
                  <input
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="New display name"
                    onKeyDown={(e) => e.key === "Enter" && handleSaveName()}
                  />
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={handleSaveName}
                  >
                    Save
                  </button>
                  <button className="btn btn-sm" onClick={handleCancelEditName}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="field">
            <span className="field-label">Email</span>
            <div className="auth-detail">{session.user.email}</div>
          </div>

          <div className="field">
            <span className="field-label">Tier</span>
            <div className="auth-detail">
              {tier === "pro" ? "Pro Plan" : "Free Plan"}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Annotations</span>
            <div className="auth-detail">0</div>
          </div>

          <div className="btn-row" style={{ marginTop: 16 }}>
            {tier === "free" && (
              <a
                href="https://oddity1.com/plans"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm"
              >
                Upgrade to Pro
              </a>
            )}
            <button className="btn btn-sm btn-danger" onClick={handleSignOut}>
              Log out
            </button>
          </div>

          <div className="danger-zone">
            <span className="field-label danger-label">Danger Zone</span>
            <p className="field-hint" style={{ marginBottom: 10 }}>
              Permanently delete your account and all data. This cannot be undone.
            </p>
            {deleteConfirm && (
              <div className="site-input-row" style={{ marginTop: 8, marginBottom: 8 }}>
                <input
                  type="text"
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                  placeholder='Type "delete" to confirm'
                  onKeyDown={(e) => e.key === 'Enter' && handleDeleteAccount()}
                />
              </div>
            )}
            <button
              className="btn btn-sm btn-danger"
              onClick={handleDeleteAccount}
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : deleteConfirm ? 'Confirm Deletion' : 'Delete Account'}
            </button>
          </div>
        </div>

        {/* Auto-Enabled Sites Card */}
        <div className="card">
          <div className="card-title">Auto-Enabled Sites</div>
          <p className="field-hint" style={{ marginBottom: 12 }}>
            Oddity 1 will automatically run on these domains.
          </p>

          {enabledSites.length > 0 ? (
            <ul className="site-list">
              {enabledSites.map((site) => (
                <li key={site}>
                  {site}
                  <button
                    className="site-remove"
                    onClick={() => handleRemoveSite(site)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state-text">No sites enabled.</div>
          )}

          <div className="site-input-row">
            <input
              type="text"
              value={newSite}
              onChange={(e) => setNewSite(e.target.value)}
              placeholder="example.com"
              onKeyDown={(e) => e.key === "Enter" && handleAddSite()}
            />
            <button className="btn btn-sm btn-primary" onClick={handleAddSite}>
              Add
            </button>
          </div>
        </div>

        {/* Default Preferences Card */}
        <div className="card">
          <div className="card-title">Default Preferences</div>

          <div className="field">
            <span className="field-label">Depth Personality</span>
            <div className="radio-group">
              {["terry", "jerry", "sally"].map((p) => (
                <button
                  key={p}
                  className={`radio-btn ${depthPersonality === p ? "active" : ""}`}
                  onClick={() => handlePersonality(p)}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
            <p className="field-hint">
              Controls the personality style for Depth mode annotations.
            </p>
          </div>

          <div className="field">
            <span className="field-label">Enabled Annotation Types</span>
            <div className="checkbox-grid">
              {/* Overview types (yellow) */}
              {ALL_OVERVIEW_TYPES.map((type) => (
                <label key={type} className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={visibleTypes.includes(type)}
                    onChange={() => handleToggleType(type)}
                  />
                  <span
                    className="type-dot"
                    style={{ background: ANNOTATION_COLORS[type] || "#FFDD69" }}
                  />
                  {(ANNOTATION_LABELS[type] || type)
                    .replace(/_/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase())
                    .replace(/\bOf\b/g, "of")}
                </label>
              ))}
              {/* Depth types */}
              {ALL_DEPTH_TYPES.map((type) => (
                <label key={type} className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={visibleTypes.includes(type)}
                    onChange={() => handleToggleType(type)}
                  />
                  <span
                    className="type-dot"
                    style={{ background: ANNOTATION_COLORS[type] || "#888" }}
                  />
                  {(ANNOTATION_LABELS[type] || type)
                    .replace(/_/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase())
                    .replace(/\bOf\b/g, "of")}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
