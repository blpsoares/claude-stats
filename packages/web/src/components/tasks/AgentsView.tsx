/**
 * AgentsView — the board read the way an ORCHESTRATOR reads it, rather than the way a planner does.
 *
 * The kanban answers "which column is full" and the metrics answer "what is it costing me". Neither
 * answers the three questions a person running a fleet actually asks, which are the three panels
 * here:
 *
 *  1. **What is available?** The ready queue — open, unblocked, unclaimed — in the order an agent
 *     would take it, with the WITHHELD tasks and their reasons beside it. "Nothing to do because it
 *     is all done" and "nothing to do because everything is blocked" are different facts and a
 *     coordinator that cannot tell them apart re-dispatches forever.
 *  2. **Who is on what?** The live fleet joined to the board. A CLAIM is a statement somebody made
 *     ("mine until 14:20"); a live SESSION is something observed on this machine right now. They
 *     are drawn separately on purpose — conflating them lets "an agent said it would" read as "an
 *     agent is".
 *  3. **What happened while I was away?** The activity log, newest first.
 *
 * Everything here is a READ. Nothing on this screen starts, stops or approves anything; the one
 * write is releasing a lease you can see has lapsed, which is a correction, not an instruction.
 */

import { useMemo } from 'react'
import { Activity, Bot, CheckCircle2, CircleSlash, Clock, Layers, Terminal } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  PRIORITY, SESSION_STATE, STATUS, button, claimLeft, microLabel, numeric, pill, surface,
  type BoardStatus,
} from './board'
import type { NextReply, TaskEvent, TaskListRow } from '../../lib/tasks'

const WHY: Record<string, { label: string; color: string }> = {
  blocked: { label: 'waiting on another task', color: 'var(--accent-red)' },
  claimed: { label: 'somebody has it', color: 'var(--accent-green)' },
  closed: { label: 'finished', color: 'var(--text-tertiary)' },
  status: { label: 'not pickable in this column', color: 'var(--text-tertiary)' },
}

/** The words an event is read in. A kind nobody mapped prints ITSELF rather than vanishing. */
function describe(e: TaskEvent): string {
  switch (e.kind) {
    case 'status': return `moved ${e.from ?? '?'} → ${e.to ?? '?'}`
    case 'claim': return e.detail === 'takeover' ? 'took over' : 'claimed'
    case 'release': return 'released'
    case 'priority': return `priority ${e.from ?? '?'} → ${e.to ?? '?'}`
    case 'assign': return `owner ${e.from || 'nobody'} → ${e.to || 'nobody'}`
    case 'session': return `filed a ${e.detail ?? ''} session`.trim()
    case 'move': return `reordered (${e.detail ?? ''})`.trim()
    default: return e.kind
  }
}

