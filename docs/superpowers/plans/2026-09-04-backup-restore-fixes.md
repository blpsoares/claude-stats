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

---

# Wave C — the reporting still lies in five places

One Critical and four Important. None stops a backup from being written; all five let it claim
something the code did not do.

## C1 (finding C5). A bundle that FAILED is treated exactly like one that was EMPTY

`repo-probe.ts` spends nine lines explaining that `failed` must never read as `empty` — "their
unpushed work was checked and found to be already safe". Its sole caller, `buildRepoManifest` in
`cli-backup.ts`, drops the distinction:

```ts
    if (res === 'written') e.bundle = rel
    else if (res === 'too-large') { e.note = 'too-large'; log(…) }
```

`'failed'` falls off the end: no log line, no note, `bundle` stays `null`, the run reports success.
The defect the module documents, reintroduced one layer up.

**The fix.** `RepoEntry` gains a field mirroring `RepoDirty.patchUnavailable`, which exists for
exactly this reason. In `repo-manifest.ts`:

```ts
  /**
   * Set when a bundle could NOT be produced — a permission error, a full disk, a timeout. Carries
   * the reason, and the restore prints it.
   *
   * A `bundle` of `null` used to mean both "every local commit is already on the remote" and "we
   * could not look", so a repository whose unpushed work was never captured restored silently
   * without it.
   */
  bundleUnavailable?: string
```

and in `cli-backup.ts`:

```ts
    if (res === 'written') e.bundle = rel
    else if (res === 'too-large') {
      e.note = 'too-large'
      log(`  ${e.key}: bundle over the ceiling — cloning without local-only history`)
    } else if (res === 'failed') {
      e.bundleUnavailable = 'git bundle failed — this repository restores WITHOUT its unpushed commits'
      log(`  ${e.key}: ${e.bundleUnavailable}`)
    }
    // 'empty' is the happy case: every local commit is already on the remote.
```

`restoreRepos` names it beside the untracked report:

```ts
  for (const e of entries) {
    if (e.bundleUnavailable) log(`note ${e.key}: ${e.bundleUnavailable}`)
    for (const d of e.dirty) { … }
  }
```

## C2 (I1). An unreadable source ROOT reads as "this harness is not installed"

`backup.ts`: `if (!isRoot) skipped.push(...)`. At a root, ENOENT and EACCES/ELOOP/ENOTDIR are one
value. `~/.claude` unreadable ⇒ the whole claude layer contributes zero bytes, `skipped` is empty,
`record.skipped` is 0, and the result is `ok: true`. `backup.test.ts`'s missing-source test would
still pass with the distinction removed.

```ts
    } catch (e) {
      // A source ROOT that is ABSENT is the ordinary "this harness is not installed" case and is
      // not reported. A root that exists and cannot be READ is a hole in the backup, and only the
      // errno separates them — without this check a permission error on ~/.claude produced an
      // empty claude layer inside a backup reporting complete success.
      const code = (e as NodeJS.ErrnoException).code
      if (!isRoot || code !== 'ENOENT') skipped.push({ rel, reason: 'unreadable', detail: errText(e) })
      return
    }
```

Test:

```ts
test('a source root that exists but cannot be read is reported, not read as "not installed"', async () => {
  const locked = join(home, '.locked')
  mkdirSync(locked, { recursive: true })
  writeFileSync(join(locked, 'x.json'), '{}')
  chmodSync(locked, 0o000)
  try {
    const { files, skipped } = await walkSources(home, [{ rel: '.locked', layer: 'raw', harness: 'claude' }])
    expect(files).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.reason).toBe('unreadable')
  } finally {
    chmodSync(locked, 0o700)
    rmSync(locked, { recursive: true, force: true })
  }
})
```

If the test environment runs as root (where a 000 directory is still readable), skip it with an
explicit `if (process.getuid?.() === 0) return` and say so in a comment — a test that silently
cannot fail is the thing this branch keeps finding.

## C3 (I2). The scheduled backup records a `repos` layer it never carries

