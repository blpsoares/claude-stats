/**
 * step-detail.ts — PURE: ONE step of a session's work, opened up.
 *
 * The Live feed says a session RAN something or WROTE something, one line each. That line is the
 * first line of the call's own input and nothing else — which answers "what is it doing" and never
 * "what is it doing THAT". Asked for directly: the feed's rows should open and show the work under
 * them, while it happens.
 *
 * The transcript already holds both halves. A `tool_use` block carries the full input and an `id`;
 * the `tool_result` that answers it carries the output and names that same id. So a step is a PAIR,
 * looked up by the id the feed already knows, and the pairing is EXACT — never by position, which
 * is the mistake `workflow-match.ts` exists to have fixed once.
 *
 * THREE RULES THIS MODULE KEEPS.
 *
 * 1. A step with no result yet is RUNNING, and says so. That is not an error and not an empty
 *    output: the command is executing, and it is the state the whole "in real time" request is
 *    about. Rendering it as "no output" would be a confident wrong answer at the exact moment the
 *    reader is watching.
 * 2. NOTHING IS INVENTED AND NOTHING IS SILENTLY DROPPED. An input shape this module does not know
 *    is shown as its own JSON rather than summarised into a sentence; a result block that is not
 *    text (an image) is NAMED rather than skipped, or a screenshot would read as a command that
 *    produced nothing.
 * 3. IT IS BOUNDED, and truncation is REPORTED. A `bun test` run is megabytes and a written file
 *    can be a whole module; both are shown up to a ceiling with a flag the UI turns into a
 *    sentence. A silently cut output is worse than a short one, because the reader draws
 *    conclusions from the end of a log.
 *
 * The lookup is a SUBSTRING PREFILTER before any JSON parsing: a transcript here is 4.4 MB and the
 * id appears in exactly two of its lines, so parsing all of them to find two is work nobody needs.
 */

/** The most input characters one step returns. A written file is a whole module. */
export const MAX_STEP_INPUT = 20_000
/** …and the most output. A test run is megabytes; the tail is what a reader wants. */
export const MAX_STEP_OUTPUT = 40_000

/**
 * A tool-call id, as the client may send it.
 *
 * Bounded and charset-checked before it is used as a substring: it decides how much of a multi-MB
 * file is scanned, and a ref of a thousand characters is a request nobody meant to make. It never
 * reaches a path.
 */
const REF_SHAPE = /^[A-Za-z0-9_-]{1,200}$/

export function validStepRef(ref: string): boolean {
  return REF_SHAPE.test(ref)
}

export interface StepDetail {
  /** The tool that was called, verbatim — the vocabulary is the harness's, not ours. */
  name: string
  /** The full call, rendered for reading. */
  input: string
  inputTruncated: boolean
  /** The result, or `null` while the step is still running (which is NOT an empty output). */
  output: string | null
  outputTruncated: boolean
  /** The harness marked this result an error. */
  isError: boolean
  /** No result has been written yet — the step is executing right now. */
  running: boolean
}

/** Cut to a ceiling, keeping the END of an output (where a failure is) and the START of an input. */
function clip(text: string, max: number, keep: 'head' | 'tail'): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return keep === 'head'
    ? { text: text.slice(0, max), truncated: true }
    : { text: text.slice(text.length - max), truncated: true }
}

/**
 * The call, as text somebody can read.
 *
 * Named shapes first, because a shell call IS its command and a write IS its content; anything
 * unrecognised falls through to its own JSON rather than being reduced to a field somebody guessed
 * was the interesting one.
 */
