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
  /**
   * THE FREE-TEXT OPTION HANDS THE COMPOSER OVER, rather than growing a field of its own.
   *
   * Asked for: "ao clicar na opção de digitar o input fica disponível pro usuário usar (pq daí
   * consigo usar recurso de voz, ctrl+v, anexos etc.)". The one-line `<input>` this replaced was a
   * second composer with none of the composer's features — no dictation, no paste-an-image, no
   * attachments, no auto-grow — and its own separate idea of what Enter does.
   */
  onWrite?: (option: { number: number; label: string }) => void
  /** Which option the composer is currently answering, so the row can say so. */
  answering?: number | null
}

export function ApprovalCard({ row, lang, act, onWrite, answering = null }: ApprovalCardProps) {
  const pt = lang === 'pt'
  const [busy, setBusy] = useState<number | 'confirm' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * Did the last attempt FAIL? A refusal and a confirmation are not the same sentence and must not
   * look alike.
   *
   * The notice was one dim 11.5px line in `--text-tertiary` at the bottom of a card tall enough to
   * scroll — so a server refusal ("the question changed", "this needs text", "the session is not
   * asking any more") was, to a reader, indistinguishable from the button doing nothing at all.
   * Reported as exactly that: "simplesmente não envia".
   */
  const [failed, setFailed] = useState(false)

  const options = row.dialogOptions ?? []
  const approve = row.verbs.find(v => v.action === 'approve')

  /**
   * WHICH DIALOG THIS IS. Its options, as text — the only thing on the row that changes when the
   * question does, and stays the same while it is still being asked.
   */
  const shape = options.map(o => `${o.number}:${o.label}`).join('\n')
  /** The dialog that has already been answered from here. */
  const [answeredShape, setAnsweredShape] = useState<string | null>(null)

  /**
   * ONE ANSWER PER DIALOG, and the second one was doing real damage.
   *
   * An option is picked by TYPING ITS DIGIT — that is the only mechanism claude publishes. For an
   * ordinary option the digit selects and submits, but claude's `AskUserQuestion` has a
   * WRITE-YOUR-OWN option, and there the digit opens a TEXT FIELD. Every further digit then lands
   * INSIDE that field: reported with a screenshot where option 3 read `33333333333333333` and the
   * card cheerfully said `answered: 3333333333333333`.
   *
   * The card cannot tell text-entry mode from selection mode — no probed marker distinguishes them,
   * and inventing one is how a guess ships. What it CAN say is that this dialog has already been
   * answered from here, so the buttons go inert until the options CHANGE. A dialog still on screen
   * after an answer is either processing it or has opened a mode this card does not drive; pressing
   * again helps in neither case.
   */
  const alreadyAnswered = answeredShape !== null && answeredShape === shape

  async function answer(choice?: number, text?: string) {
    setBusy(choice ?? 'confirm')
    const out = await act({
      id: row.id,
      action: 'approve',
      ...(choice !== undefined ? { choice } : {}),
      ...(text !== undefined ? { text } : {}),
    })
    setBusy(null)
    setNotice(out.message)
    setFailed(!out.ok)
    if (out.ok) setAnsweredShape(shape)
  }

  return (
    <div style={{
      border: '1px solid var(--anthropic-orange)',
      background: 'var(--anthropic-orange-dim)',
      borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
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
          fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)',
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
                onClick={() => {
                  // THE FREE-TEXT OPTION ANSWERS NOTHING BY ITSELF — it hands the COMPOSER over.
                  // In the session the digit does not submit either: it turns that row into a
                  // field, and every further press types the digit INTO it, which is how
                  // `33333333333333333` happened. So the digit and the words travel together,
                  // once, when the composer sends — see `answerSession`.
                  if (o.freeText) { onWrite?.({ number: o.number, label: o.label }); return }
                  void answer(o.number)
                }}
                // Picking the free-text option SENDS NOTHING — it hands the composer over — so it
                // stays live even once something has been answered from here. Everything else is
                // an answer and obeys `alreadyAnswered`.
                disabled={!o.freeText && (busy !== null || alreadyAnswered)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                  padding: '9px 11px', borderRadius: 10,
                  cursor: o.freeText || (busy === null && !alreadyAnswered) ? 'pointer' : 'default',
                  border: `1px solid ${answering === o.number || o.selected ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
                  background: answering === o.number ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
                  color: 'var(--text-primary)',
                  // 12.5, matching the conversation's own body text. It was 13 and read as the
                  // largest thing on a card whose question is set at 11.5 — reported as the font
                  // being too big, and the option rows were the half that could come down.
                  fontFamily: 'inherit', fontSize: 12.5, minWidth: 0,
                  opacity: o.freeText ? 1 : (alreadyAnswered ? 0.5 : (busy !== null && busy !== o.number ? 0.5 : 1)),
                }}
              >
                <span style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 20, height: 20, borderRadius: 6, flexShrink: 0,
                  background: answering === o.number ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
                  color: answering === o.number ? '#fff' : 'var(--text-tertiary)',
                  fontSize: 10.5, fontWeight: 700,
                }}>
                  {o.number}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>{o.label}</span>
                {/* THE COMPOSER IS THE FIELD, and the row has to say where the answer goes — a row
                    that highlights and grows nothing reads as a click that did nothing. */}
                {o.freeText && answering === o.number && (
                  <span style={{ fontSize: 10.5, color: 'var(--anthropic-orange)', flexShrink: 0 }}>
                    {pt ? 'escreva abaixo ↓' : 'write below ↓'}
                  </span>
                )}
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
          disabled={busy !== null || alreadyAnswered}
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

      {/* A REFUSAL IS NOT A CONFIRMATION AND MUST NOT LOOK LIKE ONE.
          Every one of these sentences was rendered the same dim 11.5px grey at the bottom of a card
          tall enough to scroll — so "the question changed", "this needs text" and "the session is
          not asking any more" all reached the reader as silence. Reported as "simplesmente não
          envia, o componente fica visível eternamente": the card WAS answering, in a colour and a
          place nobody looks. A failure now carries the alert colour, an icon, a border and
          `role="alert"`; a confirmation stays quiet, because it is the expected outcome. */}
      {notice && (
        <p
          role={failed ? 'alert' : 'status'}
          style={failed
            ? {
              margin: 0, display: 'flex', alignItems: 'flex-start', gap: 7,
              padding: '8px 10px', borderRadius: 9,
              border: '1px solid var(--accent-red)',
              background: 'color-mix(in srgb, var(--accent-red) 12%, transparent)',
              fontSize: 12, lineHeight: 1.5, color: 'var(--accent-red)',
            }
            : { margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}
        >
          {failed && <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />}
          <span style={{ minWidth: 0 }}>{notice}</span>
        </p>
      )}

      {/* WHY THE BUTTONS ARE INERT. A row that stops responding with no sentence is the
          control-that-reads-as-broken; and the one case a person most needs told about is the
          write-your-own option, where the answer has to be typed in the session itself. */}
      {alreadyAnswered && (
        <p role="status" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--anthropic-orange)' }}>
          {pt
            ? 'Já respondido daqui. Se o diálogo continuar na tela, a sessão ainda está processando — ou ele abriu um campo, e aí a opção de escrever acima entrega o campo de mensagem para você responder.'
            : 'Already answered from here. If the dialog is still on screen the session is still processing it — or it has opened a field, in which case the write-your-own option above hands the message box over so you can answer there.'}
        </p>
      )}
    </div>
  )
}
