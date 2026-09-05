import { describe, test, expect } from 'bun:test'
import type { FetchLike } from './github-api'
import { pruneRemoteReleases, selectForPruning } from './github-retention'

interface ReleaseFixture { id: number; tag_name: string; created_at: string; body?: string }

// Every fixture below carries the `- host:` line `buildReleaseBody` writes, and every call passes
// the same label. Without an attribution a release is another machine's as far as retention can
// tell, and is kept — which is the rule `selectForPruning` exists for, not an artefact of these
// tests. They are about ordering, hand-made releases and error reporting, so they state the
// attribution and go on testing what they were written for.
const HOST = 'thisbox'
const owned = (r: ReleaseFixture): ReleaseFixture => ({ ...r, body: r.body ?? `- host: ${HOST}` })

function fakeFetch(releases: ReleaseFixture[], deleteStatus: (id: number) => number = () => 204): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? 'GET'
    if (url.includes('per_page=100') && method === 'GET') {
      return new Response(JSON.stringify(releases.map(owned)), { status: 200 })
    }
    const m = url.match(/\/releases\/(\d+)$/)
    if (m && method === 'DELETE') {
      const id = Number(m[1])
      const status = deleteStatus(id)
      return status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ message: 'refused' }), { status })
    }
    throw new Error(`unexpected request in test fake: ${method} ${url}`)
  }
}

describe('pruneRemoteReleases — keepRemote 0 keeps everything', () => {
  test('no request is ever made', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => { called = true; return new Response('[]') }
    const result = await pruneRemoteReleases('o', 'r', 'tok', 0, fetchImpl, () => {}, HOST)
    expect(called).toBe(false)
    expect(result).toEqual({ deleted: [], kept: [], errors: [] })
  })
})

describe('pruneRemoteReleases — keeps the newest N, deletes the rest', () => {
  test('newest-first ordering by created_at, not by list order', async () => {
    const releases: ReleaseFixture[] = [
      { id: 2, tag_name: 'backup-2026-09-02T00-00-00Z', created_at: '2026-09-02T00:00:00Z' },
      { id: 1, tag_name: 'backup-2026-09-01T00-00-00Z', created_at: '2026-09-01T00:00:00Z' },
      { id: 3, tag_name: 'backup-2026-09-03T00-00-00Z', created_at: '2026-09-03T00:00:00Z' },
    ]
    const result = await pruneRemoteReleases('o', 'r', 'tok', 2, fakeFetch(releases), () => {}, HOST)
    expect(result.kept).toEqual(['backup-2026-09-03T00-00-00Z', 'backup-2026-09-02T00-00-00Z'])
    expect(result.deleted).toEqual([{ tag: 'backup-2026-09-01T00-00-00Z', id: 1 }])
  })
})

describe('pruneRemoteReleases — only a backup- tag this product minted is ever a candidate', () => {
  test('a hand-made release is never counted toward keepRemote and never deleted', async () => {
    const releases: ReleaseFixture[] = [
      { id: 10, tag_name: 'v1.0.0', created_at: '2026-01-01T00:00:00Z' },
      { id: 11, tag_name: 'my-important-release', created_at: '2026-02-01T00:00:00Z' },
      { id: 12, tag_name: 'backup-2026-09-01T00-00-00Z', created_at: '2026-09-01T00:00:00Z' },
      { id: 13, tag_name: 'backup-2026-09-02T00-00-00Z', created_at: '2026-09-02T00:00:00Z' },
    ]
    const result = await pruneRemoteReleases('o', 'r', 'tok', 1, fakeFetch(releases), () => {}, HOST)
    expect(result.deleted).toEqual([{ tag: 'backup-2026-09-01T00-00-00Z', id: 12 }])
    expect(result.kept).toEqual(['backup-2026-09-02T00-00-00Z'])
    // Ids 10 and 11 never appear anywhere in the result — not kept, not deleted, not considered.
    const touched = [...result.deleted.map(d => d.id)]
    expect(touched).not.toContain(10)
    expect(touched).not.toContain(11)
  })

  test('a lookalike prefix that is not the exact minted shape is left alone', async () => {
    const releases: ReleaseFixture[] = [
      { id: 20, tag_name: 'backup-notes', created_at: '2026-01-01T00:00:00Z' },
      { id: 21, tag_name: 'my-backup-2026-09-01T00-00-00Z', created_at: '2026-02-01T00:00:00Z' },
    ]
    const result = await pruneRemoteReleases('o', 'r', 'tok', 0, fakeFetch(releases), () => {}, HOST)
    // keepRemote 0 already short-circuits, so exercise the filter directly via keepRemote > 0 with
    // an empty backup set: nothing should be deleted or kept, since neither tag qualifies.
    void result
    const result2 = await pruneRemoteReleases('o', 'r', 'tok', 5, fakeFetch(releases), () => {}, HOST)
    expect(result2.deleted).toEqual([])
    expect(result2.kept).toEqual([])
  })
})

