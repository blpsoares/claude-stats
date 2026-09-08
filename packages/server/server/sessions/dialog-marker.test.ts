import { describe, expect, test } from 'bun:test'
import { readDialog } from './dialog-choice'

/**
 * The TRUST dialog — the one this whole shape exists for.
 *
 * Captured from a live claude session on 2026-09-08, through agentop's own `approvalLines` preview
 * (the user was shown exactly these rows and could only answer the highlighted one). It carries NO
 * numbers, which is why the numbered reader answered `none` and the UI drew a bare confirm — and a
 * bare confirm here sends `Enter`, which takes `No, exit`.
 */
const TRUST = [
  'project, or work from your team). If not, take a moment to review what\'s in this folder first.',
  '',
  'Claude Code\'ll be able to read, edit, and execute files here.',
  '',
  'Security guide',
  '',
  '❯ No, exit',
  '  Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
]

/** claude's model picker, captured live on 2026-09-08. Numbered — must stay on the numbered path. */
const NUMBERED = [
  '   Select model',
  '   Switch between Claude models. Your pick becomes the default for new sessions.',
  '',
  '     1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks',
  '   ❯ 2. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday, complex tasks',
  '     3. Fable                  Fable 5.1 · Most capable for your hardest tasks',
  '',
  '   Enter to set as default · s to use this session only · Esc to cancel',
]

/** An IDLE claude prompt, captured live on 2026-09-08: the composer's own `❯` and nothing under it. */
const IDLE = [
  '                                                              ● high · /effort',
  '────────────────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 6 agents',
]

describe('the numberless select', () => {
  test('the trust dialog reads as two options, the highlighted one marked', () => {
    const d = readDialog(TRUST, { marker: true })
    expect(d.kind).toBe('options')
    expect(d.select).toBe('marker')
    expect(d.options.map(o => o.label)).toEqual(['No, exit', 'Yes, I trust this folder'])
    expect(d.options.map(o => o.selected)).toEqual([true, false])
  })

  test('its numbers are POSITIONS, so a caller can address one without a printed digit', () => {
    const d = readDialog(TRUST, { marker: true })
    expect(d.options.map(o => o.number)).toEqual([1, 2])
  })

  test('the top is where the block starts, so the preview and the options describe one place', () => {
    expect(readDialog(TRUST, { marker: true }).top).toBe(6)
  })
})

/**
 * kimi 0.41.0's trust prompt, captured by driving a live session in a fresh directory on
 * 2026-09-08. Numberless like claude's — and NOT the same shape: every option carries a description
 * line at the SAME indentation, with blank lines between the groups.
 */
const KIMI_TRUST = [
  '  Trust this folder?',
  '  ↑↓ navigate · Enter select · Esc exit',
  '',
  '  /tmp/agkimi-wAb8iS',
  '',
  '  Project-level MCP servers are disabled until you explicitly choose Trust. Trust starts the',
  '  listed project MCP targets and remembers this folder.',
  '',
  '   ❯ Trust this folder',
  '     Enable project MCP servers. Remembered for this folder.',
  '',
  '     Don\'t trust',
  '     Exit Kimi Code. Asked again next launch.',
]

describe('the gate', () => {
  // The DEFAULT is off, and every caller that does not know which harness drew the frame keeps it
  // off. `attention.ts` is the one that matters: its window rule is written for a numbered block.
  test('the shape reader does not run unless it is asked for', () => {
    expect(readDialog(TRUST).kind).toBe('none')
    expect(readDialog(TRUST).select).toBeNull()
  })

  test("kimi's numberless prompt would be HALF-READ, which is why kimi is not gated on", () => {
    // Asked for anyway, this is what comes out: the first option and its own DESCRIPTION, and
    // `Don't trust` never reached. Offering that is worse than offering nothing — the assertion
    // exists so nobody turns kimi on without modelling the description lines first.
    const forced = readDialog(KIMI_TRUST, { marker: true })
    expect(forced.options.map(o => o.label)).toEqual([
      'Trust this folder',
      'Enable project MCP servers. Remembered for this folder.',
    ])
    // And with the gate as it ships, kimi reads exactly as it did before this reader existed.
    expect(readDialog(KIMI_TRUST).kind).toBe('none')
  })
})

describe('what it must NOT read as a menu', () => {
  test('a numbered dialog stays numbered — the marker scan never runs on it', () => {
    const d = readDialog(NUMBERED, { marker: true })
    expect(d.kind).toBe('options')
    expect(d.select).toBe('numbered')
    expect(d.options.map(o => o.number)).toEqual([1, 2, 3])
    expect(d.options.find(o => o.selected)?.number).toBe(2)
  })

  test('the idle composer is not a menu: its cursor row is empty and has no siblings', () => {
    const d = readDialog(IDLE, { marker: true })
    expect(d.kind).toBe('none')
    expect(d.options).toEqual([])
  })

  test('a cursor row with nothing beside it is a statement, not a choice', () => {
    // The codex-shaped `Press enter to continue`: one row, so a bare confirm is still the right
    // answer and this reader must not turn it into a one-option menu.
    const d = readDialog(['Something happened.', '', '❯ Press enter to continue', ''], { marker: true })
    expect(d.kind).toBe('none')
  })

  test('two cursors is a frame this parser does not understand, and it says so', () => {
    const d = readDialog(['❯ one', '❯ two'], { marker: true })
    expect(d.kind).toBe('unreadable')
    expect(d.reason).toBe('two-cursors')
  })

  test('a quoted `>` block is never a menu — only the select cursor counts', () => {
    const d = readDialog(['> quoted line one', '> quoted line two', '', 'Enter to confirm'], { marker: true })
    expect(d.kind).toBe('none')
  })

  test('rows at a different indentation than the cursor are not its siblings', () => {
    const d = readDialog(['        far away', '❯ No, exit', '            also far', ''], { marker: true })
    expect(d.kind).toBe('none')
  })

  test('a blank line ends the block', () => {
    const d = readDialog(['  not mine', '', '❯ No, exit', '  Yes, I trust this folder'], { marker: true })
    expect(d.options.map(o => o.label)).toEqual(['No, exit', 'Yes, I trust this folder'])
  })
})
