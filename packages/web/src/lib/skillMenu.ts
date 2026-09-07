/**
 * skillMenu.ts — PURE: invoking a skill by typing `/` in the composer.
 *
 * A skill is something you INVOKE while writing, so it belongs where the writing happens. It was
 * only reachable from the composer's "more options" menu, which is the shape of a setting — you
 * stop, open a menu, hunt a list of 49 entries, and come back. Every assistant CLI in this product
 * takes them as `/<name>`, and that is the gesture people already have in their fingers.
 *
 * FOUR DECISIONS live here, because each of them can be wrong and none of them belongs in JSX:
 *
 * 1. WHEN THE PICKER IS OPEN. A `/` only starts a command at the START OF A LINE — `and/or` in the
 *    middle of a sentence is not an invocation, and a picker that opened there would steal the
 *    arrow keys from someone writing prose. The trigger is read from the text BEFORE THE CARET, so
 *    it follows where the person is actually typing rather than where the draft happens to end.
 *
 * 2. THE GROUPING. A skill's name is `package:skill` where it came from a plugin, and the package
 *    is the only thing that makes a list of 49 readable — `superpowers:brainstorming` and
 *    `superpowers:writing-plans` are one body of work. Names with no colon are the machine's own
 *    loose skills and get a group NAMED for that, never an empty heading: a heading with no word
 *    on it reads as a rendering fault.
 *
 * 3. THE FILTER. Matching the NAME alone is not enough — half of these are named for what they do
 *    (`brainstorming`) and half for a tool (`wrangler`), and only the description tells you which
 *    is which. Typing after the `/` filters on both.
 *
 * 4. WHAT INSERTION WRITES. It REPLACES the `/partial` the person typed with `/<name> ` and never
 *    sends: most skills take an argument, and the composer's whole contract is that what reaches
 *    the session is what the person chose to send. That rule already exists in the menu and does
 *    not change here.
 */

/** One skill as the server reports it. Structural, so this module imports no view. */
export interface MenuSkill {
  name: string
  description: string
}

/** One package's worth of skills, under the heading the UI prints. */
export interface SkillGroup {
  /** The package name, or `null` for the machine's own un-packaged skills. */
  pkg: string | null
  /** Already localized — `pkg` where there is one, the un-packaged sentence where there is not. */
  label: string
  skills: MenuSkill[]
}

/** The heading un-packaged skills sit under. Never an empty string — see the header. */
export function looseGroupLabel(lang: 'pt' | 'en'): string {
  return lang === 'pt' ? 'Sem pacote' : 'No package'
}

/**
 * The package a skill belongs to: everything before the FIRST colon.
 *
 * First and not last, because a plugin skill is `plugin:skill` and a name carrying a second colon
 * would otherwise be filed under a package nobody installed. An empty half on either side is not a
 * package — `":x"` and `"x:"` are malformed names, and inventing a group called `""` for them puts
 * a blank heading on the screen.
 */
export function skillPackage(name: string): string | null {
  const at = name.indexOf(':')
  if (at <= 0) return null
  if (at === name.length - 1) return null
  return name.slice(0, at)
}

/**
 * Group by package, in reading order.
 *
 * Packages come first, alphabetically, and the loose group LAST: a package is a body of work
 * somebody installed on purpose, while the loose ones are whatever else is on the machine. Within
 * a group the order is the server's own — it already answers sorted, and re-sorting here would be
 * a second ordering rule for the same list.
 *
 * Case-insensitive comparison for the package order only; the package's own casing is preserved,
 * because that is what the directory is called.
 */
export function groupSkills(skills: readonly MenuSkill[], lang: 'pt' | 'en'): SkillGroup[] {
  const packaged = new Map<string, MenuSkill[]>()
  const loose: MenuSkill[] = []
  for (const sk of skills) {
    const pkg = skillPackage(sk.name)
    if (pkg === null) { loose.push(sk); continue }
    const bucket = packaged.get(pkg)
    if (bucket) bucket.push(sk)
    else packaged.set(pkg, [sk])
  }
  const out: SkillGroup[] = [...packaged.entries()]
    .sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()))
    .map(([pkg, list]) => ({ pkg, label: pkg, skills: list }))
  if (loose.length > 0) out.push({ pkg: null, label: looseGroupLabel(lang), skills: loose })
  return out
}

/**
 * Narrow the list by what was typed after the `/`.
 *
 * Case-insensitive, and matched against the name AND the description — see decision 3 in the
 * header. A blank query returns everything: here, unlike a search box, an empty query means "the
 * picker just opened", not "nothing was asked for".
 */
