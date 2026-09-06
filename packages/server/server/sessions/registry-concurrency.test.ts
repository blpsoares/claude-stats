import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The registry, written by SEVERAL PROCESSES at once.
 *
 * This is the test that did not exist, and its absence is why the bug shipped: every existing
 * registry test runs in ONE process, where the promise chain already serialised everything. agentop
 * is not one process — it is the systemd server, the cockpit, and every one-shot `agentop session
 * …` — and a promise chain does not reach across them.
 *
 * So this spawns real processes. It is slower than the rest of the suite and it is the only shape
 * that can fail when the lock is removed.
 */

const WRITER = `
const { createSessionRegistry } = await import(process.argv[2])
const file = process.argv[3]
const id = process.argv[4]
const reg = createSessionRegistry(file)
await reg.add({
  id, harness: 'claude', cwd: '/tmp/x',
  createdAt: new Date().toISOString(),
  label: 'label-' + id,
})
`

/**
 * Run the writers, and FAIL LOUDLY if one of them did not.
 *
 * The first version awaited `p.exited` and ignored it. A writer that never ran left the file
 * without its record, and the assertion below then reported "a record was erased" — which is a
 * different fault with the same symptom, and it is the one that actually happened: this test went
 * red in CI and green locally, and the message said nothing about why. A test that cannot tell its
 * own failure from the failure it is looking for is worse than no test.
 */
async function runWriters(file: string, ids: string[]): Promise<void> {
  const regPath = join(import.meta.dir, 'registry.ts')
  const script = join(await mkdtemp(join(tmpdir(), 'agentop-writer-')), 'w.ts')
  await Bun.write(script, WRITER)
  const runs = await Promise.all(ids.map(async id => {
    const p = Bun.spawn([process.execPath, script, regPath, file, id], { stdout: 'pipe', stderr: 'pipe' })
    const err = await new Response(p.stderr).text()
    return { id, code: await p.exited, err }
  }))
  const bad = runs.filter(r => r.code !== 0)
  if (bad.length > 0) {
    throw new Error(
      `writer process failed (this is the TEST breaking, not the registry): `
      + bad.map(b => `${b.id} exited ${b.code}: ${b.err.trim().split('\n').slice(-3).join(' | ')}`).join('  //  '),
    )
  }
}

/*
 * IT RUNS AGAIN. It was skipped with a note asking for `lockFile` to be INSTRUMENTED rather than
 * guessed at, and that is what found the fault.
 *
 * Six processes taking the lock 25 times each, counting which branch each blocked acquirer took:
 * the age-based expiry NEVER fired (`staleOld: 0`, so the 5s contention fallback and the 15s
 * staleness were both red herrings — the first hypothesis, and wrong). What fired was `stat`
 * throwing `ENOENT`: the lock released in the instant between the failed `mkdir` and the `stat`.
 * That branch answered with `rm(dir, {recursive: true})`, and by the time the `rm` ran another
 * process could already hold a NEW lock at that path — so it deleted a live lock and both holders
 * proceeded. Measured **31 overlapping acquisitions out of 150**.
 *
 * With a vanished lock answered by RETRYING and an abandoned one taken over by `rename`, the same
 * probe measures **0 out of 600** across three rounds of eight processes.
 */
test('a record written by one process is not erased by another', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-registry-'))
  const file = join(dir, 'managed-sessions.json')
  try {
    const ids = ['aaa1', 'bbb2', 'ccc3', 'ddd4', 'eee5', 'fff6']
    await runWriters(file, ids)
    const list = JSON.parse(await readFile(file, 'utf-8')) as { id: string; label?: string }[]
    // EVERY id, and every label. Before the cross-process lock this lost records whenever two
    // writers overlapped — which is exactly what a spawn racing the server's heartbeat does.
    expect(list.map(r => r.id).sort()).toEqual([...ids].sort())
    expect(list.every(r => r.label === `label-${r.id}`)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
