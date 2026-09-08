/**
 * harness-defaults.ts — the model and effort each CLI will use HERE when none is passed.
 *
 * `spawn-spec.ts` holds what the TOOL publishes and, for defaults, holds nothing: measured on all
 * six CLIs, none prints one in its own `--help`, and that module is a pure static table which a
 * per-machine answer could not honestly live in. Its note ends by saying so about kimi — "it is
 * THIS MACHINE's configuration rather than the CLI's".
 *
 * That is a reason not to put the answer in a static table, not a reason to withhold it. This
 * machine's configuration is exactly what the session about to be started will obey, and a picker
 * offering "Default" without saying what the default IS names a thing without naming it — reported
 * as "you are not showing the default values for model and effort". So the answer is read HERE,
 * impurely, at the moment the wizard asks, from the file each CLI documents as its own.
 *
 * EVERY ENTRY NAMES ITS FILE AND KEY, and was verified by reading a real one on 2026-09-05:
 *
 * - claude    `~/.claude/settings.json` → `model`  (e.g. `opus[1m]`). No effort key exists.
 * - codex     `~/.codex/config.toml`    → `model`, `model_reasoning_effort`.
 * - kimi      `~/.kimi-code/config.toml`→ `default_model`, which `kimi --help` names by KEY.
 * - antigravity `~/.gemini/antigravity-cli/settings.json` → `model` (a DISPLAY name, e.g.
 *   `Gemini 3.6 Flash (Medium)`) — shown as read, never mapped onto a `--model` value it may not be.
 * - gemini    `~/.gemini/settings.json` carries no model key. ABSENT, and absent is the answer.
 * - copilot   its user settings file carries no model key. ABSENT.
 *
 * IT NAMES NOTHING ELSE IN THOSE FILES. They also hold credentials — `~/.copilot/config.json`
 * holds a live GitHub token, and the antigravity settings hold a GCP project and a permission
 * allowlist — so this module reads ONE named key per file and `harness-defaults.test.ts` greps its
 * own source and fails if it so much as mentions another. Same guard, and the same reason, as
 * `billing-detect.ts`.
 *
 * A DEFAULT IS A READING, NEVER A CLAIM. An unreadable file, a missing key, a value of the wrong
 * shape and a harness with no such file are all the same answer here: nothing. The picker then says
 * "Default", exactly as it did before, rather than "Default (something we guessed)".
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { HOME_DIR } from '../config'

/** What one harness will do with no flags, as far as this machine can be read. */
export interface HarnessDefaults {
  model?: string
  effort?: string
}

/**
 * One key out of a JSON document, as a non-empty string.
 *
 * Total: a document that will not parse, is not an object, or holds the key as anything but a
 * string yields nothing. A default is a convenience; it may never be a reason a wizard fails.
 */
export function jsonStringKey(text: string, key: string): string | undefined {
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return undefined }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined
  const v = (doc as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/**
 * One TOP-LEVEL key out of a TOML document, as a string.
 *
 * Deliberately not a TOML parser: the two files read here state their model at the top level, and
 * a dependency-free reader that stops at the first `[section]` header cannot be tricked by a
 * same-named key deeper in the document into reporting a default that is not in force. Quotes are
 * required, because every value this reads is a string in both files; a bare value is left alone
 * rather than half-understood.
 */
export function tomlTopKey(text: string, key: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#') || line === '') continue
    // A section header ends the top level. Everything after it belongs to something.
    if (line.startsWith('[')) return undefined
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (line.slice(0, eq).trim() !== key) continue
    const value = line.slice(eq + 1).trim().replace(/\s*#.*$/, '').trim()
    const m = /^"([^"]*)"$|^'([^']*)'$/.exec(value)
    const out = (m?.[1] ?? m?.[2] ?? '').trim()
    return out === '' ? undefined : out
  }
  return undefined
}

/** Read a file, or nothing. A default never throws — see the header. */
async function text(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf-8') } catch { return null }
}

/**
 * What this machine has configured for one harness.
 *
 * `HOME_DIR`, never a harness data-dir constant: these are the USER's own settings files, and a
 * container mounting somebody else's `~/.claude` read-only would otherwise report that person's
 * default as this machine's. Same distinction `cli-hooks.ts` and `mcp-list.ts` make.
 */
export async function readHarnessDefaults(harness: HarnessId): Promise<HarnessDefaults> {
  switch (harness) {
    case 'claude': {
      const t = await text(join(HOME_DIR, '.claude', 'settings.json'))
      const model = t ? jsonStringKey(t, 'model') : undefined
      return model ? { model } : {}
    }
    case 'codex': {
      const t = await text(join(HOME_DIR, '.codex', 'config.toml'))
      if (!t) return {}
      const model = tomlTopKey(t, 'model')
      const effort = tomlTopKey(t, 'model_reasoning_effort')
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    }
    case 'kimi': {
      const t = await text(join(HOME_DIR, '.kimi-code', 'config.toml'))
      const model = t ? tomlTopKey(t, 'default_model') : undefined
      return model ? { model } : {}
    }
    case 'antigravity': {
      const t = await text(join(HOME_DIR, '.gemini', 'antigravity-cli', 'settings.json'))
      const model = t ? jsonStringKey(t, 'model') : undefined
      return model ? { model } : {}
    }
    // Their settings files carry no model key at all — see the header. Absent is the answer, and
    // it is listed rather than defaulted so a harness added later cannot fall through silently.
    case 'gemini':
    case 'copilot':
      return {}
  }
}
