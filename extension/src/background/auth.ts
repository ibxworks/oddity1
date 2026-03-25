import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
  type SupportedStorage,
} from "@supabase/supabase-js";
import { DEFAULT_ENABLED_SITES } from "@oddity/shared";

// ─── Supabase Configuration ───
// Replace with real values before production
const SUPABASE_URL = "https://gmmektzvvrtttszdgiai.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdtbWVrdHp2dnJ0dHRzemRnaWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3MzQyNzYsImV4cCI6MjA4NzMxMDI3Nn0.aFzJcKC4dHgSz7TuQFR-4ZjnVMNQZAycWYkXg1UHKKY";
const EXTENSION_REDIRECT_URL = `https://${chrome.runtime.id}.chromiumapp.org/`;

// ─── Chrome Storage Adapter for Service Workers ───
// Service workers have NO localStorage. We use chrome.storage.session
// for the access token (ephemeral) and chrome.storage.local for the
// refresh token (persisted across restarts).

// const STORAGE_KEY_PREFIX = "oddity-auth-";

const chromeStorageAdapter: SupportedStorage = {
  async getItem(key: string): Promise<string | null> {
    // Try session first (fast, in-memory), then local
    const sessionResult = await chrome.storage.session.get(key);
    if (sessionResult[key] !== undefined) {
      return sessionResult[key] as string;
    }
    const localResult = await chrome.storage.local.get(key);
    if (localResult[key] !== undefined) {
      return localResult[key] as string;
    }
    return null;
  },

  async setItem(key: string, value: string): Promise<void> {
    // Store in both session (fast access) and local (persistence)
    await chrome.storage.session.set({ [key]: value });
    await chrome.storage.local.set({ [key]: value });
  },

  async removeItem(key: string): Promise<void> {
    await chrome.storage.session.remove(key);
    await chrome.storage.local.remove(key);
  },
};

// ─── Supabase Client ───

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: chromeStorageAdapter,
    autoRefreshToken: true,
    persistSession: true,
    flowType: 'pkce',
  },
});

// ─── Exported Auth Functions ───

export async function getSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error("[Oddity 1] getSession error:", error.message);
    return null;
  }
  return data.session;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signUp(email: string, password: string, displayName: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
    },
  });
  if (error) throw error;
  if (data.user) {
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: data.user.id,
      display_name: displayName,
      preferences: { enabled_sites: DEFAULT_ENABLED_SITES },
    }, { onConflict: 'id' });
    if (profileError) {
      console.error('[Oddity 1] Failed to save display_name to profiles:', profileError.message);
    }
  }
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function signInWithGoogle() {
  console.log("[Oddity 1] signInWithGoogle: starting OAuth flow");
  console.log("[Oddity 1] signInWithGoogle: redirect URL =", EXTENSION_REDIRECT_URL);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: EXTENSION_REDIRECT_URL,
      skipBrowserRedirect: true,
    },
  });

  if (error || !data.url) {
    console.error("[Oddity 1] signInWithGoogle: OAuth URL error:", error?.message);
    throw error ?? new Error("Failed to get OAuth URL");
  }

  console.log("[Oddity 1] signInWithGoogle: got OAuth URL, launching web auth flow");

  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: data.url,
    interactive: true,
  });

  if (!redirectUrl) throw new Error("OAuth flow was cancelled");

  console.log("[Oddity 1] signInWithGoogle: redirect URL received:", redirectUrl.substring(0, 200));

  const url = new URL(redirectUrl);
  let sessionData;

  // Try PKCE flow first (code in query params)
  const code = url.searchParams.get("code");
  console.log("[Oddity 1] signInWithGoogle: code =", code ? `${code.substring(0, 20)}...` : "null");

  if (code) {
    console.log("[Oddity 1] signInWithGoogle: exchanging code for session (PKCE)");
    const { data: d, error: e } =
      await supabase.auth.exchangeCodeForSession(code);
    if (e) {
      console.error("[Oddity 1] signInWithGoogle: code exchange error:", e.message);
      throw e;
    }
    console.log("[Oddity 1] signInWithGoogle: code exchange successful, user:", d.user?.email);
    sessionData = d;
  } else {
    // Fall back to implicit flow (tokens in hash fragment)
    console.log("[Oddity 1] signInWithGoogle: no code, trying implicit flow (hash)");
    const hashParams = new URLSearchParams(url.hash.substring(1));
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");
    if (accessToken && refreshToken) {
      const { data: d, error: e } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (e) throw e;
      sessionData = d;
    } else {
      console.error("[Oddity 1] signInWithGoogle: no code or tokens in redirect URL");
      throw new Error(
        "No auth code or tokens in redirect URL: " + redirectUrl,
      );
    }
  }

  if (sessionData.user) {
    console.log("[Oddity 1] signInWithGoogle: ensuring profile for", sessionData.user.email);
    await ensureProfile(sessionData.user);
  }

  console.log("[Oddity 1] signInWithGoogle: complete, session established");
  return sessionData;
}

