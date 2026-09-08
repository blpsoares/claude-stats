import { emptySearchFields } from '@agentistics/tui/control/search-scope'
import { describe, expect, test } from 'bun:test'
import type { ControlSession, SessionState } from '@agentistics/tui/control'
import {
  NATURAL_WIDTH, composeLine, emptyReason, renderSessionTable, resolveWidth,
  type SessionTableStrings,
} from './session-table'
import { dimensionWordBook } from '@agentistics/tui/control/sessions'

const STRINGS: SessionTableStrings = {
  cols: {
    id: 'id', state: 'state', title: 'session', age: 'started', task: 'task',
    worktree: 'worktree', metrics: 'usage', context: 'window', harness: 'harness', where: 'project',
  },
  words: dimensionWordBook({
    labels: {
      day: 'day',
      status: 'state', harness: 'harness', model: 'model', project: 'project', repo: 'repository',
      task: 'task', marked: 'marked',
    },
    unfiled: {
      day: 'no date',
      status: 'state unrecorded', harness: 'harness unknown', model: 'no model recorded',
      project: 'no directory recorded', repo: 'no repository', task: 'no task',
      marked: 'not marked',
    },
    states: {
      working: 'working', waiting: 'waiting', 'waiting-approval': 'needs approval',
      exited: 'ended', lost: 'lost', closed: 'closed', unknown: 'unknown',
    },
    goneProject: 'directory no longer exists',
    marked: 'marked',
  }),
  closed: 'closed',
  done: 'finished',
}

function session(o: Partial<ControlSession> & { id: string }): ControlSession {
  const state: SessionState = o.state ?? 'working'
  return {
    harness: 'claude',
    cwd: `/home/dev/${o.project ?? 'app'}`,
    project: 'app',
    title: `session ${o.id}`,
    stateLabel: state === 'waiting-approval' ? 'needs approval' : state,
    state,
    actionable: true,
    attached: false,
    searchFields: emptySearchFields(),
    ...o,
  }
}

