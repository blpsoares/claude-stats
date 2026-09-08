/**
 * harness-session-file.ts — PURE. What a harness records ABOUT ITS OWN SESSION, and which name wins.
 *
 * Claude Code writes `~/.claude/sessions/<pid>.json` while a session is alive. It holds the name the
 * user gave it with `/rename`, the conversation id, the pid, and — for a session started under our
 * backend — the tmux session name. That last field is the interesting one: it is an EXACT link from
 * a harness's own record to an agentop row, where everything else in this codebase has had to guess
 * by harness-and-directory.
 *
 * ## This is one harness's private file, so it is read like one
 *
 * The format is undocumented and internal to Claude Code; it can change shape in any release. So:
 * every field is checked, a missing or wrong-typed one yields "I do not know" rather than a throw or
 * an invented value, and a file that will not parse is simply absent. Same discipline as
 * `antigravity-protobuf.ts`, which never throws.
 *
 * `Record<HarnessId, … | null>` for the same reason `SPAWN_SPECS` is one: the other five harnesses
 * have no such file, or have one in a shape nobody has read, and they must go on behaving exactly as
 * they do today rather than being handed a guess.
 *
 * ## Which name wins, and why it is not the obvious answer
 *
 * `nameSource: 'derived'` marks a name CLAUDE INVENTED (`agentistics-77`, `aipe-c9`) rather than one
 * a person typed. Measured on this machine: 24 of 40 named session files are derived. A derived name
 * is not a name, and letting one replace a label somebody chose in agentop would be the "reopen
 * renamed the row back to the transcript's title" bug wearing a new hat. It is dropped before
 * anything else is considered.
 *
 * `nameSince` would settle the rest by recency, and it is the field this cannot lean on: it appears
 * only in claude 2.1.232 (3 of 16 user-named files here; every older version writes the name with no
 * timestamp at all). So the rule has to work when the comparison is impossible, and `pickTitle`
 * spells out what it does in each case rather than pretending the timestamps are there.
 *
 * When the two names disagree, NEITHER is thrown away: the winner becomes the title, the loser stays
 * on the row's facts, and `source` says which is which. Someone who renamed in both places must be
 * able to see that both renames happened — otherwise the one that lost reads as a rename that
 * silently failed.
 */

import type { HarnessId } from '@agentistics/core'
import { agyLogFromFds, conversationFromAgyLog } from './agy-conversation'

/** One harness session record, reduced to the fields anything here may rely on. */
export interface HarnessSessionFile {
  /** The OS pid the harness is running as. Matches what `/proc` reports for an external session. */
  pid?: number
  /** The harness's own conversation id — exact, not inferred from a directory. */
  sessionId?: string
  cwd?: string
  /** The session's own name. Absent when it has none. */
  name?: string
  /**
   * Where that name came from. `'derived'` means the HARNESS invented it, which is not a name a
   * person chose and is treated as no name at all.
   */
  nameSource?: string
  /** When the name was set, epoch ms. Absent on every claude before 2.1.232. */
  nameSince?: number
  /**
   * The tmux session this harness is running inside, as `<session>:@window.%pane`.
   *
   * Present only when the harness was started under tmux, which for our purposes means: started by
   * agentop. It is the EXACT link between a harness's own record and a managed row.
   */
  tmux?: string
  /**
   * The process's start time as the kernel counts it — field 22 of `/proc/<pid>/stat`.
   *
   * **This is what makes `pid` safe to believe.** These records outlive their processes by design
   * (that is what keeps a name readable on a `lost` row), so the directory is mostly full of dead
   * pids — measured here: 64 records, 3 of them still running. A pid alone would therefore report a
   * long-dead session as alive the moment the OS handed its number to something else, and it would
   * do it on the row that says "this conversation is running", which is the worst place to be wrong.
   *
   * Compared as an opaque STRING, never parsed into a time: it is a count of clock ticks since boot,
   * whose unit and epoch are the kernel's business. All this code needs is whether the process
   * answering to that pid is the same one that wrote the record.
   *
   * Verified on this machine 2026-08-15: of the three records whose pid still existed, all three
   * matched `/proc` exactly.
   */
  procStart?: string
  /**
   * Which harness wrote this record — stamped by the loader, which knows because it is iterating
   * `HARNESS_SESSION_SOURCES` one harness at a time.
   *
   * Not in the file, and carried so no reader has to hardcode a harness to use one of these. Only
   * claude writes such a record today; that is a fact about the sources table, and the day a second
   * one does, every consumer is already correct.
   */
  harness?: HarnessId
  /**
   * Whether the process that wrote this record is STILL RUNNING — stamped by the loader.
   *
   * Not part of the file: it is a fact about this moment, answered by the platform. `undefined`
   * means nobody could tell (no `/proc`, so not Linux) and must be read as "unknown", never as
   * "not running" — the same N/A-versus-a-confident-0 rule the dashboard applies to harness
   * capabilities. A row whose liveness is unknown stays exactly as it was.
   */
  alive?: boolean
}