`daemon.ts` passes `repos: []` and no `assetRoot`, while `scheduleLayers` defaults to
`['metrics','repos']`. The manifest and `BackupRecord.layers` then claim `repos`, `status` shows it,
and a restore prints "Repository plan: 0 to clone". A user who set `daily` believes their repository
layout and unpushed branches are being saved. The deviation is recorded in the plan; the ARTIFACT
does not record it.

```ts
      // The scheduled run carries no repository manifest — building one shells out to git across
      // every known directory and writes bundles, which is load nobody asked for unattended. So it
      // must not RECORD a repos layer either: a manifest that claims one produces a restore saying
      // "0 repositories to clone" on a machine whose owner believed they were covered.
      const layers = prefs.scheduleLayers.filter(l => l !== 'repos')
      log(`[backup] scheduled run: layers ${layers.join(', ')} (repos are built by \`agentop backup\`, not on a schedule)`)
```

and pass `layers` to `runBackup`.

## C4 (I3). Retention is never applied to a scheduled backup

`toPrune` has exactly one caller, in `runBackupCli`. An unattended daily schedule grows unbounded —
the precise scenario the spec's retention rule exists for.

Extract the prune from `runBackupCli` into an exported helper in `cli-backup.ts`, and call it from
both:

```ts
/**
 * Delete the FILES of backups beyond `keep`, newest first. The records stay: the store is
 * append-only and `markPresence` reports a missing file as absent from then on.
 */
export async function pruneOldBackups(keep: number, log: (l: string) => void): Promise<void> {
  const entries = markPresence(await readBackups(), p => existsSync(p))
  for (const old of toPrune(entries, keep)) {
    await rm(old.path, { force: true }).catch(() => {})
    log(`pruned ${old.path}`)
  }
}
```

In `daemon.ts`, after a successful run:

```ts
      if (r.ok) await pruneOldBackups(prefs.keep, l => log(`[backup] ${l}`))
