/**
 * ApprovalCard — the question a session is blocked on, answerable from the chat.
 *
 * This is the one thing the conversation view cannot get from the transcript: a dialog is on the
 * SCREEN and is never written to the JSONL. It arrives on the fleet row instead — `approvalLines`
 * verbatim, and `dialogOptions` parsed off the frame by `parseDialogOptions`.
 *
 * MOST DIALOGS ARE NOT YES/NO. Claude's permission prompt is `1. Yes / 2. Yes, always / 3. No`, and
 * an `AskUserQuestion` can offer five answers that do different work. A key that "approves" takes
 * whichever row is HIGHLIGHTED, which on such a dialog is choosing for the user — so the options
 * are listed and the PICKED one is sent by number. Where the harness has no verified way to select
 * by number the server sets `canChoose` false and hands over the row's own sentence, and this card
 * refuses in words rather than falling back to the bare confirm key. That fallback is the defect,
 * not the safety net.
 *
 * The card shows the dialog VERBATIM above the options. What the keystroke will do is not obvious
 * from a label alone, and a person agreeing to something should be able to read what they are
 * agreeing to.
 */

import { useState } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import type { FleetActionId, FleetRow } from '../../lib/fleet'

export interface ApprovalCardProps {
  row: FleetRow
  lang: 'pt' | 'en'
  act: (req: { id: string; action: FleetActionId; text?: string; choice?: number })
    => Promise<{ ok: boolean; message: string; id?: string }>
}

export function ApprovalCard({ row, lang, act }: ApprovalCardProps) {
  const pt = lang === 'pt'
  const [busy, setBusy] = useState<number | 'confirm' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const options = row.dialogOptions ?? []
  const approve = row.verbs.find(v => v.action === 'approve')

  async function answer(choice?: number) {
    setBusy(choice ?? 'confirm')
    const out = await act({ id: row.id, action: 'approve', ...(choice !== undefined ? { choice } : {}) })
    setBusy(null)
    setNotice(out.message)
  }

  return (
    <div style={{
      border: '1px solid var(--anthropic-orange)',
      background: 'var(--anthropic-orange-dim)',
      borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
        color: 'var(--anthropic-orange)',
      }}>
        <AlertCircle size={14} />
        {pt ? 'Esta sessão está perguntando' : 'This session is asking'}
      </div>

      {/* The dialog itself, monospaced and unedited. A person agreeing to something has to be able
          to read what they are agreeing to, and a label alone does not say what the key will do. */}
      {(row.approvalLines?.length ?? 0) > 0 && (
        <pre style={{
          margin: 0, padding: '10px 12px', borderRadius: 10,
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
          fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap', overflowX: 'auto', maxHeight: 260, overflowY: 'auto',
        }}>
          {row.approvalLines!.join('\n')}
        </pre>
      )}

      {options.length > 0 ? (
        row.chooseBlind ? (
          // A numbered dialog on a harness with no verified way to select by number. Refused in
          // words that name what DOES work, rather than sending the confirm key and taking
          // whichever row happens to be highlighted.
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
            {row.chooseBlind}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {options.map(o => (
              <button
                key={o.number}
                onClick={() => void answer(o.number)}
                disabled={busy !== null}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                  padding: '10px 12px', borderRadius: 10, cursor: busy === null ? 'pointer' : 'default',
                  border: `1px solid ${o.selected ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
                  background: 'var(--bg-card)', color: 'var(--text-primary)',
                  fontFamily: 'inherit', fontSize: 13, minWidth: 0,
                  opacity: busy !== null && busy !== o.number ? 0.5 : 1,
                }}
              >
                <span style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                  background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
                  fontSize: 11, fontWeight: 700,
                }}>
                  {o.number}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>{o.label}</span>
                {/* Which row the dialog currently has highlighted. Shown because it is a fact about
                    the screen, never because it is a recommendation. */}
                {o.selected && (
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                    {pt ? 'em foco' : 'highlighted'}
                  </span>
                )}
              </button>
            ))}
          </div>
        )
      ) : approve?.enabled ? (
        // Nothing to choose between — the `Press enter to continue` shape. The bare confirm key
        // survives only here.
        <button
          onClick={() => void answer()}
          disabled={busy !== null}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            padding: '10px 14px', borderRadius: 10, border: 'none', alignSelf: 'flex-start',
            background: 'var(--anthropic-orange)', color: '#fff',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            cursor: busy === null ? 'pointer' : 'default',
          }}
        >
          <Check size={14} />
          {approve.label}
        </button>
      ) : (
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
          {approve?.reason ?? row.approveBlind ?? (pt
            ? 'Esta pergunta não pode ser respondida daqui. Abra a sessão no terminal.'
            : 'This question cannot be answered from here. Open the session in the terminal.')}
        </p>
      )}

      {notice && (
        <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
          {notice}
        </p>
      )}
    </div>
  )
}
