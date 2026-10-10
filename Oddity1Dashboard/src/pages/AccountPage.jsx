import { useEffect, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { useToast } from "../context/ToastContext";
import { useProfile } from "../hooks/useProfile";
import { supabase } from "../lib/supabase";
import {
  ALL_DEPTH_TYPES,
  ALL_OVERVIEW_TYPES,
  ANNOTATION_COLORS,
  ANNOTATION_LABELS,
  BACKEND_URL,
  LLM_EFFORT_OPTIONS,
  LLM_PROVIDERS,
  LLM_PROVIDER_META,
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
    refetchProfile,
  } = useProfile(session);
  const showToast = useToast();

  const [searchParams, setSearchParams] = useSearchParams();
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [newSite, setNewSite] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [subscription, setSubscription] = useState(null);
  const [subscriptionError, setSubscriptionError] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [llmStatus, setLlmStatus] = useState(null);
  const [llmForm, setLlmForm] = useState({
    api_key: "",
    model: "",
    base_url: "",
    reasoning_effort: "default",
  });
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmStatusState, setLlmStatusState] = useState("loading");
  const [llmStatusError, setLlmStatusError] = useState("");

  const tier = profile?.tier || "free";
  const displayName =
    profile?.display_name ||
    session.user.email.split("@")[0] ||
    session.user.email;
  // Fetch subscription info
  useEffect(() => {
    if (!session?.access_token) return;
    fetch(`${BACKEND_URL}/api/subscription`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setSubscription(data);
        else setSubscriptionError(true);
      })
      .catch(() => setSubscriptionError(true));
  }, [session?.access_token]);

  // Handle ?portal_return=1 from billing portal redirect
  useEffect(() => {
    if (searchParams.get("portal_return") !== "1") return;
    setSearchParams({}, { replace: true });

    refetchProfile();
    if (!session?.access_token) return;
    fetch(`${BACKEND_URL}/api/subscription`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setSubscription(data);
          setSubscriptionError(false);
          showToast("Subscription updated.");
        } else {
          setSubscriptionError(true);
        }
      })
      .catch(() => setSubscriptionError(true));
  }, []);

  // Handle ?checkout=success from Stripe redirect
  useEffect(() => {
    if (searchParams.get("checkout") !== "success") return;
    setSearchParams({}, { replace: true });

    // Re-fetch profile and subscription so UI reflects updated tier immediately
    refetchProfile();
    if (!session?.access_token) {
      showToast("Subscription activated! Welcome to Standard.");
      return;
    }
    fetch(`${BACKEND_URL}/api/subscription`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setSubscription(data);
        showToast("Subscription activated! Welcome to Standard.");
      })
      .catch(() => showToast("Subscription activated! Welcome to Standard."));
  }, []);

  // Ignore persisted values we don't recognize: indexing provider metadata
  // with one would crash Settings.
  const rawLlmProvider = preferences.llm_provider ?? null;
  const activeLlmProvider =
    rawLlmProvider !== null && LLM_PROVIDER_META[rawLlmProvider]
      ? rawLlmProvider
      : null;
  const llmKeyStatus = activeLlmProvider
    ? (llmStatus?.keys || []).find((k) => k.provider === activeLlmProvider)
    : undefined;

  // Fetch AI provider statuses. Failures (e.g. BYOK unavailable server-side)
  // surface as an error state instead of a silently empty form.
  useEffect(() => {
    if (!session?.access_token) return;
    setLlmStatusState("loading");
    setLlmStatusError("");
    fetch(`${BACKEND_URL}/api/user/llm-keys`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            data.error || `Provider status request failed (${res.status})`,
          );
        }
        return res.json();
      })
      .then((data) => {
        setLlmStatus(data);
        setLlmStatusState("ready");
      })
      .catch((err) => {
        setLlmStatusError(err.message || "Couldn't load provider status.");
        setLlmStatusState("error");
      });
  }, [session?.access_token]);

  // Prefill the key form when the selection or statuses change
  useEffect(() => {
    setLlmForm({
      api_key: "",
      model: llmKeyStatus?.model ?? "",
      base_url: llmKeyStatus?.base_url ?? "",
      reasoning_effort: llmKeyStatus?.reasoning_effort ?? "default",
    });
  }, [activeLlmProvider, llmStatus]);

  async function handleLlmProvider(value) {
    await updatePreferences({ llm_provider: value });
  }

  async function handleLlmSave() {
    if (!activeLlmProvider || activeLlmProvider === "oddity-free") return;
    if (llmStatusState !== "ready") return;
    setLlmSaving(true);
    try {
      const body = {
        model: llmForm.model.trim(),
        base_url: llmForm.base_url.trim(),
        reasoning_effort: llmForm.reasoning_effort,
      };
      if (llmForm.api_key.trim()) body.api_key = llmForm.api_key.trim();
      const res = await fetch(
        `${BACKEND_URL}/api/user/llm-keys/${activeLlmProvider}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save key");
      }
      const updated = await res.json();
      setLlmStatus((prev) =>
        prev
          ? {
              ...prev,
              keys: prev.keys.some((k) => k.provider === updated.provider)
                ? prev.keys.map((k) =>
                    k.provider === updated.provider ? updated : k,
                  )
                : [...prev.keys, updated],
            }
          : prev,
      );
      setLlmForm((prev) => ({ ...prev, api_key: "" }));
      showToast("Provider key saved");
    } catch (err) {
      showToast(err.message);
    } finally {
      setLlmSaving(false);
    }
  }

  async function handleLlmDelete() {
    if (!activeLlmProvider || activeLlmProvider === "oddity-free") return;
    if (llmStatusState !== "ready") return;
    const label = LLM_PROVIDER_META[activeLlmProvider].label;
    if (!window.confirm(`Remove your saved ${label} key?`)) return;
    try {
      const res = await fetch(
        `${BACKEND_URL}/api/user/llm-keys/${activeLlmProvider}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove key");
      }
      const statusRes = await fetch(`${BACKEND_URL}/api/user/llm-keys`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (statusRes.ok) setLlmStatus(await statusRes.json());
      await refetchProfile();
      showToast("Provider key removed");
    } catch (err) {
      showToast(err.message);
    }
  }

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
    if (value === "sally" && tier !== "standard") {
      showToast("Sally personality requires a Standard plan");
      return;
    }
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
    if (deleteInput.toLowerCase() !== "delete") {
      showToast('Type "delete" to confirm');
      return;
    }
    setDeleting(true);
    try {
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();
      const res = await fetch(`${BACKEND_URL}/api/user/account`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${currentSession.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to delete account");
      }
      await supabase.auth.signOut();
      window.location.href = "https://oddity1.com";
    } catch (err) {
      showToast(err.message);
      setDeleting(false);
    }
  }

  async function handleManageSubscription() {
    setPortalLoading(true);
    try {
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();
      const res = await fetch(`${BACKEND_URL}/api/portal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentSession.access_token}`,
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to open billing portal");
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      showToast(err.message);
      setPortalLoading(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
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
              {tier === "standard" ? "Standard Plan" : "Free Plan"}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Usage</span>
            <div className="auth-detail">
              {subscription
                ? `${subscription.usage.count} / ${subscription.usage.limit} pages annotated this month`
                : subscriptionError
                  ? "Unable to load usage"
                  : "Loading..."}
            </div>
          </div>

          {tier === "standard" && subscription && (
            <div className="field">
              <span className="field-label">Subscription</span>
              <div className="auth-detail">
                {subscription.subscription_status === "active"
                  ? "Active"
                  : subscription.subscription_status === "past_due"
                    ? "Past due"
                    : subscription.subscription_status
                      ? subscription.subscription_status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
                      : "—"}
                {subscription.billing_interval &&
                  ` · ${subscription.billing_interval.replace(/\b\w/g, (c) => c.toUpperCase())} billing`}
              </div>
              {subscription.current_period_end && (
                <div className="auth-detail" style={{ marginTop: 4 }}>
                  {subscription.cancel_at_period_end
                    ? `Cancels on ${new Date(subscription.current_period_end).toLocaleDateString()}`
                    : `Renews ${new Date(subscription.current_period_end).toLocaleDateString()}`}
                </div>
              )}
            </div>
          )}

          {tier === "standard" && subscription?.subscription_status === "past_due" && (
            <div className="past-due-warning">
              <span>⚠ Payment failed. Update your payment method to keep your subscription.</span>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleManageSubscription}
                disabled={portalLoading}
              >
                {portalLoading ? "Redirecting..." : "Update Payment"}
              </button>
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 16 }}>
            {tier === "free" && (
              <Link to="/plans" className="btn btn-sm">
                Upgrade to Standard
              </Link>
            )}
            {tier === "standard" && (
              <button
                className="btn btn-sm"
                onClick={handleManageSubscription}
                disabled={portalLoading}
              >
                {portalLoading ? "Redirecting..." : "Manage Subscription"}
              </button>
            )}
            <button className="btn btn-sm btn-danger" onClick={handleSignOut}>
              Sign out
            </button>
          </div>

          <div className="danger-zone">
            <span className="field-label danger-label">Danger Zone</span>
            <p className="field-hint" style={{ marginBottom: 10 }}>
              Permanently delete your account and all data. This cannot be
              undone.
            </p>
            {deleteConfirm && (
              <div
                className="site-input-row"
                style={{ marginTop: 8, marginBottom: 8 }}
              >
                <input
                  type="text"
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                  placeholder='Type "delete" to confirm'
                  onKeyDown={(e) => e.key === "Enter" && handleDeleteAccount()}
                />
              </div>
            )}
            <button
              className="btn btn-sm btn-danger"
              onClick={handleDeleteAccount}
              disabled={deleting}
            >
              {deleting
                ? "Deleting..."
                : deleteConfirm
                  ? "Confirm Deletion"
                  : "Delete Account"}
            </button>
          </div>
        </div>

        {/* AI Provider Card */}
        <div className="card">
          <div className="card-title">AI Provider</div>
          <p className="field-hint" style={{ marginBottom: 12 }}>
            Use Oddity&apos;s managed model, the free shared pool, or your own
            provider keys. BYOK and Oddity Free requests don&apos;t count
            toward monthly limits.
          </p>

          <div className="field">
            <span className="field-label">Provider</span>
            <div className="radio-group">
              <button
                key="oddity"
                className={`radio-btn ${activeLlmProvider === null ? "active" : ""}`}
                onClick={() => handleLlmProvider(null)}
              >
                Oddity
              </button>
              {LLM_PROVIDERS.map((p) => (
                <button
                  key={p}
                  className={`radio-btn ${activeLlmProvider === p ? "active" : ""}`}
                  onClick={() => handleLlmProvider(p)}
                >
                  {LLM_PROVIDER_META[p].short}
                </button>
              ))}
            </div>
          </div>

          {activeLlmProvider === null && (
            <p className="field-hint">
              Oddity-managed model included with your plan. No setup needed.
            </p>
          )}

          {activeLlmProvider === "oddity-free" && (
            <p className="field-hint llm-note-warn">
              {LLM_PROVIDER_META["oddity-free"].note}
            </p>
          )}

          {activeLlmProvider !== null &&
            activeLlmProvider !== "oddity-free" && (
              <div className="llm-form">
                <p className="field-hint">
                  {LLM_PROVIDER_META[activeLlmProvider].note}{" "}
                  {LLM_PROVIDER_META[activeLlmProvider].keyUrl && (
                    <a
                      href={LLM_PROVIDER_META[activeLlmProvider].keyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Get a key
                    </a>
                  )}
                </p>
                {llmStatusState === "loading" && (
                  <p className="field-hint">Loading provider status…</p>
                )}
                {llmStatusState === "error" && (
                  <p className="field-hint llm-note-warn">
                    Provider key management is unavailable: {llmStatusError}
                  </p>
                )}
                <div className="field">
                  <span className="field-label">API key</span>
                  <input
                    type="password"
                    disabled={llmStatusState !== "ready"}
                    value={llmForm.api_key}
                    onChange={(e) =>
                      setLlmForm((prev) => ({ ...prev, api_key: e.target.value }))
                    }
                    placeholder={
                      llmKeyStatus?.configured
                        ? `Saved (${llmKeyStatus.key_hint ?? "****"}) — enter a new key to replace`
                        : "Paste API key"
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="field">
                  <span className="field-label">Model</span>
                  <input
                    type="text"
                    disabled={llmStatusState !== "ready"}
                    value={llmForm.model}
                    onChange={(e) =>
                      setLlmForm((prev) => ({ ...prev, model: e.target.value }))
                    }
                    placeholder={
                      LLM_PROVIDER_META[activeLlmProvider].modelPlaceholder ||
                      "Default model"
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="field">
                  <span className="field-label">Reasoning effort</span>
                  <select
                    disabled={
                      llmStatusState !== "ready" ||
                      !LLM_PROVIDER_META[activeLlmProvider].effortSupported
                    }
                    title={
                      LLM_PROVIDER_META[activeLlmProvider].effortSupported
                        ? undefined
                        : "Reasoning effort is not supported for this provider."
                    }
                    value={llmForm.reasoning_effort}
                    onChange={(e) =>
                      setLlmForm((prev) => ({
                        ...prev,
                        reasoning_effort: e.target.value,
                      }))
                    }
                  >
                    {LLM_EFFORT_OPTIONS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort.charAt(0).toUpperCase() + effort.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <span className="field-label">Base URL (optional)</span>
                  <input
                    type="text"
                    disabled={llmStatusState !== "ready"}
                    value={llmForm.base_url}
                    onChange={(e) =>
                      setLlmForm((prev) => ({
                        ...prev,
                        base_url: e.target.value,
                      }))
                    }
                    placeholder="Default endpoint"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                {!llmKeyStatus?.configured && (
                  <p className="field-hint">
                    Add your {LLM_PROVIDER_META[activeLlmProvider].label} API
                    key to use this provider.
                  </p>
                )}
                <div className="btn-row">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={handleLlmSave}
                    disabled={llmSaving || llmStatusState !== "ready"}
                  >
                    {llmSaving ? "Saving..." : "Save"}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={handleLlmDelete}
                    disabled={
                      !llmKeyStatus?.configured || llmStatusState !== "ready"
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
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
                  style={undefined}
                  title={p === "sally" && tier !== "standard" ? "Standard plan required" : undefined}
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
