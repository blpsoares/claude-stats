/**
 * cli-hooks.ts — `agentop hooks install | uninstall | status | context`.
 *
 * The I/O half of the Claude Code integration. Every DECISION it makes is already made by a pure
 * module: `claude-hooks.ts` says what goes in `settings.json` and how it merges, `claude-skill.ts`
 * says what the skill document is and whether the one on disk is ours, and `session-context.ts`
 * says what the hook prints. This file reads files, writes files, and reports.
 *
 * Three rules it exists to honour:
 *
 *  1. **Installing is something the user does.** Nothing here runs by itself. `agentop setup` may
 *     print one line suggesting the command; writing into someone's `~/.claude` because they
 *     installed a metrics dashboard is not a thing this project does. The precedent is
 *     `autostart.ts`, which touches `~/.bashrc` only behind an explicit `agentop autostart`.
 *  2. **The file is not ours.** Writes go through `planHookInstall` / `planHookRemoval`, which
 *     preserve every key they did not write and REFUSE a document they cannot merge into. On a
 *     refusal, nothing is written at all.
 *  3. **No Claude Code, no files.** If nothing here looks like a Claude Code install, the command
 *     says so and creates neither directory nor file — a `~/.claude` conjured by a dashboard is a
 *     directory the user did not ask for and will not know to delete.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { HOME_DIR } from './config'
import {
  HOOK_SPECS,
  HOOK_VERSION,
  explainHookPlanError,
  hookCommand,
  hookInvocation,
  parseHooksArgs,
  planHookInstall,
  planHookRemoval,
  readHookStatus,
} from './claude-hooks'
import {
  SKILL_NAME,
  SKILL_VERSION,
  isManagedSkill,
  managedSkillVersion,
  skillMarkdown,
} from './claude-skill'
import { planSessionContext, type ContextSession } from './session-context'

const USAGE = `Usage:
  agentop hooks install    [--hook-only | --skill-only]
  agentop hooks uninstall  [--hook-only | --skill-only]
  agentop hooks status

Teach Claude Code to run work in parallel through agentop, and to report when it stops.

  skill  ~/.claude/skills/${SKILL_NAME}/SKILL.md
         WHAT Claude needs to know: when a task splits into independent pieces, how to propose
         the split, how to write each session's prompt, and how to start them all with
         \`agentop session batch\`. Claude loads it when the task matches its description and
         ignores it otherwise, so it costs nothing on a session that never parallelises.

  hooks  two entries in ~/.claude/settings.json
         SessionStart → FACTS a static file cannot hold: which agentop sessions are running
         right now, which one is blocked on a permission prompt, which task can be reopened in
         this directory. It prints NOTHING when there is nothing running, so a quiet machine
         pays no tokens.
         Stop → records that this session finished a turn, into agentop's event inbox. It is
         the exact half of \`agentop events\`: Claude saying it stopped, rather than the fleet
         monitor inferring it from the screen five seconds later. It prints nothing at all.

A hook does not infer anything — it is a shell command on an event. The inference is Claude's,
reading what the skill teaches and what the hook injected. See docs/claude-integration.md.

Neither is installed unless you run this command, and \`uninstall\` takes back exactly what
\`install\` put there.`

// ---------------------------------------------------------------------------
// Where things live
//
// Deliberately HOME_DIR, not CLAUDE_DIR: this administers the user's own Claude Code install, the
// same distinction `mcp-list.ts` makes and `config.ts` documents. CLAUDE_DIR can point at a
// container's read-only mount of somebody else's `~/.claude`, which is a thing to report on, never
// a thing to write hooks into.
// ---------------------------------------------------------------------------

const claudeHome = (): string => join(HOME_DIR, '.claude')
const settingsFile = (): string => join(claudeHome(), 'settings.json')
const skillDir = (): string => join(claudeHome(), 'skills', SKILL_NAME)
const skillFile = (): string => join(skillDir(), 'SKILL.md')

/** `~/.claude/x` → `~/.claude/x` in prose, whatever HOME actually is. */
const tilde = (p: string): string => (HOME_DIR && p.startsWith(HOME_DIR) ? `~${p.slice(HOME_DIR.length)}` : p)

