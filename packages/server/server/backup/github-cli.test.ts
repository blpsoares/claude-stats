/**
 * github-cli.test.ts — using the GitHub CLI the machine already has, instead of storing a token.
 */
import { describe, test, expect } from 'bun:test'
import { GH_TOKEN_ARGV, describeGhAuth, resolveGithubAuth } from './github-cli'

describe('the argv, which is the whole of what this runs', () => {
  test('it asks gh for a token and nothing else', () => {
    // Pinned because it is the ONE command this feature shells out to. `gh auth token` prints the
    // token of the ACTIVE account and exits non-zero when nobody is logged in — no prompt, no
    // browser, nothing that could block a scheduled backup at 3am.
    expect(GH_TOKEN_ARGV).toEqual(['gh', 'auth', 'token'])
  })
})

describe('resolveGithubAuth — which credential a config actually uses', () => {
  test('a config with a stored token uses it, and never runs gh', async () => {
    let ran = false
    const r = await resolveGithubAuth(
      { auth: 'token', token: 'ghp_stored' },
      async () => { ran = true; return { ok: true, token: 'ghp_from_gh' } },
    )
    expect(r).toEqual({ ok: true, token: 'ghp_stored' })
    expect(ran).toBe(false)
  })

  test('a config with NO auth field reads as a stored token', async () => {
    // Every config written before `gh` was an option holds a token. Treating absence as anything
    // else would break every machine already versioning, at the moment it tried to upload.
    const r = await resolveGithubAuth(
      { token: 'ghp_legacy' },
      async () => ({ ok: true, token: 'ghp_from_gh' }),
    )
    expect(r).toEqual({ ok: true, token: 'ghp_legacy' })
  })

  test('a gh config asks gh EVERY time and stores nothing', async () => {
    let calls = 0
    const ask = async (): Promise<{ ok: true; token: string }> => { calls++; return { ok: true, token: `t${calls}` } }
    expect(await resolveGithubAuth({ auth: 'gh', token: '' }, ask)).toEqual({ ok: true, token: 't1' })
    expect(await resolveGithubAuth({ auth: 'gh', token: '' }, ask)).toEqual({ ok: true, token: 't2' })
    // Asked again rather than cached: gh's token can be rotated or revoked between two backups, and
    // a copy we kept would go on failing with a credential the user already replaced.
    expect(calls).toBe(2)
  })

  test('a gh that cannot answer is a REASON, never a silent fallback to a stored token', async () => {
    // Falling back would upload under a credential the user did not choose — and on a `gh` config
    // there is no stored token to fall back to anyway, so the honest answer is why it failed.
    const r = await resolveGithubAuth(
      { auth: 'gh', token: '' },
      async () => ({ ok: false, reason: 'not-logged-in' }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('gh')
  })

  test('a token config whose token is EMPTY is refused, not sent as an empty credential', async () => {
    const r = await resolveGithubAuth({ auth: 'token', token: '  ' }, async () => ({ ok: true, token: 'x' }))
    expect(r.ok).toBe(false)
  })
})

describe('describeGhAuth — what the interface offers, in a sentence', () => {
  test('available and logged in', () => {
    expect(describeGhAuth({ installed: true, account: 'blpsoares' }).usable).toBe(true)
  })
  test('installed but logged out says so, and is not offered', () => {
    const d = describeGhAuth({ installed: true, account: null })
    expect(d.usable).toBe(false)
    if (d.usable) return
    expect(d.reason).toBe('logged-out')
  })
  test('not installed at all is a different reason — the fix is a different one', () => {
    // "Install gh" and "run gh auth login" are different instructions, and one sentence covering
    // both would be right for neither.
    const d = describeGhAuth({ installed: false, account: null })
    expect(d.usable).toBe(false)
    if (d.usable) return
    expect(d.reason).toBe('not-installed')
  })
})
