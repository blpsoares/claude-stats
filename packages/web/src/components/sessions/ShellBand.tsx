/**
 * ShellBand — a real shell, in the selected session's own folder, docked as the LAST band of the
 * session panel.
 *
 * It is called **Shell**, not Terminal, and that is not fussiness: the session header already
 * carries a `Chat | Terminal` toggle, and that "Terminal" is the ASSISTANT'S own screen — the tmux
 * pane `claude` is drawing in, where a permission dialog is answered. Two controls named Terminal
 * on one panel, doing different things, is an ambiguity nobody untangles on their own.
 *
 * ## What is reused, and what is new
 *
 * Everything that renders and drives a tmux pane in this browser already exists and is already
 * hardened: `SessionTerminal` (the lazily-chunked xterm), `useTerminalStream` (SSE + the honesty
 * line), `useTerminalWrite` (the ordered WS write channel with its per-key acks). This component
 * points all three at the SHELL scope — `lib/terminalEndpoint.ts` owns which routes that means —
 * and adds the two things a shell needs that a session does not: the band geometry, and the mobile
 * key strip.
 *
 * ## The unwatch discipline
 *
 * The capture loop runs ONLY while the band is open, this session is the selected one, and the
 * document is visible. It is the only per-second cost this feature has, and it is `shellWatching`'s
 * one job; `useTerminalStream(null)` is what actually drops the subscription, after which the
 * server's hub stops capturing as its last reader leaves. Collapsing the band, switching session
 * (the component is keyed by session, so it unmounts) or backgrounding the tab all stop it.
 *
 * ## Consent
 *
 * There is no arm/disarm here, unlike the fleet terminal's composer. OPENING the shell is the
 * consent — a person pressed a button that spawned `$SHELL` in a directory they named — and the
 * server refused the whole route unless `CAPS.localShell` and the `shellEnabled` switch both stand.
 * A second gate on top of that would be ceremony, not safety.
 *
 * ## Refusals
 *
 * `/api/shell/open` answers a REFUSAL as a 200 carrying a sentence (`no-tmux`, `no-cwd`,
 * `cwd-missing`, `at-cap`) — shown verbatim, never re-worded here. The route-level errors upstream
 * of it (`shell_disabled`, `shell_central`) carry a CODE and no prose, and `shellErrorText` is the
 * one place that turns those into sentences. A blank band is never an answer.
 */

import { Suspense, lazy, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  ChevronDown, ChevronUp, ChevronLeft, Loader2, RotateCcw, TerminalSquare, Trash2,
} from 'lucide-react'
import { useDocumentVisible } from '../../hooks/useDocumentVisible'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useTerminalStream } from '../../hooks/useTerminalStream'
import { useTerminalWrite } from '../../hooks/useTerminalWrite'
import {
  BAND_MIN_PX, clampBandHeight, readBandPrefs, shellApiUrl, shellErrorText, shellWatching,
  shellWhere, writeBandPrefs,
} from '../../lib/shellBand'
import {
  INITIAL_SHELL_BAND, shellBandReducer, shellResolveWanted, type OpenShell,
} from '../../lib/shellBandState'
import { SHELL_STRIP, ctrlKeyFor, keyBytes, stripKeyLabel } from '../../lib/shellKeys'
import { terminalStatus } from '../../lib/terminalStream'

const SessionTerminal = lazy(() => import('../SessionTerminal'))

interface T {
  title: string
  open: string
  opening: string
  close: string
  collapse: string
  expand: string
  toggleBar: string
  back: string
  ctrlHint: string
  ctrlRefused: (c: string) => string
  resize: string
  retry: string
}

