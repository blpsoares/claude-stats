/**
 * SessionFacts — what a session row says about itself.
 *
 * Shared by the open list's row and the collapsed rail's tooltip, deliberately: the tooltip has to
 * carry exactly what the row carries, and two implementations of one card is how they come to
 * disagree — the same argument `rowMenu.ts` makes about the verbs and `task-reopen.ts` makes about
 * reopening.
 *
 * Extracted verbatim from `SessionRow`'s own body — nothing about the open row's rendering changes.
 */

import { sessionNotify, type ControlSession } from '@agentistics/tui/control/session-fleet'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'

/**
 * A model id, shortened for a narrow column.
 *
 * The provider prefix and the dated suffix are what a person already knows or does not care about
 * in a sidebar — `anthropic/claude-sonnet-4-5-20250929` becomes `claude-sonnet-4-5`. The full id is
 * on the row's `title` attribute, so nothing is lost.
 */
export function shortModel(model: string): string {
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  return bare.replace(/-\d{8}$/, '')
}

export interface SessionFactsProps {
  session: ControlSession
  /** Bolder title — the same rule the open row uses (selected or wants a person). */
  selected?: boolean
}

export function SessionFacts({ session, selected = false }: SessionFactsProps) {
  const wants = sessionNotify(session)
  return (
    <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{
        fontSize: 12.5, fontWeight: selected || wants ? 650 : 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {session.title}
      </span>
      <span style={{
        display: 'flex', alignItems: 'center', gap: 5, minWidth: 0,
        fontSize: 10.5, color: wants ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
      }}>
        <span style={{ flexShrink: 0 }}>{session.stateLabel}</span>
        <span style={{ opacity: 0.4, flexShrink: 0 }}>·</span>
        <span style={{
          color: (HARNESS_COLORS as Record<string, string>)[session.harness] ?? 'var(--text-tertiary)',
          fontWeight: 650, flexShrink: 0,
        }}>
          {(HARNESS_LABELS as Record<string, string>)[session.harness] ?? session.harness}
        </span>
        {/* The model, when the row knows one. A row that does not is not "some default model" —
            it is unknown, and inventing a name there is the confident-zero defect in words. */}
        {session.model && (
          <>
            <span style={{ opacity: 0.4, flexShrink: 0 }}>·</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shortModel(session.model)}
            </span>
          </>
        )}
        {session.task && (
          <>
            <span style={{ opacity: 0.4, flexShrink: 0 }}>·</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.task}
            </span>
          </>
        )}
      </span>
    </span>
  )
}
