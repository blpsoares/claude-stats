/**
 * shell-store.ts — where the open utility shells are recorded, and why it is not the registry.
 *
 * `~/.agentistics/shells.json`, a separate file with a separate writer from
 * `managed-sessions.json`, and that separation is the whole performance argument of this feature.
 * `host.sessions()` "walks every session and captures its pane: ~200 ms measured here"
 * (`fleet-web.ts`) and runs every 5 s in the cockpit, in the web fleet poll, in the VS Code
 * extension and on every `/api/fleet` call. A shell in the registry would join that loop — and
 * would also become a fleet row, be probed by `attention.ts` for dialog markers, take a
 * `lastSeenMs` heartbeat, and count toward "N sessions waiting on you", so an `htop` would read as
 * a session needing a person.
 *
 * Reads are TOTAL: a missing, unreadable, non-array or half-written store yields `[]`. A shell is a
 * convenience, and a corrupt store must cost the person a new shell, never the dashboard.
 */

import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'

/** One open shell. There is no `tmuxName` field: it is `tmuxName(id)`, on `SHELL_SOCKET`. */
export interface ShellRecord {
  /** This shell's own id — also its tmux session name, through `tmuxName`. */
  id: string
  /** The fleet row it was opened for. Not a foreign key anything enforces: the row can go away. */
  sessionId: string
  /** Where it was opened. Recorded at open, the one moment the directory is provably there. */
  cwd: string
  createdMs: number
  /** When a viewer last had it on screen — the tiebreak the ceiling's recommendation will use. */
  lastViewedMs: number
}

export function shellsPath(dir: string = AGENTISTICS_DATA_DIR): string {
  return join(dir, 'shells.json')
}

/**
 * A record, or `null` for anything that does not read as one.
 *
 * DROPPED rather than repaired: the ceiling counts these rows, so a half-read one would be charged
 * against the cap while being useless to every verb — a shell you cannot reach and cannot close.
 */
function asRecord(v: unknown): ShellRecord | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.sessionId !== 'string') return null
  if (typeof r.cwd !== 'string' || !r.cwd) return null
  if (typeof r.createdMs !== 'number' || !Number.isFinite(r.createdMs)) return null
  if (typeof r.lastViewedMs !== 'number' || !Number.isFinite(r.lastViewedMs)) return null
  return {
    id: r.id,
    sessionId: r.sessionId,
    cwd: r.cwd,
    createdMs: r.createdMs,
    lastViewedMs: r.lastViewedMs,
  }
}

export async function readShells(dir?: string): Promise<ShellRecord[]> {
  try {
    const file = Bun.file(shellsPath(dir))
    if (!(await file.exists())) return []
    const parsed = JSON.parse(await file.text()) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(asRecord).filter((r): r is ShellRecord => r !== null)
  } catch {
    return []
  }
}

export async function writeShells(list: ShellRecord[], dir?: string): Promise<void> {
  await Bun.write(shellsPath(dir), JSON.stringify(list, null, 2))
}