/**
 * Parse one session file's already-decoded JSON — total, and never a throw.
 *
 * `null` for anything that is not an object. Every field is dropped individually on a type
 * mismatch, so a release that changes one field's shape costs that field and not the record.
 */
export function parseHarnessSessionFile(raw: unknown): HarnessSessionFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  return {
    ...(num(s.pid) !== undefined ? { pid: num(s.pid)! } : {}),
    ...(str(s.sessionId) ? { sessionId: str(s.sessionId)! } : {}),
    ...(str(s.cwd) ? { cwd: str(s.cwd)! } : {}),
    ...(str(s.name) ? { name: str(s.name)! } : {}),
    ...(str(s.nameSource) ? { nameSource: str(s.nameSource)! } : {}),
    ...(num(s.nameSince) !== undefined ? { nameSince: num(s.nameSince)! } : {}),
    ...(str(s.tmux) ? { tmux: str(s.tmux)! } : {}),
    // Claude writes it as a STRING of clock ticks; a number would also be reasonable and is
    // accepted, because the only operation ever performed on it is equality against `/proc`.
    ...(str(s.procStart) ? { procStart: str(s.procStart)! }
      : num(s.procStart) !== undefined ? { procStart: String(num(s.procStart)!) } : {}),
  }
}

/**
 * The name a person chose INSIDE the session, or `undefined` — PURE.
 *
 * Only `derived` is rejected: it is what the harness makes up from the folder when nobody has said
 * anything (`agentistics-77`, `aipe-c9`), and it changes nothing about what the session is.
 *
 * Three values have been seen in real files on 2026-08-14, and the third is why this is a rejection
 * list rather than an allow list:
 *   absent      the ordinary case for a name typed with `/rename`
 *   `derived`   invented by the harness — not a name
 *   `collision` the user's name plus a disambiguating suffix, when two sessions chose the same one
 *               (`principal do cockpit-mutable-spring`). That IS the user's name, so it passes.
 * An unknown fourth value therefore shows the name rather than blanking it: a field this module
 * does not recognise must not silently delete something a person typed.
 */
export function chosenName(file: HarnessSessionFile | undefined): string | undefined {
  if (!file?.name) return undefined
  return file.nameSource === 'derived' ? undefined : file.name
}

/**
 * Our managed session's id, read out of the harness's own `tmux` field — PURE.
 *
 * `agentop-ebd7dedf2e:@2.%2` -> `ebd7dedf2e`. The window and pane are dropped: a session of ours is
 * one window with one pane, and the id is the only part that names anything we hold.
 *
 * `undefined` for a tmux session that is not ours, which is the ordinary case for a user's own tmux.
 * The caller supplies the prefix test rather than this module importing the backend, so the pure
 * layer stays free of the platform.
 */
export function tmuxSessionName(file: HarnessSessionFile | undefined): string | undefined {
  const raw = file?.tmux
  if (!raw) return undefined
  const name = raw.split(':')[0] ?? ''
  return name === '' ? undefined : name
}

/** Where a row's displayed name came from. Said on the row when the two sources disagree. */
export type TitleSource = 'label' | 'harness' | 'derived'

export interface PickedTitle {
  title: string
  source: TitleSource
  /**
   * The name that LOST, when there was one and it differs.
   *
   * Kept so the row can say that both renames happened. A rename that vanishes without a word is
   * indistinguishable from a rename that failed, which is the complaint this feature answers — in
   * the other direction.
   */
  other?: string
}

/**
 * Which name a row wears — PURE, and the ONE place the precedence lives.
 *
 * The cases, in the order they are decided:
 *
 *  1. **Neither.** The caller's derived fallback (`claude in tmp`), marked `derived` so nothing
 *     downstream mistakes it for something a person typed.
 *  2. **One of them.** That one. No contest to resolve.
 *  3. **Both, and both timestamps are known.** The NEWER one, which is the only reading that
 *     respects a deliberate rename made afterwards in either place.
 *  4. **Both, and the timestamps cannot be compared.** The HARNESS's, and this is the judgement
 *     call, so here is the reasoning. The complaint that produced this feature is precisely someone
 *     renaming inside the session and agentop going on showing its own older label; `nameSince`
 *     exists only from claude 2.1.232, so on today's machines case 3 almost never fires and a rule
 *     that preferred the label would leave the feature not working for most people. It is not the
 *     bug the repo has already paid for either: THAT was a name NOBODY chose (a transcript title)
 *     replacing one somebody did, and a non-derived harness name is a name somebody typed. And
 *     nothing is lost — the label comes back as `other`, on the row.
 */
