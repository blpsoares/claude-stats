import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockFile, STALE_MS, withFileLock } from './file-lock'

async function tmp(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'agentop-lock-')), 'file.json')
}

test('a lock is held, and released', async () => {
  const f = await tmp()
  const held = await lockFile(f)
  expect(held.contended).toBe(false)
  await expect(stat(`${f}.lock`)).resolves.toBeDefined()
  await held.release()
  await expect(stat(`${f}.lock`)).rejects.toBeDefined()
})

test('an ABANDONED lock is cleared rather than waited on forever', async () => {
  // A process killed between acquire and release leaves the directory. Without expiry the next
  // start of agentop would hang on a lock nobody holds.
  const f = await tmp()
  await mkdir(`${f}.lock`)
  const old = Date.now() + STALE_MS + 1000
  const held = await lockFile(f, () => old)
  expect(held.contended).toBe(false)
  await held.release()
})

test('a contended lock PROCEEDS and says so, rather than failing the caller', async () => {
  // Refusing here would mean not recording a session that has already been spawned — a lost label
  // is a smaller harm than a live session with no record at all.
  const f = await tmp()
  const first = await lockFile(f)
  let t = Date.now()
  const second = await lockFile(f, () => (t += 3000))
  expect(second.contended).toBe(true)
  await first.release()
  await second.release()
})

test('the lock is released even when the work throws', async () => {
  const f = await tmp()
  await expect(withFileLock(f, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  await expect(stat(`${f}.lock`)).rejects.toBeDefined()
})

test('two callers in one process still run one at a time', async () => {
  const f = await tmp()
  const order: string[] = []
  await Promise.all([
    withFileLock(f, async () => { order.push('a-in'); await Bun.sleep(30); order.push('a-out') }),
    withFileLock(f, async () => { order.push('b-in'); await Bun.sleep(1); order.push('b-out') }),
  ])
  // Whoever went first finished before the other started.
  expect(order[0]!.endsWith('-in')).toBe(true)
  expect(order[1]).toBe(`${order[0]!.slice(0, 1)}-out`)
})

test('the lock directory does not survive a release, so it cannot become stale garbage', async () => {
  const f = await tmp()
  await withFileLock(f, async () => undefined)
  await expect(stat(`${f}.lock`)).rejects.toBeDefined()
  await rm(f, { force: true })
})