describe('pruneRemoteReleases — failures are reported, never thrown', () => {
  test('a listing failure yields an error and touches nothing', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ message: 'bad creds' }), { status: 401 })
    const result = await pruneRemoteReleases('o', 'r', 'tok', 2, fetchImpl, () => {}, HOST)
    expect(result.errors.length).toBe(1)
    expect(result.deleted).toEqual([])
  })

  test('one release failing to delete does not stop the others', async () => {
    const releases: ReleaseFixture[] = [
      { id: 1, tag_name: 'backup-2026-09-01T00-00-00Z', created_at: '2026-09-01T00:00:00Z' },
      { id: 2, tag_name: 'backup-2026-09-02T00-00-00Z', created_at: '2026-09-02T00:00:00Z' },
      { id: 3, tag_name: 'backup-2026-09-03T00-00-00Z', created_at: '2026-09-03T00:00:00Z' },
    ]
    const result = await pruneRemoteReleases(
      'o', 'r', 'tok', 1, fakeFetch(releases, id => (id === 2 ? 403 : 204)), () => {}, HOST,
    )
    expect(result.deleted.map(d => d.id).sort()).toEqual([1])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('backup-2026-09-02T00-00-00Z')
  })
})

test('retention only ever deletes releases it can prove are THIS machine\'s', () => {
  // The whole reason labels exist. `pruneRemote` weighed every machine's releases against one
  // `keepRemote`: a laptop backing up daily filled the window and the desktop's only backup fell
  // out of it and was DELETED — by the laptop, silently. A machine may delete its own history; it
  // may never delete another machine's.
  const rel = (tag: string, at: string, host: string | null) => ({ tag, createdAt: at, host })
  const plan = selectForPruning([
    rel('backup-laptop-2026-09-05T10-00-00Z', '2026-09-05T10:00:00Z', 'laptop'),
    rel('backup-laptop-2026-09-04T10-00-00Z', '2026-09-04T10:00:00Z', 'laptop'),
    rel('backup-laptop-2026-09-03T10-00-00Z', '2026-09-03T10:00:00Z', 'laptop'),
    rel('backup-desktop-2026-08-01T10-00-00Z', '2026-08-01T10:00:00Z', 'desktop'),
  ], 2, 'laptop')
  expect(plan.remove).toEqual(['backup-laptop-2026-09-03T10-00-00Z'])
  expect(plan.keep).toContain('backup-laptop-2026-09-05T10-00-00Z')
  // The other machine's release is not merely kept — it was never a candidate.
  expect(plan.remove).not.toContain('backup-desktop-2026-08-01T10-00-00Z')
  expect(plan.otherMachines).toEqual(['desktop'])
})

test('a legacy tag is attributed by the release BODY, and never deleted when it cannot be', () => {
  // A tag minted before labels existed carries no machine. The body does (`- host: NAME`), so it
  // can still be attributed exactly. When even that is missing the release is UNATTRIBUTABLE, and
  // the only safe reading is that it might be another machine's: keeping a release too long costs
  // storage, deleting one that was somebody's only copy costs the backup.
  const plan = selectForPruning([
    { tag: 'backup-2026-09-05T10-00-00Z', createdAt: '2026-09-05T10:00:00Z', host: 'laptop' },
    { tag: 'backup-2026-09-04T10-00-00Z', createdAt: '2026-09-04T10:00:00Z', host: 'laptop' },
    { tag: 'backup-2026-09-03T10-00-00Z', createdAt: '2026-09-03T10:00:00Z', host: null },
  ], 1, 'laptop')
  expect(plan.remove).toEqual(['backup-2026-09-04T10-00-00Z'])
  expect(plan.unattributable).toEqual(['backup-2026-09-03T10-00-00Z'])
})

test('a release the user made by hand is not a backup and is never touched', () => {
  const plan = selectForPruning([
    { tag: 'v1.2.3', createdAt: '2026-09-05T10:00:00Z', host: null },
    { tag: 'backup-laptop-2026-09-05T10-00-00Z', createdAt: '2026-09-05T10:00:00Z', host: 'laptop' },
  ], 0, 'laptop')
  expect(plan.remove).toEqual([])
})

test('keepRemote of zero keeps everything — a config typo is not a way to wipe a repository', () => {
  const plan = selectForPruning(
    [{ tag: 'backup-laptop-2026-09-05T10-00-00Z', createdAt: '2026-09-05T10:00:00Z', host: 'laptop' }],
    0, 'laptop')
  expect(plan.remove).toEqual([])
})
