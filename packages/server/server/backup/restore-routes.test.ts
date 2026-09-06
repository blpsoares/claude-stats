/**
 * restore-routes.test.ts — restoring FROM the interface: list what a repository holds, then take
 * one of them.
 *
 * The scenario every rule here is written against: a machine that has just been reformatted. It
 * has the repository URL and nothing else — no stored token, no local backup history, no expected
 * hash. Everything must come from the repository or be asked for.
 */
import { describe, test, expect } from 'bun:test'
import {
  RESTORE_LINE_CAP, finishRestoreJob, newRestoreJob, restoreCredential, restoreJobLine,
  restoreListing,
} from './restore-routes'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('restoreCredential — where the token comes from on a machine that has none', () => {
  test('a pasted token is used as given', async () => {
    const r = await restoreCredential({ token: 'ghp_pasted' }, async () => ({ ok: true, token: 'ghp_gh' }))
    expect(r).toEqual({ ok: true, token: 'ghp_pasted' })
  })

  test('with no token it asks gh — which is the whole point on a fresh machine', async () => {
    // A reformatted machine has no stored config to read a token out of. `gh` is the one credential
    // that can already be there, because `gh auth login` is part of setting the machine up at all.
    const r = await restoreCredential({}, async () => ({ ok: true, token: 'ghp_gh' }))
    expect(r).toEqual({ ok: true, token: 'ghp_gh' })
  })

  test('no token and no gh is a SENTENCE naming both ways out', async () => {
    const r = await restoreCredential({}, async () => ({ ok: false, reason: 'not-installed' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('gh')
    expect(r.reason).toContain('token')
  })
})

describe('restoreListing — what a repository holds, by machine', () => {
  const RELEASES = [
    {
      tag_name: 'backup-notebook-2026-09-05T10-00-00Z', created_at: '2026-09-05T10:00:00Z',
      body: '# Agentistics backup\n\n- created: 2026-09-05T10:00:00Z\n- host: notebook\n'
        + '- layers: metrics, repos\n- harnesses: claude\n- sessions: 649\n- size: 91.4 MB (95000000 bytes)\n'
        + '- sha256: `abc123`\n',
      assets: [{ id: 1, name: 'agentistics-backup-notebook-2026-09-05.tar.zst', size: 95000000 }],
    },
    {
      tag_name: 'backup-desktop-2026-08-01T10-00-00Z', created_at: '2026-08-01T10:00:00Z',
      body: '# Agentistics backup\n\n- created: 2026-08-01T10:00:00Z\n- host: desktop\n'
        + '- layers: metrics\n- harnesses: claude\n- sessions: 12\n- size: 4.1 MB (4300000 bytes)\n'
        + '- sha256: `def456`\n',
      assets: [{ id: 2, name: 'agentistics-backup-desktop-2026-08-01.tar.zst', size: 4300000 }],
    },
    // A release the user made by hand. Never ours, never listed.
    { tag_name: 'v1.0.0', created_at: '2026-07-01T10:00:00Z', body: 'a real release', assets: [] },
  ]

  test('groups by machine, newest machine first, and drops what is not a backup', async () => {
    const r = await restoreListing(
      { url: 'https://github.com/me/backups', token: 'ghp_x' },
      { fetchImpl: async () => json(RELEASES) },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.machines.map(m => m.machine)).toEqual(['notebook', 'desktop'])
    expect(r.machines[0]!.releases[0]!.tagName).toBe('backup-notebook-2026-09-05T10-00-00Z')
    // Every row carries what a person needs to choose: when, how big, what is in it.
    const first = r.machines[0]!.releases[0]!
    // Derived from the BYTES the body carries, never from the human string beside them. The
    // fixture deliberately disagrees with itself (`91.4 MB (95000000 bytes)`) and the answer
    // follows the number: a body is written by another machine, possibly on another version, and
    // the count is the half that cannot drift into a different unit.
    expect(first.sizeLabel).toBe('90.6 MB')
    expect(first.layers).toEqual(['metrics', 'repos'])
    expect(first.sessions).toBe(649)
  })

  test('a URL that is not github.com is refused BEFORE any request', async () => {
    let called = false
    const r = await restoreListing(
      { url: 'https://gitlab.com/me/backups', token: 'ghp_x' },
      { fetchImpl: async () => { called = true; return json([]) } },
    )
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })

  test('a repository with no backups says so — never an empty list that reads as a failure', async () => {
    const r = await restoreListing(
      { url: 'https://github.com/me/backups', token: 'ghp_x' },
      { fetchImpl: async () => json([{ tag_name: 'v1', created_at: '2026-01-01T00:00:00Z', body: '', assets: [] }]) },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.machines).toEqual([])
  })

  test('GitHub refusing is the reason it gave, not a generic failure', async () => {
    const r = await restoreListing(
      { url: 'https://github.com/me/backups', token: 'ghp_bad' },
      { fetchImpl: async () => json({ message: 'Bad credentials' }, 401) },
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('Bad credentials')
  })

  test('a release whose body cannot be decoded is still LISTED, marked undecodable', async () => {
    // Dropping it would hide a backup that may be someone's only copy. It is offered with what is
    // known — the tag and the date — and the missing facts are said rather than invented.
    const r = await restoreListing(
      { url: 'https://github.com/me/backups', token: 'ghp_x' },
      {
        fetchImpl: async () => json([{
          tag_name: 'backup-old-2026-01-01T00-00-00Z', created_at: '2026-01-01T00:00:00Z',
          body: 'written by something else', assets: [{ id: 9, name: 'x.tar.zst', size: 10 }],
        }]),
      },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const row = r.machines[0]!.releases[0]!
    expect(row.tagName).toBe('backup-old-2026-01-01T00-00-00Z')
    expect(row.sizeLabel).toBe(null)
    expect(row.sessions).toBe(null)
  })
})

describe('restoreJob — a restore the interface can watch without holding a request open', () => {
  test('a fresh job reports queued, with nothing done yet', () => {
    const j = newRestoreJob({ tag: 'backup-notebook-2026-09-05T10-00-00Z', withRepos: false })
    expect(j.state).toBe('queued')
    expect(j.lines).toEqual([])
    expect(j.finishedAt).toBe(null)
  })

  test('lines accumulate and are BOUNDED — a repos phase prints thousands', () => {
    // 235 repositories, several git commands each. Keeping every line would grow a server-side
    // object without limit for a screen that only ever shows the tail.
    const j = newRestoreJob({ tag: 't', withRepos: true })
    for (let i = 0; i < RESTORE_LINE_CAP + 50; i++) restoreJobLine(j, `line ${i}`)
    expect(j.lines.length).toBe(RESTORE_LINE_CAP)
    // The TAIL is what is kept: the end of a restore is where its outcome is.
    expect(j.lines[j.lines.length - 1]).toBe(`line ${RESTORE_LINE_CAP + 49}`)
  })

  test('finishing stamps a time, and a failure keeps its reason', () => {
    const ok = newRestoreJob({ tag: 't', withRepos: false })
    finishRestoreJob(ok, { ok: true, written: 699, skipped: 0 })
    expect(ok.state).toBe('done')
    expect(ok.finishedAt).not.toBe(null)
    expect(ok.written).toBe(699)

    const bad = newRestoreJob({ tag: 't', withRepos: false })
    finishRestoreJob(bad, { ok: false, reason: 'the archive could not be verified' })
    expect(bad.state).toBe('failed')
    expect(bad.reason).toBe('the archive could not be verified')
  })

  test('a job that asked for repos says so, because it is the long half', () => {
    // The phase distinction is what the screen needs to set expectations: metrics is seconds,
    // repos clones every repository the backup mapped and can take many minutes.
    expect(newRestoreJob({ tag: 't', withRepos: true }).withRepos).toBe(true)
  })
})

describe('which of these machines is the one I am sitting at', () => {
  const rel = (tag: string, at: string, host: string) => ({
    tag_name: tag, created_at: at,
    body: `# Agentistics backup\n\n- created: ${at}\n- host: ${host}\n- layers: metrics\n`
      + `- harnesses: claude\n- sessions: 1\n- size: 1 MB (1000000 bytes)\n- sha256: \`x\`\n`,
  })

  test('this machine is marked and comes FIRST, whatever the dates say', async () => {
    // Asked after seeing it: "pq ta aparecendo pra eu restaurar backup de outras machines?".
    // Offering them is right — a reformatted machine has a new hostname and needs the OLD one's
    // backups, so filtering to "this machine" would empty the screen exactly when it matters. What
    // was missing is saying WHICH is which, and putting the likely one at the top.
    const r = await restoreListing(
      { url: 'https://github.com/me/backups', token: 'tok', label: 'alienware' },
      {
        fetchImpl: async () => new Response(JSON.stringify([
          rel('backup-braiaode2-2026-09-06T16-00-00Z', '2026-09-06T16:00:00Z', 'braiaode2'),
          rel('backup-alienware-2026-09-06T10-00-00Z', '2026-09-06T10:00:00Z', 'alienware'),
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // `braiaode2` is NEWER and still comes second: this machine leads.
    expect(r.machines.map(m => m.machine)).toEqual(['alienware', 'braiaode2'])
    expect(r.machines[0]!.thisMachine).toBe(true)
    expect(r.machines[1]!.thisMachine).toBe(false)
  })

  test('with no label given, nothing is marked — never a guess', async () => {
    // A machine that has not connected a repository has no label, and marking the wrong group as
    // "yours" is worse than marking none: it is the group somebody would restore without reading.
    const r = await restoreListing(
      { url: 'https://github.com/me/backups', token: 'tok' },
      {
        fetchImpl: async () => new Response(JSON.stringify([
          rel('backup-alienware-2026-09-06T10-00-00Z', '2026-09-06T10:00:00Z', 'alienware'),
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.machines[0]!.thisMachine).toBe(false)
  })

  test('the match folds case and spacing, like every other label comparison', async () => {
    const r = await restoreListing(
      { url: 'https://github.com/me/backups', token: 'tok', label: ' Alienware ' },
      {
        fetchImpl: async () => new Response(JSON.stringify([
          rel('backup-alienware-2026-09-06T10-00-00Z', '2026-09-06T10:00:00Z', 'alienware'),
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.machines[0]!.thisMachine).toBe(true)
  })
})
