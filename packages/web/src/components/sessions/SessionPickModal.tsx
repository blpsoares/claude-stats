/**
 * SessionPickModal — tick some sessions, then do one thing to all of them.
 *
 * ONE component for two features, because they differ only in where the ticks start and what the
 * button promises — see `lib/sessionPick.ts`, which holds that arithmetic and is tested apart from
 * any DOM. Two modals would be two places for the header checkbox, the count, the search and the
 * empty state to drift, and this is a screen that starts assistants or writes into them: the
 * number on the button is the last thing anybody checks.
 *
 * `send` is a TWO-STEP WIZARD — pick WHO, then write WHAT — because the prompt grew a composer of
 * its own (paste-to-attach, an attach button, a preview strip) and a session list plus a composer
 * do not both fit a 390px screen. `reopen` has no prompt and stays exactly one step; `lib/
 * sendWizard.ts` holds which steps a kind has, whether the second is reachable, and what the primary
 * button says on each — the same reasoning `sessionPick.ts` applies to the two FEATURES applies here
 * to the two STEPS of one of them. The step lives in this component's own state (never remounted
 * between steps), which is what lets the ticks, the search and the typed text all survive going
 * back and forth.
 *
 * It is built from `formBits` and wears the new-session wizard's own shell, tab strip and field.
 * A dialog that invents its own chrome reads as a different product from the one beside it.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Loader, Paperclip, RotateCcw, Search, Send, X } from 'lucide-react'
import {
  PICK_TABS, filterPickRows, initialPick, pickAllState, pickEmpty, pickTabHint,
  pickTabLabel, pickedRows, togglePick, togglePickAll,
  type PickRow, type PickTab,
} from '../../lib/sessionPick'
import { composeBroadcastText, wizardPrimaryLabel, type WizardStep } from '../../lib/sendWizard'
import { hasSomethingToSend } from '../../lib/composerAction'
import { MAX_ATTACHMENTS, attachmentRoom, planPaste } from '../../lib/pastePlan'
import { isImagePath } from '../../lib/attachmentPreview'
import { attachmentUrl } from '../../lib/attachmentUrl'
import { useIsMobile } from '../../hooks/useIsMobile'
import { overlayPadding } from '../../lib/mobileOverlay'
import { Field, Muted, TabStrip, inputStyle } from './formBits'

/**
 * A MIRROR of the server's `MAX_BROADCAST`, kept so the client does not offer what will be refused
 * — the same reason the input channel keeps a copy of the key allowlist. The server stays the
 * authority: it refuses regardless, and its refusal is what the user is shown.
 */
const MAX_BROADCAST = 12

export type PickModalRow = PickRow

interface Props {
  kind: 'reopen' | 'send'
  rows: readonly PickModalRow[]
  lang: 'pt' | 'en'
  busy?: boolean
  onClose: () => void
  /** `text` is present only for `send`. */
  onConfirm: (ids: string[], text: string) => void
}

/** One uploaded file, as the composer holds it — the same shape `SessionChat`'s own composer uses. */
interface Attachment { name: string; path: string }

