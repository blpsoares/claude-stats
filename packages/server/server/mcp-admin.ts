/**
 * mcp-admin.ts — reading the machine's MCP servers, and adding or removing one.
 *
 * The rules are the pure `mcp-config.ts` (where a server lives, what a paste means, which command
 * performs a write) and `mcp-status.ts` (what may honestly be said about whether one is up). This
 * is the IO, and it holds three decisions of its own.
 *
 * 1. **EVERY WRITE IS THE HARNESS'S OWN COMMAND.** `~/.claude.json` is rewritten by every running
 *    `claude`, so a read-modify-write from here would lose our bytes or clobber theirs — the same
 *    reason `rename-spec.ts` types `/rename` instead of writing the session file. Where the CLI is
 *    absent the action is REFUSED in a sentence naming what does work, never approximated.
 * 2. **A WRITE IS AN EXPLICIT ACT, AND ITS SCOPE IS THE USER'S CHOICE.** Nothing here is called as
 *    a side effect of listing, and no scope is inferred: `user` reaches every project on this
 *    machine and `project` is written into a repository other people pull, so choosing between them
 *    is a decision, not a default. A per-directory scope with no directory is refused rather than
 *    quietly turned into `user`.
 * 3. **PATHS COME FROM `HOME_DIR`, never `CLAUDE_DIR`** — the same distinction `cli-hooks.ts` and
 *    `mcp-list.ts` make: `CLAUDE_DIR` can be a container's read-only mount of somebody else's
 *    `~/.claude`, and writing this machine's servers into it would configure the wrong machine.
 */

import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import type { LiveUnavailableReason } from '@agentistics/core'
import { HOME_DIR } from './config'
import { CAPS } from './exposure'
import { detectionUnavailable } from './live-sessions'
import {
  mcpAddArgs, mcpRemoveArgs, mergeScopes, parseMcpPaste, scopeNeedsProject, serversFromClaudeJson,
  serversFromMcpJson, validMcpName, type McpScope, type McpServer,
} from './mcp-config'
import { mcpRunState, type McpRunState, type ProcArgv } from './mcp-status'

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf-8')) } catch { return null }
}

/**
 * Every process this machine can see, as argv.
 *
 * Deliberately NOT `scanProcesses`: that one returns HARNESS processes, and an MCP server is not a
 * harness. The unavailability reason is shared, though, so an unreadable `/proc` says the same
 * thing here as it does on the live-sessions panel.
 */
async function readProcArgv(): Promise<{ procs: ProcArgv[]; unavailable: LiveUnavailableReason | null }> {
  if (!CAPS.localProcesses) return { procs: [], unavailable: 'capability-off' }
  if (process.platform !== 'linux') {
    return { procs: [], unavailable: detectionUnavailable({ platform: process.platform, procReadable: false, foreignPids: 0, cwdDenied: false }) }
  }
  let pids: string[]
  try { pids = await readdir('/proc') } catch { return { procs: [], unavailable: 'no-proc' } }
  const numeric = pids.filter(p => /^\d+$/.test(p))
  const own = String(process.pid)
  const foreignPids = numeric.filter(p => p !== own).length
  const procs: ProcArgv[] = []
  await Promise.all(numeric.map(async pid => {
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf-8').catch(() => ''))
      .split('\0').filter(Boolean)
    if (argv.length > 0) procs.push({ pid: Number(pid), argv })
  }))
  // `cwdDenied` is not part of this read — an MCP server is matched on ARGV, which is world
  // readable, so the uid mismatch that hides a cwd does not hide this.
  const unavailable = detectionUnavailable({ platform: 'linux', procReadable: true, foreignPids, cwdDenied: false })
  return { procs, unavailable }
}

export interface McpEntry extends McpServer {
  run: McpRunState
}

export interface McpListPayload {
  servers: McpEntry[]
  /** The directory the `local` and `project` scopes were read for, when there was one. */
  projectPath?: string
  /** True when `claude mcp` can be run here at all. False makes every write refuse, in words. */
  canWrite: boolean
}

