import React from 'react'
import { clearDataCache } from '../hooks/useData'

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

/**
 * The last line of defense for the whole app. Before this existed, ANY uncaught render error
 * (e.g. a malformed date in statsCache reaching `parseISO`) unmounted the entire React tree —
 * no message, just the bare `--bg-base` background. One bad record from an external file must
 * never look indistinguishable from "the app failed to start".
 */
export class RootErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[agentistics] uncaught render error', error, info.componentStack)
  }

  override render() {
    if (!this.state.error) return this.props.children

    const pt = typeof navigator !== 'undefined' && navigator.language?.startsWith('pt')
    const detail = `${this.state.error.name}: ${this.state.error.message}`

    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0a0a0f', color: 'rgba(255,255,255,0.92)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: 24,
      }}>
        <div style={{ maxWidth: 440, width: '100%', textAlign: 'center' }}>
          <div style={{
            width: 48, height: 48, borderRadius: 14, margin: '0 auto 20px',
            background: 'rgba(239,68,68,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
          </div>
          <h1 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
            {pt ? 'Algo deu errado' : 'Something went wrong'}
          </h1>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 1.6, marginBottom: 20 }}>
            {pt
              ? 'A interface encontrou um dado inesperado e não conseguiu continuar. Recarregar a página normalmente resolve.'
              : 'The interface hit unexpected data and could not continue. Reloading the page usually fixes this.'}
          </p>
          <button
            onClick={() => {
              // Clear the persisted /api/data snapshot BEFORE reloading. The most likely cause of
              // a render crash is data, and the only data that survives a reload is that snapshot —
              // so a bare reload re-read exactly the bytes that just crashed, and the button below
              // the sentence "reloading usually fixes this" fixed nothing, forever. Verified: an
              // incomplete snapshot throws in `computeDerivedStats` and every reload repeats it.
              // Dropping it costs one slower first paint and is the only thing that can recover.
              clearDataCache()
              window.location.reload()
            }}
            style={{
              padding: '9px 20px', borderRadius: 8, border: 'none',
              background: '#D97706', color: '#fff', fontSize: 13, fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit', marginBottom: 16,
            }}
          >
            {pt ? 'Recarregar' : 'Reload'}
          </button>
          <details style={{ textAlign: 'left', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
            <summary style={{ cursor: 'pointer', marginBottom: 6 }}>
              {pt ? 'Detalhes técnicos' : 'Technical details'}
            </summary>
            <pre style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace',
              background: '#16161f', border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 8, padding: 10, margin: 0,
            }}>{detail}{this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}</pre>
          </details>
        </div>
      </div>
    )
  }
}
