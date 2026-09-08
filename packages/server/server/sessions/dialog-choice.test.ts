import { describe, expect, it } from 'bun:test'
import { needsChoice, parseDialogOptions, readDialog } from './dialog-choice'

/**
 * VERBATIM from a live claude 2.1.232 Write permission prompt, 2026-08-14.
 *
 * The dialog this feature's first version treated as a yes/no. It is not one: option 2 grants
 * standing permission for the rest of the session, which is a materially different answer from
 * option 1, and a keystroke called "approve" picked whichever was highlighted.
 */
const WRITE_PERMISSION = [
  ' Create file',
  ' agentop-choice-probe.txt',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '  1 probe',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to create agentop-choice-probe.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
]

/**
 * VERBATIM from a live claude 2.1.232 `AskUserQuestion`, 2026-08-14.
 *
 * The shape the user was looking at when they reported this: options with DESCRIPTION lines under
 * them, a free-text escape hatch, and a fifth option below a horizontal rule.
 */
const ASK_QUESTION = [
  '────────────────────────────────────────',
  ' ☐ Deploy',
  '',
  'Como você quer fazer o deploy?',
  '',
  '❯ 1. Deploy manual via CLI',
  '     Você (ou eu) roda o comando de deploy direto do terminal — controle total, sem',
  '     configuração extra, mas cada release depende de alguém executar o comando.',
  '  2. CI/CD automático no push',
  '     Um pipeline faz build, testes e deploy a cada push na branch principal.',
  '  3. Deploy por tag/release',
  '     O pipeline dispara só quando você cria uma tag ou release.',
  '  4. Type something.',
  '────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
]

