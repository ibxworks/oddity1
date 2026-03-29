import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const RESET_PASSWORD_REDIRECT_URL = 'https://app.oddity1.com/reset-password'
const RECOVERY_SESSION_TIMEOUT_MS = 5000
const RECOVERY_SESSION_POLL_MS = 250
const CODE_EXCHANGE_FALLBACK_MS = 1200

export default function ResetPassword({ onComplete }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [checkingLink, setCheckingLink] = useState(true)
  const [ready, setReady] = useState(false)
  const [needsResetEmail, setNeedsResetEmail] = useState(false)

  useEffect(() => {
    let mounted = true
    const timeoutIds = []

    const searchParams = new URLSearchParams(window.location.search)
    const hashParams = new URLSearchParams(
      window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash,
    )

    const hasRecoveryParams =
      searchParams.get('type') === 'recovery' ||
      hashParams.get('type') === 'recovery' ||
      searchParams.has('code') ||
      searchParams.has('token_hash') ||
      hashParams.has('access_token') ||
      hashParams.has('refresh_token')
    const code = searchParams.get('code')

    function scheduleTimeout(callback, delay) {
      const timeoutId = window.setTimeout(callback, delay)
      timeoutIds.push(timeoutId)
      return timeoutId
    }

    function finishRecoveryReady() {
      setReady(true)
      setNeedsResetEmail(false)
      setCheckingLink(false)
      setError('')
    }

    async function useExistingSession() {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!mounted) return true

      if (session) {
        finishRecoveryReady()
        return true
      }

      return false
    }

    async function verifyRecoveryLink() {
      if (await useExistingSession()) return

      if (!hasRecoveryParams) {
        setNeedsResetEmail(true)
        setCheckingLink(false)
        return
      }

      const startedAt = Date.now()
      let attemptedCodeExchange = false

      while (mounted && Date.now() - startedAt < RECOVERY_SESSION_TIMEOUT_MS) {
        if (await useExistingSession()) return

        const elapsedMs = Date.now() - startedAt
        if (code && !attemptedCodeExchange && elapsedMs >= CODE_EXCHANGE_FALLBACK_MS) {
          attemptedCodeExchange = true
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
          if (!exchangeError && (await useExistingSession())) return
        }

        await new Promise(resolve => scheduleTimeout(resolve, RECOVERY_SESSION_POLL_MS))
      }

      if (!mounted) return

      setError("This password reset link is invalid or expired. Request a new one and try again.")
      setNeedsResetEmail(true)
      setCheckingLink(false)
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return
      if (event === 'PASSWORD_RECOVERY' || (hasRecoveryParams && session)) {
        finishRecoveryReady()
      }
    })

    verifyRecoveryLink().catch(err => {
      if (!mounted) return
      setError(err.message || 'Failed to verify your reset link.')
      setNeedsResetEmail(true)
      setCheckingLink(false)
    })

    return () => {
      mounted = false
      timeoutIds.forEach(timeoutId => window.clearTimeout(timeoutId))
      subscription.unsubscribe()
    }
  }, [])

  async function handleSendResetLink(e) {
    e.preventDefault()
    if (!email.trim()) {
      setError('Enter your email first.')
      return
    }

    setLoading(true)
    setError('')
    setMessage('')

    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: RESET_PASSWORD_REDIRECT_URL,
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    setMessage('Check your email for a password reset link.')
    setLoading(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setMessage('')
    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    setMessage('Password updated successfully. Redirecting you to sign in...')
    setLoading(false)

    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) {
      console.warn('[ResetPassword] Failed to sign out recovery session:', signOutError)
    }

    onComplete()
  }

  if (checkingLink) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-header">
            <h1 className="auth-logo">Oddity<sup>1</sup></h1>
            <p className="auth-subtitle">Verifying your reset link...</p>
          </div>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-header">
            <h1 className="auth-logo">Oddity<sup>1</sup></h1>
            <p className="auth-subtitle">
              {needsResetEmail ? 'Request a reset link' : 'Reset password'}
            </p>
          </div>
          {error && <p className="auth-error">{error}</p>}
          {message && <p className="auth-message">{message}</p>}

          <form onSubmit={handleSendResetLink} className="auth-form">
            <div className="form-field">
              <label htmlFor="reset-email">Email</label>
              <input
                id="reset-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>

            <button type="submit" className="auth-button" disabled={loading}>
              {loading ? 'Sending...' : 'Send reset link'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <h1 className="auth-logo">Oddity<sup>1</sup></h1>
          <p className="auth-subtitle">Set a new password</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-field">
            <label htmlFor="new-password">New Password</label>
            <input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>

          <div className="form-field">
            <label htmlFor="confirm-password">Confirm Password</label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat your password"
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>

          {error && <p className="auth-error">{error}</p>}
          {message && <p className="auth-message">{message}</p>}

          <button type="submit" className="auth-button" disabled={loading || !!message}>
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