/** Is there a Claude Code here at all? Either its home directory or its CLI is enough. */
function claudeCodePresent(): boolean {
  return existsSync(claudeHome()) || !!Bun.which('claude')
}

/** How the installed hook should invoke this agentop. See `hookInvocation` for the ordering. */
function invocation(): string {
  const onPath = !!Bun.which('agentop')
  return hookInvocation({ onPath, execPath: process.execPath, script: process.argv[1] })
}

/** Write through a temp file and rename, so a crash mid-write leaves the old file or the new one —
 *  never a truncated `settings.json`, which Claude Code would then refuse to start with. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.agentop-tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/** `null` when the file is absent; throws only when it is unreadable or not JSON — which the caller
 *  reports rather than papering over, because "unreadable" is not "empty". */
async function readSettings(file: string): Promise<unknown> {
  if (!existsSync(file)) return null
  const raw = await readFile(file, 'utf8')
  if (raw.trim() === '') return null
  return JSON.parse(raw) as unknown
}

/** Remove a directory only while it is empty. A directory we cannot list is one we leave alone. */
async function pruneEmpty(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  } catch { /* not there, not ours, not empty — all three mean: leave it */ }
}

/**
 * The assistants this machine can actually start, for the skill to name.
 *
 * Derived from the spawn specs (never a second hand-written list) and then narrowed to the ones
 * whose CLI is on PATH. A skill that offers `codex` where no codex exists teaches a command that
 * fails. If none of them resolve — a PATH-less environment, say — name every startable harness
 * rather than writing a skill that says nothing can be started.
 */
async function startableHarnesses(): Promise<HarnessId[]> {
  const { availableHarnesses } = await import('./sessions/harness-available')
  return availableHarnesses().ids
}

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

export async function runHooks(argv: string[]): Promise<number> {
  const cmd = parseHooksArgs(argv)
  switch (cmd.kind) {
    case 'help': console.log(USAGE); return 0
    case 'error': console.error(cmd.message); console.error(`\n${USAGE}`); return 1
    // `context` is what the installed hook runs. It must be silent and harmless everywhere,
    // including on a machine with no Claude Code and no tmux, so it is answered before the guard.
    case 'context': return context()
    case 'status': return status()
    case 'install':
    case 'uninstall': {
      if (!claudeCodePresent()) {
        console.error(
          'Claude Code does not appear to be installed for this user — no ~/.claude directory and no `claude` on PATH.\n' +
          'Nothing was created. Install Claude Code first, then run this again.',
        )
        return 1
      }
      return cmd.kind === 'install'
        ? install({ hook: cmd.hook, skill: cmd.skill })
        : uninstall({ hook: cmd.hook, skill: cmd.skill })
    }
  }
}

/**
 * The one line `agentop setup` is allowed to print about this: an OFFER, never an install.
 *
 * Null when there is no Claude Code here, or when the integration is already in place — a
 * suggestion to run a command you have already run is noise, and noise is what makes people stop
 * reading the last line of a wizard. Never throws: a setup run must not fail over a hint.
 */
export async function suggestHooksLine(): Promise<string | null> {
  try {
    if (!claudeCodePresent()) return null
    const hookInstalled = readHookStatus(await readSettings(settingsFile()).catch(() => null)).installed
    const skillInstalled = existsSync(skillFile())
    if (hookInstalled && skillInstalled) return null
    return 'Tip: `agentop hooks install` teaches Claude Code to split independent work across '
      + 'several assistants and start them with `agentop session batch`. Nothing is written to '
      + '~/.claude until you run it.'
  } catch {
    return null
  }
}

