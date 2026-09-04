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

---

# Wave B — credentials reach the archive

Two Critical findings. The module's own header promises "a tarball holding these is a master key to
the user's accounts" and excludes them for that reason. The promise currently holds for two of six
harnesses, and not at all for the one file that is in EVERY backup.

## B1 (C2). `preferences.json` carries live central tokens, in the default 4 MB backup

`backup-plan.ts` puts `.agentistics/preferences.json` in `ALWAYS`, and `excludeFor` returns `null`
for it. On the reference machine both `team.connections[].token` and the legacy `team.token` are
non-empty, and `preferences.ts` states outright that those tokens "exist nowhere else on this
machine". The spec's secrets table already lists `preferences.json → team.token` as excluded — the
spec is currently false.

Dropping the file is not the answer: it carries custom layouts, the billing timeline, the sharing
rules and the backup configuration, all of which the design promises to restore. **The file travels
REDACTED.**

**The mechanism.** A staged replacement: the redacted copy is written into the stage root at its
own `$HOME`-relative path, the real file is not walked, and `tar` takes that one path from the
stage root instead of from `$HOME`. It is then ordinary archive content — digested, counted, and
merged on restore like any other file.

In `backup-plan.ts`, remove `.agentistics/preferences.json` from `ALWAYS` and leave this in its
place:

```ts
// NOT here, deliberately. `preferences.json` travels REDACTED, staged by `cli-backup.ts`, because
// it carries live central tokens (`team.token` and `team.connections[].token`) that exist nowhere
// else on this machine. Walking it would put them in the archive verbatim — in the 4 MB default
// backup the design says is safe to schedule and carry on a pendrive.
```

In `backup.ts`, `BackupOptions` gains:

```ts
  /**
   * Archive-relative paths to take from `assetRoot` instead of from `$HOME`.
   *
   * For a file that must be TRANSFORMED before it travels — today, `preferences.json` with its
   * tokens redacted. They are archive content like any walked file: digested, sized, counted, and
   * merged on restore. They differ only in where `tar` reads them from.
   */
  stagedRels?: string[]
```

and `runBackup`, after the walk:

```ts
  // Staged replacements join the walked files for every purpose except which root tar reads them
  // from. They must be in the digest — they are $HOME content and the restore merges them.
  const staged: WalkedFile[] = []
  for (const rel of opts.stagedRels ?? []) {
    const st = await stat(join(opts.assetRoot ?? '', rel)).catch(() => null)
    if (!st?.isFile()) continue
    staged.push({ rel, bytes: st.size, layer: 'metrics', harness: null })
    addBytes(sizes, 'metrics', null, st.size)
  }
  const archived = [...files, ...staged]
```

`manifestDigest(archived)` and `groups[0].files = archived.length`; `listPath` stays built from
`files` alone (the staged ones are not under `$HOME`); the tar roots become:

```ts
    const assets = opts.assetRoot && existsSync(join(opts.assetRoot, 'repos'))
      ? ['-C', opts.assetRoot, 'repos'] : []
    const stagedArgs = opts.assetRoot && staged.length
      ? ['-C', opts.assetRoot, ...staged.map(f => f.rel)] : []
    await run('tar', [
      ...flags, '-cf', archivePath,
      '-C', opts.destDir, MANIFEST_NAME,
      ...assets, ...stagedArgs,
      '-C', opts.homeDir, '-T', listPath,
    ], { maxBuffer: 16 * 1024 * 1024 })
```

`stat` needs importing from `fs/promises` in `backup.ts`.

In `cli-backup.ts`, before `runBackup`, stage the redacted copy:

