import { describe, expect, it } from 'bun:test'
import { classifyUserEntry, classifyUserText } from './chat-envelope'

describe('classifyUserText', () => {
  it('keeps a plain message as the person’s, verbatim', () => {
    expect(classifyUserText('  faz isso aí  ')).toEqual({ kind: 'person', text: 'faz isso aí' })
  })

  // The report this module exists for: the user circled one of these and said they did not send it.
  it('does not attribute a task notification to the person', () => {
    const r = classifyUserText('<task-notification>\n<task-id>bkl8s3c3q</task-id>\n</task-notification>')
    expect(r.kind).toBe('system')
    expect(r).not.toHaveProperty('text')
  })

  it('never carries the BODY of a system entry', () => {
    // A <system-reminder> can be the whole of CLAUDE.md. The note names the kind; the body is gone.
    const huge = `<system-reminder>${'x'.repeat(50_000)}</system-reminder>`
    const r = classifyUserText(huge)
    expect(r).toEqual({ kind: 'system', note: 'system reminder' })
    expect(JSON.stringify(r).length).toBeLessThan(120)
  })

  it('treats every measured system envelope as system', () => {
    for (const tag of [
      'task-notification', 'system-reminder', 'local-command-caveat',
      'local-command-stdout', 'bash-stdout', 'bash-stderr',
    ]) {
      expect(classifyUserText(`<${tag}>body</${tag}>`).kind).toBe('system')
    }
  })

  it('UNWRAPS the envelopes the person really did perform', () => {
    // Dropping these would erase a turn that happened — the user did run the command.
    expect(classifyUserText('<command-name>/commit</command-name>'))
      .toEqual({ kind: 'person', text: '/commit' })
    expect(classifyUserText('<bash-input>ls -la</bash-input>'))
      .toEqual({ kind: 'person', text: 'ls -la' })
  })

  it('unwraps a slash command spread across several envelope tags', () => {
    const r = classifyUserText('<command-name>/review</command-name>\n<command-args>PR 314</command-args>')
    expect(r).toEqual({ kind: 'person', text: '/review\n\nPR 314' })
  })

  it('an unrecognised tag stays the person’s — the safe direction', () => {
    // A message that merely starts with `<` is theirs. A new envelope wrongly shown is the
    // behaviour that already shipped; a real message wrongly hidden is gone.
    expect(classifyUserText('<Foo /> renders twice, why?'))
      .toEqual({ kind: 'person', text: '<Foo /> renders twice, why?' })
    expect(classifyUserText('<diff>\n- a\n+ b\n</diff>').kind).toBe('person')
  })

  it('an empty entry is not an empty bubble under someone’s avatar', () => {
    expect(classifyUserText('   ').kind).toBe('system')
    expect(classifyUserText('<bash-input>   </bash-input>').kind).toBe('system')
  })
})

/**
 * MEASURED on this machine, 2026-09-04, over the 120 most recently touched transcripts — 992 `user`
 * entries carrying text:
 *
 *   800  isMeta ABSENT   the person
 *   192  isMeta true     the harness, 148 of them with NO envelope tag
 *     0  isMeta false    never written
 *
 * The untagged 148, by first line:
 *
 *    52  Another Claude session sent a message:
 *    31  [Image: …]                       (two shapes: `source: <path>` and `original WxH…`)
 *    21  Continue from where you left off.
 *    13  Base directory for this skill: /…   ← the block the user circled
 *     6  The coordinator sent a message while you were working…
 *     2  ## Context Usage
 *     2  a `/config` output, in Portuguese
 *
 * Note the correction to the plan: a person's entry does not carry `isMeta: false`, it carries NO
 * `isMeta` KEY AT ALL. Both are covered below — the classifier keys on `=== true`, so an absent
 * flag and an explicit `false` both read as the person, and that is the direction that must be
 * safe.
 */
