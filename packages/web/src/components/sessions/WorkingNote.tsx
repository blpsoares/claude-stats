/**
 * WorkingNote — the quiet line that says the session is busy, under the last message.
 *
 * NOT a message, and styled so it cannot be mistaken for one: no bubble, no mark, no surface, dim
 * and small. It sits AFTER the conversation because that is where the next thing will appear, and
 * it is the only place the reasoning and the tool calls surface at all — rendering them as chat
 * entries drowned the two or three sentences actually addressed to the user under forty commands.
 *
 * It says WHAT is happening in one line, not everything that is happening. The terminal view is one
 * click away for anyone who wants the detail, and this exists so a session that thinks for four
 * minutes does not look stuck.
 */

import { Loader } from 'lucide-react'

export interface WorkingNoteProps {
  lang: 'pt' | 'en'
  /** The tools the newest turn invoked, if any. */
  tools?: Array<{ name: string; detail?: string }>
  /** True when the assistant recorded reasoning but no text on the newest turn. */
  thinking?: boolean
}

export function WorkingNote({ lang, tools, thinking }: WorkingNoteProps) {
  const pt = lang === 'pt'
  const names = (tools ?? []).map(t => t.name)

  const what = names.length > 0
    // Named, but only up to two: a turn can invoke eight tools and the line is not a manifest.
    ? (names.length <= 2
        ? names.join(', ')
        : pt ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : `${names.slice(0, 2).join(', ')} +${names.length - 2}`)
    : thinking
      ? (pt ? 'pensando' : 'thinking')
      : (pt ? 'trabalhando' : 'working')

  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        // Aligned with the bubbles' text rather than their edge: the 26px mark plus its 10px gap.
        paddingLeft: 36, minWidth: 0,
        fontSize: 11.5, color: 'var(--text-tertiary)',
      }}
    >
      <Loader size={12} className="ag-working-spin" style={{ flexShrink: 0 }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {what}
      </span>
      {/* The first tool's own detail, when there is one and there is room. The line stays one line:
          a command is routinely longer than the pane and this is a status, not content. */}
      {tools?.[0]?.detail && (
        <code style={{
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
          fontSize: 10.5, opacity: 0.75,
        }}>
          {tools[0].detail}
        </code>
      )}
    </div>
  )
}