```ts
/**
 * Write `preferences.json` into the stage root with its live tokens removed.
 *
 * Returns the archive-relative paths staged. The redaction mirrors what `preferences.ts` already
 * does for its API read-out — this is not a new rule, it is the existing one applied to the copy
 * that leaves the machine.
 */
async function stagePreferences(stageRoot: string, log: (l: string) => void): Promise<string[]> {
  const rel = '.agentistics/preferences.json'
  const raw = await readFile(join(HOME_DIR, rel), 'utf-8').catch(() => null)
  if (raw === null) return []
  let prefs: Record<string, unknown>
  try {
    prefs = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Unparseable preferences are not carried at all: a file we cannot read is a file whose tokens
    // we cannot prove we removed.
    log('preferences.json could not be parsed — it is NOT in this backup')
    return []
  }
  const team = prefs.team as Record<string, unknown> | undefined
  if (team) {
    delete team.token
    const conns = team.connections
    if (Array.isArray(conns)) for (const c of conns) if (c && typeof c === 'object') delete (c as Record<string, unknown>).token
  }
  await mkdir(dirname(join(stageRoot, rel)), { recursive: true })
  await writeFile(join(stageRoot, rel), JSON.stringify(prefs, null, 2))
  return [rel]
}
```

Call it inside the existing `try` (so the stage root's cleanup covers it) and pass
`stagedRels` to `runBackup`. `readFile` and `dirname` need importing.

`omittedSecrets()` must also name it, so the restore prints it. Add to `EXCLUDE_RULES`:

```ts
  {
    pattern: '.agentistics/preferences.json#team.token', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop member connect <url> <token>',
    why: 'The central tokens inside preferences.json. The file itself travels, redacted — see backup-plan.ts ALWAYS.',
  },
```

That pattern can never match a real path (a `#` is not in any filename this walks), so it changes
no exclusion; it exists to appear in `omittedSecrets()`. **State that in the rule's own comment** —
a rule that looks like a path and is not one is otherwise a trap for the next reader.

## B2 (C3). The secret rules are a hardcoded harness list, and it is already incomplete

There are rows for claude, codex, gemini and copilot. Kimi and antigravity have none, and the
gemini and copilot rows do not reach the files that actually exist. Probed on the reference machine,
all reachable under `--with-raw`:

| path | today | on disk |
|---|---|---|
| `.kimi-code/config.toml` (holds `api_key`) | KEPT | exists |
| `.gemini/gemini-credentials.json` | KEPT | 526 B |
| `.gemini/google_accounts.json` | KEPT | exists |
| `.gemini/antigravity-cli/antigravity-oauth-token` | KEPT | 548 B |
| `.copilot/mcp-oauth-config/*.tokens.json` | KEPT | dir exists |

This is the `HARNESS_ORDER` rule — applied everywhere on this branch except the one table where
forgetting a harness leaks a credential.

**The fix.** Make it a `Record<HarnessId, ExcludeRule[]>` so the compiler requires an entry, and
derive `EXCLUDE_RULES` from it:

```ts
/**
 * Credential paths, per harness.
 *
 * A Record, so a new harness cannot be added without a decision about its secrets — the same rule
 * `HARNESS_SORT` enforces for display order, applied to the one table where forgetting a harness
 * puts a key in a tarball. An empty array is a legitimate entry and means "this harness stores no
 * credential under its own directory"; it is a claim, so state the evidence in a comment.
 */
const HARNESS_SECRETS: Record<HarnessId, ExcludeRule[]> = {
  claude: [
    { pattern: '.claude/.credentials.json', match: 'prefix', reason: 'secret',
      restoreWith: 'claude login',
      why: 'Claude Code OAuth credentials — a live session token.' },
  ],
  codex: [
    { pattern: '.codex/auth.json', match: 'prefix', reason: 'secret',
      restoreWith: 'codex login',
      why: 'Codex CLI credentials, including the id token whose payload carries the tier.' },
  ],
  gemini: [
    { pattern: '.gemini/oauth_creds.json', match: 'prefix', reason: 'secret',
      restoreWith: 'gemini  (sign in on first run)',
      why: 'Gemini CLI OAuth credentials.' },
    { pattern: '.gemini/gemini-credentials.json', match: 'prefix', reason: 'secret',
      restoreWith: 'gemini  (sign in on first run)',
      why: 'A second Gemini credential file the oauth_creds rule does not reach — verified present on a real machine.' },
    { pattern: '.gemini/google_accounts.json', match: 'prefix', reason: 'secret',
      restoreWith: 'gemini  (sign in on first run)',
      why: 'The signed-in Google account identifiers.' },
  ],
  copilot: [
    { pattern: '.copilot/token', match: 'contains', reason: 'secret',
      restoreWith: 'copilot  (sign in on first run)',
      why: 'Copilot CLI token files.' },
    { pattern: '.copilot/mcp-oauth-config', match: 'prefix', reason: 'secret',
      restoreWith: 're-authorise each MCP server from inside copilot',
      why: 'Per-MCP-server OAuth tokens. The `.copilot/token` rule does not reach `mcp-oauth-config/<x>.tokens.json`.' },
  ],
  antigravity: [
    { pattern: '.gemini/antigravity-cli/antigravity-oauth-token', match: 'prefix', reason: 'secret',
      restoreWith: 'agy  (sign in on first run)',
      why: 'Antigravity OAuth token. It lives under the Gemini directory, so no Gemini rule reaches it.' },
  ],
  kimi: [
    { pattern: '.kimi-code/config.toml', match: 'prefix', reason: 'secret',
      restoreWith: 'restore your api_key in ~/.kimi-code/config.toml',
      why: 'Holds `api_key` alongside ordinary settings. The whole file is excluded: over-excluding costs the user their Kimi settings, which are recoverable, while under-excluding costs them a key, which is not.' },
  ],
}
```

`EXCLUDE_RULES` becomes:

```ts
export const EXCLUDE_RULES: ExcludeRule[] = [
  ...HARNESS_ORDER.flatMap(h => HARNESS_SECRETS[h]),
  ...CROSS_HARNESS_SECRETS,   // the .agentistics connections + machine key + the preferences note
  ...REGENERABLE,
  ...RUNTIME,
]
```

Split the existing non-harness rows into those three arrays, unchanged.

**The test grows a per-harness probe.** In `backup-plan.test.ts`:

```ts
// One credential per harness, so a harness added without a secrets decision fails here rather than
// in someone's tarball. The Record makes the omission a compile error; this makes the WRONG path a
// test failure.
test('every harness has at least one credential rule, and each names how to re-establish it', () => {
  for (const h of HARNESS_ORDER) {
    const rules = EXCLUDE_RULES.filter(r => r.reason === 'secret' && r.why.length > 0)
    expect(rules.length).toBeGreaterThan(0)
  }
  for (const [rel, harness] of [
    ['.claude/.credentials.json', 'claude'],
    ['.codex/auth.json', 'codex'],
    ['.gemini/oauth_creds.json', 'gemini'],
    ['.gemini/gemini-credentials.json', 'gemini'],
    ['.gemini/google_accounts.json', 'gemini'],
    ['.gemini/antigravity-cli/antigravity-oauth-token', 'antigravity'],
    ['.copilot/token', 'copilot'],
    ['.copilot/mcp-oauth-config/github.tokens.json', 'copilot'],
    ['.kimi-code/config.toml', 'kimi'],
  ] as [string, string][]) {
    const rule = excludeFor(rel)
    expect(rule?.reason, `${harness}: ${rel} must be excluded`).toBe('secret')
    expect(rule?.restoreWith ?? '').not.toBe('')
  }
})

test('preferences.json is not walked — it travels redacted, staged', () => {
  const rels = planSources({ layers: ['metrics'], harnesses: ['claude'] }).map(e => e.rel)
  expect(rels).not.toContain('.agentistics/preferences.json')
})
```

And in `backup.test.ts`, prove the redaction over a real archive:

```ts
test('the staged preferences travel WITHOUT their tokens', async () => {
  // written by the fixture with a token in it
  const text = execFileSync('tar', ['-xOf', archivePath, '.agentistics/preferences.json'], { encoding: 'utf8' })
  expect(text).toContain('"lang"')
  expect(text).not.toContain('SUPER-SECRET-TOKEN')
})
```

Build the fixture's `preferences.json` with `team: { token: 'SUPER-SECRET-TOKEN', connections: [{ token: 'SUPER-SECRET-TOKEN' }] }` and assert the literal is absent from the extracted file.

## Verify

```bash
bun test packages/server/server/backup/
```

**Then a deliberate-break check, and report it:** remove the `.kimi-code/config.toml` rule and
confirm the per-harness probe FAILS naming kimi; restore it. And remove the redaction from
`stagePreferences` and confirm the archive test FAILS finding the token; restore it.
