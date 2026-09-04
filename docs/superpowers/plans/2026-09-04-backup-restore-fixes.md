# Backup & restore — fixes from the final branch review

> **For agentic workers:** these are corrections to code that is already committed and passing its
> own tests. Each wave is applied by one subagent and re-reviewed. Steps use `- [ ]` for tracking.

**Source:** the whole-branch review of `e065e18b..d8adf6d0` returned ❌ Not ready with five Critical
findings, two of them reproduced by running the code. This document holds the fixes.

**Why they all share a shape:** every one is a failure that disguises itself as good news. That is
the defect class this feature is judged on, and the review found five more instances of it after
seven had already been fixed during development.

## Global constraints

- Work in `/home/mithrandir/agentistics/.claude/worktrees/backup-restore`, branch `feat/backup-restore`.
- Code, comments and identifiers in ENGLISH. Commit messages in PORTUGUESE, Conventional Commits.
- No new dependencies.
- **`git add` only the files you changed, by explicit path.** Never `git add -A`.
- **Never run `git config`, `git reset`, `git checkout`, `git rebase`** against this worktree. This
  branch has had its shared git identity destroyed twice by agents running git carelessly.
- Any git a TEST runs against a temp repo must use `gitEnv()` from `./backup/repo-probe` for its
  child environment. Neither `cwd` nor `-C` overrides an inherited `GIT_DIR`.
- The pre-commit hook runs `bun tsc --noEmit` and the full suite. Both must pass. No `--no-verify`.

---

# Wave A — the restore does not work

Two Critical findings, both reproduced by the reviewer, plus the reporting gaps around them.

## A1 (C1). A backup with the default layers cannot be restored

`backup.ts` digests only the `$HOME` walk (`manifestDigest(files)`). `restore.ts`'s `walkStaged`
walks **everything** in the staging tree except the manifest, and compares that against the same
digest. The `repos/` assets are in the archive and not in the digest, so the two never agree.

`DEFAULT_LAYERS` is `['metrics','repos']`, `assetRoot` is always passed, and `buildRepoManifest`
always creates `repos/`. So this is the **default** path on any machine with one bundle or patch:

```
backup ok? true  …/agentistics-backup-old-….tar.zst
RESTORE: {"ok":false,"reason":"the archive contents do not match the manifest digest"}
```

An intact archive reporting corruption, on a machine that no longer exists. Both halves were
tested; the seam between them was not — `backup.test.ts` builds an archive WITH assets and only
reads `tar -tf`; `restore.test.ts` builds its fixture with `layers:['metrics']` and no `assetRoot`.

**The fix.** `repos/` is archive-internal: it is neither `$HOME` content nor something to merge into
`$HOME`. `walkStaged` must drop it before the digest AND before `planMetrics` — the second half
matters just as much, because otherwise the merge copies git bundles into `$HOME/repos/`.

In `restore.ts`, replace `walkStaged`'s trailing filter:

```ts
  await visit(root)
  // `repos/` holds the archive's OWN assets — the bundles and patches — not $HOME content. It is
  // outside the manifest digest (which covers the walk that produced the archive) and outside the
  // merge (which writes into $HOME). Leaving it in broke both: the digest never matched, so a
  // perfectly intact backup refused to restore, and had it matched, the merge would have copied
  // git bundles into `$HOME/repos/`.
  return out.filter(f => f.rel !== MANIFEST_NAME && f.rel !== 'repos' && !f.rel.startsWith('repos/'))
}
```

## A2 (C4). The bundle fetch fails on exactly the repositories it exists for

`repo-manifest.ts` emits `git clone <url> <main>` — which checks out the default branch — followed
by `git fetch <bundle> refs/heads/*:refs/heads/*`. Git refuses:

```
fatal: refusing to fetch into branch 'refs/heads/main' checked out at '…/restored'
```

The bundle is `--all --not --remotes`, so it contains `main` precisely when `main` is ahead of its
remote — which is the only reason to have unpushed work at all. The repo is then recorded `failed`
and retried identically forever.

**The fix.** Clone with `--no-checkout` when there is a bundle, so no branch is checked out and the
fetch can write any ref; force the refspec, because our history is the one that should win over a
fresh clone's; then check out. Replace `restoreArgv`'s body after the `asset` helper:

