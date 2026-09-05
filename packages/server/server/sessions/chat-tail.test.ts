import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import {
  forgetChatTailContent, forgetChatTailPaths, readRecentChatTurns, resolveChatTranscriptPath,
} from './chat-tail'

const SESSION_ID = 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789'

function line(obj: unknown): string {
  return JSON.stringify(obj)
}

const userTurn = (text: string) => line({ type: 'user', message: { content: text } })
const assistantTurn = (text: string) => line({
  type: 'assistant', message: { content: [{ type: 'text', text }] },
})
const toolResultTurn = () => line({
  type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] },
})
/** A `queued_command` attachment — how a message typed while the assistant was busy is recorded,
 *  and also how the harness's own `<task-notification>` reaches the transcript. */
const queuedTurn = (prompt: string) => line({
  type: 'attachment',
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt' },
})

const toolUseTurn = (...names: string[]) => line({
  type: 'assistant',
  message: { content: names.map(name => ({ type: 'tool_use', name, input: {} })) },
})

describe('resolveChatTranscriptPath', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-'))
    forgetChatTailPaths()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('finds the transcript at the directly encoded project path', async () => {
    const projectDir = join(root, '-home-user-my-project')
    await mkdir(projectDir, { recursive: true })
    const file = join(projectDir, `${SESSION_ID}.jsonl`)
    await writeFile(file, userTurn('hi') + '\n')

    const resolved = await resolveChatTranscriptPath('/home/user/my-project', SESSION_ID, root)
    expect(resolved).toBe(file)
  })

  test('falls back to a scan when the directly encoded path does not exist', async () => {
    // The naive encoding of this cwd would land on a directory that is not where Claude actually
    // put the file (an ambiguous-dash collision) — the scan is what finds it anyway, by filename.
    const realDir = join(root, 'some-other-directory-name')
    await mkdir(realDir, { recursive: true })
    const file = join(realDir, `${SESSION_ID}.jsonl`)
    await writeFile(file, userTurn('hi') + '\n')

    const resolved = await resolveChatTranscriptPath('/home/user/my-project', SESSION_ID, root)
    expect(resolved).toBe(file)
  })

  test('returns null and never throws when nothing matches', async () => {
    const resolved = await resolveChatTranscriptPath('/nowhere', SESSION_ID, root)
    expect(resolved).toBeNull()
  })

  test('rejects a non-UUID session id without touching the filesystem', async () => {
    const resolved = await resolveChatTranscriptPath('/nowhere', 'not-a-uuid', root)
    expect(resolved).toBeNull()
  })

  test('caches a miss so a second lookup does not re-scan', async () => {
    const first = await resolveChatTranscriptPath('/nowhere', SESSION_ID, root)
    expect(first).toBeNull()

    // Adding the file after the miss was cached must not change the cached answer.
    const lateDir = join(root, '-late')
    await mkdir(lateDir, { recursive: true })
    await writeFile(join(lateDir, `${SESSION_ID}.jsonl`), userTurn('hi') + '\n')

    const second = await resolveChatTranscriptPath('/nowhere', SESSION_ID, root)
    expect(second).toBeNull()
  })
})