const TXT: Record<'pt' | 'en', T> = {
  en: {
    title: 'Shell',
    open: 'Open a shell here',
    opening: 'Opening…',
    close: 'End this shell',
    collapse: 'Collapse the shell',
    expand: 'Expand the shell',
    toggleBar: 'Open or collapse the shell',
    back: 'Back to the session',
    ctrlHint: 'ctrl is armed — press a letter',
    ctrlRefused: c => `ctrl+${c} is not one of the keys this channel sends.`,
    resize: 'Drag to resize the shell',
    retry: 'Try again',
  },
  pt: {
    title: 'Shell',
    open: 'Abrir um shell aqui',
    opening: 'Abrindo…',
    close: 'Encerrar este shell',
    collapse: 'Recolher o shell',
    expand: 'Expandir o shell',
    toggleBar: 'Abrir ou recolher o shell',
    back: 'Voltar para a sessão',
    ctrlHint: 'ctrl armado — pressione uma letra',
    ctrlRefused: c => `ctrl+${c} não é uma das teclas que este canal envia.`,
    resize: 'Arraste para redimensionar o shell',
    retry: 'Tentar de novo',
  },
}

export interface ShellBandProps {
  /** The fleet row this shell belongs to. Its `cwd` is the server's to read — never sent from here. */
  sessionId: string
  /** Shown in the band's title, so it is obvious WHERE the shell was opened. */
  cwd?: string
  lang: 'pt' | 'en'
  theme: 'dark' | 'light'
}