```

## C5 (I6). `gitEnv()` leaves the config-injection variables in place

It deletes the five directory hijackers and sets `GIT_CONFIG_NOSYSTEM`, but not `GIT_CONFIG_GLOBAL`,
the numbered `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` triple, or
`GIT_SSH_COMMAND`. `repo-manifest.ts`'s `git clone` is the one argv with no `-C`, and an inherited
`url.<base>.insteadOf` rewrites the remote it clones from.

```ts
const HIJACKERS = [
  // Directory: these make `-C` and `cwd` a lie.
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
  // Configuration: these inject config we did not read. `url.<base>.insteadOf` rewrites the remote
  // a clone actually fetches from, and the clone is the one argv here with no `-C` to anchor it.
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT',
  // Transport.
  'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND',
] as const

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of HIJACKERS) delete env[k]
  // GIT_CONFIG_COUNT is deleted above, which disables the numbered pairs — but they are removed
  // too, so nothing is left for a later `GIT_CONFIG_COUNT` in a child to pick up.
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_CONFIG_KEY_') || k.startsWith('GIT_CONFIG_VALUE_')) delete env[k]
  }
  return env
}
```

Test, in `repo-probe.test.ts` beside the `GIT_COMMON_DIR` one:

```ts
// `url.<base>.insteadOf` in an inherited environment rewrites the remote a clone fetches from, and
// the clone is the one git argv on this branch with no `-C` to anchor it.
test('inherited GIT_CONFIG_* cannot inject configuration into a probe', async () => {
  const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, val: process.env.GIT_CONFIG_VALUE_0 }
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'remote.origin.url'
  process.env.GIT_CONFIG_VALUE_0 = 'https://evil.example/injected.git'
  try {
    const f = await probeDir(repo)
    expect(f.cloneUrl).toBe('git@github.com:org/repo.git')
  } finally {
    for (const [k, v] of [['GIT_CONFIG_COUNT', saved.count], ['GIT_CONFIG_KEY_0', saved.key], ['GIT_CONFIG_VALUE_0', saved.val]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})
```

## Verify

```bash
bun test packages/server/server/backup/
```

**Deliberate-break check, and report it:** remove `GIT_CONFIG_COUNT` from `HIJACKERS` and confirm
the injection test FAILS; restore it.

---

# Wave D — three Criticals from the re-review, one of them created by Wave B

## D1. The scheduled backup carries no `preferences.json` at all — a regression from B1

Wave B removed the file from `ALWAYS` and re-established it as a staged replacement wired only
through `cli-backup.ts`. `daemon.ts` is the other caller of `runBackup` and passes neither
`assetRoot` nor `stagedRels`, so every scheduled run silently drops the billing timeline (which
exists in no other file on any machine), the custom layouts, `archiveMode`, and the backup
configuration itself — and logs `wrote <path>` and reports a healthy backup in `status`.

**Why it happened, and what that dictates about the fix.** The new contract lets a caller omit half
the payload by omitting an argument. `daemon.ts` was written against the old contract, where every
source came from the `$HOME` walk and there was nothing to forget. Fixing `daemon.ts` would leave
the trap for the third caller.

**The staging moves INTO `runBackup`.** `stagedRels` leaves `BackupOptions` entirely.

Move `stagePreferences` from `cli-backup.ts` into `backup.ts` (it needs `HOME_DIR`, which that
module can import), and have `runBackup` own it:

```ts
  // Staged replacements are built HERE, not passed in. `preferences.json` must be redacted before
  // it travels, and the previous shape — an optional `stagedRels` supplied by the caller — meant a
  // caller could omit it by omitting an argument, which is exactly what the scheduled run did:
  // every unattended backup silently lost the billing timeline while reporting success. A payload
  // that is only complete when the caller remembers something is a payload that will be incomplete.
  const prefStage = await mkdtemp(join(tmpdir(), 'agentistics-staged-'))
  try {
    const staged = await stageRedactedFiles(opts.homeDir, prefStage, log)
    …everything from the walk to recordBackup…
  } finally {
    await rm(prefStage, { recursive: true, force: true }).catch(() => {})
  }
```

with the tar gaining a fourth root:

```ts
    const stagedArgs = staged.length ? ['-C', prefStage, ...staged.map(f => f.rel)] : []
```

`stageRedactedFiles` returns `WalkedFile[]` (it stats what it wrote), so `archived`, the digest and
the manifest count are unchanged from Wave B. Delete `stagePreferences` and the `stagedRels`
plumbing from `cli-backup.ts`.

**A test that pins the contract, not the caller** — in `backup.test.ts`:

```ts
// D1: the regression was that a CALLER could omit the redacted staging. Nothing about this test
// mentions cli-backup; it asserts that `runBackup` itself always carries it, so the scheduled path
// and every future caller get it for free.
test('runBackup always carries the redacted preferences, with no caller cooperation', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box',   // no assetRoot, no staged anything
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const text = execFileSync('tar', ['-xOf', r.record.path, '.agentistics/preferences.json'], { encoding: 'utf8' })
  expect(text).toContain('"lang"')
  expect(text).not.toContain('SUPER-SECRET-TOKEN')
})
```

## D2. A repository that fails AFTER cloning is never retried, and the retry says `skipped`

Reproduced:

```
RUN 1: FAILED k — git worktree add … fatal: invalid reference:
RUN 2: attempted 0  failures []  skipped [{"key":"k","reason":"destination-exists"}]  exit 0
```

`planRepos` tests `destExists` before it reaches the `previousFailure` branch, and the clone is step
one of several. So any failure at `branch -m`, `fetch`, `checkout`, `worktree add` or `apply` leaves
the directory on disk, and from then on `agentop restore --repos` is a no-op printing `skipped` and
returning 0 — while the CLI tells the user "Re-run the same command to retry only the failures".
The worktrees, the unpushed branches and the uncommitted diffs are gone with no failing signal.

**This is not resumed mid-sequence.** Making each step idempotent is a larger change than it looks
(`branch -m` is not repeatable, `worktree add` is not), and a half-clever resume that gets it wrong
writes into a repository the user may have started working in. It gets its own WORD instead, said
loudly, with the previous reason and what to do.

`RepoStep` gains the state, checked BEFORE `destExists`:

```ts
    // A repo that failed after its clone leaves the destination behind. Checking `destExists` first
    // — as this did — turns every such repo into a permanent silent skip, which is worse than the
    // failure: the CLI tells the user to re-run, the re-run does nothing, and it exits 0.
    if (prior?.state === 'failed' && destExists(expandHome(e.mainPath, homeDir))) {
      return {
        ...base,
        state: 'half-restored',
        reason: 'half-restored',
        previousFailure: prior.reason ?? 'unknown',
        argv: [], commands: [],
      }
    }
```

`RepoStepState` becomes `'pending' | 'done' | 'skipped' | 'half-restored'`.

`RestoreReposResult` gains `halfRestored: { key: string; path: string; previousFailure: string }[]`,
`restoreRepos` fills it, and `runRestoreCli` prints it as its own block and **returns non-zero**:

```ts
  if (r.halfRestored.length) {
    log('')
    log('These repositories were PARTLY restored and will not be retried automatically:')
    for (const h of r.halfRestored) {
      log(`  ${h.key} at ${h.path}`)
      log(`    the earlier run failed after cloning: ${h.previousFailure}`)
    }
    log('  Inspect them, then remove the directory and re-run to restore each from scratch.')
  }
  return r.failures.length || r.halfRestored.length ? 1 : 0
```

## D3. A worktree in detached HEAD emits `git worktree add <path> ''`

`probeDir` deliberately records `branch: ''` for a detached HEAD, and `restoreArgv` passes it
through. Real git: `fatal: invalid reference:` (exit 128). `runSteps` returns on the first failure,
so ONE detached worktree costs the repository every later step — the remaining worktrees and every
`git apply` of the uncommitted diffs — and by D2 it is then never retried. Detached HEADs are
routine (bisects, CI checkouts, `worktree add --detach`).

In `repo-manifest.ts`:

```ts
  for (const w of entry.worktrees) {
    const at = expandHome(w.path, homeDir)
    // A detached worktree has no branch — `probeDir` records '' for it deliberately. Passing that
    // through emitted an empty argv element and git refused the whole repository at that point.
    if (w.branch) out.push(['git', '-C', main, 'worktree', 'add', at, w.branch])
    else if (w.head) out.push(['git', '-C', main, 'worktree', 'add', '--detach', at, w.head])
    // With neither a branch nor a head there is nothing to recreate; the entry stays in the
    // manifest so the report can name it.
  }
```

Tests in `repo-manifest.test.ts`:

```ts
test('a detached worktree is recreated detached at its head, never with an empty ref', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: `${HOME}/proj/wt`, commonDir: `${HOME}/proj/.git`, topLevel: `${HOME}/proj/wt`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: '', head: 'deadbee',
  })
  const [e] = groupRepos([main, wt], HOME)
  const argv = restoreArgv(e!, HOME)
  expect(argv).toContainEqual(['git', '-C', '/home/u/proj', 'worktree', 'add', '--detach', '/home/u/proj/wt', 'deadbee'])
  expect(argv.every(a => a.every(x => x !== ''))).toBe(true)
})

