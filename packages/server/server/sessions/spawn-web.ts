/**
 * spawn-web.ts — starting a session from the web dashboard, and reopening what fell.
 *
 * Everything here goes through the SAME host the terminal cockpit drives, so what the browser may
 * ask for is exactly what the wizard may ask for. Two consequences worth stating:
 *
 * - The harness list is `startableHarnesses()`, already narrowed by `availableHarnesses()` to the
 *   CLIs on PATH. A second list here would be the defect that fix exists to have removed once — a
 *   wizard offering `codex` where no codex exists starts a tmux session that dies on
 *   `command not found` behind a screen nobody is watching.
 * - `reopenFell` calls the host's own verb, which recomputes the crash group rather than trusting a
 *   snapshot. This spawns real assistants; a five-second-old list is the difference between
 *   reopening what fell and reopening what fell as of a moment ago.
 *
 * `attach` is never honoured from here. Attaching hands over a real terminal, which a browser tab
 * does not have — the request type does not even carry the flag, so it cannot be smuggled in.
 */

import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { controlStrings } from '@agentistics/tui/control/i18n'
import { modelsFor, type ModelOption } from '@agentistics/core'

export interface WebHarnessOption {
  id: string
  label: string
  /**
   * The ids alone. KEPT for one release: the VS Code extension reads this field, and a client on
   * an older build is exactly the one that would break silently.
   */
  modelSuggestions: string[]
  /** The same models, each with the NAME the harness prints. See `harnessModels.ts`. */
  models: ModelOption[]
  supportsModel: boolean
  efforts: string[]
}

export interface WebProjectOption {
  path: string
  label: string
  repo?: string
  detail: string
  source: string
}

export interface SpawnWebRequest {
  harness: string
  cwd: string
  task?: string
  prompt?: string
  model?: string
  effort?: string
  label?: string
}

export interface SpawnWebResult {
  ok: boolean
  message: string
  /** The new session's id, so the page can select it without waiting for the next poll. */
  id?: string
}

/** What this machine can start, and which questions each one earns. */
export async function webHarnesses(host: StartHost): Promise<WebHarnessOption[]> {
  if (!host.startableHarnesses) return []
  const found = await host.startableHarnesses()
  return found.map(h => ({ ...h, models: modelsFor(h.id) }))
}

/** Directories to offer, from the LOCAL store — so the picker works with the server's data cold. */
export async function webProjects(host: StartHost, query: string): Promise<WebProjectOption[]> {
  if (!host.searchProjects) return []
  const found = await host.searchProjects(query)
  return found.map(p => ({
    path: p.path,
    label: p.label,
    ...(p.repo ? { repo: p.repo } : {}),
    detail: p.detail,
    source: String(p.source),
  }))
}

/** The tasks that already exist, so filing a session is a pick rather than a spelling test. */
export async function webTasks(host: StartHost): Promise<string[]> {
  if (!host.sessionTasks) return []
  return await host.sessionTasks().catch(() => [])
}

/**
 * Start one session, detached.
 *
 * The plan is checked by `spawnManaged` BEFORE anything is spawned, so an unsupported flag comes
 * back as a sentence rather than as a session that starts and immediately dies with a usage error
 * on a screen nobody sees.
 */

/** Reopen everything the machine took at once. Recomputed by the host, never from a snapshot. */
export async function reopenFellFromWeb(
  host: StartHost,
  lang: CliLang,
): Promise<{ ok: boolean; message: string }> {
  const s = controlStrings(lang)
  if (!host.reopenFell) return { ok: false, message: s.sessionsNoHost }
  const out = await host.reopenFell()
  return { ok: out.ok, message: out.message }
}
