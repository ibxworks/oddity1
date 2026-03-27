import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import AuthForm from "./components/AuthForm";
import Layout from "./components/Layout";
import ResetPassword from "./components/ResetPassword";
import { supabase } from "./lib/supabase";
import AccountPage from "./pages/AccountPage";
import ArchivePage from "./pages/ArchivePage";
import DocumentsPage from "./pages/DocumentsPage";
import EditorPage from "./pages/EditorPage";
import { clearAuthCookie, setAuthCookie } from "./utils/authCookie";

const DEFAULT_ENABLED_SITES = ['chatgpt.com', 'chat.openai.com', 'claude.ai'];

async function syncProfile(session) {
  const { data: existing } = await supabase
    .from('profiles')
    .select('id, display_name, preferences')
    .eq('id', session.user.id)
    .single();

  // Resolve display_name: auth metadata → localStorage cache → null
  let displayName =
    session.user.user_metadata?.display_name ??
    session.user.user_metadata?.full_name ??
    session.user.user_metadata?.name ??
    null;

  if (!displayName) {
    try {
      const cached = JSON.parse(localStorage.getItem('pending_display_name') || 'null');
      if (cached && cached.email === session.user.email && cached.displayName) {
        displayName = cached.displayName;
        localStorage.removeItem('pending_display_name');
      }
    } catch { /* ignore */ }
  }

  if (!existing) {
    // Profile row missing (trigger didn't fire) — create it
    await supabase.from('profiles').upsert(
      {
        id: session.user.id,
        display_name: displayName,
        preferences: { enabled_sites: DEFAULT_ENABLED_SITES },
      },
      { onConflict: 'id' },
    );
  } else if (!existing.display_name && displayName) {
    // Profile exists but display_name is null — update it
    await supabase
      .from('profiles')
      .update({ display_name: displayName })
      .eq('id', session.user.id);
  }
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);

  useEffect(() => {
    // 1. Subscribe to auth changes FIRST (Supabase recommended pattern)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (_event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true);
      }

      // Set session IMMEDIATELY — never block on profile operations
      if (session) setAuthCookie();
      else clearAuthCookie();
      setSession(session);
      setLoading(false); // safety net if getSession was slow

      // Profile sync in background — fire-and-forget
      if (_event === 'SIGNED_IN' && session) {
        syncProfile(session).catch(err =>
          console.warn('[Auth] Profile sync failed:', err),
        );
      }
    });

    // 2. THEN get existing session (with error handling)
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        if (session) setAuthCookie();
        else clearAuthCookie();
        setSession(session);
      })
      .catch(err => {
        console.error('[Auth] getSession failed:', err);
        clearAuthCookie();
        setSession(null); // graceful fallback → shows AuthForm
      })
      .finally(() => {
        setLoading(false); // ALWAYS unblocks rendering
      });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="app-loading">
        <img src="/Oddity1-Logo.png" alt="Oddity1" className="app-loading-logo-img" />
      </div>
    );
  }

  if (!session) return <AuthForm />;

  if (recoveryMode) return <ResetPassword onComplete={() => setRecoveryMode(false)} />;

  return (
    <Routes>
      <Route path="/documents/:id" element={<EditorPage session={session} />} />
      <Route element={<Layout session={session} />}>
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/settings" element={<AccountPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/" element={<Navigate to="/archive" replace />} />
        <Route path="*" element={<Navigate to="/archive" replace />} />
      </Route>
    </Routes>
  );
}
