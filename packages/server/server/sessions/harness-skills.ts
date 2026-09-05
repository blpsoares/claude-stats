/**
 * harness-skills.ts — which skills the assistant in a session can be asked to run, and how.
 *
 * A `Record<HarnessId, SkillSource | null>`, shaped like `rename-spec.ts` and `modelSwitch.ts`:
 * adding a harness breaks the build here rather than silently shipping a control that does
 * nothing, and every `null` is a FINDING with its own sentence rather than an omission.
 *
 * ONLY CLAUDE IS WIRED. Its skills are files on disk with a documented frontmatter, and the way to
 * run one is the slash command the CLI itself resolves. For the other five there is no discovered
 * format and no verified command, and a guessed slash command does not fail loudly — it types a
 * line of nonsense into a live session.
 *
 * PATHS COME FROM `HOME_DIR`, never `CLAUDE_DIR`. The two differ exactly where it matters: a
 * container can mount somebody else's `~/.claude` read-only, and reading skills out of it would
 * offer the operator's skills to a session that cannot run them. Same distinction `cli-hooks.ts`
 * and `mcp-list.ts` make.
 *
 * MEASURED on this machine against claude 2.1.260, because the plugin layout is not the one a
 * flat walk would find:
 *   ~/.claude/skills/<name>/SKILL.md                                       → `/<name>`
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
 *                                                                          → `/<plugin>:<name>`
 *   <cwd>/.claude/skills/<name>/SKILL.md                                   → `/<name>`
 * The plugin prefix is the PLUGIN segment, not the marketplace — `superpowers-dev/superpowers/
 * 6.0.2/skills/brainstorming` is invoked as `/superpowers:brainstorming`, and
 * `blpsoares/claude-code-notifications/1.7.0` as `claude-code-notifications:…`. Walking the cache
 * root as though it held skill directories (which is what a single flat `userDirs` entry would do)
 * finds nothing at all: its first level is marketplaces.
 *
 * The list is a CONVENIENCE for typing, never an authority: what the session accepts is whatever
 * its own CLI resolves — a plugin can be installed and disabled, and nothing on disk says so — and
 * this only helps somebody type it.
 */

import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { HOME_DIR } from '../config'

export interface HarnessSkill {
  /** The INVOCATION name, prefix included — what `skillLine` turns into a typed line. */
  name: string
  description: string
  scope: 'user' | 'plugin' | 'project'
  /**
   * The `SKILL.md` this was read from.
   *
   * Carried so the panel can SHOW a skill rather than only name it — and it is the server that
   * holds it, never the browser: the detail route takes a skill NAME and resolves it back through
   * this same list, so no path a client sent is ever opened. That is the whole reason this field
   * exists here instead of on the wire.
   */
  path: string
}

export interface SkillSource {
  /** `<HOME_DIR>/<dir>/<name>/SKILL.md`. */
  userDirs: string[]
  /**
   * `<HOME_DIR>/<root>/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md`, invoked as
   * `<plugin>:<name>`. A fixed depth rather than a search: it is the layout the CLI writes, and a
   * recursive hunt for `SKILL.md` under a home directory is a different and much slower promise.
   */
  pluginRoots: string[]
  /** `<cwd>/<dir>/<name>/SKILL.md`. */
  projectDirs: string[]
  /** The line typed to invoke one. `{name}` is replaced. */
  line: string
}

export const HARNESS_SKILLS: Record<HarnessId, SkillSource | null> = {
  // Verified against claude 2.1.260 on this machine — see the layout in the header.
  claude: {
    userDirs: ['.claude/skills'],
    pluginRoots: ['.claude/plugins/cache'],
    projectDirs: ['.claude/skills'],
    line: '/{name}',
  },
  // No documented skill mechanism reachable from a typed line.
  codex: null,
  gemini: null,
  copilot: null,
  antigravity: null,
  kimi: null,
}

/** Why the picker is absent, so the menu says it instead of leaving a hole. */
export function skillsReason(harness: string, lang: 'en' | 'pt'): string | null {
  if (HARNESS_SKILLS[harness as HarnessId]) return null
  return lang === 'pt'
    ? 'Invocar skills a partir daqui só está verificado no Claude Code.'
    : 'Invoking skills from here is only verified for Claude Code.'
}

/**
 * PURE: the `name` and `description` out of a SKILL.md's frontmatter.
 *
 * Deliberately a small hand parser rather than a YAML dependency: it reads two scalar keys out of
 * a leading `---` block, and it is TOTAL — a malformed, unterminated or empty document yields `{}`
 * rather than throwing. A skill file somebody is midway through editing must not take the picker
 * down with it.
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^\s*(name|description)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2]!.trim().replace(/^["']|["']$/g, '')
    if (value !== '') out[m[1] as 'name' | 'description'] = value
  }
  return out
}

/** The line to type for a skill, or null where the harness has none. */
export function skillLine(harness: string, name: string): string | null {
  const spec = HARNESS_SKILLS[harness as HarnessId]
  if (!spec || name === '') return null
  return spec.line.replace('{name}', name)
}

/** The IO half. Unreadable directories and files are skipped, never thrown. */
export async function readHarnessSkills(harness: string, cwd: string): Promise<HarnessSkill[]> {
  const spec = HARNESS_SKILLS[harness as HarnessId]
  if (!spec) return []
  const { readdir, readFile } = await import('node:fs/promises')
  const found = new Map<string, HarnessSkill>()

  const dirs = async (root: string): Promise<string[]> => {
    try { return await readdir(root) } catch { return [] }
  }

  /** One directory of skill directories. `prefix` is a plugin's, empty for user and project. */
  const walk = async (root: string, scope: HarnessSkill['scope'], prefix: string) => {
    for (const entry of await dirs(root)) {
      try {
        const text = await readFile(join(root, entry, 'SKILL.md'), 'utf8')
        const fm = parseSkillFrontmatter(text)
        const name = `${prefix}${fm.name ?? entry}`
        // First writer wins: a project skill and a user skill of the same name are one command, and
        // listing it twice would offer a choice the CLI does not have.
        if (!found.has(name)) {
          found.set(name, {
            name, description: fm.description ?? '', scope, path: join(root, entry, 'SKILL.md'),
          })
        }
      } catch { /* not a skill directory, or unreadable */ }
    }
  }

  for (const d of spec.userDirs) await walk(join(HOME_DIR, d), 'user', '')
  for (const r of spec.pluginRoots) {
    const root = join(HOME_DIR, r)
    for (const marketplace of await dirs(root)) {
      for (const plugin of await dirs(join(root, marketplace))) {
        for (const version of await dirs(join(root, marketplace, plugin))) {
          await walk(join(root, marketplace, plugin, version, 'skills'), 'plugin', `${plugin}:`)
        }
      }
    }
  }
  for (const d of spec.projectDirs) await walk(join(cwd, d), 'project', '')

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}
