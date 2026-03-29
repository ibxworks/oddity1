import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const searchParams =
  typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
const hashParams =
  typeof window !== 'undefined'
    ? new URLSearchParams(
        window.location.hash.startsWith('#')
          ? window.location.hash.slice(1)
          : window.location.hash,
      )
    : null
const hasRecoveryUrlParams =
  (typeof window !== 'undefined' && window.location.pathname === '/reset-password') ||
  searchParams?.get('type') === 'recovery' ||
  hashParams?.get('type') === 'recovery' ||
  searchParams?.has('token_hash') ||
  hashParams?.has('access_token') ||
  hashParams?.has('refresh_token')

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: !hasRecoveryUrlParams,
    persistSession: true,
  },
})

export const passwordResetSupabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    flowType: 'implicit',
    detectSessionInUrl: false,
    persistSession: false,
    autoRefreshToken: false,
  },
})
