/**
 * backup-route-body.lint.test.ts — a route must PASS ON every field its function accepts.
 *
 * `connectGithub` was fixed to authenticate through `gh` without a token, its unit tests went
 * green, the binary was rebuilt — and the screen still said "a GitHub personal access token is
 * required", because the HTTP handler destructured `{ url, token }` out of the body and dropped
 * `auth` on the floor. The function was right and unreachable.
 *
 * A unit test on the function cannot see that, and a full HTTP test would need a live server. This
 * greps the handler's own source instead — the shape `tokens.lint.test.ts` and
 * `releaseWorkflow.lint.test.ts` already use — and asserts that every field the input type declares
 * is at least MENTIONED in the handler that feeds it.
 */
import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const INDEX = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8')

/** The handler block for one route path, from its `if (url.pathname === …)` to the next one. */
function handlerFor(path: string): string {
  const start = INDEX.indexOf(`url.pathname === '${path}'`)
  expect(start).toBeGreaterThan(-1)
  const rest = INDEX.slice(start + 1)
  const end = rest.indexOf("url.pathname === '")
  return rest.slice(0, end === -1 ? rest.length : end)
}

test('the github setup route passes on `auth` — the field that makes gh mode work', () => {
  const h = handlerFor('/api/backup/github/setup')
  for (const field of ['url', 'token', 'auth']) {
    expect(h.includes(field)).toBe(true)
  }
})

test('the restore start route passes on every field a restore needs', () => {
  // Same class of defect, waiting to happen: `withRepos` decides whether repositories are cloned,
  // and dropping it would quietly restore metrics only while the screen said "everything".
  const h = handlerFor('/api/backup/restore/start')
  for (const field of ['url', 'tag', 'token', 'withRepos']) {
    expect(h.includes(field)).toBe(true)
  }
})

test('the restore list route passes on the token', () => {
  const h = handlerFor('/api/backup/restore/list')
  for (const field of ['url', 'token']) {
    expect(h.includes(field)).toBe(true)
  }
})