const FLEET: ControlSession[] = [
  session({ id: 'aaaa1', project: 'agentistics', title: 'refactor the parser', state: 'waiting-approval', tokens: '51.7k', cost: '$1.20' }),
  session({ id: 'bbbb2', project: 'agentistics', title: 'port the tests', harness: 'codex', task: 'auth-refactor' }),
  session({ id: 'external:claude:/home/dev/prontuario:12', project: 'prontuario', title: 'claude in prontuario', harness: 'claude', state: 'unknown', stateLabel: 'external' }),
  session({ id: 'cccc3', project: 'embark', title: 'a very long session title that will not fit a narrow terminal', state: 'exited', stateLabel: 'exited', worktree: true, projectGroup: 'embark' }),
]

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('renderSessionTable', () => {
  test('no line ever exceeds the width, at any width, coloured or not', () => {
    for (let width = 8; width <= 200; width++) {
      for (const color of [false, true]) {
        const lines = renderSessionTable({
          sessions: FLEET, width, grouping: 'project', strings: STRINGS, color,
        })
        for (const line of lines) {
          expect(stripAnsi(line).length).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  test('indents a cascade branch, so `session ls --group tree` IS the cockpit table', () => {
    // The same rows, drawn by the same functions: a tree that came out flat on the command line
    // would be a different arrangement wearing one name, which is the defect `session-table.ts`
    // exists to have fixed once.
    const ROOT = '/home/dev/agentistics'
    const lines = renderSessionTable({
      sessions: [
        session({ id: 'aaaa1', cwd: `${ROOT}/packages/tui`, projectGroup: 'agentistics', projectRoot: ROOT }),
        session({ id: 'bbbb2', cwd: `${ROOT}/packages/server`, projectGroup: 'agentistics', projectRoot: ROOT }),
      ],
      width: NATURAL_WIDTH,
      grouping: 'tree',
      strings: STRINGS,
      color: false,
    })
    const headings = lines.map(stripAnsi).filter(l => /^\s*\S.*\s{2}\d/.test(l) && !l.includes('claude'))
    expect(headings.map(l => l.replace(/\s\s+\d.*$/, ''))).toEqual([
      'agentistics',
      '  packages',
      '    server',
      '    tui',
    ])
  })

  test('a piped run at the natural width truncates nothing', () => {
    const lines = renderSessionTable({
      sessions: FLEET, width: NATURAL_WIDTH, grouping: 'project', strings: STRINGS, color: false,
    })
    expect(lines.join('\n')).toContain('a very long session title that will not fit a narrow terminal')
    expect(lines.some(l => l.includes('…'))).toBe(false)
  })

  test('a heading rules to the edge of the TABLE, never of the budget', () => {
    // At a pipe's width the budget is ten thousand columns and the table is a few dozen. Ruling to
    // the budget drew ten thousand dashes over four sessions.
    const lines = renderSessionTable({
      sessions: FLEET, width: NATURAL_WIDTH, grouping: 'project', strings: STRINGS, color: false,
    })
    const widest = Math.max(...lines.map(l => l.length))
    expect(widest).toBeLessThan(200)
    expect(lines.some(l => l.includes('─'))).toBe(true)
  })

  test('the same table with colour off is the coloured one with the escapes removed', () => {
    const opts = { sessions: FLEET, width: 100, grouping: 'project' as const, strings: STRINGS }
    const plain = renderSessionTable({ ...opts, color: false })
    const coloured = renderSessionTable({ ...opts, color: true })
    expect(coloured.map(stripAnsi)).toEqual(plain)
    expect(coloured.join('')).toContain('\x1b[')
  })

  test('groups by project, heading each section with its count', () => {
    const lines = renderSessionTable({
      sessions: FLEET, width: 120, grouping: 'project', strings: STRINGS, color: false,
    })
    const headings = lines.filter(l => /^\S/.test(l) && !l.startsWith('  '))
    expect(headings.some(h => h.startsWith('agentistics  2'))).toBe(true)
    expect(headings.some(h => h.startsWith('prontuario  1'))).toBe(true)
  })

  test('a session with no recorded usage prints no zero', () => {
    const noUsage = [session({ id: 'aaaa1' }), session({ id: 'bbbb2' })]
    const lines = renderSessionTable({
      sessions: noUsage, width: 120, grouping: 'none', strings: STRINGS, color: false,
    })
    // The usage column does not exist at all — an absent metric is never a confident 0.
    expect(lines[0]).not.toContain('usage')
    expect(lines.join('\n')).not.toMatch(/\b0\b/)
  })

  test('usage is shown for the rows that have it, and only for those', () => {
    const lines = renderSessionTable({
      sessions: FLEET, width: 140, grouping: 'none', strings: STRINGS, color: false,
    })
    expect(lines[0]).toContain('usage')
    expect(lines.join('\n')).toContain('51.7k $1.20')
  })

  test('an external row is listed and wears its own word', () => {
    const lines = renderSessionTable({
      sessions: FLEET, width: 140, grouping: 'none', strings: STRINGS, color: false,
    })
    expect(lines.join('\n')).toContain('external')
    // ...and carries no handle: `agentop session attach` cannot resolve one for it.
    const row = lines.find(l => l.includes('claude in prontuario'))!
    expect(row).not.toContain('exter ')
  })

  test('an empty fleet renders nothing at all — the caller says why', () => {
    expect(renderSessionTable({
      sessions: [], width: 80, grouping: 'project', strings: STRINGS, color: false,
    })).toEqual([])
  })

  test('a finished task says so on its heading', () => {
    const lines = renderSessionTable({
      sessions: [session({ id: 'aaaa1', task: 'auth-refactor' })],
      width: 120,
      grouping: 'task',
      strings: STRINGS,
      color: false,
      doneTasks: ['auth-refactor'],
    })
    expect(lines.join('\n')).toContain('auth-refactor · finished')
  })
})

describe('resolveWidth', () => {
  test('--width outranks everything, including a terminal that disagrees', () => {
    expect(resolveWidth({ explicit: 72, columns: 200, env: '30' })).toBe(72)
  })

  test('a terminal answers for itself', () => {
    expect(resolveWidth({ columns: 118, env: '30' })).toBe(118)
  })

  test('with no tty, COLUMNS is what says how wide the reader is', () => {
    // `agentop session ls | less -S` in an 80-column terminal: a pipe is not evidence that nobody
    // is reading, and COLUMNS is the only thing left that says how wide the reader is.
    expect(resolveWidth({ env: '80' })).toBe(80)
    expect(resolveWidth({ env: ' 96 ' })).toBe(96)
  })

  test('a pipe that says nothing gets the natural width, so nothing is truncated', () => {
    expect(resolveWidth({})).toBe(NATURAL_WIDTH)
    expect(resolveWidth({ env: undefined })).toBe(NATURAL_WIDTH)
    expect(resolveWidth({ env: '' })).toBe(NATURAL_WIDTH)
  })

  test('a COLUMNS that is not a width falls through rather than exploding', () => {
    for (const junk of ['abc', '0', '-1', '12.5', 'NaN', '1e3px', ' ']) {
      expect(resolveWidth({ env: junk })).toBe(NATURAL_WIDTH)
    }
  })

  test('no floor is invented — a caller asking for twenty columns gets twenty', () => {
    expect(resolveWidth({ env: '20' })).toBe(20)
    expect(resolveWidth({ explicit: 1 })).toBe(1)
    // ...and the table still fits inside them, which is the clip's job, not a minimum's.
    const lines = renderSessionTable({
      sessions: FLEET, width: resolveWidth({ env: '20' }), grouping: 'project',
      strings: STRINGS, color: true,
    })
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(20)
  })
})

describe('emptyReason', () => {
  test('a table is drawn, so there is nothing to explain', () => {
    expect(emptyReason({ fleet: 3, shown: 1 })).toBeNull()
  })

  test('a failed poll never claims that nothing is running', () => {
    expect(emptyReason({ fleet: 0, shown: 0, unavailable: 'tmux is not answering' })).toBe('unavailable')
    // Even with rows carried over from the previous poll, the reason is the failure.
    expect(emptyReason({ fleet: 4, shown: 0, unavailable: 'tmux is not answering' })).toBe('unavailable')
  })

  test('an empty machine and a filtered one are different sentences', () => {
    expect(emptyReason({ fleet: 0, shown: 0 })).toBe('empty')
    expect(emptyReason({ fleet: 7, shown: 0 })).toBe('filtered')
  })
})

describe('composeLine', () => {
  test('clips on visible characters, never on the escapes', () => {
    const line = composeLine([{ text: 'abcdefgh', code: '\x1b[2m' }], 4, true)
    expect(stripAnsi(line)).toBe('abcd')
  })

  test('drops the padding at the end of the line, coloured or not', () => {
    const segs = [{ text: 'ab' }, { text: '  cd    ', code: '\x1b[2m' }]
    expect(composeLine(segs, 40, false)).toBe('ab  cd')
    expect(stripAnsi(composeLine(segs, 40, true))).toBe('ab  cd')
  })

  test('a zero width yields an empty line rather than a partial one', () => {
    expect(composeLine([{ text: 'abc' }], 0, false)).toBe('')
  })
})
