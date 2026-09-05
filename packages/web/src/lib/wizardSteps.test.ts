import { describe, expect, it } from 'bun:test'
import {
  STEP_ORDER, clearForHarness, modelDisplay, nextStep, prevStep, stepReady, unsetAnswer,
  visibleQuestions, type WizardDraft,
} from './wizardSteps'

const claude = {
  id: 'claude', label: 'Claude Code',
  models: [{ id: 'opus', label: 'Opus 5' }],
  supportsModel: true, efforts: ['low', 'high'],
}
const codex = { id: 'codex', label: 'Codex', models: [], supportsModel: true, efforts: [] }
const empty: WizardDraft = {
  harness: '', cwd: '', task: '', model: '', effort: '', prompt: '', label: '', attachments: [],
}

describe('STEP_ORDER', () => {
  it('is assistant, where, message, review', () => {
    expect(STEP_ORDER).toEqual(['assistant', 'where', 'message', 'review'])
  })
})

describe('stepReady', () => {
  it('blocks step 1 until an assistant is chosen, and says what is missing', () => {
    const out = stepReady('assistant', empty, null)
    expect(out.ok).toBe(false)
    expect(out.missing).toBe('assistant')
  })
  it('still blocks step 1 once an assistant is chosen but no title is written', () => {
    const out = stepReady('assistant', { ...empty, harness: 'claude' }, claude)
    expect(out.ok).toBe(false)
    expect(out.missing).toBe('title')
  })
  it('accepts step 1 with an assistant and a title — model and effort stay optional', () => {
    expect(stepReady('assistant', { ...empty, harness: 'claude', label: 'Wizard polish' }, claude).ok).toBe(true)
  })
  it('does not accept whitespace as a title', () => {
    const out = stepReady('assistant', { ...empty, harness: 'claude', label: '   ' }, claude)
    expect(out.ok).toBe(false)
    expect(out.missing).toBe('title')
  })
  it('asks for the assistant BEFORE the title — one sentence at a time', () => {
    expect(stepReady('assistant', { ...empty, label: 'Wizard polish' }, null).missing).toBe('assistant')
  })
  it('blocks step 2 until a directory is chosen', () => {
    expect(stepReady('where', { ...empty, harness: 'claude', label: 'n' }, claude).ok).toBe(false)
    expect(stepReady('where', { ...empty, harness: 'claude', label: 'n', cwd: '/home/u/p' }, claude).ok).toBe(true)
  })
  it('never blocks step 3 — the first message is optional', () => {
    expect(stepReady('message', { ...empty, harness: 'claude', label: 'n', cwd: '/home/u/p' }, claude).ok).toBe(true)
  })
  it('accepts review only when every earlier step does', () => {
    expect(stepReady('review', { ...empty, harness: 'claude', label: 'n' }, claude).ok).toBe(false)
    expect(stepReady('review', { ...empty, harness: 'claude', cwd: '/home/u/p' }, claude).missing).toBe('title')
    expect(stepReady('review', { ...empty, harness: 'claude', label: 'n', cwd: '/home/u/p' }, claude).ok).toBe(true)
  })
})

describe('visibleQuestions', () => {
  it('asks for a model only when the harness names some', () => {
    expect(visibleQuestions(claude).model).toBe(true)
    // supportsModel is true for codex, but it names no models — a dropdown whose only entry is
    // "the assistant's default" is a control that cannot be used.
    expect(visibleQuestions(codex).model).toBe(false)
  })
  it('asks for an effort only when the CLI prints a closed set', () => {
    expect(visibleQuestions(claude).effort).toBe(true)
    expect(visibleQuestions(codex).effort).toBe(false)
  })
  it('asks nothing extra when there is no harness yet', () => {
    expect(visibleQuestions(null)).toEqual({ model: false, effort: false })
  })
})

describe('modelDisplay', () => {
  const models = [{ id: 'opus', label: 'Opus 5' }, { id: 'auto', label: 'auto' }]
  it('shows the name the harness prints, with the id beside it', () => {
    expect(modelDisplay(models, 'opus')).toEqual({ label: 'Opus 5', id: 'opus' })
  })
  it('drops the id when the harness publishes no name for it', () => {
    expect(modelDisplay(models, 'auto')).toEqual({ label: 'auto', id: null })
  })
  it('shows an unlisted id as itself, never as an invented name', () => {
    expect(modelDisplay(models, 'claude-opus-5-20260101')).toEqual({ label: 'claude-opus-5-20260101', id: null })
  })
  it('says nothing at all for an unset model — that is a sentence, not a value', () => {
    expect(modelDisplay(models, '')).toBeNull()
  })
})

describe('unsetAnswer', () => {
  it('names the default when the CLI published one', () => {
    expect(unsetAnswer('sonnet')).toEqual({ known: true, value: 'sonnet' })
  })
  it('says it cannot name one when nothing was published', () => {
    expect(unsetAnswer(undefined)).toEqual({ known: false })
    expect(unsetAnswer(null)).toEqual({ known: false })
  })
  it('treats a blank as absent — an empty field is nobody naming a default', () => {
    expect(unsetAnswer('')).toEqual({ known: false })
    expect(unsetAnswer('   ')).toEqual({ known: false })
  })
})

describe('navigation', () => {
  it('walks forward and back without falling off either end', () => {
    expect(nextStep('assistant')).toBe('where')
    expect(nextStep('review')).toBe('review')
    expect(prevStep('assistant')).toBe('assistant')
    expect(prevStep('review')).toBe('message')
  })
})

describe('clearForHarness', () => {
  it('drops a model and an effort the new assistant does not accept', () => {
    const d = { ...empty, harness: 'codex', model: 'opus', effort: 'high' }
    expect(clearForHarness(d, codex)).toMatchObject({ model: '', effort: '' })
  })
  it('keeps a model the new assistant does name', () => {
    const d = { ...empty, harness: 'claude', model: 'opus', effort: 'high' }
    expect(clearForHarness(d, claude)).toMatchObject({ model: 'opus', effort: 'high' })
  })
  it('never touches the answers that belong to any assistant', () => {
    const d = { ...empty, harness: 'codex', cwd: '/p', task: 't', prompt: 'go', label: 'n' }
    expect(clearForHarness(d, codex)).toMatchObject({ cwd: '/p', task: 't', prompt: 'go', label: 'n' })
  })
})
