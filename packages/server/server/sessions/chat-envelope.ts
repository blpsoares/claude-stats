/**
 * chat-envelope.ts — PURE: is a `type: 'user'` transcript entry something the PERSON said?
 *
 * Claude Code writes several kinds of entry under the `user` role that no person typed. They are
 * the harness talking to itself in the one channel the transcript has for input: a background task
 * reporting back, a hook's output, a reminder injected before a turn, the stdout of a `!` command.
 * `isHumanUserEntry` (jsonl.ts) does not separate them — it only excludes a pure `tool_result` —
 * so the chat pane rendered every one of them in the user's own bubble, over their avatar.
 *
 * Reported by the user, who circled a `<task-notification>` block and said "I didn't send that
 * message." They were right, and it is the same class of defect as `sessionLabel()` stripping
 * `<local-command-caveat>` out of a title: the transcript's raw text is a wire format, and putting
 * it on screen attributes the harness's plumbing to a human being.
 *
 * MEASURED on this machine, over the 40 most recently touched transcripts — 715 user entries
 * carrying text, of which 116 (16%) were an envelope:
 *
 *   54  <task-notification>      a background task finished        SYSTEM
 *   24  <system-reminder>        injected context for the turn     SYSTEM
 *   11  <local-command-caveat>   "the messages below were…"        SYSTEM
 *   11  <command-name>           a slash command the user ran      PERSON (unwrapped)
 *    5  <local-command-stdout>   that command's output             SYSTEM
 *    5  <bash-input>             a `!` line the user ran           PERSON (unwrapped)
 *    5  <bash-stdout>            that line's output                SYSTEM
 *    1  <command-message>        the slash command's own text      PERSON (unwrapped)
 *
 * The split is not cosmetic. `<command-name>` and `<bash-input>` ARE the person acting — dropping
 * them would erase a turn that happened — so they are UNWRAPPED to the thing they typed (`/foo`,
 * `!ls`) rather than shown as XML or hidden. Everything else is the harness, and is reported as a
 * one-line note naming WHAT it was, never its body: a `<system-reminder>` can be the whole of
 * CLAUDE.md, and a pane that renders it has stopped being a conversation.
 *
 * The list is a matched pair with the measurement above and nothing more — an envelope nobody has
 * seen is not in it. An UNRECOGNISED entry is therefore treated as the person's, which is the safe
 * direction: a real message wrongly hidden is gone, while a new envelope wrongly shown is the
 * behaviour that already shipped.
 *
 * ---
 *
 * THE TAG TABLE IS ONLY HALF OF IT, and the other half is a flag the harness sets itself.
 * Re-measured 2026-09-04 over the 120 most recently touched transcripts — 992 `user` entries
 * carrying text:
 *
 *   800  isMeta ABSENT   the person
 *   192  isMeta true     the harness, and 148 of those carry NO envelope tag at all
 *     0  isMeta false    never written
 *
 * Those 148 went into the person's own bubble, because the table above decides by LEADING TAG and
 * they have none. By first line:
 *
 *    52  Another Claude session sent a message:
 *    31  [Image: …]                          (`source: <path>`, and `original WxH…`)
 *    21  Continue from where you left off.
 *    13  Base directory for this skill: /…   ← the block the user circled, a whole SKILL.md
 *     6  The coordinator sent a message while you were working…
 *     2  ## Context Usage
 *     2  a `/config` output
 *
 * So `classifyUserEntry` checks the FLAG FIRST — it is the harness declaring the entry is not a
 * turn the person took — and the tag table keeps doing the job the flag cannot: unwrapping
 * `<command-name>` and `<bash-input>` to the thing the person actually typed. Those ARE the person
 * acting, and dropping them would erase a turn that happened.
 *
 * Note the shape: a person's entry does not carry `isMeta: false`, it carries no `isMeta` key. The
 * test keys on `=== true` so that both an absent flag and an explicit `false` read as the person —
 * the direction that has to be safe.
 */

/** What a `user` entry turns out to be. */
export type UserEntry =
  /** The person typed this. `text` is theirs, verbatim. */
  | { kind: 'person'; text: string }
  /**
   * The harness wrote this under the user role. `note` names the kind in one short phrase; the
   * BODY is deliberately absent — see the header.
   */
  | { kind: 'system'; note: string }

/**
 * Envelopes the harness writes, and what each one is.
 *
 * `unwrap` marks the ones the person really did perform: the tag is stripped and what is inside is
 * their action. The rest carry the words the pane shows in their place.
 */
const ENVELOPES: Array<{ tag: string; unwrap: boolean; note: string }> = [
  { tag: 'task-notification', unwrap: false, note: 'background task reported back' },
  { tag: 'system-reminder', unwrap: false, note: 'system reminder' },
  { tag: 'local-command-caveat', unwrap: false, note: 'local-command caveat' },
  { tag: 'local-command-stdout', unwrap: false, note: 'command output' },
  { tag: 'bash-stdout', unwrap: false, note: 'command output' },
  { tag: 'bash-stderr', unwrap: false, note: 'command output' },
  { tag: 'command-name', unwrap: true, note: 'slash command' },
  { tag: 'command-message', unwrap: true, note: 'slash command' },
  { tag: 'command-args', unwrap: true, note: 'slash command' },
  { tag: 'bash-input', unwrap: true, note: 'shell command' },
]

