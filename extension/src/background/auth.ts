import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
  type SupportedStorage,
} from "@supabase/supabase-js";

// ─── Supabase Configuration ───
// Replace with real values before production
const SUPABASE_URL = "https://gmmektzvvrtttszdgiai.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdtbWVrdHp2dnJ0dHRzemRnaWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3MzQyNzYsImV4cCI6MjA4NzMxMDI3Nn0.aFzJcKC4dHgSz7TuQFR-4ZjnVMNQZAycWYkXg1UHKKY";

// ─── Chrome Storage Adapter for Service Workers ───
// Service workers have NO localStorage. We use chrome.storage.session
// for the access token (ephemeral) and chrome.storage.local for the
// refresh token (persisted across restarts).

const STORAGE_KEY_PREFIX = "oddity-auth-";

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

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.access_token ?? null;
}

export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
) {
  return supabase.auth.onAuthStateChange(callback);
}
