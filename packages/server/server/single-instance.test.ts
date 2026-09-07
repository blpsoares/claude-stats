/** The guard that stops a second server from spending a laptop's memory on work the first one is
 *  already doing. Four were once found running side by side, two of them started in the same
 *  second — so "two processes racing" is the case that actually matters here, not the tidy one. */
import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, readFile, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { claimInstanceLock } from './single-instance'

async function lockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'lock-')), 'server.lock')
}

test('the first caller claims it and the second is refused', async () => {
  const file = await lockPath()

  // This process's own pid, because the holder has to be ALIVE for the claim to mean anything —
  // a made-up pid is a dead pid, and a dead holder is correctly treated as debris.
  const first = await claimInstanceLock(file, process.pid)
  expect(first.ok).toBe(true)

  const second = await claimInstanceLock(file, 2222)
  expect(second.ok).toBe(false)
  // It reports WHO holds it, so the loser can say something useful instead of dying silently.
  if (!second.ok) expect(second.holder).toBe(process.pid)
})

test('exactly one of many simultaneous starts wins', async () => {
  const file = await lockPath()

  // The real failure: a supervisor launching copies in the same second, where a "is the port
  // free?" probe lets every one of them through.
  const results = await Promise.all(
    Array.from({ length: 8 }, () => claimInstanceLock(file, process.pid))
  )

  expect(results.filter(r => r.ok)).toHaveLength(1)
})

test('releasing lets the next one in', async () => {
  const file = await lockPath()

  const first = await claimInstanceLock(file, process.pid)
  expect(first.ok).toBe(true)
  if (first.ok) await first.release()

  const second = await claimInstanceLock(file, 2222)
  expect(second.ok).toBe(true)
})

test('a lock left by a dead process is reclaimed, not obeyed forever', async () => {
  const file = await lockPath()
  // What a crash or `kill -9` leaves behind. Refusing to ever start again would be a worse
  // failure than the duplicate this guards against.
  await writeFile(file, '999999')

  const claim = await claimInstanceLock(file, 4444)
  expect(claim.ok).toBe(true)
  expect((await readFile(file, 'utf-8')).trim()).toBe('4444')
})

test('a live holder is obeyed — this process is the liveness proof', async () => {
  const file = await lockPath()
  await writeFile(file, String(process.pid))

  const claim = await claimInstanceLock(file, 5555)
  expect(claim.ok).toBe(false)
})

test('an unreadable lock that is FRESH is obeyed — a winner may be mid-write', async () => {
  const file = await lockPath()
  // Creating the lock and writing the pid into it are two operations. Deleting a claim caught in
  // between them would make this guard cause the race it prevents.
  await writeFile(file, '')

  const claim = await claimInstanceLock(file, 6666)
  expect(claim.ok).toBe(false)
})

test('an unreadable lock that is OLD is debris, and is reclaimed', async () => {
  const file = await lockPath()
  await writeFile(file, 'not-a-pid')
  const longAgo = new Date(Date.now() - 60_000)
  await utimes(file, longAgo, longAgo)

  const claim = await claimInstanceLock(file, 6666)
  expect(claim.ok).toBe(true)
})

test('release does not free a lock another process has already taken over', async () => {
  const file = await lockPath()

  const first = await claimInstanceLock(file, process.pid)
  expect(first.ok).toBe(true)
  // A slow shutdown: by the time the old server releases, the next one already owns the file.
  await writeFile(file, '2222')
  if (first.ok) await first.release()

  // Still held by 2222 — the late release must not have opened the door to a third.
  expect((await readFile(file, 'utf-8')).trim()).toBe('2222')
})