export function pickTitle(o: {
  /** The name typed into agentop, when there is one. */
  label?: string
  /** When that was written, epoch ms. Absent on a row renamed before agentop recorded it. */
  labelSince?: number
  /** The harness's session record, when one could be read. */
  file?: HarnessSessionFile
  /** What to call a row nobody has named. Already localized. */
  fallback: string
}): PickedTitle {
  const harness = chosenName(o.file)
  const label = o.label && o.label.trim() !== '' ? o.label : undefined

  if (!label && !harness) return { title: o.fallback, source: 'derived' }
  if (!harness) return { title: label!, source: 'label' }
  if (!label) return { title: harness, source: 'harness' }
  if (label === harness) return { title: label, source: 'label' }

  const since = o.file?.nameSince
  if (o.labelSince !== undefined && since !== undefined) {
    return o.labelSince >= since
      ? { title: label, source: 'label', other: harness }
      : { title: harness, source: 'harness', other: label }
  }

  // A `collision` name is not a competing name. It is the user's OWN name with a suffix the harness
  // appended because two sessions asked for the same one — `Principal` came back as
  // `principal do cockpit-zippy-conway`. With no timestamps to compare, handing the row to the
  // harness shows a mangled copy in preference to the original, which is exactly the complaint:
  // "the real name still isn't prevailing in the listing". A genuine `/rename` inside the session
  // carries NO `nameSource` at all, so it is untouched by this and still wins below.
  if (o.file?.nameSource === 'collision') return { title: label, source: 'label', other: harness }

  return { title: harness, source: 'harness', other: label }
}

/**
 * Which harnesses record a session file agentop knows how to read.
 *
 * A `Record`, so a harness added to `HarnessId` fails the build until somebody decides. `null` means
 * "no such file, or one nobody has read" — and that harness goes on behaving exactly as it does
 * today, which is the point: this is a Claude Code specific format, and inventing a reader for the
 * other five would be inventing their data.
 *
 * `dir` is relative to the harness's own home, resolved by the caller — the pure layer names no path
 * on this machine.
 */
export interface HarnessSessionSource {
  /** Directory under the harness home holding one JSON file per live session. */
  dir: string
  /** File names to consider: `<pid>.json`, never the sibling `<pid>.<hash>.key` files. */
  matches: RegExp
}

export const HARNESS_SESSION_SOURCES: Record<HarnessId, HarnessSessionSource | null> = {
  // Probed on 2026-08-14 against claude 2.1.232: `~/.claude/sessions/<pid>.json`, one per live
  // session, holding pid / sessionId / cwd / name / nameSource / nameSince / tmux. The directory
  // also holds `<pid>.<hash>.key` files, which are NOT session records.
  claude: { dir: 'sessions', matches: /^\d+\.json$/ },
  // The other five write no such file, or write one nobody has read. Absent, never guessed.
  codex: null,
  gemini: null,
  copilot: null,
  antigravity: null,
  kimi: null,
}

/**
 * The OTHER shape a harness can betray its own live conversation in: a log it keeps OPEN.
 *
 * `HARNESS_SESSION_SOURCES` above is one shape — a directory of JSON records a harness writes ABOUT
 * its sessions — and every rule it carries is about that shape. antigravity has nothing of the
 * kind, and it has no assign flag either (`agy --conversation <fresh-uuid>` answers
 * `warning: conversation "…" not found` and creates one under an id of its own; measured against
 * agy 1.1.27 on 2026-09-08). What it DOES have is one log per process, held open for the life of
 * that process, naming the conversation it created. See `agy-conversation.ts` for why that is the
 * only exact answer available for this harness.
 *
 * Two tables rather than one widened table: "a file per session, keyed by pid, parsed as JSON" and
 * "the process's own open log, read by regex" share no rule beyond the question they answer, and
 * folding them together would qualify every sentence in both.
 *
 * The functions live with the harness that needs them, so the day a second harness turns out to do
 * this its reader lands beside its own parser and not in here.
 */
export interface HarnessProcessLog {
  /** Pick this harness's own log out of a process's open fd targets. Refuses on ambiguity. */
  logFromFds(targets: readonly string[]): string | null
  /** The conversation that log says the process created, or `null`. */
  conversationFrom(text: string): string | null
}

export const HARNESS_PROCESS_LOGS: Record<HarnessId, HarnessProcessLog | null> = {
  antigravity: { logFromFds: agyLogFromFds, conversationFrom: conversationFromAgyLog },
  // Nobody has read a per-process log for the other five, and one that has not been read is one
  // that must not be guessed at. claude is `null` HERE and non-null above: it already has two exact
  // links and needs no third.
  claude: null,
  codex: null,
  gemini: null,
  copilot: null,
  kimi: null,
}