async function install(what: { hook: boolean; skill: boolean }): Promise<number> {
  let failed = false

  if (what.hook) {
    const file = settingsFile()
    let current: unknown
    try {
      current = await readSettings(file)
    } catch (e) {
      console.error(`Could not read ${tilde(file)}: ${e instanceof Error ? e.message : String(e)}`)
      console.error('Nothing was written.')
      failed = true
      current = undefined
    }
    if (!failed) {
      // Both hooks are planned against the SAME document, one after the other, and the file is
      // written ONCE at the end. Writing per hook would leave a settings.json holding one of the
      // two if the second plan refused — a half-installed integration that `status` would then
      // report as partly stale forever.
      let settings = current
      const written: string[] = []
      for (const spec of HOOK_SPECS) {
        const command = hookCommand(invocation(), HOOK_VERSION, spec.event)
        const plan = planHookInstall(settings, command, spec.event)
        if (!plan.ok) {
          console.error(explainHookPlanError(plan.error, tilde(file)))
          failed = true
          break
        }
        settings = plan.settings
        if (plan.changed) written.push(`hook   ${spec.event} → ${command}`)
        else console.log(`hook   ${spec.event} already installed in ${tilde(file)} (v${HOOK_VERSION}) — unchanged.`)
      }
      if (!failed && written.length > 0) {
        await writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`)
        for (const line of written) console.log(line)
        console.log(`       written to ${tilde(file)}`)
      }
    }
  }

  if (what.skill) {
    const file = skillFile()
    const desired = skillMarkdown({ harnesses: await startableHarnesses() })
    let existing: string | null = null
    if (existsSync(file)) {
      try { existing = await readFile(file, 'utf8') } catch { existing = null }
    }
    if (existing !== null && !isManagedSkill(existing)) {
      // The marker is gone, so this file is the user's. Rewriting it would destroy their edits.
      console.error(`skill  ${tilde(file)} exists and is not agentop's (no marker line) — left untouched.`)
      failed = true
    } else if (existing === desired) {
      console.log(`skill  already installed at ${tilde(file)} (v${SKILL_VERSION}) — unchanged.`)
    } else {
      await writeAtomic(file, desired)
      const was = existing === null ? 'installed' : `updated (was v${managedSkillVersion(existing) ?? '?'})`
      console.log(`skill  ${SKILL_NAME} ${was} at ${tilde(file)} (v${SKILL_VERSION})`)
    }
  }

  if (!failed) {
    console.log('')
    console.log('Claude Code picks both up on its next session. Ask it to run something in parallel')
    console.log('and it will propose the split, write each prompt, and start them with')
    console.log('`agentop session batch` — after you say yes.')
  }
  return failed ? 1 : 0
}

async function uninstall(what: { hook: boolean; skill: boolean }): Promise<number> {
  let failed = false

  if (what.hook) {
    const file = settingsFile()
    let current: unknown
    try {
      current = await readSettings(file)
    } catch (e) {
      console.error(`Could not read ${tilde(file)}: ${e instanceof Error ? e.message : String(e)}`)
      console.error('Nothing was changed.')
      failed = true
    }
    if (!failed) {
      let settings = current
      const removed: string[] = []
      for (const spec of HOOK_SPECS) {
        const plan = planHookRemoval(settings, spec.event)
        if (!plan.ok) {
          console.error(explainHookPlanError(plan.error, tilde(file)))
          failed = true
          break
        }
        settings = plan.settings
        if (plan.changed) removed.push(spec.event)
      }
      if (!failed && removed.length === 0) {
        console.log(`hook   not installed in ${tilde(file)} — nothing to remove.`)
      } else if (!failed) {
        await writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`)
        console.log(`hook   removed ${removed.join(' + ')} from ${tilde(file)}`)
      }
    }
  }

  if (what.skill) {
    const file = skillFile()
    if (!existsSync(file)) {
      console.log(`skill  not installed at ${tilde(file)} — nothing to remove.`)
    } else {
      let content = ''
      try { content = await readFile(file, 'utf8') } catch { content = '' }
      if (!isManagedSkill(content)) {
        console.error(`skill  ${tilde(file)} is not agentop's (no marker line) — left in place. Delete it yourself if you want it gone.`)
        failed = true
      } else {
        await rm(file)
        // Only remove the directories we created, and only while they hold nothing else. The
        // `skills/` parent goes too when it is empty — an install created it on a machine that had
        // no skills at all, and leaving an empty directory behind is not "removed exactly what was
        // put". An empty one the user already had is indistinguishable and equally harmless.
        await pruneEmpty(skillDir())
        await pruneEmpty(dirname(skillDir()))
        console.log(`skill  removed ${tilde(file)}`)
      }
    }
  }

  return failed ? 1 : 0
}

async function status(): Promise<number> {
  const file = settingsFile()
  console.log(`claude   ${claudeCodePresent() ? tilde(claudeHome()) : 'not found (no ~/.claude, no `claude` on PATH)'}`)

  try {
    const settings = await readSettings(file)
    for (const spec of HOOK_SPECS) {
      const st = readHookStatus(settings, HOOK_VERSION, spec.event)
      if (!st.installed) {
        console.log(`hook     ${spec.event}: not installed  (${tilde(file)})`)
        continue
      }
      const version = st.version === null ? 'no version' : `v${st.version}`
      const stale = st.stale ? `  STALE — this agentop writes v${HOOK_VERSION}; run \`agentop hooks install\`` : ''
      const dupes = st.commands.length > 1 ? `  (${st.commands.length} copies)` : ''
      console.log(`hook     ${spec.event}: installed ${version}${dupes}${stale}\n         ${st.commands[0]}`)
    }
    console.log(`         ${tilde(file)}`)
  } catch (e) {
    console.log(`hook     cannot read ${tilde(file)}: ${e instanceof Error ? e.message : String(e)}`)
  }

  const sf = skillFile()
  if (!existsSync(sf)) {
    console.log(`skill    not installed  (${tilde(sf)})`)
  } else {
    let content = ''
    try { content = await readFile(sf, 'utf8') } catch { /* reported as not-ours below */ }
    if (!isManagedSkill(content)) {
      console.log(`skill    present but not agentop's — ${tilde(sf)}`)
    } else {
      const v = managedSkillVersion(content)
      const stale = v !== SKILL_VERSION ? `  STALE — this agentop writes v${SKILL_VERSION}` : ''
      console.log(`skill    installed v${v}${stale}\n         ${tilde(sf)}`)
    }
  }
  return 0
}

/**
 * The hook body: print what is running, or print nothing.
 *
 * Every failure path is silence with exit 0. This runs on the critical path of starting a Claude
 * Code session; a hook that errors, hangs, or prints a stack trace into the model's context is
 * worse in every case than one that says nothing. The whole read is also raced against a deadline
 * for the same reason — tmux and `/proc` are usually milliseconds, and "usually" is not a promise
 * to make on someone's session start.
 */
const CONTEXT_DEADLINE_MS = Number(process.env.AGENTISTICS_HOOK_TIMEOUT_MS) > 0
  ? Number(process.env.AGENTISTICS_HOOK_TIMEOUT_MS)
  : 4_000

async function context(): Promise<number> {
  try {
    const rows = await Promise.race([
      readFleet(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), CONTEXT_DEADLINE_MS)),
    ])
    if (!rows || rows.length === 0) return 0

    const text = planSessionContext({ sessions: rows, cwd: process.cwd(), home: HOME_DIR })
    if (!text) return 0

    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }))
  } catch {
    // Deliberately silent — see above.
  }
  return 0
}

