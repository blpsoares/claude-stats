import { test, expect } from 'bun:test'
import { mcpCheckText } from './mcpCheckText'

/**
 * IT NEVER SAYS "CONNECTED". agentistics does not run MCP servers — Claude Code starts them, once,
 * at session start — so the most this can honestly report is that the command answered when asked
 * HERE, plus what has to happen for a session to have it.
 */
test('a server that answered says so, and says what still has to happen', () => {
  const v = mcpCheckText({ outcome: 'answers', serverName: 'Serena' }, true)
  expect(v.text).toContain('Serena')
  expect(v.text).toContain('próxima sessão')
  expect(v.text.toLowerCase()).not.toContain('conectado')
  expect(mcpCheckText({ outcome: 'answers' }, false).text).toContain('next start')
})

/** The measured case, and its own outcome: "ran and quit" is fixed elsewhere than "not installed". */
test('exited carries the code and names the likely cause', () => {
  const v = mcpCheckText({ outcome: 'exited', exitCode: 2 }, true)
  expect(v.text).toContain('código 2')
  expect(v.text).toContain('caminho')
  // Without a code it still reads as a sentence, with no empty parenthesis.
  expect(mcpCheckText({ outcome: 'exited' }, true).text).not.toContain('(')
})

test('the four failures are four different sentences, not one', () => {
  const said = ['not-found', 'timeout', 'unreachable', 'uncheckable']
    .map(o => mcpCheckText({ outcome: o }, false).text)
  expect(new Set(said).size).toBe(4)
})

/**
 * A refused ROUTE is not a verdict about the server. The capability is denied outright on a `lan`
 * or `public` profile, and showing that as "this server is broken" would be a wrong answer about
 * somebody else's configuration.
 */
test('an unknown outcome blames the panel, never the server', () => {
  const v = mcpCheckText({ outcome: 'unavailable' }, true)
  expect(v.text).toContain('Não deu para testar daqui')
  expect(v.color).toBe('var(--text-tertiary)')
})

test('only a success is green, and a slow start is not red', () => {
  expect(mcpCheckText({ outcome: 'answers' }, false).color).toBe('#22c55e')
  expect(mcpCheckText({ outcome: 'timeout' }, false).color).toBe('#f59e0b')
  expect(mcpCheckText({ outcome: 'not-found' }, false).color).toBe('var(--accent-red)')
})

test('it answers in both languages, always', () => {
  for (const o of ['answers', 'exited', 'not-found', 'timeout', 'unreachable', 'uncheckable', '?']) {
    expect(mcpCheckText({ outcome: o }, true).text.length).toBeGreaterThan(0)
    expect(mcpCheckText({ outcome: o }, false).text.length).toBeGreaterThan(0)
  }
})