async function ensureProfile(user: { id: string; user_metadata?: Record<string, unknown> }) {
  const displayName =
    (user.user_metadata?.full_name as string) ??
    (user.user_metadata?.name as string) ??
    null;

  const { error: profileError } = await supabase.from("profiles").upsert(
    {
      id: user.id,
      display_name: displayName,
      preferences: { enabled_sites: DEFAULT_ENABLED_SITES },
    },
    { onConflict: "id", ignoreDuplicates: true },
  );

  if (profileError) {
    console.error("[Oddity 1] Failed to create profile for Google user:", profileError.message);
  }
}

export async function getProfile(): Promise<{ display_name: string | null; tier: 'free' | 'pro'; annotation_count: number } | null> {
  const session = await getSession();
  if (!session) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('display_name, tier, annotation_count')
    .eq('id', session.user.id)
    .single();

  if (error || !data) return null;
  return {
    display_name: data.display_name ?? null,
    tier: (data.tier as 'free' | 'pro') ?? 'free',
    annotation_count: (data.annotation_count as number) ?? 0,
  };
}

export async function updateProfile(displayName: string): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('profiles')
    .update({ display_name: displayName })
    .eq('id', session.user.id);

  if (error) throw error;
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.access_token ?? null;
}

/**
 * Force-refresh the session using the refresh token.
 * Returns the new access token, or null if refresh failed.
 * This is needed because getSession() only reads from storage
 * and the autoRefreshToken timer dies when the MV3 service worker suspends.
 */
export async function refreshAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) {
    console.error("[Oddity 1] refreshSession failed:", error?.message);
    return null;
  }
  return data.session.access_token;
}

export async function getUserTier(): Promise<"free" | "pro"> {
  const session = await getSession();
  if (!session) return "free";

  const { data, error } = await supabase
    .from("profiles")
    .select("tier")
    .eq("id", session.user.id)
    .single();

  if (error || !data) return "free";
  return (data.tier as "free" | "pro") ?? "free";
}

export async function getEnabledSites(): Promise<string[] | null> {
  const session = await getSession();
  if (!session) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', session.user.id)
    .single();

  if (error || !data) return null;
  const prefs = data.preferences as Record<string, unknown> | null;
  if (!prefs || !Array.isArray(prefs.enabled_sites)) return null;
  return prefs.enabled_sites as string[];
}

export async function updateEnabledSites(sites: string[]): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('Not authenticated');

  // Read-modify-write to preserve other preference keys
  const { data } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', session.user.id)
    .single();

  const existing = (data?.preferences as Record<string, unknown>) ?? {};
  const updated = { ...existing, enabled_sites: sites };

  const { error } = await supabase
    .from('profiles')
    .update({ preferences: updated })
    .eq('id', session.user.id);

  if (error) throw error;
}

export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
) {
  return supabase.auth.onAuthStateChange(callback);
}
