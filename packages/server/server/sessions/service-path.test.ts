import { expect, test } from 'bun:test'
import { servicePath, SYSTEM_PATH } from './service-path'

test('the harness directories reach the unit — the bug this exists for', () => {
  const out = servicePath('/home/u/.local/bin:/home/u/.bun/bin:/usr/bin:/bin')
  expect(out).toBe('/home/u/.local/bin:/home/u/.bun/bin:/usr/bin:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin')
})

test('it is ADDITIVE — the system directories are never lost', () => {
  const out = servicePath('/home/u/.local/bin')!
  for (const d of SYSTEM_PATH) expect(out.split(':')).toContain(d)
})

test('relative and empty entries are dropped', () => {
  // A service has no meaningful working directory: `.` on its PATH lets whatever directory it
  // started in supply a binary.
  const out = servicePath('.:/home/u/.local/bin::relative/bin')!
  expect(out.split(':')).not.toContain('.')
  expect(out.split(':')).not.toContain('')
  expect(out.split(':')).not.toContain('relative/bin')
  expect(out.split(':')[0]).toBe('/home/u/.local/bin')
})

test('duplicates collapse, keeping the first position', () => {
  expect(servicePath('/home/u/bin:/usr/bin:/home/u/bin')!.split(':').filter(d => d === '/home/u/bin'))
    .toHaveLength(1)
})

test('a trailing slash is the same directory', () => {
  const out = servicePath('/home/u/bin/:/home/u/bin')!
  expect(out.split(':').filter(d => d.startsWith('/home/u/bin'))).toEqual(['/home/u/bin'])
})

test('nothing to add writes NO line at all', () => {
  // A unit restating the default is a line somebody has to read and then discard.
  expect(servicePath('/usr/bin:/bin')).toBeNull()
  expect(servicePath('')).toBeNull()
  expect(servicePath(undefined)).toBeNull()
})
