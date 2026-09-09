/**
 * skill-source.ts — PURE: what a skill IS, where each harness keeps them, and how one is named.
 *
 * Split out of `harness-skills.ts` so a module with no business touching the filesystem can read
 * these rules. `chat-envelope.ts` needs `skillNameFromDir` to say WHICH skill a note is about, and
 * it is a zero-import pure parser: importing the reader would have dragged `HOME_DIR` and the whole
 * of `config.ts` — which reads the environment at import time — into it. Only `readHarnessSkills`
 * ever needed a home directory, so the split falls exactly along that line.
 *
 * `harness-skills.ts` re-exports everything here, so every existing importer is untouched.
 */

import type { HarnessId } from '@agentistics/core'

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
/** Where `needle` sits inside `hay` as a run of consecutive segments, or -1. */
function segmentRun(hay: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > hay.length) return -1
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break }
    if (ok) return i
  }
  return -1
}

/**
 * PURE: the INVOCATION name of the skill whose base directory this is, or `null`.
 *
 * The injected entry that produces the `a skill was loaded` note carries exactly one useful fact —
 * `Base directory for this skill: <dir>` — and `chat-envelope.ts` used to drop it, so the chip
 * could open the skills tab and never say WHICH row. This is what turns that directory back into
 * something the panel can match.
 *
 * It must come out as the INVOCATION name, prefix and all, because that is what `HarnessSkill.name`
 * is and what the panel lists; `path` deliberately never crosses to the browser. And the layouts
 * are read from the `SkillSource` this harness already declares rather than re-derived here — the
 * plugin shape (`<root>/<marketplace>/<plugin>/<version>/skills/<name>`, invoked `<plugin>:<name>`)
 * is stated once, in `HARNESS_SKILLS`, and two readers now depend on that one statement.
 *
 * A directory matching NO declared source answers `null` rather than falling back to its basename.
 * A basename would look like an answer and resolve to no row in the panel, which is the confident
 * wrong value this codebase refuses everywhere else — the caller then simply omits the reference
 * and the chip behaves exactly as it does today.
 */
export function skillNameFromDir(dir: string, source: SkillSource): string | null {
  const parts = dir.split('/').filter(p => p !== '')
  if (parts.length === 0) return null
  const name = parts[parts.length - 1]!

  for (const root of source.pluginRoots) {
    const rootParts = root.split('/').filter(p => p !== '')
    const at = segmentRun(parts, rootParts)
    if (at === -1) continue
    // <root>/<marketplace>/<plugin>/<version>/skills/<name> — a FIXED depth, for the reason
    // `SkillSource.pluginRoots` gives: it is the layout the CLI writes, not something to search for.
    const nameAt = at + rootParts.length + 4
    if (nameAt !== parts.length - 1) continue
    if (parts[nameAt - 1] !== 'skills') continue
    const plugin = parts[at + rootParts.length + 1]
    if (!plugin) continue
    return `${plugin}:${name}`
  }

  for (const dirSeg of [...source.userDirs, ...source.projectDirs]) {
    const segParts = dirSeg.split('/').filter(p => p !== '')
    const at = segmentRun(parts, segParts)
    if (at === -1) continue
    if (at + segParts.length !== parts.length - 1) continue
    return name
  }
  return null
}