describe('parseDialogOptions', () => {
  it('reads a permission prompt as the THREE-way choice it actually is', () => {
    const out = parseDialogOptions(WRITE_PERMISSION)
    expect(out.map(o => o.number)).toEqual([1, 2, 3])
    expect(out.map(o => o.label)).toEqual([
      'Yes',
      'Yes, allow all edits during this session (shift+tab)',
      'No',
    ])
  })

  it('marks the row the dialog is highlighting, and only that one', () => {
    const out = parseDialogOptions(WRITE_PERMISSION)
    expect(out.filter(o => o.selected).map(o => o.number)).toEqual([1])
  })

  it('reads a question whose options carry DESCRIPTIONS under them', () => {
    // The continuation lines are indented prose, not options, and must not become entries.
    const out = parseDialogOptions(ASK_QUESTION)
    expect(out.map(o => o.number)).toEqual([1, 2, 3, 4, 5])
    expect(out[0]!.label).toBe('Deploy manual via CLI')
    expect(out[3]!.label).toBe('Type something.')
  })

  it('crosses the rule that separates the last option from the block', () => {
    // `5. Chat about this` sits below a horizontal rule. Stopping at the rule would drop a real
    // answer, and the numbers would then still look consecutive — a silent, plausible truncation.
    expect(parseDialogOptions(ASK_QUESTION).map(o => o.label)).toContain('Chat about this')
  })

  // --- the confidence gates ------------------------------------------------------------------

  it('reads the LAST block, not a numbered list further up the conversation', () => {
    const frame = [
      '● Here is my plan:',
      '  1. read the file',
      '  2. change it',
      '  3. run the tests',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      ' Esc to cancel · Tab to amend',
    ]
    expect(parseDialogOptions(frame).map(o => o.label)).toEqual(['Yes', 'No'])
  })

  it('refuses a list whose numbers are not exactly 1..n', () => {
    // Half-read options are worse than none: they would be OFFERED, as if they were the whole menu.
    expect(parseDialogOptions([' 1. a', ' 3. c'])).toEqual([])
    expect(parseDialogOptions([' 2. b', ' 3. c'])).toEqual([])
    expect(parseDialogOptions([' 1. a', ' 2. b', ' 2. b again'])).toEqual([])
  })

  it('refuses a single option — that is a statement, not a choice', () => {
    expect(parseDialogOptions([' 1. Yes'])).toEqual([])
  })

  it('refuses a frame showing two cursors, which it does not understand', () => {
    expect(parseDialogOptions([' ❯ 1. a', ' ❯ 2. b'])).toEqual([])
  })

  it('refuses a bare number with no text after it', () => {
    // Far more likely an ordinal in prose than a menu entry.
    expect(parseDialogOptions([' 1. ', ' 2. '])).toEqual([])
  })

  it('is empty for a dialog that offers nothing to choose between', () => {
    // codex: `Press enter to continue`. There is genuinely no choice, and the caller confirms.
    expect(parseDialogOptions(['Update available', '', 'Press enter to continue'])).toEqual([])
    expect(parseDialogOptions([])).toEqual([])
  })

  it('does not scan the whole scrollback looking for a 1', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`)
    expect(parseDialogOptions([...long, ' 7. stray'])).toEqual([])
  })
})

describe('needsChoice', () => {
  it('is the question the UI asks before it may send a bare confirm', () => {
    expect(needsChoice(parseDialogOptions(WRITE_PERMISSION))).toBe(true)
    expect(needsChoice(parseDialogOptions(ASK_QUESTION))).toBe(true)
    expect(needsChoice([])).toBe(false)
  })
})


/**
 * THE DIALOG FROM THE REPORT, 2026-09-07 — a multi-select `AskUserQuestion` with four options,
 * each carrying a description that WRAPS, plus the free-text row expanded into a field and the
 * `Chat about this` escape hatch below the rule.
 *
 * Reconstructed from the reported screenshot, re-wrapped at the NARROW width it was drawn at
 * (44 columns of description) — which is the condition that reproduces it. The user could not
 * answer it from the browser and had to open the terminal: the preview began in the middle of a
 * sentence ("…causa'. Puramente informativo") and the card offered a bare confirm button.
 *
 * What makes it the regression fixture is its HEIGHT. Option 1 sits far more than 40 lines above
 * the bottom — not because the dialog is unusual, but because the window was narrow enough for the
 * descriptions to wrap onto four lines each. The same dialog on a wide terminal fits and parses.
 */
const TALL_ASK = [
  'Vou fazer isso num worktree a partir de origin/dev.',
  '',
  '────────────────────────────────────────────────────────',
  ' ☐ Gatilhos v1',
  '',
  'Quais gatilhos entram na v1? (o compact que você',
  'citou é o sintoma; o contexto é a causa)',
  '',
  '❯ 1. [ ] Contexto ≥85% sem compact ainda',
  '        context_tokens / resolveContextWindow.',
  '        Dispara ANTES da perda — o handoff sai da',
  '        sessão cheia, não de um resumo de resumo. Só',
  '        funciona em claude/codex/antigravity',
  '        (contextWindow: true); gemini/copilot/kimi',
  '        não medem contexto e simplesmente não',
  '        recebem esse card.',
  '  2. [ ] ≥2 compacts na sessão',
  '        compact_boundary + compactMetadata. Diz o',
  '        custo já pago com número (\'2 compacts,',
  '        3m29s, 2,9M descartados\'). Só Claude — exige',
  '        um HARNESS_CAPABILITIES.compaction novo. É',
  '        tarde para um handoff bom, mas é o sinal',
  '        mais legível.',
  '  3. [ ] Esperando aprovação há >N min',
  '        attention.ts já sabe disso; o card só',
  '        empacota a ação que já existe',
  '        (aprovar/abrir). Barato, funciona nos 6',
  '        harnesses, mas é quase redundante com o',
  '        contador de \'precisa de você\' no header.',
  '  4. [ ] Erros repetidos da mesma categoria',
  '        tool_error_categories. Prompt sugerido:',
  '        \'esses N erros são todos X, ataca a causa\'.',
  '        Puramente informativo/prompt, sem migração.',
  '        Disponível onde o adapter preenche a',
  '        categoria.',
  '  5. [ ] Type something',
  '      Submit',
  '────────────────────────────────────────────────────────',
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '',
  '  ❯ /context',
]

describe('readDialog — the tall dialog that stranded a user', () => {
  it('reads a dialog whose option 1 is far more than 40 lines up', () => {
    const out = readDialog(TALL_ASK)
    expect(out.kind).toBe('options')
    expect(out.options.map(o => o.number)).toEqual([1, 2, 3, 4, 5, 6])
    expect(out.options[0]!.selected).toBe(true)
  })

  it('points the preview at the option block, not at a flat ten lines', () => {
    const out = readDialog(TALL_ASK)
    expect(TALL_ASK[out.top]).toContain('Contexto ≥85%')
  })

  it('never reaches the prose above the dialog', () => {
    expect(readDialog(TALL_ASK).options.some(o => o.label.includes('worktree'))).toBe(false)
  })
})

describe('readDialog — the two different empties', () => {
  it('says `none` when there is no menu: a confirm key is the right answer there', () => {
    const out = readDialog(['Press enter to continue', ''])
    expect(out.kind).toBe('none')
    expect(out.options).toEqual([])
  })

  it('says `unreadable` when option 1 is out of reach — NOT `none`', () => {
    // The block is real; its top ran off the frame. Offering a confirm here picks the
    // highlighted row blind, which is the accident this module exists to prevent.
    const frame = ['  3. c', '  4. d', '❯ 5. e', '', 'Esc to cancel']
    const out = readDialog(frame)
    expect(out.kind).toBe('unreadable')
    expect(out.reason).toBe('no-anchor')
    expect(out.options).toEqual([])
  })

  it('says `unreadable` on a gap, and on two cursors', () => {
    expect(readDialog([' 1. a', ' 3. c']).reason).toBe('gap')
    expect(readDialog(['❯ 1. a', '❯ 2. b']).reason).toBe('two-cursors')
  })

  it('a single option is `none` — a statement, not a menu', () => {
    expect(readDialog([' 1. Yes', '', 'Esc to cancel']).kind).toBe('none')
  })

  it('numbered prose far above the menu is not joined to it', () => {
    const frame = [
      '1. primeiro ponto de uma lista em prosa',
      ...Array.from({ length: 16 }, (_, i) => `linha de prosa ${i}`),
      '  2. b',
      '  3. c',
      '',
      'Esc to cancel',
    ]
    // It found 3 and 2, then the gap to `1.` is wider than one option's description.
    expect(readDialog(frame).kind).toBe('unreadable')
  })
})

describe('parseDialogOptions stays the thin reading', () => {
  it('agrees with readDialog on every fixture', () => {
    for (const f of [WRITE_PERMISSION, ASK_QUESTION, TALL_ASK]) {
      expect(parseDialogOptions(f)).toEqual(readDialog(f).options)
    }
  })
})