```ts
  // With a bundle, the clone must NOT check anything out: git refuses to fetch into a branch that
  // is checked out, and the bundle contains the main branch precisely when that branch is ahead of
  // its remote — the only reason unpushed work exists. The refspec is forced because a fresh clone's
  // refs are the ones being corrected.
  const out: string[][] = entry.bundle
    ? [
        ['git', 'clone', '--no-checkout', entry.cloneUrl, main],
        ['git', '-C', main, 'fetch', asset(entry.bundle), '+refs/heads/*:refs/heads/*'],
      ]
    : [['git', 'clone', entry.cloneUrl, main]]

  if (entry.mainBranch) {
    out.push(['git', '-C', main, 'checkout', entry.mainBranch])
  } else if (entry.bundle) {
    // The main checkout was never probed, so its branch is unknown — but `--no-checkout` left the
    // working tree empty and something has to materialise it. HEAD is still attached to the clone's
    // default branch, so this fills the tree without inventing a branch name.
    out.push(['git', '-C', main, 'reset', '--hard'])
  }

  for (const w of entry.worktrees) {
    out.push(['git', '-C', main, 'worktree', 'add', expandHome(w.path, homeDir), w.branch])
  }
  for (const d of entry.dirty) {
    if (d.patch) out.push(['git', '-C', expandHome(d.path, homeDir), 'apply', asset(d.patch)])
  }
  return out
}
```

## A3 (I4). A failed asset extraction reads as "there are no assets"

`restore.ts`'s `restoreRepos` does
`.catch(() => log('no repos assets in this archive — cloning without local-only history'))`.
A corrupt archive, a full disk and a permission error all become that benign sentence; every repo is
then cloned without its unpushed commits and each is reported `ok`. Nothing reaches the result.

**The fix.** `tar` exits non-zero both for "no such member" and for a real failure, and the two must
not be one value. List first — cheap, and it answers whether the member exists — then extract, and
treat an extraction failure as fatal to the phase:

```ts
  const needsAssets = entries.some(e => e.bundle || e.dirty.some(d => d.patch))
  if (needsAssets) {
    const listed = await run('tar', ['-tf', opts.archive, 'repos'], { maxBuffer: 16 * 1024 * 1024 })
      .then(() => true).catch(() => false)
    if (!listed) {
      log('this archive carries no repos assets — cloning without local-only history')
    } else {
      try {
        await run('tar', ['-xf', opts.archive, '-C', assetDir, 'repos'], { maxBuffer: 16 * 1024 * 1024 })
      } catch (e) {
        // The assets ARE in the archive and could not be extracted. Cloning on would silently
        // rebuild every repository without the unpushed work this phase exists to restore.
        await rm(assetDir, { recursive: true, force: true }).catch(() => {})
        return {
          attempted: 0, succeeded: 0, skipped: [],
          failures: [{ key: '(repos assets)', reason: `could not extract them: ${e instanceof Error ? e.message : String(e)}` }],
        }
      }
    }
  }
```

## A4 (I5 + known-Minor 3). `skipped — undefined` reaches the user

`restore.ts` pushes `{ key, reason: String(s.reason) }`, and `s.reason` is `undefined` for a repo
whose prior state was `skipped` but whose note has since changed. The user reads the literal word.

**The fix**, in `restore-plan.ts`'s `planRepos`, for the `prior?.state === 'skipped'` branch:

```ts
    if (prior?.state === 'skipped') {
      // A repo skipped on an earlier run stays skipped, but the REASON may no longer apply (it was
      // `gone` and the directory is back). Say which it is rather than printing `undefined`.
      return {
        ...base,
        state: 'skipped',
        reason: e.note ?? 'skipped-earlier',
        argv: [],
        commands: [],
      }
    }
```

Widen `RepoStep.reason` to `RepoNote | 'destination-exists' | 'skipped-earlier'`.

## A5. The seam gets a test

Both halves were tested and the join was not. Add to `restore.test.ts`:

```ts
// The defect this test exists for: the manifest digest covered only the $HOME walk while the
// staging walk covered the repos assets too, so a backup taken with the DEFAULT layers reported
// itself corrupt on restore. Both halves had tests; this is the seam.
test('an archive carrying repos assets restores — the digest covers the same set both sides', async () => {
  const assetRoot = mkdtempSync(join(tmpdir(), 'agentistics-a-'))
  const target = mkdtempSync(join(tmpdir(), 'agentistics-rt-'))
  try {
    mkdirSync(join(assetRoot, 'repos'), { recursive: true })
    writeFileSync(join(assetRoot, 'repos/example.bundle'), 'BUNDLE BYTES')
    writeFileSync(join(assetRoot, 'repos/example__main.patch'), 'PATCH BYTES')

    const made = await runBackup({
      homeDir: oldHome, destDir: dest, layers: ['metrics', 'repos'], harnesses: ['claude'],
      repos: [], assetRoot, agentopVersion: 'test', hostname: 'old',
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    const r = await restoreMetrics({ archive: made.record.path, homeDir: target })
    expect(r.ok).toBe(true)
    expect(existsSync(join(target, '.agentistics/sessions/claude/a.json'))).toBe(true)
    // …and the assets are NOT merged into $HOME: they belong to the archive, not to the home.
    expect(existsSync(join(target, 'repos'))).toBe(false)
  } finally {
    rmSync(assetRoot, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})
```