test('a worktree with neither branch nor head is left out rather than emitted broken', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: `${HOME}/proj/wt`, commonDir: `${HOME}/proj/.git`, topLevel: `${HOME}/proj/wt`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo', branch: '', head: '',
  })
  const [e] = groupRepos([main, wt], HOME)
  expect(restoreArgv(e!, HOME).some(a => a.includes('worktree'))).toBe(false)
})
```

## Verify

```bash
bun test packages/server/server/backup/
```

**Deliberate-break checks, both reported:**
1. Remove the `stageRedactedFiles` call from `runBackup` and confirm the D1 test FAILS (no
   `preferences.json` in the archive). Restore it.
2. Move the `prior?.state === 'failed'` check back BELOW `destExists` and confirm a D2 test FAILS.
   Restore it.

---

# Wave E — the four Importants and the Minors

## E1 (I6). `gitEnv()` strips too much — an over-correction of mine

Wave C added `GIT_SSH_COMMAND` and `GIT_PROXY_COMMAND` to the strip list alongside the config
variables. The config ones are right: `url.<base>.insteadOf` rewrites the remote a clone fetches
from, and `git clone` is the one invocation here with no `-C`. The transport ones are not, and they
reach the RESTORE clone through the same `gitEnv()`. A user whose forge access depends on
`GIT_SSH_COMMAND` — a non-default identity file, a `ProxyJump` — has every clone fail on the new
machine, which is the moment they can least afford it.

The threat model does not support it either: anything able to set `GIT_SSH_COMMAND` in agentop's
environment already has code execution as the user, and `~/.ssh/config` does the same job and
cannot be stripped.

Remove both from `HIJACKERS` and say why they are absent:

```ts
  // Transport variables (GIT_SSH_COMMAND, GIT_PROXY_COMMAND) are deliberately NOT here. They reach
  // the restore's `git clone`, and a user whose forge access needs a non-default identity or a
  // ProxyJump would have every clone fail on the new machine. Anything that can set them in this
  // process already has code execution as the user, and ~/.ssh/config does the same job unstrippably.