describe('classifyUserEntry — isMeta', () => {
  /** Every entry here IS meta, so it is `system` by construction — the note is what is under test. */
  const meta = (text: string) => {
    const out = classifyUserEntry({ text, isMeta: true })
    if (out.kind !== 'system') throw new Error(`expected system, got person: ${text}`)
    return out
  }

  it('treats an injected skill body as the harness, not the person', () => {
    const out = meta('Base directory for this skill: /home/u/.claude/skills/x\n\n# A skill\n…')
    expect(out.kind).toBe('system')
  })

  it('never renders the body — a SKILL.md on screen is not a conversation', () => {
    const out = meta('Base directory for this skill: /home/u/.claude/skills/x\n\n# A skill\n…')
    expect(JSON.stringify(out)).not.toContain('# A skill')
  })

  it('names each measured kind rather than saying "system"', () => {
    expect(meta('Another Claude session sent a message:\nhello').note).toContain('session')
    expect(meta('The coordinator sent a message while you were working: hi').note).toContain('session')
    expect(meta('[Image: source: /tmp/x.png]').note).toContain('image')
    expect(meta('[Image: original 2150x1328, displayed at 2000x1235.]').note).toContain('image')
    expect(meta('Continue from where you left off.').note).toContain('resum')
    expect(meta('## Context Usage\n…').note).toContain('context')
    expect(meta('[Cross-session idle notice] "x"').note).toContain('idle')
    expect(meta('Base directory for this skill: /x').note).toContain('skill')
  })

  it('is system even for an unrecognised meta entry — the flag is the harness saying so', () => {
    const out = meta('something nobody has seen before')
    expect(out.kind).toBe('system')
    expect(out.note).not.toBe('')
  })

  it('leaves a real person message alone, flag absent OR explicitly false', () => {
    expect(classifyUserEntry({ text: 'fix the header please' }))
      .toEqual({ kind: 'person', text: 'fix the header please' })
    expect(classifyUserEntry({ text: 'fix the header please', isMeta: false }))
      .toEqual({ kind: 'person', text: 'fix the header please' })
  })

  it('still unwraps the envelopes that ARE the person acting', () => {
    expect(classifyUserEntry({ text: '<bash-input>ls -la</bash-input>' }))
      .toEqual({ kind: 'person', text: 'ls -la' })
  })

  it('does not hide an ordinary message that merely starts with a bracket', () => {
    expect(classifyUserEntry({ text: '<Foo /> renders twice' }).kind).toBe('person')
  })

  it('a TAGGED meta entry is still system, and keeps the tag’s own more specific note', () => {
    const out = classifyUserEntry({ text: '<system-reminder>do not do that</system-reminder>', isMeta: true })
    expect(out.kind).toBe('system')
    expect(out).toEqual({ kind: 'system', note: 'system reminder' })
  })

  it('an empty meta entry is droppable, exactly as an empty person entry is', () => {
    expect(classifyUserEntry({ text: '   ', isMeta: true })).toEqual({ kind: 'system', note: '' })
  })

  it('classifyUserText keeps working — existing callers are untouched', () => {
    expect(classifyUserText('hello')).toEqual({ kind: 'person', text: 'hello' })
  })
})


describe('the compaction summary', () => {
  it('a compaction summary is a NOTE, never a message the person sent', () => {
  // Claude Code writes the summary back in as a `user` entry with no `isMeta` and no envelope tag,
  // so both other rules read it as typed. It is the largest thing in a transcript.
  const summary = 'This session is being continued from a previous conversation that ran out of '
    + 'context.\n\nSummary:\n1. Primary Request and Intent:\n…'
  const out = classifyUserEntry({ text: summary, isCompactSummary: true })
  expect(out.kind).toBe('system')
  expect(out).toEqual({ kind: 'system', note: 'the conversation was compacted' })
  })

  it('the compaction flag outranks isMeta, so the note is the specific one', () => {
  expect(classifyUserEntry({ text: 'anything', isMeta: true, isCompactSummary: true }))
    .toEqual({ kind: 'system', note: 'the conversation was compacted' })
  })

  it('the same text WITHOUT the flag is still the person — it is not matched by its wording', () => {
  // Quoting the summary back at a session is a message somebody typed. The harness declares the
  // real one; a sentence match would both miss a reworded summary and eat a genuine quote.
  const quoted = 'This session is being continued from a previous conversation that ran out of context.'
  expect(classifyUserEntry({ text: quoted }).kind).toBe('person')
  })
})