And to `repo-manifest.test.ts`, replacing the command-order test's expectations so they pin the new
shape (a bundle implies `--no-checkout` and a forced refspec):

```ts
test('a bundle forces --no-checkout, because git refuses to fetch into a checked-out branch', () => {
  const main = mainRepo(`${HOME}/proj`)
  const [e] = groupRepos([main], HOME)
  e!.bundle = 'repos/k.bundle'
  const argv = restoreArgv(e!, HOME)
  expect(argv[0]).toEqual(['git', 'clone', '--no-checkout', 'git@github.com:org/repo.git', '/home/u/proj'])
  expect(argv[1]).toEqual(['git', '-C', '/home/u/proj', 'fetch', 'repos/k.bundle', '+refs/heads/*:refs/heads/*'])
  expect(argv[2]).toEqual(['git', '-C', '/home/u/proj', 'checkout', 'main'])
})

test('with no bundle the clone checks out normally', () => {
  const [e] = groupRepos([mainRepo(`${HOME}/proj`)], HOME)
  const argv = restoreArgv(e!, HOME)
  expect(argv[0]).toEqual(['git', 'clone', 'git@github.com:org/repo.git', '/home/u/proj'])
  expect(argv.some(a => a.includes('--no-checkout'))).toBe(false)
})
```

**A live round trip is the real proof.** Add to `restore.test.ts`, using real git:

```ts
// C4 reproduced and pinned: `git fetch <bundle> refs/heads/*:refs/heads/*` after a plain clone is
// REFUSED when the branch is checked out — which is exactly the case a bundle exists for.
test('a repository ahead of its remote comes back WITH its unpushed commit', async () => {
  const origin = makeOrigin(join(dest, 'origin-ahead'))
  const clone = join(dest, 'ahead-work')
  const target = mkdtempSync(join(tmpdir(), 'agentistics-ahead-'))
  try {
    git(dest, 'clone', '-q', origin, clone)
    git(clone, 'config', 'user.email', 't@t')
    git(clone, 'config', 'user.name', 't')
    writeFileSync(join(clone, 'b.txt'), 'unpushed\n')
    git(clone, 'add', 'b.txt')
    git(clone, 'commit', '-q', '-m', 'unpushed work')

    const bundleDir = mkdtempSync(join(tmpdir(), 'agentistics-b-'))
    mkdirSync(join(bundleDir, 'repos'), { recursive: true })
    const res = await createBundle(clone, join(bundleDir, 'repos/ahead.bundle'), {
      full: false, maxBytes: 100_000_000,
    })
    expect(res).toBe('written')

    const made = await runBackup({
      homeDir: oldHome, destDir: dest, layers: ['metrics', 'repos'], harnesses: ['claude'],
      assetRoot: bundleDir, agentopVersion: 'test', hostname: 'old',
      repos: [entry({ key: 'ahead', cloneUrl: origin, mainPath: '~/back', bundle: 'repos/ahead.bundle' })],
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    const m = await readManifestOf(made.record.path)
    expect(m.ok).toBe(true)
    if (!m.ok) return

    const r = await restoreRepos({ manifest: m.manifest, homeDir: target, archive: made.record.path })
    expect(r.failures).toEqual([])
    expect(r.succeeded).toBe(1)
    // The whole promise of the repos layer, in one assertion.
    expect(readFileSync(join(target, 'back/b.txt'), 'utf8')).toBe('unpushed\n')

    rmSync(bundleDir, { recursive: true, force: true })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
```

`entry` and `makeOrigin` already exist in that file; `createBundle` and `readManifestOf` need
importing, and `entry` needs `bundle` in its accepted overrides (it already spreads `over`).

## Verify

```bash
bun test packages/server/server/backup/restore.test.ts
bun test packages/server/server/backup/repo-manifest.test.ts
bun test packages/server/server/backup/
```

**Then a deliberate-break check, and report the result:** revert the `walkStaged` filter (A1) alone
and confirm the new seam test FAILS; restore it and confirm it passes. A regression test for a bug
that shipped must be shown to catch it.