describe('readRecentChatTurns', () => {
  let root: string
  let file: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-content-'))
    file = join(root, 'transcript.jsonl')
    forgetChatTailContent()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('returns turns oldest-first with real roles', async () => {
    await writeFile(file, [
      userTurn('what does this do'),
      assistantTurn('it does the thing'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns).toEqual([
      { role: 'user', text: 'what does this do' },
      { role: 'assistant', text: 'it does the thing' },
    ])
  })

  // The reader takes the END of the file, not the whole of it — a live session's transcript is
  // re-read on every poll, and reading megabytes to show six lines is what made /api/fleet take
  // seconds. These two pin the part that can go wrong silently: the window must never COST turns.
  test('reads the last turns out of a transcript far larger than the tail window', async () => {
    // ~2 MB of history in front of them, so the read starts mid-file and mid-line.
    const filler: string[] = []
    for (let i = 0; i < 200; i++) filler.push(assistantTurn('x'.repeat(10_000)))
    await writeFile(file, [
      ...filler,
      userTurn('the last question'),
      assistantTurn('the last answer'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file, 2)
    expect(turns).toEqual([
      { role: 'user', text: 'the last question' },
      { role: 'assistant', text: 'the last answer' },
    ])
  })

  test('widens the window rather than returning fewer turns than were asked for', async () => {
    // One enormous newest entry: the first window lands entirely INSIDE it, so the partial-line rule
    // discards everything and the pass finds nothing. Truncating there would silently drop five real
    // turns; the reader must read further back instead.
    await writeFile(file, [
      userTurn('one'),
      assistantTurn('two'),
      userTurn('three'),
      assistantTurn('four'),
      userTurn('five'),
      assistantTurn('y'.repeat(400_000)),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file, 6)
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(turns[0]).toEqual({ role: 'user', text: 'one' })
    expect(turns[5]!.text.length).toBe(400_000)
  })

  test('filters out tool-result-only user entries', async () => {
    await writeFile(file, [
      userTurn('do the thing'),
      assistantTurn('doing it'),
      toolResultTurn(),
      assistantTurn('done'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'assistant'])
  })

  test('surfaces a pending tool-activity turn when the newest event is a tool call with no text yet', async () => {
    await writeFile(file, [
      userTurn('fix the bug'),
      assistantTurn('looking into it'),
      toolUseTurn('Bash'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns).toEqual([
      { role: 'user', text: 'fix the bug' },
      { role: 'assistant', text: 'looking into it' },
      { role: 'assistant', text: 'Running Bash', pending: true },
    ])
  })

  test('names every tool called in the newest entry', async () => {
    await writeFile(file, [userTurn('go'), toolUseTurn('Read', 'Bash')].join('\n') + '\n')
    const turns = await readRecentChatTurns(file)
    expect(turns.at(-1)).toEqual({ role: 'assistant', text: 'Running Read, Bash', pending: true })
  })

  test('does NOT synthesize a pending turn for an older tool call that already has a result', async () => {
    // Only the newest event in the file may be read as "busy right now" — an earlier tool_use with
    // nothing after it in this fixture would otherwise misreport a finished exchange as still running.
    await writeFile(file, [
      toolUseTurn('Bash'),
      toolResultTurn(),
      assistantTurn('done'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns).toEqual([{ role: 'assistant', text: 'done' }])
  })

  test('stops parsing once `max` turns are collected, from the end', async () => {
    const lines: string[] = []
    for (let i = 0; i < 20; i++) {
      lines.push(userTurn(`q${i}`))
      lines.push(assistantTurn(`a${i}`))
    }
    await writeFile(file, lines.join('\n') + '\n')

    const turns = await readRecentChatTurns(file, 2)
    expect(turns).toEqual([
      { role: 'user', text: 'q19' },
      { role: 'assistant', text: 'a19' },
    ])
  })

  test('skips malformed lines without throwing', async () => {
    await writeFile(file, [
      'not json at all',
      userTurn('hello'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns).toEqual([{ role: 'user', text: 'hello' }])
  })

  test('returns empty for a missing file rather than throwing', async () => {
    const turns = await readRecentChatTurns(join(root, 'nope.jsonl'))
    expect(turns).toEqual([])
  })

  test('re-parses when the file changes and reuses the cache when it has not', async () => {
    await writeFile(file, userTurn('first') + '\n')
    const first = await readRecentChatTurns(file)
    expect(first).toEqual([{ role: 'user', text: 'first' }])

    // Unchanged mtime: appending nothing and re-reading must return the cached array instance.
    const cached = await readRecentChatTurns(file)
    expect(cached).toBe(first)

    // Bump mtime forward so the cache is invalidated even on filesystems with coarse resolution.
    const future = new Date(Date.now() + 5_000)
    await writeFile(file, userTurn('first') + '\n' + assistantTurn('second') + '\n')
    await utimes(file, future, future)

    const updated = await readRecentChatTurns(file)
    expect(updated).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'second' },
    ])
  })
})

/**
 * A watcher is the one tool call worth a line in a conversation. Its END was already reported (the
 * `<task-notification>` that comes back as a system note); only the START was missing, so a task
 * appeared to finish having never begun.
 */
describe('background tasks', () => {
  let root: string
  let file: string

  const bgStart = (id: string, description: string) => line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'x', description, run_in_background: true } }] },
  })
  const bgDone = (id: string) => line({
    type: 'user',
    message: { content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>` },
  })
  const foreground = () => line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_fg', name: 'Bash', input: { command: 'ls', description: 'List files' } }] },
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-bg-'))
    const dir = join(root, '-p')
    await mkdir(dir, { recursive: true })
    file = join(dir, `${SESSION_ID}.jsonl`)
    forgetChatTailPaths(); forgetChatTailContent()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('a started task is a RUNNING line, by the label the assistant gave it', async () => {
    await writeFile(file, [bgStart('tu_1', 'Ship the grant')].join('\n') + '\n')
    const turns = await readRecentChatTurns(file, 20)
    const task = turns.find(t => t.task)
    expect(task?.task).toEqual({ label: 'Ship the grant', running: true })
  })

  test('its notification settles it, paired by tool-use-id', async () => {
    // The exact pairing: the notification carries the id of the very tool_use that launched it.
    await writeFile(file, [bgStart('tu_1', 'Ship the grant'), bgDone('tu_1')].join('\n') + '\n')
    const turns = await readRecentChatTurns(file, 20)
    expect(turns.find(t => t.task)?.task).toEqual({ label: 'Ship the grant', running: false })
  })

  test("someone else's notification does not settle it", async () => {
    await writeFile(file, [bgStart('tu_1', 'Watch the release'), bgDone('tu_other')].join('\n') + '\n')
    expect(turns2(await readRecentChatTurns(file, 20)).running).toBe(true)
  })

  test('a FOREGROUND tool call draws no line at all', async () => {
    // Rendering every tool call would turn a conversation into a command log — the discriminator is
    // the tool's own `run_in_background`, never a guess about how long something might take.
    await writeFile(file, [foreground()].join('\n') + '\n')
    const turns = await readRecentChatTurns(file, 20)
    expect(turns.some(t => t.task)).toBe(false)
  })

  test('two tasks are settled independently', async () => {
    await writeFile(file, [
      bgStart('tu_1', 'First'), bgStart('tu_2', 'Second'), bgDone('tu_2'),
    ].join('\n') + '\n')
    const byLabel = new Map(
      (await readRecentChatTurns(file, 20)).filter(t => t.task).map(t => [t.task!.label, t.task!.running]),
    )
    expect(byLabel.get('First')).toBe(true)
    expect(byLabel.get('Second')).toBe(false)
  })
})

function turns2(turns: { task?: { label: string; running: boolean } }[]): { label: string; running: boolean } {
  const t = turns.find(x => x.task)?.task
  if (!t) throw new Error('no task line')
  return t
}

describe('a queued_command carries envelopes too', () => {
  let root: string
  let file: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-queued-'))
    file = join(root, 'transcript.jsonl')
    forgetChatTailContent()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('a task notification queued by the harness is not shown as the user\'s message', async () => {
    // Measured on a real transcript: a background task's completion reaches the file as an
    // `attachment` / `queued_command`, not as a `user` entry — so the envelope filter, which only
    // ever ran on the `user` path, never saw it. Seven of them were drawn in the reader's own
    // bubble, and they were reported exactly as the skill body was: "that message wasn't me".
    await writeFile(file, [
      userTurn('go ahead'),
      queuedTurn('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'),
    ].join('\n') + '\n')
    const turns = await readRecentChatTurns(file)
    expect(turns.some(t => (t.text ?? '').includes('<task-notification>'))).toBe(false)
    expect(turns.some(t => (t.text ?? '').includes('<task-id>'))).toBe(false)
  })

  test('a real message queued while the assistant was busy still appears', async () => {
    // The whole point of reading this entry type. Filtering must not cost the feature it serves.
    await writeFile(file, [
      userTurn('go ahead'),
      queuedTurn('also fix the header while you are there'),
    ].join('\n') + '\n')
    const turns = await readRecentChatTurns(file)
    expect(turns.some(t => t.role === 'user' && t.text === 'also fix the header while you are there')).toBe(true)
  })

  test('a slash command queued by the user is unwrapped, not hidden', async () => {
    // `<command-name>` is the person ACTING — dropping it would erase a turn that happened.
    await writeFile(file, [
      queuedTurn('<command-name>/login</command-name>'),
    ].join('\n') + '\n')
    const turns = await readRecentChatTurns(file)
    expect(turns.some(t => t.role === 'user' && (t.text ?? '').includes('/login'))).toBe(true)
    expect(turns.some(t => (t.text ?? '').includes('<command-name>'))).toBe(false)
  })
})