/** `<tag>…</tag>` (or a self-closing / unterminated one), anchored at the start. */
function leadingTag(text: string): string | null {
  const m = /^<([a-zA-Z][\w-]*)/.exec(text)
  return m ? m[1]!.toLowerCase() : null
}

/** Strip every known envelope tag, keeping what was inside. */
function unwrapAll(text: string): string {
  let out = text
  for (const { tag } of ENVELOPES) {
    out = out
      .replace(new RegExp(`</?${tag}>`, 'gi'), '\n')
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Classify one user entry's text.
 *
 * Empty or whitespace-only input is `system` with an empty note, so a caller can drop it — an
 * empty bubble under someone's avatar is the same false attribution in a smaller size.
 */
export function classifyUserText(text: string): UserEntry {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'system', note: '' }

  const tag = leadingTag(trimmed)
  if (tag === null) return { kind: 'person', text: trimmed }

  const env = ENVELOPES.find(e => e.tag === tag)
  // An unrecognised tag is left alone: a message that merely STARTS with `<` (a diff, a snippet,
  // "<Foo /> renders twice") is the person's, and hiding it would be the expensive mistake.
  if (env === undefined) return { kind: 'person', text: trimmed }

  if (!env.unwrap) return { kind: 'system', note: env.note }

  const inner = unwrapAll(trimmed)
  // An envelope the person performed but which unwraps to nothing has no text to show and is still
  // not a message — the note names what it was.
  return inner === '' ? { kind: 'system', note: env.note } : { kind: 'person', text: inner }
}

/**
 * The kinds of injected entry seen in the wild, named by their opening line.
 *
 * The NOTE is what the pane shows; the body never is. `isMeta` alone is enough to classify — this
 * table only decides how the note READS, and an entry it does not recognise still gets a truthful
 * generic one. That is why a new shape appearing upstream cannot regress anything here: it is
 * already `system`, it just says less.
 */
const META_KINDS: Array<{ test: RegExp; note: string }> = [
  { test: /^Base directory for this skill:/, note: 'a skill was loaded' },
  { test: /^\(Re-invocation of/, note: 'a skill was re-invoked' },
  { test: /^Another Claude session sent a message:/, note: 'a message from another session' },
  // agentop's own peer message, from the event channel — the same family, and measured beside it.
  { test: /^The coordinator sent a message/, note: 'a message from another session' },
  { test: /^\[Image:/, note: 'an image was attached' },
  { test: /^Continue from where you left off\./, note: 'the session was resumed' },
  { test: /^\[Cross-session idle notice\]/, note: 'an idle notice about another session' },
  { test: /^## Context Usage/, note: 'a context-usage report' },
]

/**
 * Classify one `user` entry.
 *
 * `isMeta` is CLAUDE CODE'S OWN FLAG and it is checked FIRST, because it is the harness declaring
 * that the entry is not a turn the person took — see the measurement in this file's header for what
 * that flag covers that the tag table cannot.
 *
 * A TAGGED entry still goes through the table, which knows more: `<system-reminder>` names itself
 * more precisely than "injected by the assistant" does, and the unwrapping envelopes must keep
 * unwrapping. The flag only decides that a tag-less entry is the harness's; where a tag exists it
 * is the better answer.
 */
export function classifyUserEntry(
  { text, isMeta, isCompactSummary }: { text: string; isMeta?: boolean; isCompactSummary?: boolean },
): UserEntry {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'system', note: '' }

  /*
   * THE COMPACTION SUMMARY IS NOT A MESSAGE ANYBODY SENT, and it is the largest thing in the
   * transcript. When a conversation runs out of context Claude Code writes the summary back in as
   * a `user` entry — carrying NO `isMeta` and no envelope tag, so both of the rules above read it
   * as the person having typed it. What the chat then drew was a wall of "Primary Request and
   * Intent / Files and Code Sections" in a user bubble: a prompt the user is looking at, did not
   * write, and cannot account for. Reported exactly that way — "um prompt GIGANTE que nao foi eu
   * que enviei" — and 12 transcripts on the machine it was reported from carry one.
   *
   * The harness DECLARES it (`isCompactSummary: true`), so this is not a heuristic and does not
   * belong in `META_KINDS`: matching it by its opening sentence would both miss a reworded one and
   * catch a person quoting it. Checked BEFORE `isMeta`, because it is the more specific fact — a
   * summary that also carried the flag would otherwise get the generic note.
   *
   * A NOTE, never the body: the same rule every other injected entry keeps. What was compacted is
   * the conversation the reader is already looking at.
   */
  if (isCompactSummary === true) return { kind: 'system', note: 'the conversation was compacted' }

  if (isMeta !== true) return classifyUserText(trimmed)

  // A tag the table knows says more than the flag does, so it wins — but only ever toward `system`:
  // an `unwrap` envelope on a meta entry is the harness quoting a command, not the person running
  // one, so its note stands in for the body rather than releasing it.
  const tagged = classifyUserText(trimmed)
  if (tagged.kind === 'system') return tagged

  const kind = META_KINDS.find(k => k.test.test(trimmed))
  // An unrecognised meta entry is still the harness — the flag said so. It gets a truthful generic
  // note rather than being shown, because the alternative is attributing to a person something
  // they did not write.
  return { kind: 'system', note: kind?.note ?? 'injected by the assistant' }
}