function Stat({ icon, label, value, color }: {
  icon: React.ReactNode
  label: string
  value: string | number
  color?: string
}) {
  return (
    <div style={{ ...surface, padding: '10px 12px', display: 'grid', gap: 4, minWidth: 0 }}>
      <span style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {icon} {label}
      </span>
      <span style={{ ...numeric, fontSize: 19, color: color ?? 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}

export interface AgentsViewProps {
  next: NextReply | null
  rows: TaskListRow[]
  events: TaskEvent[]
  sessions: readonly {
    id: string; state: string; harness: string; title: string; task?: string; cwd: string
  }[]
  onOpen: (id: string) => void
  onRelease: (id: string) => void
  nowMs: number
}

export function AgentsView(p: AgentsViewProps) {
  const isMobile = useIsMobile()
  const titleOf = useMemo(
    () => new Map(p.rows.map(r => [r.task.id, r.task.title])),
    [p.rows],
  )

  /** Every session that names a task, plus the claims — the two halves of "who is on what". */
  const working = useMemo(() => p.sessions.filter(s => s.task), [p.sessions])
  const claimed = useMemo(
    () => p.rows.filter(r => r.task.claim).map(r => ({
      row: r, lease: claimLeft(r.task.claim!.expiresAt, p.nowMs),
    })),
    [p.rows, p.nowMs],
  )

  const progress = p.next?.progress
  const withheld = p.next?.withheld ?? []
  const byWhy = useMemo(() => {
    const m = new Map<string, typeof withheld>()
    for (const w of withheld) m.set(w.why, [...(m.get(w.why) ?? []), w])
    return m
  }, [withheld])

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {progress && (
        <div style={{
          display: 'grid', gap: 10,
          gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(auto-fit, minmax(150px, 1fr))',
        }}>
          <Stat icon={<Layers size={11} />} label="Ready to pick up" value={progress.ready}
            color={progress.ready > 0 ? 'var(--anthropic-orange)' : 'var(--text-tertiary)'} />
          <Stat icon={<Bot size={11} />} label="In hands" value={progress.claimed} />
          <Stat icon={<CircleSlash size={11} />} label="Blocked" value={progress.blocked}
            color={progress.blocked > 0 ? 'var(--accent-red)' : undefined} />
          <Stat icon={<CheckCircle2 size={11} />} label="Delivered" value={progress.done}
            color="var(--accent-green)" />
          <Stat icon={<Terminal size={11} />} label="Sessions on a task" value={working.length} />
        </div>
      )}

      {progress && (
        // The convergence sentence, and it is deliberately two facts. "Nothing available" while
        // three agents are mid-task is not done.
        <div style={{
          ...surface, padding: '10px 13px', fontSize: 12.5, color: 'var(--text-secondary)',
          borderLeft: `3px solid ${progress.settled ? 'var(--accent-green)' : 'var(--anthropic-orange)'}`,
        }}>
          {progress.settled
            ? 'Nothing left to hand out and nothing in flight — the board is settled.'
            : progress.ready === 0
              ? `Nothing available to pick up, but ${progress.claimed} task${progress.claimed === 1 ? ' is' : 's are'} in somebody's hands. Not finished — in progress.`
              : `${progress.ready} task${progress.ready === 1 ? '' : 's'} can be picked up right now.`}
        </div>
      )}

      <div style={{
        display: 'grid', gap: 14,
        gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1.2fr) minmax(0, 1fr)',
        alignItems: 'start',
      }}>
        <div style={{ ...surface, padding: 13, display: 'grid', gap: 10 }}>
          <span style={microLabel}>The queue — in the order an agent would take it</span>
          {(p.next?.ready.length ?? 0) === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Nothing is available. The reasons are listed below — that is the difference between a
              finished board and a stuck one.
            </div>
          )}
          {p.next?.ready.map(({ task, position }) => {
            const pr = PRIORITY[task.priority ?? 'none']!
            return (
              <button
                key={task.id}
                onClick={() => p.onOpen(task.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                  ...surface, background: 'var(--bg-base)', padding: '8px 10px', cursor: 'pointer',
                  color: 'var(--text-primary)', minHeight: isMobile ? 44 : 34,
                }}
              >
                <span style={{ ...numeric, width: 20, color: 'var(--text-tertiary)' }}>{position}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {task.title}
                </span>
                {task.priority && task.priority !== 'none' && (
                  <span style={{
                    padding: '1px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                    background: pr.dim, color: pr.color, border: `1px solid ${pr.color}`,
                  }}>{pr.label}</span>
                )}
                <span style={pill(STATUS[task.status as BoardStatus]?.color)}>
                  {STATUS[task.status as BoardStatus]?.label ?? task.status}
                </span>
              </button>
            )
          })}

          {byWhy.size > 0 && (
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <span style={microLabel}>Withheld, and why</span>
              {[...byWhy.entries()].map(([why, list]) => {
                const w = WHY[why] ?? { label: why, color: 'var(--text-tertiary)' }
                return (
                  <div key={why} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={pill(w.color)}>{list.length}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{w.label}</span>
                    <span style={{
                      fontSize: 11, color: 'var(--text-tertiary)', flex: 1, minWidth: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {list.slice(0, 3).map(x => x.title).join(' · ')}
                      {list.length > 3 ? ` +${list.length - 3}` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ ...surface, padding: 13, display: 'grid', gap: 9 }}>
            <span style={microLabel}>Who is on what</span>
            {claimed.length === 0 && working.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Nothing is claimed and no running session names a task.
              </div>
            )}
            {claimed.map(({ row, lease }) => (
              <div key={row.task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: isMobile ? 44 : 26 }}>
                <span style={pill(lease.expired ? 'var(--text-tertiary)' : 'var(--accent-green)')}>
                  <Bot size={10} /> {row.task.claim!.by}
                </span>
                <button
                  onClick={() => p.onOpen(row.task.id)}
                  style={{
                    flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none',
                    color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    // The tap target is the whole ROW, not the glyph-high line of text inside it.
                    alignSelf: 'stretch',
                  }}
                >{row.task.title}</button>
                <span style={{ ...microLabel, fontSize: 10.5, color: lease.expired ? 'var(--accent-red)' : 'var(--text-tertiary)' }}>
                  {lease.text}
                </span>
                {lease.expired && (
                  // The one write on this screen, and only on a lease that has visibly lapsed:
                  // clearing a stale holder is a correction, not an instruction to anybody.
                  <button
                    onClick={() => p.onRelease(row.task.id)}
                    style={{ ...button(isMobile), height: isMobile ? 44 : 24, fontSize: 11 }}
                    title="The lease has run out — clear the holder"
                  >clear</button>
                )}
              </div>
            ))}
            {working.map(s => {
              const st = SESSION_STATE[s.state]
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: isMobile ? 44 : 26 }}>
                  <Terminal size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.task}
                  </span>
                  <span style={pill()}>{s.harness}</span>
                  {st && <span style={pill(st.color)}>{st.label}</span>}
                </div>
              )
            })}
          </div>

          <div style={{ ...surface, padding: 13, display: 'grid', gap: 8 }}>
            <span style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Activity size={11} /> What has been happening
            </span>
            {p.events.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Nothing recorded yet. Status moves, claims and assignments land here as they happen.
              </div>
            )}
            {p.events.slice(0, 30).map(e => (
              /*
               * The whole LINE opens the task, rather than an inline link inside it. A log line is
               * one thought — "who did what to which task" — and on a phone a 14px inline anchor is
               * a target nobody can hit, while giving that anchor 44px of its own would double-space
               * the log to buy it.
               */
              <button
                key={e.id}
                onClick={() => p.onOpen(e.taskId)}
                style={{
                  display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5, width: '100%',
                  textAlign: 'left', background: 'none', border: 'none', padding: 0,
                  cursor: 'pointer', minHeight: isMobile ? 44 : undefined, fontFamily: 'inherit',
                }}
              >
                <span style={{ ...microLabel, fontSize: 10, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Clock size={9} /> {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{ color: 'var(--text-secondary)', minWidth: 0 }}>
                  <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{e.actor}</strong>
                  {' '}{describe(e)}{' '}
                  <span style={{ color: 'var(--accent-blue)' }}>
                    {titleOf.get(e.taskId) ?? e.taskId}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