/** The fleet, as the cockpit and `agentop session list` see it. Null when it cannot be read. */
async function readFleet(): Promise<ContextSession[] | null> {
  try {
    const [{ resolveBackend }, { readRegistry }, { scanProcesses }, { createSessionsPoller }] = await Promise.all([
      import('./sessions/index'),
      import('./sessions/registry'),
      import('./live-sessions'),
      import('./sessions/sessions-host'),
    ])
    const backend = await resolveBackend()
    if (await backend.unavailable()) return null
    // The running server's poller first — it is the one with movement memory, and a hook that
    // reports a producing session as waiting injects a wrong fact into every new conversation. See
    // `shared-snapshot.ts`; `null` simply means there is no server and the local poll answers.
    const { isServerProcess, readServerSnapshot } = await import('./sessions/shared-snapshot')
    const shared = isServerProcess()
      ? null
      : await readServerSnapshot<Awaited<ReturnType<ReturnType<typeof createSessionsPoller>['poll']>>>('en')
    const snap = shared ?? await createSessionsPoller({ backend, readRegistry, scanProcesses }).poll()
    return snap.sessions.map(v => ({
      id: v.id,
      status: v.status,
      activity: v.activity,
      harness: v.harness,
      cwd: v.cwd,
      label: v.label,
      task: v.task,
    }))
  } catch {
    return null
  }
}