```

## E2 (I4). A bundle restore loses the main branch's upstream and leaves the placeholder behind

Verified: after the clone/rename/fetch sequence, `branch.main.remote` is absent, so `git pull` says
"no tracking information" and `git push` says "no upstream branch". `branch -m` carries the tracking
config to the placeholder, and the bundle fetch then creates `refs/heads/main` with none. It bites
only when the main branch has unpushed commits — exactly the repositories the bundle exists for.
The placeholder also survives in every restored repo, where the NEXT backup would bundle it as
"unpushed work".

**Steps must be able to be optional for this.** `restoreArgv` returns
`{ argv: string[]; optional?: boolean }[]`; `restoreCommands` joins `argv`; `runSteps` logs and
CONTINUES past a failing optional step instead of abandoning the repository. `--set-upstream-to`
legitimately fails (a branch with no matching remote branch), and that must not cost the worktrees.

After the checkout:

```ts
    out.push({ argv: ['git', '-C', main, 'branch', '--set-upstream-to', `origin/${entry.mainBranch}`, entry.mainBranch], optional: true })
```

and last, once nothing else needs it:

```ts
  if (entry.bundle) out.push({ argv: ['git', '-C', main, 'branch', '-D', PLACEHOLDER_BRANCH], optional: true })
```

Export `PLACEHOLDER_BRANCH` so the rename and the delete cannot drift apart.

For the unknown-`mainBranch` case the `reset --hard` leaves the checkout ON the placeholder, with a
working tree at the pushed tip while the unpushed work sits in `refs/heads/main`. Replace it with
`['git','-C',main,'checkout','--detach','origin/HEAD']` — a detached checkout at the clone's own
default is honest about knowing no branch name, and leaves no placeholder checked out.

## E3 (I5). The digest is strict `path:bytes` equality taken over a live machine

Any file whose SIZE changes between the walk and the moment tar reaches it makes the archive
permanently unrestorable, discovered only after the source machine is gone. `~/.agentistics/sessions/*`
is rewritten by the running server and `.claude/projects/**/*.jsonl` by every live session, so with
`--with-raw` this is close to expected.

**The digest was never content integrity** — it is `path:bytes`, so an edited file of the same size
already passes. Its real job is catching a rebuilt or edited ARCHIVE. So it checks the SET, and
reports size drift instead of refusing on it:

```ts
export type StagedVerdict =
  | { ok: true; drifted: string[] }
  | { ok: false; reason: string }

/**
 * Compare the extracted set against the manifest.
 *
 * MISSING or EXTRA paths are a refusal: that is a rebuilt or truncated archive, which is what this
 * check exists for. A path whose SIZE differs is REPORTED and does not block — the backup was taken
 * on a live machine, where the running server rewrites session documents and every open assistant
 * appends to a transcript, so a few bytes of drift between the walk and tar's read is expected. It
 * used to refuse, which made a perfectly restorable archive unopenable on a machine that no longer
 * existed.
 */