export function SessionPickModal({ kind, rows, lang, busy, onClose, onConfirm }: Props) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const needsText = kind === 'send'
  const [picked, setPicked] = useState<Set<string>>(() => initialPick(rows, kind === 'reopen' ? 'all' : 'none'))
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  // Reopen has no tabs: every row in it fell, so none of them is running and "Active" would always
  // be empty. A tab that can only ever be empty is a control that teaches the wrong thing.
  const [tab, setTab] = useState<PickTab>('active')
  // `reopen` never leaves 'pick' — `wizardSteps('reopen')` is a single entry, so nothing here ever
  // asks it to advance. Kept in ONE piece of state (not remounted between screens) so the ticks, the
  // search and the typed text all survive going back and forth.
  const [step, setStep] = useState<WizardStep>('pick')
  const [attached, setAttached] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // The fleet polls every five seconds. A row that ended while this was open must not stay ticked,
  // and one that arrived must not be silently ticked into a verb the user never saw.
  useEffect(() => {
    setPicked(prev => {
      const takeable = new Set(rows.filter(r => r.enabled !== false).map(r => r.id))
      const next = new Set([...prev].filter(id => takeable.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [rows])

  useEffect(() => {
    // Escape ALWAYS closes the whole wizard, on either step — it is the modal's own exit, not the
    // step's. Going back one screen is a separate gesture (the Back button), because a person who
    // has half-written a prompt and presses Escape expects to leave, not to lose the page.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const shown = useMemo(
    () => (needsText ? filterPickRows(rows, tab, query) : filterPickRows(rows, 'all', query)),
    [rows, tab, query, needsText],
  )
  // The header box and the button count the WHOLE selection, never the filtered view: a search that
  // silently shrank what the button was about to do would be the worst kind of quiet.
  const allState = pickAllState(shown, picked)
  const chosen = useMemo(() => pickedRows(rows, picked), [rows, picked])
  const overCap = needsText && chosen.length > MAX_BROADCAST
  const primary = wizardPrimaryLabel(step, kind, chosen.length, pt)
  // On the PICK step, `send` only turns the page — busy/cap/text have nothing to do with that yet.
  // On the one step `reopen` has, and on `send`'s COMPOSE step, the button actually PERFORMS the
  // verb, so it inherits every guard the single-screen modal always had.
  const ready = step === 'pick' && kind === 'send'
    ? primary.enabled && !busy
    : primary.enabled && !busy && !overCap
      && (!needsText || hasSomethingToSend({ draft: text, attachments: attached.length }))

  async function upload(files: readonly File[]): Promise<void> {
    if (files.length === 0) return
    setUploading(true)
    for (const file of files) {
      const body = new FormData()
      body.append('file', file)
      /*
       * `session` IS OPTIONAL ON THE WIRE (see `/api/fleet/attach` in `server/index.ts`: "Absent is
       * fine — the attachment still works, it just cannot be drawn as a thumbnail in that case").
       * Its only job is letting a later `[Image #N]` marker find its file again FOR ONE SESSION —
       * `recordAttachmentSend` files it under exactly the id given. A broadcast has no single
       * session to name honestly: naming one of the N picked would make marker resolution work for
       * that one recipient and silently not for the rest, which is a worse lie than naming none. So
       * this is left BLANK on purpose — the path still reaches every session exactly as typed, it
       * just never grows a `[Image #N]` thumbnail anywhere, the same outcome as attaching from a
       * session `SessionChat` cannot link to a transcript at all.
       */
      body.append('session', '')
      try {
        const res = await fetch(`/api/fleet/attach?lang=${lang}`, { method: 'POST', body })
        const json = await res.json() as { ok: boolean; path?: string; name?: string; message?: string }
        if (json.ok && json.path && json.name) {
          setAttached(a => [...a, { name: json.name!, path: json.path! }])
        } else {
          setNotice(json.message ?? (pt ? 'O anexo falhou.' : 'The attachment failed.'))
        }
      } catch {
        setNotice(pt ? 'Erro de rede ao enviar o anexo.' : 'Network error uploading the attachment.')
      }
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  function pickFiles(list: FileList | null): void {
    if (!list) return
    const room = attachmentRoom(attached.length)
    const files = Array.from(list).slice(0, room)
    if (files.length < list.length) {
      setNotice(pt
        ? `No máximo ${MAX_ATTACHMENTS} anexos por mensagem.`
        : `At most ${MAX_ATTACHMENTS} attachments per message.`)
    }
    void upload(files)
  }

  /** Same rule the live composer uses — `planPaste.ts` decides which of the three a paste is. */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const plan = planPaste({
      files: Array.from(e.clipboardData.files),
      text: e.clipboardData.getData('text/plain'),
      existing: attached.length,
    })
    if (plan.kind === 'text') return
    e.preventDefault()
    if (plan.kind === 'files') { void upload(plan.files); return }
    if (plan.kind === 'textFile') {
      void upload([new File([plan.text], plan.name, { type: 'text/plain' })])
      setNotice(pt
        ? 'O texto colado era grande demais para digitar na sessão, então foi anexado como arquivo.'
        : 'The pasted text was too large to type into the session, so it was attached as a file.')
    }
  }

  const t = {
    title: kind === 'reopen'
      ? (pt ? 'Reabrir o que caiu' : 'Reopen what fell')
      : (pt ? 'Enviar prompt em massa' : 'Send a prompt to several sessions'),
    lead: kind === 'reopen'
      ? (pt
        ? 'Estas sessões estavam abertas quando a máquina parou. Vêm todas marcadas — desmarque as que não quiser de volta.'
        : 'These sessions were open when the machine stopped. They all start ticked — untick any you do not want back.')
      : (pt
        ? 'Escolha as sessões que vão receber o mesmo prompt. Nenhuma vem marcada: escolha uma a uma.'
        : 'Pick the sessions that will receive the same prompt. None start ticked: pick them yourself.'),
    composeLead: pt
      ? (chosen.length === 1
        ? 'O prompt vai para 1 sessão.'
        : `O prompt vai para ${chosen.length} sessões, uma de cada vez.`)
      : (chosen.length === 1
        ? 'The prompt goes to 1 session.'
        : `The prompt goes to ${chosen.length} sessions, one at a time.`),
    sessions: pt ? 'Sessões' : 'Sessions',
    prompt: pt ? 'Prompt' : 'Prompt',
    all: pt ? 'Marcar todas' : 'Tick all',
    none: pt ? 'Desmarcar todas' : 'Untick all',
    searchSessions: pt ? 'Buscar por título ou pasta…' : 'Search by title or folder…',
    placeholder: pt ? 'O prompt que cada sessão vai receber…' : 'The prompt each session will receive…',
    cancel: pt ? 'Cancelar' : 'Cancel',
    back: pt ? 'Voltar' : 'Back',
    attach: pt ? 'Anexar arquivo' : 'Attach file',
    attachNote: pt
      ? 'gravados nesta máquina; o caminho vai na mensagem'
      : 'stored on this machine; the path goes in the message',
    cap: pt
      ? `No máximo ${MAX_BROADCAST} de uma vez — ${chosen.length} marcadas.`
      : `At most ${MAX_BROADCAST} at a time — ${chosen.length} ticked.`,
    chosenNote: pt
      ? `${chosen.length} marcada${chosen.length === 1 ? '' : 's'} no total`
      : `${chosen.length} ticked in total`,
  }

  const tap = isMobile ? 44 : 30

  return (
    <div
      onClick={() => { if (!busy) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 620,
        background: 'var(--ag-scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        // The status bar is not padding we may spend — see `overlayPadding`.
        padding: overlayPadding(isMobile, 20),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t.title}
        style={{
          background: 'var(--bg-surface)',
          border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 16,
          width: '100%', maxWidth: isMobile ? '100%' : 560,
          height: isMobile ? '100%' : undefined, maxHeight: isMobile ? '100%' : '86vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          {/* Only on the compose step — the pick step's own way out is the X, exactly as before. */}
          {step === 'compose' && (
            <button
              onClick={() => !busy && setStep('pick')}
              aria-label={t.back}
              title={t.back}
              style={{
                display: 'flex', width: tap, height: tap, alignItems: 'center', justifyContent: 'center',
                borderRadius: 8, border: 'none', background: 'transparent', flexShrink: 0,
                color: 'var(--text-tertiary)', cursor: busy ? 'default' : 'pointer',
              }}
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
            {t.title}
          </h2>
          <button
            onClick={onClose}
            aria-label={t.cancel}
            style={{
              display: 'flex', width: tap, height: tap, alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </header>

        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 20px',
        }}>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
            {step === 'compose' ? t.composeLead : t.lead}
          </p>

          {step === 'pick' && (
          <Field label={t.sessions}>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--text-tertiary)', pointerEvents: 'none',
              }} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t.searchSessions}
                // 16px on mobile or iOS Safari zooms the viewport and breaks the sticky header.
                style={{ ...inputStyle, ...(isMobile ? { fontSize: 16 } : {}) }}
              />
            </div>

            {needsText && (
              <>
                <TabStrip
                  tabs={PICK_TABS}
                  value={tab}
                  onPick={setTab}
                  label={id => pickTabLabel(id, pt)}
                  count={id => filterPickRows(rows, id, query).length}
                />
                <p style={{ margin: '0 0 2px', fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                  {pickTabHint(tab, pt)}
                </p>
              </>
            )}

            {shown.length > 0 && (
              <label style={{
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                minHeight: isMobile ? 44 : undefined,
              }}>
                <input
                  type="checkbox"
                  checked={allState === 'all'}
                  ref={el => { if (el) el.indeterminate = allState === 'some' }}
                  onChange={() => setPicked(togglePickAll(shown, picked))}
                  style={{ width: 15, height: 15, accentColor: 'var(--anthropic-orange)', cursor: 'pointer' }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {allState === 'all' ? t.none : t.all}
                </span>
                {/* The total, because the header box acts on the FILTERED view and the button counts
                    the whole selection — without this the two numbers look like a bug. */}
                {chosen.length > 0 && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {t.chosenNote}
                  </span>
                )}
              </label>
            )}

            <div style={{
              maxHeight: isMobile ? undefined : 220, overflowY: 'auto',
              display: 'flex', flexDirection: 'column', gap: 4,
              border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 6,
            }}>
              {shown.length === 0 ? (
                <Muted text={pickEmpty(needsText ? tab : 'all', query, rows.length > 0, pt)} />
              ) : shown.map(row => {
                const off = row.enabled === false
                const on = picked.has(row.id)
                return (
                  <label
                    key={row.id}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 9,
                      cursor: off ? 'default' : 'pointer', opacity: off ? 0.55 : 1,
                      padding: '9px 10px', borderRadius: 8,
                      minHeight: isMobile ? 44 : undefined,
                      border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
                      background: on ? 'var(--bg-elevated)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={off}
                      onChange={() => setPicked(togglePick(picked, row.id))}
                      style={{
                        width: 15, height: 15, marginTop: 2, flexShrink: 0,
                        accentColor: 'var(--anthropic-orange)', cursor: off ? 'default' : 'pointer',
                      }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{
                        display: 'block', fontSize: 12.5, color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {row.title}
                      </span>
                      {row.detail && (
                        <span style={{
                          display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {row.detail}
                        </span>
                      )}
                      {/* WHY it cannot be picked. A disabled row that says nothing is
                          indistinguishable from a broken one. */}
                      {off && row.reason && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3, fontStyle: 'italic' }}>
                          {row.reason}
                        </span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </Field>
          )}

          {step === 'compose' && (
            <>
              {/* WHO it is going to — read-only here, on purpose: changing the list is Back's job,
                  and a second way to edit the same set from this screen is a second place for the
                  two to disagree about what "chosen" means. */}
              <Field label={t.sessions}>
                <div style={{
                  maxHeight: 96, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2,
                  border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '6px 10px',
                }}>
                  {chosen.map(row => (
                    <span key={row.id} style={{
                      fontSize: 12, color: 'var(--text-secondary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {row.title}
                    </span>
                  ))}
                </div>
              </Field>

              <Field label={t.prompt}>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onPaste={onPaste}
                  placeholder={t.placeholder}
                  rows={3}
                  style={{
                    ...inputStyle, paddingLeft: 12, resize: 'vertical', lineHeight: 1.5,
                    ...(isMobile ? { fontSize: 16 } : {}),
                  }}
                />

                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  onChange={e => pickFiles(e.target.files)}
                  style={{ display: 'none' }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    aria-label={t.attach}
                    title={t.attach}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: tap, height: tap, borderRadius: 9, border: 'none', flexShrink: 0,
                      background: 'transparent', color: 'var(--text-tertiary)',
                      cursor: uploading ? 'default' : 'pointer',
                    }}
                  >
                    {uploading ? <Loader size={15} className="ag-working-spin" /> : <Paperclip size={15} />}
                  </button>
                </div>

                {attached.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {attached.map(a => isImagePath(a.path) ? (
                      <span key={a.path} title={a.name} style={{
                        position: 'relative', display: 'block', width: 48, height: 48,
                        borderRadius: 8, overflow: 'hidden', flexShrink: 0,
                        border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
                      }}>
                        <img
                          src={attachmentUrl(a.path)} alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                        <button
                          onClick={() => setAttached(list => list.filter(x => x.path !== a.path))}
                          aria-label={pt ? `Remover ${a.name}` : `Remove ${a.name}`}
                          style={{
                            position: 'absolute', top: 2, right: 2,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 16, height: 16, borderRadius: '50%', border: 'none', padding: 0,
                            background: 'rgba(0,0,0,0.55)', color: '#fff', cursor: 'pointer',
                          }}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ) : (
                      <span key={a.path} title={a.path} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                        padding: '5px 8px', borderRadius: 8, minWidth: 0,
                        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                        fontSize: 11.5, color: 'var(--text-secondary)',
                      }}>
                        <Paperclip size={11} style={{ flexShrink: 0 }} />
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.name}
                        </span>
                        <button
                          onClick={() => setAttached(list => list.filter(x => x.path !== a.path))}
                          aria-label={pt ? `Remover ${a.name}` : `Remove ${a.name}`}
                          style={{
                            display: 'flex', border: 'none', background: 'transparent', padding: 0,
                            color: 'var(--text-tertiary)', cursor: 'pointer', flexShrink: 0,
                          }}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', alignSelf: 'center' }}>
                      {t.attachNote}
                    </span>
                  </div>
                )}

                {notice && (
                  <span role="status" style={{ fontSize: 11.5, color: 'var(--anthropic-orange)' }}>{notice}</span>
                )}
                {overCap && (
                  <span role="status" style={{ fontSize: 11.5, color: 'var(--accent-red)' }}>{t.cap}</span>
                )}
              </Field>
            </>
          )}
        </div>

        <footer style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
          padding: '14px 20px', borderTop: '1px solid var(--border)',
        }}>
          <button
            onClick={() => (step === 'compose' ? setStep('pick') : onClose())}
            disabled={busy}
            style={{
              minHeight: isMobile ? 44 : 34, padding: '0 14px', borderRadius: 9,
              cursor: busy ? 'default' : 'pointer',
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12.5,
            }}
          >
            {step === 'compose' ? t.back : t.cancel}
          </button>
          <button
            onClick={() => {
              if (!ready) return
              // `send`'s pick step only turns the page — the verb has not happened yet, so it must
              // not call `onConfirm`, which is what actually starts writing into live sessions.
              if (kind === 'send' && step === 'pick') { setStep('compose'); return }
              onConfirm(
                chosen.map(r => r.id),
                kind === 'send' ? composeBroadcastText(attached.map(a => a.path), text.trim()) : '',
              )
            }}
            disabled={!ready}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              minHeight: isMobile ? 44 : 34, padding: '0 14px', borderRadius: 9,
              cursor: ready ? 'pointer' : 'default', opacity: ready ? 1 : 0.45,
              border: '1px solid var(--anthropic-orange)',
              background: ready ? 'var(--bg-elevated)' : 'transparent',
              color: 'var(--anthropic-orange)',
              fontFamily: 'inherit', fontSize: 12.5, fontWeight: 650,
            }}
          >
            {kind === 'reopen' ? <RotateCcw size={13} /> : (step === 'compose' ? <Send size={13} /> : null)}
            {primary.label}
          </button>
        </footer>
      </div>
    </div>
  )
}
