import { describe, expect, test } from 'bun:test'
import { splitApprovalFrame } from './approvalQuestion'

// Captured from a live Claude Code `AskUserQuestion` on 2026-09-07 — the shape that was reported.
const ASK = [
  'Qual estrategia de cache devo usar para o relatorio mensal?',
  '',
  '❯ 1. Cache em memoria',
  '     Guardar o resultado no processo da aplicacao.',
  '  2. Redis compartilhado',
  '     Cache externo compartilhado entre todas as instancias.',
  '  5. Type something.',
  '────────────────────────────────────────',
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
]

describe('splitApprovalFrame', () => {
  test('the question is everything above the first option', () => {
    expect(splitApprovalFrame(ASK).question)
      .toEqual(['Qual estrategia de cache devo usar para o relatorio mensal?'])
  })

  test('the cursor mark on the first row does not hide it', () => {
    expect(splitApprovalFrame(['pergunta', '', '❯ 1. um', '  2. dois']).question).toEqual(['pergunta'])
    expect(splitApprovalFrame(['pergunta', '', '  1. um', '  2. dois']).question).toEqual(['pergunta'])
  })

  test('a permission prompt keeps the COMMAND in the question half', () => {
    const frame = ['Claude wants to run:', '', '  rm -rf build/', '', '❯ 1. Yes', '  2. No']
    expect(splitApprovalFrame(frame).question)
      .toEqual(['Claude wants to run:', '', '  rm -rf build/'])
  })

  test('a frame with no numbered option is left whole — no invented heading', () => {
    const frame = ['Press enter to continue']
    expect(splitApprovalFrame(frame)).toEqual({ question: [], raw: frame })
  })

  test('a frame that STARTS at the option has no question, not an empty first line', () => {
    expect(splitApprovalFrame(['1. Yes', '2. No']).question).toEqual([])
  })

  test('the raw frame is never a subset — the disclosure must show everything', () => {
    expect(splitApprovalFrame(ASK).raw).toEqual(ASK)
  })

  test('an empty frame is not a crash', () => {
    expect(splitApprovalFrame([])).toEqual({ question: [], raw: [] })
  })
})

// Captured verbatim from a live Claude Code AskUserQuestion, 2026-09-07 — the BOXED shape.
const BOXED = [
  '│ Devo migrar o relatorio mensal para uma tabela materializada antes ou depois',
  '│ do fechamento contabil?',
  '',
  '❯ 1. Antes do fechamento',
  '     Migrar para a tabela materializada antes do fechamento contábil.',
  '  2. Depois do fechamento',
]

describe('the box the harness draws', () => {
  test('the gutter is stripped and the terminal wrap is undone', () => {
    expect(splitApprovalFrame(BOXED).question)
      .toEqual(['Devo migrar o relatorio mensal para uma tabela materializada antes ou depois do fechamento contabil?'])
  })

  test('the raw frame still carries the gutter — the disclosure shows the screen', () => {
    expect(splitApprovalFrame(BOXED).raw[0]).toBe(BOXED[0])
  })

  test('a SHORT line is an authored break and is never joined to what follows', () => {
    // SYNTHETIC, and said so: no permission prompt was captured for this. What it pins is the
    // PROPERTY — inside a box whose width the frame declares (the `────` rule below), a line that
    // does not reach that column ended because its author ended it.
    const frame = [
      '│ Claude wants to run this command and it needs your ok:',
      '│ rm -rf build/',
      '│ Continue?',
      '❯ 1. Yes',
      '────────────────────────────────────────────────────────────────────────────────',
    ]
    expect(splitApprovalFrame(frame).question)
      .toEqual(['Claude wants to run this command and it needs your ok:', 'rm -rf build/', 'Continue?'])
  })

  test('an unboxed question is left exactly as captured', () => {
    expect(splitApprovalFrame(ASK).question)
      .toEqual(['Qual estrategia de cache devo usar para o relatorio mensal?'])
  })
})