export function filterSkills(skills: readonly MenuSkill[], query: string): MenuSkill[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...skills]
  return skills.filter(sk =>
    sk.name.toLowerCase().includes(q) || sk.description.toLowerCase().includes(q))
}

/**
 * Is the caret inside a slash command, and what has been typed into it?
 *
 * `before` is the draft text UP TO the caret. The picker is open when the current line — the text
 * after the last newline — is a `/` followed by no whitespace. Consequences, all deliberate:
 *
 * - `''` → closed. A `/` has to be typed before anything is offered.
 * - `'/'` → open with an empty query, which is the whole list.
 * - `'/brain'` → open, query `brain`.
 * - `'/foo '` → CLOSED. A space ends the command and starts its argument; a picker still standing
 *   there would take the arrow keys away from someone writing the argument.
 * - `'hello /foo'` → closed. `and/or` is not an invocation.
 * - `'line one\n/foo'` → open. A new line is a new command.
 */
export function slashQuery(before: string): string | null {
  const line = before.slice(before.lastIndexOf('\n') + 1)
  if (!line.startsWith('/')) return null
  const rest = line.slice(1)
  if (/\s/.test(rest)) return null
  return rest
}

/** The draft and caret after an insertion — the caller writes both back to the field. */
export interface SkillInsertion {
  text: string
  caret: number
}

/**
 * Replace the `/partial` at the caret with `/<name> `, keeping everything else.
 *
 * The text AFTER the caret is preserved, so completing a command typed into the middle of an
 * already-written prompt does not eat the rest of it. Where the caret is not in a slash command at
 * all this APPENDS instead — the same thing the "more options" menu does — because a picker can
 * only be dismissed between the click and this call by something the user did, and losing their
 * pick to that race would be the worse of the two answers.
 */
export function applySkill(draft: string, caret: number, name: string): SkillInsertion {
  const at = Math.max(0, Math.min(caret, draft.length))
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const query = slashQuery(before)
  if (query === null) {
    const head = draft.replace(/\s+$/, '')
    const text = head === '' ? `/${name} ` : `${head} /${name} `
    return { text, caret: text.length }
  }
  const start = before.length - query.length - 1
  const inserted = `/${name} `
  return { text: draft.slice(0, start) + inserted + after, caret: start + inserted.length }
}

/**
 * Every skill of every group, in the order they are drawn.
 *
 * The picker is navigated with the arrow keys, which move through a FLAT list — the groups are
 * headings, not stops. This is the one place that flattening happens, so the cursor and the
 * rendering can never disagree about which entry is the third one.
 */
export function flattenGroups(groups: readonly SkillGroup[]): MenuSkill[] {
  return groups.flatMap(g => g.skills)
}

/**
 * Move the cursor, WRAPPING at both ends.
 *
 * A menu is a ring — pressing down on the last entry takes you to the first, which is what every
 * other list in this product does (`resolveListKey` in the cockpit) and what a reader expects from
 * a picker with more entries than fit. Returns 0 for an empty list so a caller can index blindly.
 */
export function stepSkill(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return 0
  return ((current + direction) % total + total) % total
}

/**
 * What the picker says when the filter matches nothing.
 *
 * "Nothing installed" and "nothing by that name" are DIFFERENT facts and get different sentences:
 * a machine with 49 skills reporting "no skills" over a typo reads as a broken install.
 */
export function emptyPickerReason(installed: number, query: string, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  if (installed === 0) {
    return pt ? 'Nenhuma skill instalada para esta sessão.' : 'No skills installed for this session.'
  }
  return pt
    ? `Nenhuma das ${installed} skills tem “${query}” no nome ou na descrição.`
    : `None of the ${installed} skills has “${query}” in its name or description.`
}


/**
 * Was a `/` just typed somewhere a command CANNOT be?
 *
 * Reported as "nem sempre ele ta identificando", with `asdasd /` in the field and nothing
 * happening. Nothing happening is correct — a slash in the middle of a line is a slash, and the
 * harness runs a command only when the line begins with one — but SILENCE is what makes a correct
 * refusal look like a broken feature. The picker opens for the same `/` one column earlier, so from
 * the outside it reads as unreliable rather than as a rule.
 *
 * So this is the sentence's condition, and nothing more: the caret sits immediately after a `/`
 * that is not at the start of its line. It is deliberately narrow — it does not fire while somebody
 * types a path or a date, only in the instant the slash itself was typed, which is the moment the
 * expectation was formed.
 */
export function slashMisplaced(before: string): boolean {
  if (!before.endsWith('/')) return false
  const line = before.slice(before.lastIndexOf('\n') + 1)
  return line.length > 1
}