export function renderToolInput(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return typeof input === 'string' ? input : JSON.stringify(input ?? null, null, 2)
  }
  const o = input as Record<string, unknown>
  const str = (k: string): string | null => (typeof o[k] === 'string' ? o[k] as string : null)

  const command = str('command')
  if (command !== null) return command

  // An edit is two texts and the reader needs both — a diff is the one thing "what did it write"
  // cannot be answered without.
  const oldText = str('old_string')
  const newText = str('new_string')
  if (oldText !== null || newText !== null) {
    const path = str('file_path') ?? str('path')
    return [
      path ? `${path}\n` : '',
      '--- before\n', oldText ?? '', '\n',
      '+++ after\n', newText ?? '',
    ].join('')
  }

  const content = str('content')
  if (content !== null) {
    const path = str('file_path') ?? str('path')
    return path ? `${path}\n\n${content}` : content
  }

  const single = str('file_path') ?? str('path') ?? str('pattern') ?? str('query') ?? str('url')
  if (single !== null) {
    // The other named fields ride along, so a Grep shows its pattern AND where it looked.
    const extras = Object.entries(o)
      .filter(([k, v]) => k !== 'file_path' && k !== 'path' && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${String(v)}`)
    return extras.length > 0 ? `${single}\n${extras.join('\n')}` : single
  }

  return JSON.stringify(o, null, 2)
}

/**
 * The result, as text.
 *
 * `content` is a string for most tools and a block list for the rest. A block that is not text is
 * NAMED (`[image]`) rather than skipped: a screenshot dropped in silence reads as a call that
 * produced nothing, which is the confident-wrong-answer this file's rule 2 is about.
 */
export function renderToolOutput(content: unknown, toolUseResult: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as unknown[]).map(b => {
      if (typeof b === 'string') return b
      if (typeof b !== 'object' || b === null) return ''
      const o = b as Record<string, unknown>
      if (typeof o.text === 'string') return o.text
      return typeof o.type === 'string' ? `[${o.type}]` : ''
    }).filter(t => t !== '').join('\n')
  }
  // Some results carry no content block and only the structured record beside it.
  if (typeof toolUseResult === 'object' && toolUseResult !== null) {
    const r = toolUseResult as Record<string, unknown>
    const parts = [r.stdout, r.stderr].filter((x): x is string => typeof x === 'string' && x !== '')
    if (parts.length > 0) return parts.join('\n')
    return JSON.stringify(r, null, 2)
  }
  return ''
}

/** One parsed transcript entry, as much of it as this module reads. */
type Entry = Record<string, unknown>

function blocksOf(e: Entry): Record<string, unknown>[] {
  const c = (e.message as Record<string, unknown> | undefined)?.content
  return Array.isArray(c) ? (c as Record<string, unknown>[]) : []
}

/**
 * Find one step in a raw transcript, by the `tool_use` id the feed carries.
 *
 * `null` means the id is not in this transcript at all — a real answer, and the caller says so in
 * words rather than drawing an empty box.
 */
export function findStepInTranscript(content: string, ref: string): StepDetail | null {
  if (!validStepRef(ref)) return null

  let use: { name: string; input: unknown } | null = null
  let result: { content: unknown; toolUseResult: unknown; isError: boolean } | null = null

  for (const line of content.split('\n')) {
    // The prefilter: only the two lines that name this id are worth parsing.
    if (line === '' || !line.includes(ref)) continue
    let e: Entry
    try { e = JSON.parse(line) as Entry } catch { continue }
    for (const b of blocksOf(e)) {
      if (b.type === 'tool_use' && b.id === ref && typeof b.name === 'string') {
        use = { name: b.name, input: b.input }
      } else if (b.type === 'tool_result' && b.tool_use_id === ref) {
        result = { content: b.content, toolUseResult: e.toolUseResult, isError: b.is_error === true }
      }
    }
  }

  if (!use) return null
  const input = clip(renderToolInput(use.name, use.input), MAX_STEP_INPUT, 'head')
  if (!result) {
    // RUNNING — rule 1. Not an empty output, and never rendered as one.
    return {
      name: use.name,
      input: input.text,
      inputTruncated: input.truncated,
      output: null,
      outputTruncated: false,
      isError: false,
      running: true,
    }
  }
  const out = clip(renderToolOutput(result.content, result.toolUseResult), MAX_STEP_OUTPUT, 'tail')
  return {
    name: use.name,
    input: input.text,
    inputTruncated: input.truncated,
    output: out.text,
    outputTruncated: out.truncated,
    isError: result.isError,
    running: false,
  }
}
