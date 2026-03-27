import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-loading">
          <div style={{ textAlign: 'center' }}>
            <img src="/Oddity1-Logo.png" alt="Oddity1" className="app-loading-logo-img" style={{ marginBottom: '16px' }} />
            <p style={{
              color: 'var(--text-secondary)',
              fontSize: '14px',
              marginBottom: '20px',
            }}>
              Something went wrong.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 20px',
                borderRadius: 'var(--r)',
                border: '1px solid var(--border-light)',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontSize: '13px',
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
