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
import { HARNESS_SKILLS, type HarnessSkill, parseSkillFrontmatter } from './skill-source'
import { HOME_DIR } from '../config'

// The PURE half lives in `skill-source.ts` and is re-exported, so every existing importer of this
// module is untouched. See that file's header for why the split exists.
export * from './skill-source'

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