export function ShellBand({ sessionId, cwd, lang, theme }: ShellBandProps) {
  const t = TXT[lang]
  const isMobile = useIsMobile()
  const documentVisible = useDocumentVisible()

  const [prefs, setPrefs] = useState(() => readBandPrefs())
  // THE MACHINE, not a pile of flags. See `shellBandState.ts` for the rule it enforces.
  const [band, dispatch] = useReducer(shellBandReducer, INITIAL_SHELL_BAND, init =>
    readBandPrefs().open ? shellBandReducer(init, { type: 'openBand' }) : init)
  const shell = band.shell
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [ctrlNote, setCtrlNote] = useState<string | null>(null)

  const setBand = useCallback((next: Partial<{ open: boolean; height: number }>) => {
    setPrefs(p => {
      const merged = { ...p, ...next }
      writeBandPrefs(merged)
      return merged
    })
    if (next.open === true) dispatch({ type: 'openBand' })
    if (next.open === false) dispatch({ type: 'closeBand' })
  }, [])

  /**
   * Resolve THIS session's shell: reuse the one already running for it, else open one.
   *
   * A shell lives until it is closed — it survives switching session, reloading the page and closing
   * the browser — so the list is asked first. Opening blind would mint a second shell per reload and
   * walk into the ceiling with seven copies of one directory.
   *
   * The effect is driven by ONE fact, `shellResolveWanted(band)`, and every exit dispatches: an
   * abandoned attempt goes back to `wanted` rather than leaving the band spinning on work nobody is
   * doing. That is the whole reason the machine exists — see `shellBandState.ts`.
   */
  // DEPENDS ON `band.attempt` AND NOT ON `band`. The effect dispatches, and an effect that depends
  // on what it dispatches cancels its own request on the very next render — the loop that made this
  // band spin on "Abrindo…". `attempt` moves only when a PERSON opens or retries.
  const wanted = shellResolveWanted(band)
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  useEffect(() => {
    if (!wantedRef.current) return
    let cancelled = false
    dispatch({ type: 'resolving' })
    void (async () => {
      try {
        const listed = await fetch(shellApiUrl('/api/shell/list', lang))
        if (listed.ok) {
          const body = await listed.json() as { shells?: (OpenShell & { sessionId?: string })[] }
          const mine = (body.shells ?? []).find(sh => sh.sessionId === sessionId)
          if (mine) { if (!cancelled) dispatch({ type: 'resolved', shell: { id: mine.id, cwd: mine.cwd } }); return }
        } else {
          const body = await listed.json().catch(() => ({})) as { error?: string }
          if (body.error) { if (!cancelled) dispatch({ type: 'refused', message: shellErrorText(body.error, lang) }); return }
        }
        const res = await fetch(shellApiUrl('/api/shell/open', lang), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const body = await res.json().catch(() => ({})) as {
          ok?: boolean; shell?: OpenShell; message?: string; error?: string
        }
        if (cancelled) return
        // A REFUSAL arrives as a sentence the server composed; it is shown verbatim. A route-level
        // error carries only a code, and `shellErrorText` is the one place that words those.
        if (body.ok && body.shell) dispatch({ type: 'resolved', shell: body.shell })
        else if (body.message) dispatch({ type: 'refused', message: body.message })
        else dispatch({ type: 'refused', message: shellErrorText(body.error ?? 'network', lang) })
      } catch {
        if (!cancelled) dispatch({ type: 'refused', message: shellErrorText('network', lang) })
      }
    })()
    // An abandoned attempt is NOT a failure and NOT a silence: it returns to `wanted`, so the next
    // render asks again instead of leaving a spinner over nothing.
    return () => { cancelled = true; dispatch({ type: 'cancelled' }) }
  }, [band.attempt, sessionId, lang])

  const watching = shellWatching({
    bandOpen: prefs.open,
    sessionSelected: Boolean(sessionId),
    documentVisible,
  })
  // `null` is what DROPS the subscription — the client half of the unwatch discipline.
  const { state } = useTerminalStream(watching && shell ? shell.id : null, 'shell')
  const write = useTerminalWrite(shell?.id ?? '', watching && Boolean(shell), lang, 'shell')
  // `'shell'`: the honesty line must say whose screen this is. The default subject calls it "the
  // agent's current screen", which over a shell the person opened themselves is simply false.
  const status = terminalStatus(state, lang, 'shell')

  /**
   * One send path for everything.
   *
   * A strip press produces the same bytes a real keypress would (`keyBytes`) and goes through the
   * same `send`, so `splitInput`'s allowlist judges both identically — a key it would refuse cannot
   * reach the wire by a side door. `ctrl` is a STICKY modifier because a soft keyboard has no chord
   * to hold: it arms, and the next single character becomes the control key instead.
   */
  const send = useCallback((data: string) => {
    if (ctrlArmed) {
      setCtrlArmed(false)
      const key = ctrlKeyFor(data)
      if (!key) { setCtrlNote(t.ctrlRefused(data)); return }
      setCtrlNote(null)
      write.send(keyBytes(key))
      return
    }
    write.send(data)
  }, [ctrlArmed, write, t])

  const pressStrip = useCallback((id: string) => {
    const entry = SHELL_STRIP.find(e => e.id === id)
    if (!entry) return
    if (entry.kind === 'modifier') { setCtrlNote(null); setCtrlArmed(a => !a); return }
    setCtrlArmed(false)
    write.send(keyBytes(entry.key))
  }, [write])

  const close = useCallback(async () => {
    if (!shell) return
    const id = shell.id
    dispatch({ type: 'ended' })
    setBand({ open: false })
    await fetch(shellApiUrl('/api/shell/close', lang), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => {})
  }, [shell, setBand, lang])

  // ---- the drag handle -----------------------------------------------------------------------
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const onDragStart = (clientY: number) => { dragRef.current = { startY: clientY, startH: prefs.height } }
  useEffect(() => {
    if (isMobile) return
    const move = (clientY: number) => {
      const d = dragRef.current
      if (!d) return
      // The band grows UPWARD: it is docked at the bottom, so dragging up must make it taller.
      setBand({ height: clampBandHeight(d.startH + (d.startY - clientY), window.innerHeight) })
    }
    const onMouse = (e: MouseEvent) => move(e.clientY)
    const onTouch = (e: TouchEvent) => { const p = e.touches[0]; if (p) move(p.clientY) }
    const end = () => { dragRef.current = null }
    window.addEventListener('mousemove', onMouse)
    window.addEventListener('mouseup', end)
    window.addEventListener('touchmove', onTouch)
    window.addEventListener('touchend', end)
    return () => {
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('mouseup', end)
      window.removeEventListener('touchmove', onTouch)
      window.removeEventListener('touchend', end)
    }
  }, [isMobile, setBand])

  const where = shellWhere(cwd)

  const screen = (
    <div style={{
      flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden',
      border: '1px solid var(--border-subtle)',
      background: theme === 'light' ? '#ffffff' : '#0e1116',
    }}>
      <Suspense fallback={<div style={{ padding: 12, fontSize: 12, fontFamily: 'monospace', color: 'var(--text-tertiary)' }}>
        {lang === 'pt' ? 'Carregando o emulador…' : 'Loading the emulator…'}
      </div>}>
        {/* key={shell.id}: a new shell gets a brand-new emulator, so no content leaks across. */}
        <SessionTerminal
          key={shell?.id ?? 'none'}
          frame={state.frame}
          theme={theme}
          showCursor={status.showCursor}
          interactive={write.ready}
          onInput={send}
        />
      </Suspense>
    </div>
  )

  /** The one sentence the band always has: a refusal, a delivery failure, or what is on screen. */
  const line = band.message ?? (write.reason ? write.reason : band.phase === 'opening' ? t.opening : status.detail)
  const lineIsBad = Boolean(band.message || write.reason)
  const busy = band.phase === 'opening'

  const notice = (
    <div
      role={lineIsBad ? 'status' : undefined}
      style={{
        fontSize: 11, lineHeight: 1.5, flexShrink: 0,
        color: lineIsBad ? 'var(--accent-red)' : 'var(--text-tertiary)',
      }}
    >
      {ctrlArmed ? t.ctrlHint : ctrlNote ?? line}
      {/* A refusal is a DEAD STOP by design — the band never retries a "no" on its own — so the way
          forward has to be on screen. Without it a refused band is a sentence and nothing else. */}
      {band.phase === 'refused' && (
        <button
          onClick={() => dispatch({ type: 'retry' })}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8,
            minHeight: isMobile ? 44 : 22, padding: isMobile ? '0 12px' : '0 8px',
            borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
            border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
          }}
        >
          <RotateCcw size={11} />
          {t.retry}
        </button>
      )}
    </div>
  )

  const strip = (
    <div style={{
      display: 'flex', gap: 6, flexShrink: 0, overflowX: 'auto',
      paddingBottom: 'var(--safe-bottom)',
    }}>
      {SHELL_STRIP.map(entry => {
        const armed = entry.kind === 'modifier' && ctrlArmed
        return (
          <button
            key={entry.id}
            onClick={() => pressStrip(entry.id)}
            aria-pressed={entry.kind === 'modifier' ? ctrlArmed : undefined}
            style={{
              // 44px is the MOBILE figure, and this strip exists only on mobile.
              minWidth: 44, minHeight: 44, flexShrink: 0,
              borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 14, fontWeight: 600,
              border: `1px solid ${armed ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
              background: armed ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
              color: armed ? '#fff' : 'var(--text-secondary)',
            }}
          >
            {stripKeyLabel(entry.id)}
          </button>
        )
      })}
    </div>
  )

  // ---- mobile: a full-screen sheet over the session --------------------------------------------
  if (isMobile) {
    if (!prefs.open) {
      return (
        <button
          onClick={() => setBand({ open: true })}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            minHeight: 44, padding: '0 12px', flexShrink: 0,
            borderTop: '1px solid var(--border)', border: 'none',
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <TerminalSquare size={16} />
          <span>{t.title}</span>
          {where && <span style={{
            minWidth: 0, flex: 1, textAlign: 'right', fontSize: 11, color: 'var(--text-tertiary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{where}</span>}
        </button>
      )
    }
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', flexDirection: 'column',
        background: 'var(--bg-base)',
        paddingTop: 'var(--safe-top)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 10px',
          borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)', flexShrink: 0,
        }}>
          <button
            onClick={() => setBand({ open: false })}
            aria-label={t.back}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 44, height: 44, flexShrink: 0, marginLeft: -6,
              border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
            }}
          >
            <ChevronLeft size={20} />
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>{t.title}</div>
            {where && <div style={{
              fontSize: 10.5, color: 'var(--text-tertiary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{where}</div>}
          </div>
          {shell && (
            <button
              onClick={() => { void close() }}
              aria-label={t.close}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 44, height: 44, flexShrink: 0,
                border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
              }}
            >
              <Trash2 size={18} />
            </button>
          )}
        </div>
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 10,
        }}>
          {shell ? screen : <div style={{ flex: 1 }} />}
          {notice}
          {strip}
        </div>
      </div>
    )
  }

  // ---- desktop: the last band of the panel, under the composer ---------------------------------
  return (
    <div style={{
      flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderTop: '1px solid var(--border)', background: 'var(--bg-surface)',
    }}>
      {/* The drag handle sits on the band's TOP edge — the VS Code geometry, where the panel is
          always the bottom-most strip. It is `role="separator"` and takes the arrow keys, so the
          band is resizable without a pointer. */}
      {prefs.open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t.resize}
          tabIndex={0}
          onMouseDown={e => { e.preventDefault(); onDragStart(e.clientY) }}
          onKeyDown={e => {
            if (e.key === 'ArrowUp') { e.preventDefault(); setBand({ height: clampBandHeight(prefs.height + 24, window.innerHeight) }) }
            if (e.key === 'ArrowDown') { e.preventDefault(); setBand({ height: clampBandHeight(prefs.height - 24, window.innerHeight) }) }
          }}
          style={{ height: 6, cursor: 'ns-resize', background: 'transparent' }}
        />
      )}
      {/* THE WHOLE BAR IS THE TOGGLE. A 26px chevron at the far right of a full-width strip is a
          target you have to aim at, and the strip beside it did nothing at all — so the bar takes
          the click and the chevron stays as the thing that NAMES the gesture. `role="button"`
          rather than a real one: it contains buttons, and nesting them is invalid HTML. The
          controls inside it stop propagation, or ending a shell would also collapse the band. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={prefs.open}
        aria-label={t.toggleBar}
        onClick={() => setBand({ open: !prefs.open })}
        onKeyDown={e => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          setBand({ open: !prefs.open })
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', minHeight: 32,
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{ color: 'var(--anthropic-orange)', display: 'inline-flex' }}><TerminalSquare size={14} /></span>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, color: 'var(--text-secondary)' }}>
          {t.title.toUpperCase()}
        </span>
        {where && <span style={{
          minWidth: 0, flex: 1, fontSize: 11, color: 'var(--text-tertiary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{where}</span>}
        {!where && <span style={{ flex: 1 }} />}
        {busy && <Loader2 size={13} className="ag-spin" style={{ color: 'var(--text-tertiary)' }} />}
        {prefs.open && shell && (
          <button className="ag-tap-icon"
            /* A TRASH CAN, not an ✕. The ✕ read as "close this panel" next to a chevron that
               actually closes the panel, and this one KILLS the shell — a different, irreversible
               act. The icon is the only thing saying which of the two you are about to do. */
            onClick={e => { e.stopPropagation(); void close() }}
            title={t.close}
            aria-label={t.close}
            style={iconBtn}
          >
            <Trash2 size={13} />
          </button>
        )}
        <button className="ag-tap-icon"
          onClick={e => { e.stopPropagation(); setBand({ open: !prefs.open }) }}
          title={prefs.open ? t.collapse : t.expand}
          aria-label={prefs.open ? t.collapse : t.expand}
          style={iconBtn}
        >
          {prefs.open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>
      {prefs.open && (
        <div style={{
          height: Math.max(BAND_MIN_PX, prefs.height),
          display: 'flex', flexDirection: 'column', gap: 6, padding: '0 12px 10px',
        }}>
          {shell ? screen : <div style={{ flex: 1 }} />}
          {notice}
        </div>
      )}
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 22, flexShrink: 0, borderRadius: 6, padding: 0,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)', cursor: 'pointer',
}