export function verifyStaged(staged: { rel: string; bytes: number }[], manifest: BackupManifest): StagedVerdict
```

Compute both sets from the manifest's `groups[0]` — which needs the per-file list. **The manifest
must carry it**: add `files: { rel: string; bytes: number }[]` to `FileGroup`, written from
`archived` in `backup.ts`. Keep `sha256` (it still detects a wholesale rebuild) but stop refusing on
it alone.

`restoreMetrics` names the drift:

```ts
    if (digest.drifted.length) {
      log(`${digest.drifted.length} file(s) changed size between the walk and the archive — restored as archived:`)
      for (const d of digest.drifted.slice(0, 10)) log(`  ${d}`)
    }
```

And `agentop backup` warns up front when the machine is busy, using the same producer heartbeat
`status` already reads:

```ts
  if (existsSync(join(AGENTISTICS_DATA_DIR, 'events-producer.json'))) {
    log('note: the agentop server is running, so session files may change while this backup is taken.')
    log('      Files that change are archived as read and reported on restore; nothing is lost.')
  }
```

## E4 (I7). The restored `preferences.json` normally loses to the newer local copy

On the real flow — reformat, install agentop, run `agentop setup` or accept the archive-consent
modal, THEN restore — the local `preferences.json` is minutes old, so `planMetrics`' newer-wins rule
drops the one file Wave B went to the trouble of carrying, as one line in the skip stream. The
billing timeline and the layouts do not come back.

Newer-wins is right for session documents and wrong for a config file the tool creates for itself.
`preferences.json` gets a UNION merge, in `restore.ts`'s merge loop:

```ts
      // preferences.json is the one file the tool writes for ITSELF, so on the realistic flow — set
      // up the new machine, then restore — the local copy is always newer and newer-wins would drop
      // it. Union instead: keys the local file does not have are taken from the backup, keys it has
      // are kept. Nothing local is overwritten and nothing carried is silently lost.
      if (a.rel === PREFERENCES_REL) {
        const merged = mergePreferences(localText, archivedText)
        …write merged, and report which keys came from the backup…
      }
```

`mergePreferences` is PURE and belongs in `restore-plan.ts` with its own tests: a shallow union at
the top level, local wins per key, and it returns the list of keys it took so the report can name
them. It never merges `team` (that block's tokens were redacted out; taking a half-`team` from a
backup onto a configured machine would be worse than not taking it) — say so in the code.

## E5. The Minors

- **`.claude/sessions/*.key` (141 files here) and `.claude/daemon/control.key`** enter a `--with-raw`
  backup. Local control-socket tokens for dead pids — both the `secret` and the `runtime` reason
  apply, and the table's own trade says they go out. Add a `runtime` rule for `.claude/daemon` and a
  `contains` rule for `.claude/sessions/` + `.key`.
- **`backup-plan.test.ts`'s per-harness loop never uses `h`** — it asserts one global fact six times.
  Key the probe off `HARNESS_SECRETS[h]` so a harness with an empty array fails BY NAME.
- **The backup tests append to the real `~/.agentistics/backups.jsonl`.** Thread the store path
  through `BackupOptions` (`recordFile?: string`) and give the tests a temp one.
- **`cli-backup.ts` reads the resume state from `RESTORE_STATE_FILE` while `restoreRepos` uses
  `restoreStateFile(homeDir)`.** Identical unless `AGENTISTICS_DIR` is set, in which case the printed
  plan and the executed run disagree about what is already done. Use `restoreStateFile(HOME_DIR)`.

## Verify

```bash
bun test packages/server/server/backup/
```

**Deliberate-break checks, all reported:** (1) make `verifyStaged` refuse on size drift again and
confirm a new drift test FAILS; (2) remove the `preferences.json` union and confirm the E4 test
FAILS by finding the local file unchanged; (3) put `GIT_SSH_COMMAND` back in `HIJACKERS` and confirm
the E1 test FAILS.
