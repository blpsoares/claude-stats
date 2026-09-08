/**
 * skillGroups.ts — PURE: how the skills panel is arranged and searched.
 *
 * A machine with fifty-one skills is a flat list nobody reads. They arrive already carrying what
 * groups them — a plugin skill is invoked as `plugin:name`, which is the CLI's own naming and not a
 * guess — so the package is READ off the name rather than inferred from anything else.
 *
 * Three rules:
 *
 * 1. THE PACKAGE IS THE PREFIX, and only when the harness said there is one. `scope: 'plugin'`
 *    means the name carries `plugin:`; a `user` or `project` skill has no package and is filed
 *    under a bucket named in WORDS, never under an invented package name.
 * 2. SEARCH MATCHES WHAT IS ON SCREEN — the name and the description, case-folded. A search that
 *    silently also matched a field the reader cannot see makes an unexplainable result.
 * 3. AN EMPTY SEARCH IS NOT A FILTER. It returns everything, so clearing the field restores the
 *    list rather than emptying it.
 */

export interface SkillEntry {
  name: string
  description: string
  scope?: 'user' | 'plugin' | 'project' | string
}

export interface SkillGroup {
  /** The package's own name (`superpowers`), or `''` for the ones that have none. */
  key: string
  /** Already localized, and for `''` it is a sentence rather than a name. */
  label: string
  skills: SkillEntry[]
}

/** The package a skill belongs to, or `''` when it belongs to none. */
export function packageOf(skill: SkillEntry): string {
  if (skill.scope !== 'plugin') return ''
  const i = skill.name.indexOf(':')
  return i > 0 ? skill.name.slice(0, i) : ''
}

/** The part a person types after the package — what the row shows under a package heading. */
export function shortName(skill: SkillEntry): string {
  const pkg = packageOf(skill)
  return pkg === '' ? skill.name : skill.name.slice(pkg.length + 1)
}

export function matchesSkill(skill: SkillEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q)
}

/**
 * The groups, ordered: packages alphabetically, and the package-less ones LAST under their own
 * heading — they are the machine's own skills and reading them as a package would be a lie about
 * where they came from.
 */
export function groupSkills(
  skills: readonly SkillEntry[], query: string, lang: 'pt' | 'en',
): SkillGroup[] {
  const pt = lang === 'pt'
  const by = new Map<string, SkillEntry[]>()
  for (const sk of skills) {
    if (!matchesSkill(sk, query)) continue
    const key = packageOf(sk)
    const list = by.get(key) ?? []
    list.push(sk)
    by.set(key, list)
  }
  const keys = [...by.keys()].filter(k => k !== '').sort((a, b) => a.localeCompare(b))
  const out: SkillGroup[] = keys.map(key => ({
    key,
    label: key,
    skills: [...(by.get(key) ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  }))
  const loose = by.get('')
  if (loose && loose.length > 0) {
    out.push({
      key: '',
      label: pt ? 'Suas skills (sem pacote)' : 'Your own skills (no package)',
      skills: [...loose].sort((a, b) => a.name.localeCompare(b.name)),
    })
  }
  return out
}

/** How many skills survived the search — what the "nothing found" sentence is decided on. */
export function countSkills(groups: readonly SkillGroup[]): number {
  return groups.reduce((n, g) => n + g.skills.length, 0)
}

/** The line that INVOKES a skill, exactly as a person would type it. */
export function skillInvocation(skill: SkillEntry): string {
  return `/${skill.name} `
}


/**
 * A `SKILL.md`'s YAML header, separated from the document.
 *
 * Markdown does not know what frontmatter is: rendered, the opening `---` becomes a horizontal rule
 * and `name:` / `description:` become a paragraph that reads like the skill's first sentence. It is
 * a header, so it is shown as one.
 *
 * The delimiter must be the FIRST line — a `---` further down is a rule in the document and closing
 * on it would eat half the skill.
 */
export function splitFrontmatter(text: string): { front: string; body: string } {
  if (!/^---\r?\n/.test(text)) return { front: '', body: text }
  const rest = text.replace(/^---\r?\n/, '')
  const end = rest.search(/^---\s*$/m)
  if (end < 0) return { front: '', body: text }
  return {
    front: rest.slice(0, end).replace(/\s+$/, ''),
    body: rest.slice(end).replace(/^---\s*\r?\n?/, ''),
  }
}