/** Is the harness's own CLI on this machine? Cached: it does not appear mid-process. */
let cliPresent: boolean | null = null
async function claudeCliAvailable(): Promise<boolean> {
  if (cliPresent !== null) return cliPresent
  try {
    const proc = Bun.spawn(['claude', '--version'], { stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
    cliPresent = proc.exitCode === 0
  } catch { cliPresent = false }
  return cliPresent
}

/** Tests only. */
export function forgetMcpCliProbe(): void { cliPresent = null }

export async function listMcp(projectPath?: string | null): Promise<McpListPayload> {
  const dir = projectPath && path.isAbsolute(projectPath) ? projectPath : undefined
  const claudeJson = await readJson(path.join(HOME_DIR, '.claude.json'))
  const fromHome = serversFromClaudeJson(claudeJson, dir)
  const fromRepo = dir ? serversFromMcpJson(await readJson(path.join(dir, '.mcp.json')), dir) : []
  const merged = mergeScopes([...fromHome, ...fromRepo])
  const { procs, unavailable } = await readProcArgv()
  return {
    servers: merged.map(s => ({ ...s, run: mcpRunState(s, procs, unavailable) })),
    ...(dir ? { projectPath: dir } : {}),
    canWrite: await claudeCliAvailable(),
  }
}

export type McpWriteResult =
  | { ok: true; names: string[] }
  | { ok: false; message: string }

/** The sentence for a machine with no `claude` CLI — it names what does work. */
function noCli(pt: boolean): McpWriteResult {
  return {
    ok: false,
    message: pt
      ? 'O comando `claude` não está nesta máquina, e é ele que grava a configuração de MCP. Instale o Claude Code, ou edite ~/.claude.json à mão — agentop não escreve nesse arquivo porque todo `claude` em execução o reescreve.'
      : 'The `claude` command is not on this machine, and it is what writes the MCP configuration. Install Claude Code, or edit ~/.claude.json by hand — agentop does not write that file because every running `claude` rewrites it.',
  }
}

async function runClaude(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['claude', ...args], {
    stdout: 'pipe', stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { code: proc.exitCode ?? 1, out: `${out}${err}`.trim() }
}

/**
 * Add the servers in a pasted JSON document, in one scope.
 *
 * Decision 2: the scope is passed in and never inferred, and a per-directory scope with no
 * directory is refused rather than silently widened to `user` — the difference between the two is
 * "this repository" and "everything I ever open".
 */
export async function installMcp(o: {
  paste: string
  scope: McpScope
  name?: string
  projectPath?: string
  lang: 'pt' | 'en'
}): Promise<McpWriteResult> {
  const pt = o.lang === 'pt'
  if (!(await claudeCliAvailable())) return noCli(pt)
  if (scopeNeedsProject(o.scope) && !(o.projectPath && path.isAbsolute(o.projectPath))) {
    return {
      ok: false,
      message: pt
        ? 'Este escopo é resolvido contra um diretório, e nenhum foi informado — rodá-lo no diretório errado configura o projeto errado em silêncio.'
        : 'This scope is resolved against a directory and none was given — running it in the wrong one silently configures the wrong project.',
    }
  }
  if (o.name !== undefined && !validMcpName(o.name)) {
    return { ok: false, message: pt ? 'Esse nome não é um nome de servidor válido.' : 'That is not a valid server name.' }
  }
  const parsed = parseMcpPaste(o.paste, o.name)
  if (!parsed.ok) {
    const why: Record<typeof parsed.reason, { pt: string; en: string }> = {
      'not-json': { pt: 'Isso não é JSON válido.', en: 'That is not valid JSON.' },
      'not-an-object': { pt: 'Um servidor MCP é um objeto JSON; isto não é.', en: 'An MCP server is a JSON object; this is not.' },
      'no-servers': { pt: 'Não há nenhum servidor neste JSON.', en: 'There is no server in this JSON.' },
      'bad-name': { pt: 'Falta um nome para este servidor, ou o nome não é utilizável.', en: 'This server has no usable name.' },
      'bad-entry': { pt: 'Uma das entradas não tem `command` nem `url`, então não descreve um servidor.', en: 'One entry has neither `command` nor `url`, so it does not describe a server.' },
    }
    // REFUSED, not repaired — and the reason is said, because "we could not read that" and "that
    // server does not work" send a reader to two different places.
    return { ok: false, message: why[parsed.reason][pt ? 'pt' : 'en'] }
  }

  const done: string[] = []
  for (const server of parsed.servers) {
    const r = await runClaude(mcpAddArgs(server, o.scope), scopeNeedsProject(o.scope) ? o.projectPath : undefined)
    if (r.code !== 0) {
      return {
        ok: false,
        message: (done.length > 0
          ? (pt ? `Adicionado: ${done.join(', ')}. Parou em ${server.name}: ` : `Added: ${done.join(', ')}. Stopped at ${server.name}: `)
          : '') + (r.out || (pt ? 'o comando falhou.' : 'the command failed.')),
      }
    }
    done.push(server.name)
  }
  return { ok: true, names: done }
}

/**
 * REPLACE one server's configuration, in place.
 *
 * `claude mcp add-json` REFUSES a name that already exists ("already exists in local config",
 * measured), so an edit is a removal followed by an addition — two operations, and the window
 * between them is one where the server is gone.
 *
 * So the failure of the second is handled rather than reported: the ORIGINAL json is put back, and
 * the answer says which of the three things happened. Losing somebody's MCP configuration to a
 * typo in a field they were editing is the outcome this exists to prevent, and "it failed" with the
 * old one already deleted is the same loss with a message on top.
 *
 * The caller passes the original because it is the only thing that can restore it, and it is on
 * screen at the moment they press the button — the panel is showing it.
 */
export async function replaceMcp(o: {
  name: string
  scope: McpScope
  paste: string
  original: string
  projectPath?: string
  lang: 'pt' | 'en'
}): Promise<McpWriteResult> {
  const pt = o.lang === 'pt'
  if (!(await claudeCliAvailable())) return noCli(pt)
  if (!validMcpName(o.name)) {
    return { ok: false, message: pt ? 'Esse nome não é um nome de servidor válido.' : 'That is not a valid server name.' }
  }
  // The NEW config is parsed BEFORE anything is removed. A paste that cannot be read must never
  // cost the configuration that is already working.
  const parsed = parseMcpPaste(o.paste, o.name)
  if (!parsed.ok || parsed.servers.length !== 1) {
    return {
      ok: false,
      message: pt
        ? 'Não consegui ler esse JSON como UM servidor — nada foi alterado.'
        : 'That JSON does not read as ONE server — nothing was changed.',
    }
  }
  const next = { name: o.name, json: parsed.servers[0]!.json }
  const cwd = scopeNeedsProject(o.scope) ? o.projectPath : undefined
  if (scopeNeedsProject(o.scope) && !(cwd && path.isAbsolute(cwd))) {
    return {
      ok: false,
      message: pt
        ? 'Este escopo é resolvido contra um diretório, e nenhum foi informado.'
        : 'This scope is resolved against a directory and none was given.',
    }
  }

  const removed = await runClaude(mcpRemoveArgs(o.name, o.scope), cwd)
  if (removed.code !== 0) {
    return { ok: false, message: removed.out || (pt ? 'não consegui remover a versão antiga.' : 'the old version could not be removed.') }
  }
  const added = await runClaude(mcpAddArgs(next, o.scope), cwd)
  if (added.code === 0) return { ok: true, names: [o.name] }

  // The add failed and the old one is already gone — put it back.
  const restored = await runClaude(mcpAddArgs({ name: o.name, json: o.original }, o.scope), cwd)
  return {
    ok: false,
    message: restored.code === 0
      ? (pt
        ? `A alteração falhou e a configuração anterior foi restaurada. O comando disse: ${added.out || 'nada'}`
        : `The change failed and the previous configuration was restored. The command said: ${added.out || 'nothing'}`)
      // Both failed. SAY it, loudly — the panel still holds the original json on screen.
      : (pt
        ? `A alteração falhou E a restauração também: "${o.name}" NÃO está mais configurado. Copie o JSON original desta tela e adicione de novo. O comando disse: ${added.out || 'nada'}`
        : `The change failed AND the restore failed too: "${o.name}" is NO LONGER configured. Copy the original JSON from this screen and add it again. The command said: ${added.out || 'nothing'}`),
  }
}

/** The exact inverse of an install: the same name, in the same scope it was written to. */
export async function uninstallMcp(o: {
  name: string
  scope: McpScope
  projectPath?: string
  lang: 'pt' | 'en'
}): Promise<McpWriteResult> {
  const pt = o.lang === 'pt'
  if (!(await claudeCliAvailable())) return noCli(pt)
  if (!validMcpName(o.name)) {
    return { ok: false, message: pt ? 'Esse nome não é um nome de servidor válido.' : 'That is not a valid server name.' }
  }
  if (scopeNeedsProject(o.scope) && !(o.projectPath && path.isAbsolute(o.projectPath))) {
    return {
      ok: false,
      message: pt
        ? 'Este escopo é resolvido contra um diretório, e nenhum foi informado.'
        : 'This scope is resolved against a directory and none was given.',
    }
  }
  const r = await runClaude(mcpRemoveArgs(o.name, o.scope), scopeNeedsProject(o.scope) ? o.projectPath : undefined)
  return r.code === 0
    ? { ok: true, names: [o.name] }
    : { ok: false, message: r.out || (pt ? 'o comando falhou.' : 'the command failed.') }
}
