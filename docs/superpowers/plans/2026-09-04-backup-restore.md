# Backup & Restore — Implementation Plan (Phase 1: engine, CLI, schedule)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `agentop` a `backup` and a `restore` that carry a machine's entire agentistics history — metrics, archive, raw harness dirs, and a repository manifest that reconstructs every checkout, worktree, unpushed branch and uncommitted diff — to a freshly formatted machine.

**Architecture:** Every decision is made by a pure module under `packages/server/server/backup/`; two IO modules do the walking, the git-running and the tar-driving; one CLI handler prints. The scheduled run rides along with the daemon `agentop server` already starts, exactly as `events/daemon.ts` does. Surfaces (cockpit tab, web Settings section) are Plan 2 and add no rules.

**Tech Stack:** Bun, TypeScript (strict), `bun:test`, `child_process.exec` for git and tar, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-backup-restore-design.md` — read it first.

## Global Constraints

- **Worktree:** all work happens in `.claude/worktrees/backup-restore` on branch `feat/backup-restore` (already created from `origin/dev`). Never the shared checkout.
- **Language:** code, comments and docs in **English** (project rule, `CLAUDE.md`). **Commit messages in Portuguese**, Conventional Commits — this matches the user's global preference and this branch's recent history. Do not flip between the two mid-plan.
- **No new dependencies.** No tar library, no archiver, no zstd binding. Shell out.
- **Never hardcode a harness list.** Anything per-harness is a `Record<HarnessId, …>` so the compiler requires an entry, or derives from `HARNESS_ORDER` (`@agentistics/core`). A plain array literal with a member missing compiles clean and the harness silently vanishes.
- **Pure modules import no `fs`, no `child_process`, no `./config`.** They take their inputs as arguments. This is what makes them testable without mocking the filesystem.
- **Tokens are all four counters** where any token figure appears — but this plan produces none, so the rule only matters if you are tempted to add one.
- **Pre-commit hook runs `bun tsc --noEmit` and `bun test`.** Both must pass before every commit step. If `tsc` fails on `embedded-dist.generated.ts`, run `bun run packages/server/scripts/ensure-type-stub.ts`.
- **Every path inside the archive is `$HOME`-relative with no leading slash** (`.agentistics/sessions/claude`). Absolute paths appear only in the manifest's `homeDir` field and in `RepoEntry.mainPath` when a directory genuinely lives outside `$HOME`.
- **A figure that had to be estimated is never presented as a measurement.** Concretely: no module in this plan may produce a compressed size before the archive exists.

## Prerequisites (do this once, before Task 1)

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/backup-restore
bun install
bun run packages/server/scripts/ensure-type-stub.ts
bun test packages/server/server/chat-gate.test.ts   # smoke: the harness works
```

Expected: the chat-gate tests pass. If `bun test` reports module-resolution errors, `bun install` did not finish — do not proceed.

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/server/backup/backup-plan.ts` | PURE. Which paths go in, which are excluded, and why. |
| `packages/server/server/backup/backup-plan.test.ts` | Including the source-grep that no secret can pass the filter. |
| `packages/server/server/backup/backup-size.ts` | PURE. Per-layer and per-harness byte accounting; retention totals. |
| `packages/server/server/backup/backup-size.test.ts` | Including the source-grep that no compression is predicted. |
| `packages/server/server/backup/manifest.ts` | PURE. The manifest shape, encode/decode, version tolerance. |
| `packages/server/server/backup/manifest.test.ts` | Round-trip; a newer version is refused with a reason. |
| `packages/server/server/backup/repo-manifest.ts` | PURE. `DirFacts[]` → `RepoEntry[]`, and `RepoEntry` → the commands that rebuild it. |
| `packages/server/server/backup/repo-manifest.test.ts` | Worktree grouping, the five notes, command generation. |
| `packages/server/server/backup/backup-store.ts` | The `backups.json` history. Pure decisions + two IO functions. |
| `packages/server/server/backup/backup-store.test.ts` | The "file is gone" rule and per-harness last-backup. |
| `packages/server/server/backup/schedule.ts` | PURE. Is a run due, and what the UI is allowed to say. |
| `packages/server/server/backup/schedule.test.ts` | Due/not-due; a stopped server yields "inactive", never a next time. |
| `packages/server/server/backup/restore-plan.ts` | PURE. Manifest + machine state → write / skip / clone, and the resume. |
| `packages/server/server/backup/restore-plan.test.ts` | Merge never overwrites newer; resume; `$HOME` rewrite. |
| `packages/server/server/backup/repo-probe.ts` | IO. Runs git over the candidate directories; produces `DirFacts`, bundles, patches. |
| `packages/server/server/backup/backup.ts` | IO. Walks, sizes, calls the probe, writes the archive, records it. |
| `packages/server/server/backup/restore.ts` | IO. Verifies, extracts to staging, merges, executes the repo plan. |
| `packages/server/server/backup/daemon.ts` | The scheduled runner that rides the otel-watcher daemon. |
| `packages/server/server/cli-backup.ts` | `agentop backup` / `agentop restore` handlers. |
| `packages/server/bin/cli.ts` | Dispatch two new commands. |
| `packages/server/server/cli-i18n.ts` | EN/PT strings. |
| `packages/server/server/preferences.ts` | `Preferences.backup`. |
| `packages/server/server/otel-watcher.ts` | One hook, beside `startEventProducer`. |
| `packages/web/src/pages/settings/ChatSettings.tsx` | Task 12 — receives the moved CHAT block. |
| `packages/web/src/pages/settings/PreferencesSettings.tsx` | Task 12 — loses it. |
| `packages/web/src/lib/settingsSections.ts` | Task 12 — the section gate. |

---

## Task 1: `backup-plan.ts` — what goes in, and what is refused

**Files:**
- Create: `packages/server/server/backup/backup-plan.ts`
- Test: `packages/server/server/backup/backup-plan.test.ts`

**Interfaces:**
- Consumes: `HarnessId`, `HARNESS_ORDER` from `@agentistics/core`.
- Produces: `BackupLayer`, `BACKUP_LAYERS`, `ExcludeRule`, `EXCLUDE_RULES`, `SourceEntry`, `planSources(input)`, `excludeFor(rel)`, `omittedSecrets()`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/backup-plan.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BACKUP_LAYERS, EXCLUDE_RULES, excludeFor, omittedSecrets, planSources } from './backup-plan'

test('metrics is always planned, whatever the caller asked for', () => {
  const s = planSources({ layers: ['raw'], harnesses: ['claude'] })
  expect(s.some(e => e.layer === 'metrics')).toBe(true)
})

test('a harness contributes its consolidate dir AND its raw dir', () => {
  const s = planSources({ layers: ['metrics', 'raw'], harnesses: ['codex'] })
  const rels = s.map(e => e.rel)
  expect(rels).toContain('.agentistics/sessions/codex')
  expect(rels).toContain('.codex')
})

test('an unselected harness contributes nothing of its own', () => {
  const rels = planSources({ layers: ['metrics', 'raw'], harnesses: ['codex'] }).map(e => e.rel)
  expect(rels).not.toContain('.agentistics/sessions/claude')
  expect(rels).not.toContain('.claude')
})

// Antigravity lives INSIDE ~/.gemini. Selecting both must not archive .gemini twice — the second
// entry is a subpath of the first, and tar would walk the same bytes again.
test('a source nested inside another selected source is dropped', () => {
  const rels = planSources({ layers: ['raw'], harnesses: ['gemini', 'antigravity'] }).map(e => e.rel)
  expect(rels).toContain('.gemini')
  expect(rels).not.toContain('.gemini/antigravity-cli')
})

test('antigravity alone still reaches its own dir inside .gemini', () => {
  const rels = planSources({ layers: ['raw'], harnesses: ['antigravity'] }).map(e => e.rel)
  expect(rels).toContain('.gemini/antigravity-cli')
  expect(rels).not.toContain('.gemini')
})

test('cross-harness data is always in, whatever the harness selection', () => {
  const rels = planSources({ layers: ['metrics'], harnesses: [] }).map(e => e.rel)
  expect(rels).toContain('.agentistics/tags.json')
  expect(rels).toContain('.agentistics/workflows')
  expect(rels).toContain('.agentistics/preferences.json')
  expect(rels).toContain('.claude/stats-cache.json')
})

test('every credential path is excluded, and names how to re-establish it', () => {
  for (const rel of [
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.gemini/oauth_creds.json',
    '.agentistics/connections/some-central.json',
  ]) {
    const rule = excludeFor(rel)
    expect(rule?.reason).toBe('secret')
    expect(rule?.restoreWith ?? '').not.toBe('')
  }
})

test('regenerable and runtime files are excluded', () => {
  expect(excludeFor('.agentistics/cache.db')?.reason).toBe('regenerable')
  expect(excludeFor('.agentistics/cache.db-wal')?.reason).toBe('regenerable')
  expect(excludeFor('.agentistics/agentop-server.log')?.reason).toBe('regenerable')
  expect(excludeFor('.claude/shell-snapshots/x.sh')?.reason).toBe('regenerable')
  expect(excludeFor('.agentistics/managed-sessions.json')?.reason).toBe('runtime')
  expect(excludeFor('.agentistics/managed-sessions.json.corrupt-123')?.reason).toBe('regenerable')
})

test('ordinary data is not excluded', () => {
  expect(excludeFor('.agentistics/sessions/claude/abc.json')).toBeNull()
  expect(excludeFor('.claude/stats-cache.json')).toBeNull()
  expect(excludeFor('.claude/projects/foo/bar.jsonl')).toBeNull()
})

test('omittedSecrets lists every secret rule, each with its command', () => {
  const s = omittedSecrets()
  expect(s.length).toBeGreaterThan(0)
  expect(s.every(r => r.reason === 'secret' && (r.restoreWith ?? '') !== '')).toBe(true)
})

// The enforcement, not a convention: a credential path that stopped being excluded is a leak, and
// a leak in a tarball is discovered by whoever finds the tarball. Same shape as
// billing-detect.test.ts, which greps its own module rather than trusting a reviewer.
test('no credential filename can pass the filter — asserted over the source itself', () => {
  const src = readFileSync(join(import.meta.dir, 'backup-plan.ts'), 'utf8')
  for (const needle of ['.credentials.json', 'auth.json', 'oauth_creds.json', 'connections']) {
    expect(src).toContain(needle)
  }
  for (const probe of [
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.gemini/oauth_creds.json',
    '.agentistics/connections/x',
  ]) {
    expect(excludeFor(probe)).not.toBeNull()
  }
})

// The `repos` layer's content is produced during the backup (bundles, patches) and lives nowhere
// in $HOME, so it contributes no source to this walk. Pinned so the absence reads as a decision
// rather than an omission — it is `runBackup`'s `assetRoot` that carries it into the archive.
test('the repos layer contributes no $HOME source — its content is made, not found', () => {
  const withRepos = planSources({ layers: ['metrics', 'repos'], harnesses: ['claude'] })
  const without = planSources({ layers: ['metrics'], harnesses: ['claude'] })
  expect(withRepos.map(e => e.rel)).toEqual(without.map(e => e.rel))
  expect(withRepos.some(e => e.layer === 'repos')).toBe(false)
})

test('BACKUP_LAYERS is the whole set and metrics leads it', () => {
  expect(BACKUP_LAYERS).toEqual(['metrics', 'repos', 'archive', 'raw'])
  expect(EXCLUDE_RULES.every(r => r.why.length > 0)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/backup-plan.test.ts`
Expected: FAIL — `Cannot find module './backup-plan'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/backup-plan.ts`:

```ts
/**
 * backup-plan.ts — PURE. What a backup carries, and what it refuses to carry.
 *
 * Two things live here and nowhere else.
 *
 * **The layer model.** A backup is up to four layers, each independently selectable and each
 * recorded in the manifest, so a restore knows what it is holding rather than inferring it from
 * what it happens to find. `metrics` is not optional: a backup without it restores nothing.
 *
 * **The exclusion table, with a reason per row.** Three reasons, and they are not
 * interchangeable:
 *
 *  - `secret` — a live credential. Excluded by decision: a tarball holding these is a master key
 *    to the user's accounts, and it travels on a pendrive. The cost (five minutes of re-login) is
 *    paid deliberately, and `omittedSecrets()` is what lets the restore NAME each one and the
 *    command that re-establishes it. Nothing here goes missing in silence.
 *  - `regenerable` — a cache or a log. It rebuilds itself and costs megabytes.
 *  - `runtime` — true on the old machine and false on the new one. `managed-sessions.json` names
 *    tmux sessions that will not exist; restoring it produces a fleet of rows pointing at nothing.
 *
 * `backup-plan.test.ts` greps this file and re-probes every credential path, so a rule deleted in
 * a refactor fails the build rather than shipping a leak.
 */
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'

export type BackupLayer = 'metrics' | 'repos' | 'archive' | 'raw'

/** Every layer, metrics first because it is the one that is never optional. */
export const BACKUP_LAYERS: BackupLayer[] = ['metrics', 'repos', 'archive', 'raw']

export type ExcludeReason = 'secret' | 'regenerable' | 'runtime'

export interface ExcludeRule {
  /** Matched against a $HOME-relative path with no leading slash. */
  pattern: string
  /** `prefix` — the path is, or is inside, `pattern`. `contains` — `pattern` appears anywhere. */
  match: 'prefix' | 'contains'
  reason: ExcludeReason
  /** For `secret` only: the command that re-establishes it. Required, and tested for. */
  restoreWith?: string
  /** Why this row exists. Rendered by `agentop backup --explain`. */
  why: string
}

export const EXCLUDE_RULES: ExcludeRule[] = [
  // --- secrets ---------------------------------------------------------------------------------
  {
    pattern: '.claude/.credentials.json', match: 'prefix', reason: 'secret',
    restoreWith: 'claude login',
    why: 'Claude Code OAuth credentials — a live session token.',
  },
  {
    pattern: '.codex/auth.json', match: 'prefix', reason: 'secret',
    restoreWith: 'codex login',
    why: 'Codex CLI credentials, including the id token whose payload carries the tier.',
  },
  {
    pattern: '.gemini/oauth_creds.json', match: 'prefix', reason: 'secret',
    restoreWith: 'gemini  (sign in on first run)',
    why: 'Gemini CLI OAuth credentials.',
  },
  {
    pattern: '.copilot/token', match: 'contains', reason: 'secret',
    restoreWith: 'copilot  (sign in on first run)',
    why: 'Copilot CLI token files.',
  },
  {
    pattern: '.agentistics/connections', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop member connect <url> <token>',
    why: 'Per-central member tokens. team-tokens.ts stores only hashes centrally; this is the token itself.',
  },
  {
    pattern: '.agentistics/machine-key', match: 'prefix', reason: 'secret',
    restoreWith: 'nothing — siblings re-pin this machine on its next announcement',
    why: 'The X25519 private key behind the sealed envelope channel (envelope-keys.ts, 0600, never logged).',
  },
  // --- regenerable -----------------------------------------------------------------------------
  {
    pattern: '.agentistics/cache.db', match: 'prefix', reason: 'regenerable',
    why: 'Parse cache. Rebuilt on the next build; 2.3 MB on the reference machine.',
  },
  {
    pattern: '.agentistics/git-stats.db', match: 'prefix', reason: 'regenerable',
    why: 'Git stats cache, keyed on commit. Rebuilt by walking git again.',
  },
  {
    pattern: '.agentistics/agentop-server.log', match: 'prefix', reason: 'regenerable',
    why: 'Server log. 6.2 MB on the reference machine and true of a machine that no longer exists.',
  },
  {
    pattern: '.corrupt-', match: 'contains', reason: 'regenerable',
    why: 'Quarantined copies the registry wrote when it could not parse a file.',
  },
  {
    pattern: '.tmp-', match: 'contains', reason: 'regenerable',
    why: 'Half-written temp files from an interrupted atomic write.',
  },
  {
    pattern: '.claude/shell-snapshots', match: 'prefix', reason: 'regenerable',
    why: 'Shell snapshots, recreated per session.',
  },
  {
    pattern: '.claude/paste-cache', match: 'prefix', reason: 'regenerable',
    why: 'Paste cache.',
  },
  {
    pattern: '.claude/plugins/cache', match: 'prefix', reason: 'regenerable',
    why: 'Plugin cache, re-fetched from the marketplace.',
  },
  {
    pattern: '.claude/statsig', match: 'prefix', reason: 'regenerable',
    why: 'Feature-flag cache.',
  },
  // --- runtime ---------------------------------------------------------------------------------
  {
    pattern: '.agentistics/managed-sessions.json', match: 'prefix', reason: 'runtime',
    why: 'Names tmux sessions that will not exist on the new machine. Restoring it yields rows pointing at nothing.',
  },
  {
    pattern: '.agentistics/server-', match: 'prefix', reason: 'runtime',
    why: 'Port lock files held by a process on the old machine.',
  },
  {
    pattern: '.agentistics/events-producer.json', match: 'prefix', reason: 'runtime',
    why: 'The producer heartbeat — a pid on a machine that is gone.',
  },
]

/**
 * The raw directory each harness owns, $HOME-relative.
 *
 * A Record so the compiler requires an entry per HarnessId. Note that antigravity's dir is INSIDE
 * gemini's — `planSources` drops the nested one when both are selected, or tar would walk the same
 * bytes twice and the size accounting would double-count them.
 */
const RAW_DIR: Record<HarnessId, string> = {
  claude: '.claude',
  codex: '.codex',
  gemini: '.gemini',
  copilot: '.copilot',
  antigravity: '.gemini/antigravity-cli',
  kimi: '.kimi-code',
}

/** Cross-harness data. Always included: a backup without these restores metrics that no filter,
 *  tag, layout or billing basis can interpret. */
const ALWAYS: string[] = [
  '.agentistics/tags.json',
  '.agentistics/workflows',
  '.agentistics/preferences.json',
  '.agentistics/notifications.json',
  // Claude's deep aggregate. It is the only surviving source of pre-30-day totals once Claude
  // Code's own cleanup has run, and it is 24 KB.
  '.claude/stats-cache.json',
]

export interface PlanInput {
  layers: BackupLayer[]
  harnesses: HarnessId[]
}

export interface SourceEntry {
  /** $HOME-relative, no leading slash. */
  rel: string
  layer: BackupLayer
  /** null when the entry is cross-harness. */
  harness: HarnessId | null
}

/** The exclusion rule that covers `rel`, or null. First match wins. */
export function excludeFor(rel: string): ExcludeRule | null {
  for (const r of EXCLUDE_RULES) {
    if (r.match === 'contains') {
      if (rel.includes(r.pattern)) return r
    } else if (rel === r.pattern || rel.startsWith(r.pattern + '/') || rel.startsWith(r.pattern)) {
      return r
    }
  }
  return null
}

/** Every secret rule, for the sentence the restore prints. */
export function omittedSecrets(): ExcludeRule[] {
  return EXCLUDE_RULES.filter(r => r.reason === 'secret')
}

/** Is `rel` inside `parent` (or equal to it)? */
function within(rel: string, parent: string): boolean {
  return rel === parent || rel.startsWith(parent + '/')
}

/**
 * The sources a backup walks, deduplicated.
 *
 * `metrics` is added whatever the caller asked for. The harness selection scopes two things — the
 * consolidate dir and the raw dir — and nothing else: the cross-harness files are the vocabulary
 * the metrics are read in.
 */
export function planSources(input: PlanInput): SourceEntry[] {
  const layers = new Set<BackupLayer>([...input.layers, 'metrics'])
  // Order by HARNESS_ORDER so the walk, the sizes and the manifest all list harnesses the same way.
  const harnesses = HARNESS_ORDER.filter(h => input.harnesses.includes(h))
  const out: SourceEntry[] = []

  if (layers.has('metrics')) {
    for (const h of harnesses) out.push({ rel: `.agentistics/sessions/${h}`, layer: 'metrics', harness: h })
    for (const rel of ALWAYS) out.push({ rel, layer: 'metrics', harness: null })
  }
  if (layers.has('archive')) out.push({ rel: '.agentistics/archive', layer: 'archive', harness: null })
  if (layers.has('raw')) {
    for (const h of harnesses) out.push({ rel: RAW_DIR[h], layer: 'raw', harness: h })
  }

  // Drop an entry that lives inside another entry of the SAME layer. Cross-layer nesting does not
  // occur (metrics and raw never overlap), and collapsing across layers would lose the layer label.
  const kept = out.filter((e, i) => !out.some((o, j) =>
    j !== i && o.layer === e.layer && o.rel !== e.rel && within(e.rel, o.rel)))

  const seen = new Set<string>()
  return kept.filter(e => {
    const key = `${e.layer}:${e.rel}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/backup-plan.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/backup-plan.ts packages/server/server/backup/backup-plan.test.ts
git commit -m "feat(backup): a tabela do que entra no backup, com um motivo por linha

Credenciais saem por decisão e são NOMEADAS no restore com o comando que as
restabelece; caches e arquivos de runtime saem porque são falsos na máquina
nova. Um teste faz grep no próprio módulo e re-testa cada caminho de segredo,
então uma regra apagada num refactor quebra o build em vez de virar vazamento."
```

---

## Task 2: `backup-size.ts` — measured, never estimated

**Files:**
- Create: `packages/server/server/backup/backup-size.ts`
- Test: `packages/server/server/backup/backup-size.test.ts`

**Interfaces:**
- Consumes: `BackupLayer`, `BACKUP_LAYERS` (Task 1); `HarnessId`, `HARNESS_ORDER`.
- Produces: `LayerSize`, `BackupSizes`, `emptySizes()`, `addBytes(sizes, layer, harness, bytes)`, `layerTotal(sizes, layer)`, `plannedTotal(sizes, layers)`, `harnessTotal(sizes, harness)`, `formatBytes(n)`, `retainedTotal(records)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/backup-size.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  addBytes, emptySizes, formatBytes, harnessTotal, layerTotal, plannedTotal, retainedTotal,
} from './backup-size'

test('an empty accounting has every layer at zero, and no layer is missing', () => {
  const s = emptySizes()
  expect(layerTotal(s, 'metrics')).toBe(0)
  expect(layerTotal(s, 'repos')).toBe(0)
  expect(layerTotal(s, 'archive')).toBe(0)
  expect(layerTotal(s, 'raw')).toBe(0)
})

test('bytes accumulate per layer and per harness', () => {
  const s = emptySizes()
  addBytes(s, 'metrics', 'claude', 3_400_000)
  addBytes(s, 'metrics', 'codex', 60_000)
  addBytes(s, 'raw', 'claude', 953_000_000)
  expect(layerTotal(s, 'metrics')).toBe(3_460_000)
  expect(s.metrics.byHarness.claude).toBe(3_400_000)
  expect(s.metrics.files).toBe(2)
  expect(harnessTotal(s, 'claude')).toBe(3_400_000 + 953_000_000)
})

test('cross-harness bytes count toward the layer but toward no harness', () => {
  const s = emptySizes()
  addBytes(s, 'metrics', null, 24_000)
  expect(layerTotal(s, 'metrics')).toBe(24_000)
  expect(harnessTotal(s, 'claude')).toBe(0)
})

test('the planned total counts only the layers being written', () => {
  const s = emptySizes()
  addBytes(s, 'metrics', 'claude', 100)
  addBytes(s, 'raw', 'claude', 900)
  expect(plannedTotal(s, ['metrics'])).toBe(100)
  expect(plannedTotal(s, ['metrics', 'raw'])).toBe(1000)
})

test('retention is accounted as one total across every kept backup', () => {
  expect(retainedTotal([
    { archiveBytes: 4_100_000 } as never,
    { archiveBytes: 4_050_000 } as never,
  ])).toBe(8_150_000)
  expect(retainedTotal([])).toBe(0)
})

test('formatBytes is readable and never lies about the unit', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(999)).toBe('999 B')
  expect(formatBytes(1024)).toBe('1.0 KB')
  expect(formatBytes(3_400_000)).toBe('3.2 MB')
  expect(formatBytes(2_400_000_000)).toBe('2.2 GB')
})

// The structural enforcement of the spec's rule 2. A compressed size cannot be predicted, only
// measured after the file exists — so this module must have no field, and no arithmetic, for one.
// An estimate that reads like a measurement is the same defect as a confident 0 for a metric
// nobody can produce.
test('this module never predicts a compressed size — asserted over its own source', () => {
  const src = readFileSync(join(import.meta.dir, 'backup-size.ts'), 'utf8')
  const body = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
  for (const forbidden of ['ratio', 'estimate', 'compressed', 'predict']) {
    expect(body.toLowerCase()).not.toContain(forbidden)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/backup-size.test.ts`
Expected: FAIL — `Cannot find module './backup-size'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/backup-size.ts`:

```ts
/**
 * backup-size.ts — PURE. What a backup weighs, measured.
 *
 * Three rules, and the third is the one with teeth.
 *
 * 1. **Per layer AND per harness.** The per-harness map is what lets a surface print a harness's
 *    own weight beside its own last-backup date. A single total at the top would let an unticked
 *    harness look covered.
 * 2. **Retention is a total.** 7 daily copies of the `raw` layer are 17 GB, and that has to be
 *    visible at the moment someone raises `keep N` or adds `raw` to a schedule — not afterwards.
 * 3. **Nothing here predicts a compressed size.** Compression depends on the bytes, and the bytes
 *    are only known once they are written; a ratio applied to a plan produces a figure that reads
 *    like a measurement and is not one. The compressed size exists in exactly one place —
 *    `BackupRecord.archiveBytes`, written after the archive exists. `backup-size.test.ts` asserts
 *    this over the module's own source, so the rule survives a refactor that finds it inconvenient.
 */
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { BACKUP_LAYERS, type BackupLayer } from './backup-plan'

export interface LayerSize {
  bytes: number
  files: number
  /** Bytes attributable to one harness. Cross-harness bytes are in `bytes` and in no entry here. */
  byHarness: Partial<Record<HarnessId, number>>
}

export type BackupSizes = Record<BackupLayer, LayerSize>

export function emptySizes(): BackupSizes {
  const out = {} as BackupSizes
  for (const l of BACKUP_LAYERS) out[l] = { bytes: 0, files: 0, byHarness: {} }
  return out
}

/** Add one measured file. `harness` is null for cross-harness data. Mutates, because this is
 *  called once per file over a two-gigabyte walk. */
export function addBytes(
  sizes: BackupSizes, layer: BackupLayer, harness: HarnessId | null, bytes: number,
): void {
  const l = sizes[layer]
  l.bytes += bytes
  l.files += 1
  if (harness) l.byHarness[harness] = (l.byHarness[harness] ?? 0) + bytes
}

export function layerTotal(sizes: BackupSizes, layer: BackupLayer): number {
  return sizes[layer].bytes
}

/** The total of only the layers actually being written. */
export function plannedTotal(sizes: BackupSizes, layers: BackupLayer[]): number {
  return layers.reduce((n, l) => n + sizes[l].bytes, 0)
}

/** Everything one harness contributes, across every layer. */
export function harnessTotal(sizes: BackupSizes, harness: HarnessId): number {
  return BACKUP_LAYERS.reduce((n, l) => n + (sizes[l].byHarness[harness] ?? 0), 0)
}

/** Harnesses that contributed anything, in display order. */
export function harnessesPresent(sizes: BackupSizes): HarnessId[] {
  return HARNESS_ORDER.filter(h => harnessTotal(sizes, h) > 0)
}

/** What every retained backup occupies together. Takes the records' real file sizes. */
export function retainedTotal(records: { archiveBytes: number }[]): number {
  return records.reduce((n, r) => n + r.archiveBytes, 0)
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  let v = n
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${UNITS[i]}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/backup-size.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/backup-size.ts packages/server/server/backup/backup-size.test.ts
git commit -m "feat(backup): contabilidade de tamanho por camada e por harness, medida

Um total por harness é o que permite uma superfície mostrar o peso de cada um
ao lado da sua própria data de backup — um número único no topo faria um
harness desmarcado parecer coberto. E o módulo não tem campo nem aritmética
para tamanho comprimido: uma taxa aplicada a um plano produz um número que
parece medição e não é. O teste afirma isso sobre o próprio fonte."
```

---

## Task 3: `manifest.ts` — the archive's self-description

**Files:**
- Create: `packages/server/server/backup/manifest.ts`
- Test: `packages/server/server/backup/manifest.test.ts`

**Interfaces:**
- Consumes: `BackupLayer` (Task 1), `BackupSizes` (Task 2), `RepoEntry` (Task 4 — declare the import now; Task 4 creates it).
- Produces: `MANIFEST_VERSION`, `MANIFEST_NAME`, `BackupManifest`, `FileGroup`, `OmittedSecret`, `encodeManifest(m)`, `decodeManifest(text)` → `DecodedManifest`.

> **Ordering note:** this task imports `RepoEntry` from `./repo-manifest`, which Task 4 creates. Do Task 4 first if you prefer a green `tsc` at every step; the tests here do not exercise repo entries. If you do Task 3 first, `bun tsc --noEmit` will fail on the missing import until Task 4 lands — so **commit Task 3 and Task 4 together** in that case.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/manifest.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { emptySizes } from './backup-size'
import { MANIFEST_VERSION, decodeManifest, encodeManifest, type BackupManifest } from './manifest'

const sample = (): BackupManifest => ({
  version: MANIFEST_VERSION,
  createdAt: '2026-09-04T12:00:00.000Z',
  agentopVersion: '1.1.0',
  hostname: 'old-box',
  homeDir: '/home/mithrandir',
  platform: 'linux',
  layers: ['metrics', 'repos'],
  harnesses: ['claude', 'codex'],
  sizes: emptySizes(),
  groups: [{ name: 'metrics', files: 648, bytes: 3_700_000, sha256: 'a'.repeat(64) }],
  repos: [],
  omittedSecrets: [{ path: '.claude/.credentials.json', restoreWith: 'claude login' }],
})

test('a manifest survives a round trip unchanged', () => {
  const m = sample()
  const back = decodeManifest(encodeManifest(m))
  expect(back.ok).toBe(true)
  if (back.ok) expect(back.manifest).toEqual(m)
})

test('unreadable text is refused with a reason, never thrown', () => {
  const r = decodeManifest('{not json')
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('unreadable')
})

// A backup written by a NEWER agentop may carry layers or repo fields this build cannot honour.
// Refusing is the honest answer; restoring the parts we recognise and silently dropping the rest
// would produce a machine that looks restored and is not.
test('a newer manifest version is refused, naming the version', () => {
  const raw = JSON.parse(encodeManifest(sample()))
  raw.version = MANIFEST_VERSION + 1
  const r = decodeManifest(JSON.stringify(raw))
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.reason).toBe('too-new')
    expect(r.found).toBe(MANIFEST_VERSION + 1)
  }
})

test('a manifest missing a required field is refused, not half-read', () => {
  const raw = JSON.parse(encodeManifest(sample()))
  delete raw.homeDir
  const r = decodeManifest(JSON.stringify(raw))
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('incomplete')
})

// A key that is PRESENT but the wrong type is the half-read this function exists to refuse. Each
// of these passed the presence check and came back inside an `ok` manifest before `shapeOk`.
test('a required field present but the wrong type is refused, not cast', () => {
  for (const [key, bad] of [
    ['layers', 'not-an-array'],
    ['harnesses', 42],
    ['groups', { name: 'metrics' }],
    ['sizes', null],
    ['homeDir', { toString: 'nope' }],
    ['createdAt', 1_700_000_000],
  ] as [string, unknown][]) {
    const raw = JSON.parse(encodeManifest(sample())) as Record<string, unknown>
    raw[key] = bad
    const r = decodeManifest(JSON.stringify(raw))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('incomplete')
  }
})

test('an optional array that is present but not an array is refused', () => {
  const raw = JSON.parse(encodeManifest(sample())) as Record<string, unknown>
  raw.repos = 'nope'
  const r = decodeManifest(JSON.stringify(raw))
  expect(r.ok).toBe(false)
})

// Structure is validated, contents are NOT: a layer name or harness id this build does not know
// must still decode, because the VERSION gate is what guards meaning. Refusing on contents would
// stop an older build reading a manifest it is entitled to read.
test('an unknown layer name still decodes — the version gate guards meaning, not this', () => {
  const raw = JSON.parse(encodeManifest(sample())) as Record<string, unknown>
  raw.layers = ['metrics', 'something-new']
  expect(decodeManifest(JSON.stringify(raw)).ok).toBe(true)
})

test('an older manifest still reads — absent optional arrays become empty', () => {
  const raw = JSON.parse(encodeManifest(sample()))
  delete raw.repos
  delete raw.omittedSecrets
  const r = decodeManifest(JSON.stringify(raw))
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.manifest.repos).toEqual([])
    expect(r.manifest.omittedSecrets).toEqual([])
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/manifest.test.ts`
Expected: FAIL — `Cannot find module './manifest'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/manifest.ts`:

```ts
/**
 * manifest.ts — PURE. The document an archive carries about itself.
 *
 * It answers three questions a restore cannot answer any other way: WHICH layers are in here (so
 * "the archive layer is absent" is distinguishable from "there were no transcripts"), WHAT the old
 * $HOME was (so a different username on the new machine is a deterministic substitution rather
 * than a guess), and WHETHER the bytes arrived intact (`groups[].sha256`, checked before anything
 * is written).
 *
 * `decodeManifest` never throws and never half-reads. A manifest from a NEWER agentop is REFUSED
 * naming the version: it may describe layers or repo fields this build cannot honour, and
 * restoring the parts we recognise while dropping the rest produces a machine that looks restored
 * and is not. An OLDER one reads, with absent optional arrays becoming empty — the same tolerance
 * `fromBsonDate` applies to a mixed-version fleet.
 */
import type { HarnessId } from '@agentistics/core'
import type { BackupLayer } from './backup-plan'
import type { BackupSizes } from './backup-size'
import type { RepoEntry } from './repo-manifest'

export const MANIFEST_VERSION = 1

/** The manifest's path inside the archive. Outside the $HOME-relative tree so it can never collide
 *  with a real dotfile. */
export const MANIFEST_NAME = 'agentistics-backup.json'

export interface FileGroup {
  name: string
  files: number
  bytes: number
  /** sha256 over the group's concatenated file list and contents, as written. */
  sha256: string
}

export interface OmittedSecret {
  path: string
  restoreWith: string
}

export interface BackupManifest {
  version: number
  createdAt: string
  agentopVersion: string
  hostname: string
  /** The $HOME this backup was taken from. Restore rewrites this prefix only when it differs. */
  homeDir: string
  platform: string
  layers: BackupLayer[]
  harnesses: HarnessId[]
  sizes: BackupSizes
  groups: FileGroup[]
  repos: RepoEntry[]
  omittedSecrets: OmittedSecret[]
}

export type DecodedManifest =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; reason: 'unreadable' | 'too-new' | 'incomplete'; found?: number }

export function encodeManifest(m: BackupManifest): string {
  return JSON.stringify(m, null, 2)
}

const REQUIRED = ['version', 'createdAt', 'homeDir', 'layers', 'harnesses', 'sizes', 'groups'] as const

/**
 * Present AND well-shaped.
 *
 * A presence check alone is exactly the half-read this function promises never to perform: a
 * `layers` that is a string passes it, gets cast, and comes back inside an `ok` manifest — where
 * the caller iterates its CHARACTERS as layer names. A `sizes` of `null` comes back as `null` under
 * a type that says it cannot be. The archive came off physical media somebody carried, so
 * structural corruption is a case rather than a hypothesis, and `ok` has to mean the shape is
 * usable, not merely that the keys were there.
 *
 * This validates STRUCTURE, not contents: an unknown layer name or a harness id this build does not
 * know still decodes, because the version gate above is what guards meaning. Rejecting on contents
 * would refuse manifests an older build should still be able to read.
 */
function shapeOk(raw: Record<string, unknown>): boolean {
  if (typeof raw.createdAt !== 'string' || typeof raw.homeDir !== 'string') return false
  if (!Array.isArray(raw.layers) || !Array.isArray(raw.harnesses) || !Array.isArray(raw.groups)) return false
  // The optional arrays may be ABSENT (an older manifest) but never present and not an array.
  if (raw.repos !== undefined && !Array.isArray(raw.repos)) return false
  if (raw.omittedSecrets !== undefined && !Array.isArray(raw.omittedSecrets)) return false
  const sizes = raw.sizes
  return typeof sizes === 'object' && sizes !== null && !Array.isArray(sizes)
}

export function decodeManifest(text: string): DecodedManifest {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'unreadable' }

  const version = raw.version
  if (typeof version !== 'number') return { ok: false, reason: 'incomplete' }
  if (version > MANIFEST_VERSION) return { ok: false, reason: 'too-new', found: version }

  for (const key of REQUIRED) {
    if (raw[key] === undefined || raw[key] === null) return { ok: false, reason: 'incomplete' }
  }
  if (!shapeOk(raw)) return { ok: false, reason: 'incomplete' }

  const manifest: BackupManifest = {
    version,
    createdAt: raw.createdAt as string,
    agentopVersion: typeof raw.agentopVersion === 'string' ? raw.agentopVersion : '',
    hostname: typeof raw.hostname === 'string' ? raw.hostname : '',
    homeDir: raw.homeDir as string,
    platform: String(raw.platform ?? ''),
    layers: raw.layers as BackupLayer[],
    harnesses: raw.harnesses as HarnessId[],
    sizes: raw.sizes as BackupSizes,
    groups: raw.groups as FileGroup[],
    repos: (raw.repos as RepoEntry[] | undefined) ?? [],
    omittedSecrets: (raw.omittedSecrets as OmittedSecret[] | undefined) ?? [],
  }
  return { ok: true, manifest }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/manifest.test.ts`
Expected: PASS — 5 tests. (If `tsc` complains about `./repo-manifest`, do Task 4 and commit both together.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/manifest.ts packages/server/server/backup/manifest.test.ts
git commit -m "feat(backup): o manifesto — o que o arquivo diz sobre si mesmo

Guarda quais camadas existem, qual era o \$HOME antigo e o sha256 por grupo,
checado antes de qualquer escrita. Um manifesto de um agentop MAIS NOVO é
recusado nomeando a versão: restaurar as partes reconhecidas e descartar o
resto produz uma máquina que parece restaurada e não está."
```

---

## Task 4: `repo-manifest.ts` — from git facts to a rebuildable repository

**Files:**
- Create: `packages/server/server/backup/repo-manifest.ts`
- Test: `packages/server/server/backup/repo-manifest.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure and standalone).
- Produces: `RepoNote`, `RepoWorktree`, `RepoDirty`, `RepoEntry`, `DirFacts`, `groupRepos(facts, homeDir)`, `restoreArgv(entry, homeDir)`, `restoreCommands(entry, homeDir)`, `homeRelative(path, homeDir)`, `expandHome(path, homeDir)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/repo-manifest.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { expandHome, groupRepos, homeRelative, restoreArgv, restoreCommands, type DirFacts } from './repo-manifest'

const HOME = '/home/u'

const facts = (over: Partial<DirFacts> & { path: string }): DirFacts => ({
  exists: true, commonDir: null, topLevel: null, cloneUrl: '', remote: '', branch: '', head: '',
  ...over,
})

const mainRepo = (path: string, url = 'git@github.com:org/repo.git'): DirFacts => facts({
  path, commonDir: `${path}/.git`, topLevel: path, cloneUrl: url,
  remote: 'github.com/org/repo', branch: 'main', head: 'a1b2c3d',
})

test('a plain checkout becomes one entry with no worktrees', () => {
  const [e] = groupRepos([mainRepo(`${HOME}/proj`)], HOME)
  expect(e!.key).toBe('github.com/org/repo')
  expect(e!.mainPath).toBe('~/proj')
  expect(e!.mainBranch).toBe('main')
  expect(e!.worktrees).toEqual([])
  expect(e!.note).toBeNull()
})

// The only thing a worktree provably shares with its main checkout is the git COMMON DIR. Grouping
// by remote would merge two unrelated clones of the same repo; grouping by path prefix breaks the
// moment a worktree lives outside its checkout.
test('a worktree groups under its main checkout, by common dir', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: `${HOME}/proj/.claude/worktrees/feat`, commonDir: `${HOME}/proj/.git`,
    topLevel: `${HOME}/proj/.claude/worktrees/feat`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'feat/x', head: 'deadbee',
  })
  const entries = groupRepos([wt, main], HOME)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.mainPath).toBe('~/proj')
  expect(entries[0]!.worktrees).toEqual([
    { path: '~/proj/.claude/worktrees/feat', branch: 'feat/x', head: 'deadbee' },
  ])
})

test('a worktree living outside its checkout still groups with it', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: '/tmp/elsewhere', commonDir: `${HOME}/proj/.git`, topLevel: '/tmp/elsewhere',
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'wip', head: 'f00',
  })
  const entries = groupRepos([main, wt], HOME)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.worktrees[0]!.path).toBe('/tmp/elsewhere')
})

test('two clones of the same repo stay two entries', () => {
  const entries = groupRepos([mainRepo(`${HOME}/a`), mainRepo(`${HOME}/b`)], HOME)
  expect(entries).toHaveLength(2)
  expect(entries.map(e => e.mainPath).sort()).toEqual(['~/a', '~/b'])
})

test('a directory that no longer exists is `gone` and is never asked of git', () => {
  const [e] = groupRepos([facts({ path: `${HOME}/deleted`, exists: false })], HOME)
  expect(e!.note).toBe('gone')
  expect(restoreCommands(e!, HOME)).toEqual([])
})

test('an existing directory that is not a repo says so', () => {
  const [e] = groupRepos([facts({ path: `${HOME}/notes` })], HOME)
  expect(e!.note).toBe('not-a-repo')
  expect(restoreCommands(e!, HOME)).toEqual([])
})

test('a repo with no remote is `no-remote` — there is nothing to clone from', () => {
  const [e] = groupRepos([facts({
    path: `${HOME}/local`, commonDir: `${HOME}/local/.git`, topLevel: `${HOME}/local`,
    branch: 'main', head: 'abc',
  })], HOME)
  expect(e!.note).toBe('no-remote')
  expect(e!.key).toBe(`${HOME}/local/.git`)
})

// The bug this module exists to prevent, and which it shipped for one review cycle. A bare
// repository with worktrees hanging off it reports a common dir that is not `<tree>/.git`; the old
// code left mainDir as that raw string, matched no member, and elected members[0] — so a worktree
// became "main" and the restore would rebuild the real checkout as a worktree of itself.
test('a layout that names no working tree is refused, never resolved by array order', () => {
  const bare = `${HOME}/proj.git`
  const wt = (path: string, branch: string): DirFacts => facts({
    path, commonDir: bare, topLevel: path,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo', branch, head: 'abc',
  })
  const [e] = groupRepos([wt(`${HOME}/proj/main`, 'main'), wt(`${HOME}/proj/feat`, 'feat')], HOME)
  expect(e!.note).toBe('no-main-checkout')
  expect(e!.mainPath).toBe('~/proj.git')
  expect(e!.worktrees.map(w => w.path)).toEqual(['~/proj/main', '~/proj/feat'])
  // Nothing runs: an elected worktree would clone over a real checkout.
  expect(restoreArgv(e!, HOME)).toEqual([])
})

// git refuses one branch checked out in two trees, so borrowing a worktree's branch for the
// unprobed main checkout would make `checkout` succeed and the matching `worktree add` fail.
test('an unprobed main checkout keeps its branch UNKNOWN, and every member stays a worktree', () => {
  const wt = facts({
    path: `${HOME}/proj/.worktrees/feat`, commonDir: `${HOME}/proj/.git`,
    topLevel: `${HOME}/proj/.worktrees/feat`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'feat/x', head: 'dead',
  })
  const [e] = groupRepos([wt], HOME)
  expect(e!.mainPath).toBe('~/proj')
  expect(e!.mainBranch).toBe('')
  expect(e!.worktrees).toHaveLength(1)
  const argv = restoreArgv(e!, HOME)
  expect(argv.some(a => a.includes('checkout'))).toBe(false)
  expect(argv.some(a => a.includes('worktree'))).toBe(true)
})

test('outside $HOME outranks no-remote — the stronger statement, and it saves a wasted bundle', () => {
  const [e] = groupRepos([facts({
    path: '/tmp/scratch', commonDir: '/tmp/scratch/.git', topLevel: '/tmp/scratch',
    branch: 'main', head: 'abc',
  })], HOME)
  expect(e!.note).toBe('outside-home')
})

test('a path outside $HOME is recorded and never restored', () => {
  const [e] = groupRepos([mainRepo('/tmp/scratch')], HOME)
  expect(e!.note).toBe('outside-home')
  expect(restoreCommands(e!, HOME)).toEqual([])
})

test('restoreCommands rebuilds clone, bundle, branch, worktrees and patches, in that order', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: `${HOME}/proj/wt`, commonDir: `${HOME}/proj/.git`, topLevel: `${HOME}/proj/wt`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'feat/x', head: 'dead',
  })
  const [e] = groupRepos([main, wt], HOME)
  e!.bundle = 'repos/github.com_org_repo.bundle'
  e!.dirty = [{ path: '~/proj', patch: 'repos/github.com_org_repo__main.patch', untracked: [] }]

  expect(restoreCommands(e!, '/home/new')).toEqual([
    'git clone git@github.com:org/repo.git /home/new/proj',
    'git -C /home/new/proj fetch repos/github.com_org_repo.bundle refs/heads/*:refs/heads/*',
    'git -C /home/new/proj checkout main',
    'git -C /home/new/proj worktree add /home/new/proj/wt feat/x',
    'git -C /home/new/proj apply repos/github.com_org_repo__main.patch',
  ])
})

// Display and execution come from ONE source, in two shapes. A path with a space cannot be
// recovered from a joined string, and joining then re-splitting is how a shell injection or a
// silently wrong argv gets in.
test('restoreArgv is the same plan as structured argv, and survives a path with a space', () => {
  const [e] = groupRepos([mainRepo('/home/u/my projects/app')], HOME)
  const argv = restoreArgv(e!, '/home/u')
  expect(argv[0]).toEqual(['git', 'clone', 'git@github.com:org/repo.git', '/home/u/my projects/app'])
  // The printable form is the same plan, joined for a human to read.
  expect(restoreCommands(e!, '/home/u')[0]).toBe('git clone git@github.com:org/repo.git /home/u/my projects/app')
  expect(restoreCommands(e!, '/home/u')).toHaveLength(argv.length)
})

// A bundle and a patch are paths INSIDE the archive. Printed in the plan they stay archive-
// relative (that is what a reader can locate); executed, they must resolve to where the archive
// was actually extracted, or `git fetch` is handed a path that does not exist.
test('an assetDir resolves the bundle and patch paths, and its absence leaves them archive-relative', () => {
  const [e] = groupRepos([mainRepo(`${HOME}/proj`)], HOME)
  e!.bundle = 'repos/github.com_org_repo.bundle'
  e!.dirty = [{ path: '~/proj', patch: 'repos/github.com_org_repo__main.patch', untracked: [] }]

  const bare = restoreArgv(e!, HOME)
  expect(bare[1]).toEqual(['git', '-C', '/home/u/proj', 'fetch', 'repos/github.com_org_repo.bundle', 'refs/heads/*:refs/heads/*'])

  const staged = restoreArgv(e!, HOME, '/stage')
  expect(staged[1]).toEqual(['git', '-C', '/home/u/proj', 'fetch', '/stage/repos/github.com_org_repo.bundle', 'refs/heads/*:refs/heads/*'])
  expect(staged[staged.length - 1]).toEqual(['git', '-C', '/home/u/proj', 'apply', '/stage/repos/github.com_org_repo__main.patch'])
})

test('a repo whose bundle exceeded the ceiling is `too-large` and clones without one', () => {
  const [e] = groupRepos([mainRepo(`${HOME}/big`)], HOME)
  e!.note = 'too-large'
  expect(restoreCommands(e!, HOME)).toEqual([
    'git clone git@github.com:org/repo.git /home/u/big',
    'git -C /home/u/big checkout main',
  ])
})

test('home paths round-trip, and a path outside home is left absolute', () => {
  expect(homeRelative('/home/u/proj', HOME)).toBe('~/proj')
  expect(homeRelative('/tmp/x', HOME)).toBe('/tmp/x')
  expect(expandHome('~/proj', '/home/new')).toBe('/home/new/proj')
  expect(expandHome('/tmp/x', '/home/new')).toBe('/tmp/x')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/repo-manifest.test.ts`
Expected: FAIL — `Cannot find module './repo-manifest'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/repo-manifest.ts`:

```ts
/**
 * repo-manifest.ts — PURE. From what git said about a directory to a repository that can be rebuilt.
 *
 * ## Grouped by the git COMMON DIR, and only by that
 *
 * The hard part is not listing repositories, it is knowing that 218 directories are really 89.
 * Three candidate keys, and two of them are wrong:
 *
 *  - by REMOTE — merges two independent clones of the same repository into one entry, and then the
 *    restore rebuilds one of them and silently drops the other;
 *  - by PATH PREFIX — breaks the moment a worktree lives outside its checkout, which `git worktree
 *    add /tmp/x` does routinely;
 *  - by COMMON DIR — exact. A worktree's `--git-common-dir` IS its main checkout's `.git`. That is
 *    the one thing they provably share, which is the same reasoning `repo-facts.ts` records when it
 *    refuses `--show-toplevel` as a key.
 *
 * ## Four notes, each of which means "there is nothing to clone"
 *
 * `gone` (the directory no longer exists), `not-a-repo` (it exists and git does not know it),
 * `no-remote` (a real repository with nowhere to clone from — its history can only travel as a full
 * bundle), `outside-home` (recorded so the report is complete; `/tmp` is not a place to put a
 * repository back). A directory that is GONE is not a directory outside a repository, and the
 * discriminator is whether it EXISTS, never whether git answered — the same distinction
 * `repo-facts.ts` exists to make.
 *
 * `restoreCommands` is the reverse direction and lives here so the plan a person reads and the
 * commands that run are the same function. A note means it emits nothing at all.
 */

export type RepoNote =
  | 'no-remote' | 'gone' | 'not-a-repo' | 'outside-home' | 'no-main-checkout' | 'too-large' | null

export interface RepoWorktree {
  /** `~`-prefixed when under $HOME, absolute otherwise. */
  path: string
  branch: string
  head: string
}

export interface RepoDirty {
  path: string
  /** Path INSIDE the archive (`repos/<key>__<dir>.patch`), or null when there is no patch. */
  patch: string | null
  /**
   * Set when the tree IS dirty and its diff could not be captured — too large for the buffer, too
   * slow for the timeout, or git refused. Carries the reason, and the restore prints it.
   *
   * This field exists because the alternative is the worst failure this module can have: a `patch`
   * of `null` used to mean both "clean" and "we could not look", so a working tree full of
   * uncommitted work was silently backed up as though it had none.
   */
  patchUnavailable?: string
  /**
   * Untracked file names — a LIST, never the contents.
   *
   * An untracked `.env`, `credentials.json` or service-account key sitting in a working tree is
   * exactly the class of file Task 1's exclusion table exists to keep out of the archive, and it
   * is invisible to that table because it lives under a repository path rather than a known
   * dotfile. Carrying the contents would smuggle back in through the repos layer precisely what
   * the secrets decision keeps out of the raw layer. The restore prints these by name so nothing
   * goes missing in silence.
   */
  untracked: string[]
}

export interface RepoEntry {
  /** The normalized remote, or the common dir when there is none. Stable across machines. */
  key: string
  /** The url as configured — what git actually needs, not the normalized form. */
  cloneUrl: string
  mainPath: string
  mainBranch: string
  worktrees: RepoWorktree[]
  /** Path inside the archive, or null. */
  bundle: string | null
  dirty: RepoDirty[]
  note: RepoNote
}

/** What one probe of one directory produced. All paths absolute. */
export interface DirFacts {
  path: string
  exists: boolean
  /** Absolute path of `git rev-parse --git-common-dir`, or null when git said nothing. */
  commonDir: string | null
  topLevel: string | null
  cloneUrl: string
  /** Normalized via normalizeGitRemote by the caller. '' when there is none. */
  remote: string
  branch: string
  head: string
}

export function homeRelative(path: string, homeDir: string): string {
  if (path === homeDir) return '~'
  return path.startsWith(homeDir + '/') ? '~' + path.slice(homeDir.length) : path
}

export function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  return path.startsWith('~/') ? homeDir + path.slice(1) : path
}

function isUnder(path: string, homeDir: string): boolean {
  return path === homeDir || path.startsWith(homeDir + '/')
}

/**
 * Turn a flat list of probed directories into repository entries.
 *
 * A directory whose `topLevel` equals `dirname(commonDir)` is the MAIN checkout; every other
 * directory sharing that common dir is one of its worktrees. A group with no main checkout among
 * the probed directories (the checkout itself was never a session cwd) promotes the common dir's
 * parent to `mainPath`, because that is where git will put it back.
 */
/**
 * The working tree a git common dir belongs to, or null when the layout does not name one.
 *
 * `<tree>/.git` is the ordinary case. It is NOT the only one: a BARE repository with worktrees
 * hanging off it (`~/proj.git` + `git worktree add ~/proj/main`) and a `--separate-git-dir`
 * checkout both report a common dir that is not `<tree>/.git`, and for a bare repository there is
 * genuinely no working tree to be found. Returning null for those is the whole point — the
 * alternative, which this module shipped for one review cycle, was to leave `mainDir` as the raw
 * common dir, match no member, and promote whichever directory happened to be FIRST in the array
 * to "main". That makes the restore clone into a worktree's path and rebuild the real checkout as
 * a worktree of itself.
 */
function mainTreeOf(commonDir: string): string | null {
  const suffix = '/.git'
  return commonDir.endsWith(suffix) ? commonDir.slice(0, -suffix.length) : null
}

export function groupRepos(facts: DirFacts[], homeDir: string): RepoEntry[] {
  const noted: RepoEntry[] = []
  const groups = new Map<string, DirFacts[]>()

  for (const f of facts) {
    if (!f.exists) {
      noted.push(bare(f, homeDir, 'gone'))
      continue
    }
    if (!f.commonDir || !f.topLevel) {
      noted.push(bare(f, homeDir, 'not-a-repo'))
      continue
    }
    const list = groups.get(f.commonDir) ?? []
    list.push(f)
    groups.set(f.commonDir, list)
  }

  const entries: RepoEntry[] = []
  for (const [commonDir, members] of groups) {
    const remote = members.find(m => m.remote)?.remote ?? ''
    const cloneUrl = members.find(m => m.cloneUrl)?.cloneUrl ?? ''
    const mainDir = mainTreeOf(commonDir)

    // No working tree can be named from this layout. Say so rather than electing one: every note
    // except `too-large` makes the restore skip the entry with a reason the user reads, and a
    // skipped repository costs a manual clone while a wrongly elected one corrupts a real checkout.
    if (!mainDir) {
      entries.push({
        key: remote || commonDir,
        cloneUrl,
        mainPath: homeRelative(commonDir, homeDir),
        mainBranch: '',
        worktrees: members.map(w => ({
          path: homeRelative(w.topLevel ?? w.path, homeDir),
          branch: w.branch,
          head: w.head,
        })),
        bundle: null,
        dirty: [],
        note: 'no-main-checkout',
      })
      continue
    }

    // The main checkout may simply never have been a session cwd, so it is absent from `members`.
    // That is fine — git puts it back at `mainDir` regardless — but its BRANCH is then unknown, and
    // it must stay unknown. Borrowing a worktree's branch would have the restore check that branch
    // out in the main checkout and then fail the `worktree add` for it: git refuses to have one
    // branch checked out in two trees. An empty `mainBranch` makes `restoreArgv` omit the checkout
    // step, and each worktree still adds its own branch.
    const main = members.find(m => m.topLevel === mainDir) ?? null
    const worktrees = main ? members.filter(m => m !== main) : members

    // `outside-home` is decided BEFORE `no-remote`: it is the stronger statement — this repository
    // will not be put back here whatever else is true of it — and deciding it first is what stops
    // the backup spending a full-history bundle on a remote-less repository in /tmp that no restore
    // will ever place.
    let note: RepoNote = null
    if (!isUnder(mainDir, homeDir)) note = 'outside-home'
    else if (!remote) note = 'no-remote'

    entries.push({
      key: remote || commonDir,
      cloneUrl,
      mainPath: homeRelative(mainDir, homeDir),
      mainBranch: main?.branch ?? '',
      worktrees: worktrees.map(w => ({
        path: homeRelative(w.topLevel ?? w.path, homeDir),
        branch: w.branch,
        head: w.head,
      })),
      bundle: null,
      dirty: [],
      note,
    })
  }
  return [...entries, ...noted]
}

function bare(f: DirFacts, homeDir: string, note: RepoNote): RepoEntry {
  return {
    key: f.path,
    cloneUrl: '',
    mainPath: homeRelative(f.path, homeDir),
    mainBranch: '',
    worktrees: [],
    bundle: null,
    dirty: [],
    note,
  }
}

/**
 * The exact commands that rebuild this entry under `homeDir`.
 *
 * Empty for every note except `too-large`, which is a real, cloneable repository whose local-only
 * history did not fit — it clones, and the report says what did not come with it. Returning the
 * commands rather than running them is what lets `agentop restore` print the plan before touching
 * anything.
 */
export function restoreArgv(entry: RepoEntry, homeDir: string, assetDir = ''): string[][] {
  if (entry.note && entry.note !== 'too-large') return []
  if (!entry.cloneUrl) return []

  const main = expandHome(entry.mainPath, homeDir)
  // `bundle` and `patch` are paths INSIDE the archive. At restore time they live under wherever
  // the archive was extracted, so the caller passes that directory; the plan printed BEFORE
  // extraction passes nothing and shows the archive-relative path, which is what a reader wants.
  const asset = (rel: string): string => (assetDir ? `${assetDir}/${rel}` : rel)
  const out: string[][] = [['git', 'clone', entry.cloneUrl, main]]

  // Fetch the bundle BEFORE checking out: the branch we want may only exist inside it.
  if (entry.bundle) out.push(['git', '-C', main, 'fetch', asset(entry.bundle), 'refs/heads/*:refs/heads/*'])
  if (entry.mainBranch) out.push(['git', '-C', main, 'checkout', entry.mainBranch])

  for (const w of entry.worktrees) {
    out.push(['git', '-C', main, 'worktree', 'add', expandHome(w.path, homeDir), w.branch])
  }
  for (const d of entry.dirty) {
    if (d.patch) out.push(['git', '-C', expandHome(d.path, homeDir), 'apply', asset(d.patch)])
  }
  return out
}

/**
 * The same plan, joined for a person to read.
 *
 * `restoreArgv` is what RUNS and `restoreCommands` is what PRINTS, from one source — because a
 * path containing a space cannot be recovered from a joined string, and joining then re-splitting
 * is how a wrong argv (or a shell) gets in. The printed form is for the human reading
 * `agentop restore`'s plan; nothing executes it.
 */
export function restoreCommands(entry: RepoEntry, homeDir: string, assetDir = ''): string[] {
  return restoreArgv(entry, homeDir, assetDir).map(a => a.join(' '))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/repo-manifest.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/repo-manifest.ts packages/server/server/backup/repo-manifest.test.ts
git commit -m "feat(backup): agrupa repositórios pelo git common dir, não pelo remote nem pelo caminho

Agrupar pelo remote funde dois clones independentes num só e o restore
reconstrói um e descarta o outro em silêncio; agrupar por prefixo de caminho
quebra na primeira worktree fora do checkout. O common dir é exato — é a mesma
razão que o repo-facts.ts registra ao recusar o --show-toplevel como chave.

restoreCommands é a direção inversa e mora aqui, para o plano que a pessoa lê
e os comandos que rodam serem a mesma função."
```

---

## Task 5: `backup-store.ts` — the history, and the backup that is not there

**Files:**
- Create: `packages/server/server/backup/backup-store.ts`
- Test: `packages/server/server/backup/backup-store.test.ts`

**Interfaces:**
- Consumes: `BackupLayer` (Task 1), `HarnessId`.
- Produces: `BACKUPS_FILE`, `BackupRecord`, `BackupHistoryEntry`, `markPresence(records, exists)`, `lastPerHarness(entries)`, `lastBackup(entries)`, `toPrune(entries, keep)`, `readBackups()`, `recordBackup(record)`.
- **There is deliberately no `writeBackups`** — see the module doc. Nothing ever rewrites this file.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/backup-store.test.ts`:

```ts
import { test, expect } from 'bun:test'
import {
  lastBackup, lastPerHarness, markPresence, toPrune, type BackupRecord,
} from './backup-store'

const rec = (over: Partial<BackupRecord> & { at: string; path: string }): BackupRecord => ({
  layers: ['metrics'], harnesses: ['claude'], bytesUncompressed: 1000, archiveBytes: 400,
  sha256: 'x'.repeat(64), durationMs: 100,
  ...over,
})

test('a record whose file is gone is marked absent, not dropped', () => {
  const out = markPresence(
    [rec({ at: '2026-09-01T00:00:00Z', path: '/b/one.tar.zst' })],
    p => p !== '/b/one.tar.zst',
  )
  expect(out).toHaveLength(1)
  expect(out[0]!.present).toBe(false)
})

// The rule the whole store exists for. A reassuring timestamp pointing at a file that does not
// exist is worse than no timestamp: it is the difference between knowing you are unprotected and
// believing you are covered.
test('the last backup ignores records whose file is gone', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/new.tar.zst' }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/old.tar.zst' }),
  ], p => p === '/b/old.tar.zst')
  expect(lastBackup(entries)?.at).toBe('2026-09-01T00:00:00Z')
})

test('with nothing present there is no last backup — never a stale date', () => {
  const entries = markPresence([rec({ at: '2026-09-03T00:00:00Z', path: '/b/x' })], () => false)
  expect(lastBackup(entries)).toBeNull()
})

test('last-backup is per harness, and a harness never backed up has none', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/a', harnesses: ['claude', 'codex'] }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/b', harnesses: ['claude'] }),
  ], () => true)
  const per = lastPerHarness(entries)
  expect(per.claude).toBe('2026-09-03T00:00:00Z')
  expect(per.codex).toBe('2026-09-03T00:00:00Z')
  expect(per.gemini).toBeUndefined()
})

test('a harness only in a backup whose file is gone counts as never backed up', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/a', harnesses: ['copilot'] }),
  ], () => false)
  expect(lastPerHarness(entries).copilot).toBeUndefined()
})

// The store is append-only and read back in file order, which is not necessarily sorted — a
// function that depended on its caller having sorted would go wrong the day one did not.
test('last-per-harness keeps the maximum, whatever order it is given', () => {
  const unsorted = [
    { ...rec({ at: '2026-09-01T00:00:00Z', path: '/b/1' }), present: true },
    { ...rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' }), present: true },
    { ...rec({ at: '2026-09-02T00:00:00Z', path: '/b/2' }), present: true },
  ]
  expect(lastPerHarness(unsorted).claude).toBe('2026-09-03T00:00:00Z')
})

test('pruning keeps the newest N present records and returns the rest', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/1' }),
    rec({ at: '2026-09-02T00:00:00Z', path: '/b/2' }),
  ], () => true)
  expect(toPrune(entries, 2).map(r => r.path)).toEqual(['/b/1'])
})

test('pruning never proposes deleting a file that is already gone', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/1' }),
  ], p => p === '/b/3')
  expect(toPrune(entries, 1)).toEqual([])
})

test('keep 0 or below prunes nothing — an accidental zero must not wipe the history', () => {
  const entries = markPresence([rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' })], () => true)
  expect(toPrune(entries, 0)).toEqual([])
  expect(toPrune(entries, -1)).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/backup-store.test.ts`
Expected: FAIL — `Cannot find module './backup-store'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/backup-store.ts`:

```ts
/**
 * backup-store.ts — the record of what has actually been backed up.
 *
 * The decisions are pure and take an `exists` predicate; only `readBackups` / `writeBackups` touch
 * the disk. That split is what lets the one rule this module exists for be tested without a
 * filesystem:
 *
 * **A recorded backup whose file is gone is not a backup.** The file lives on a pendrive, an
 * external disk, a directory someone tidied. `markPresence` marks it rather than dropping it (the
 * record is still the honest history), and `lastBackup` / `lastPerHarness` count only what is
 * present — so a machine whose only backup was deleted reads as never backed up, which is what it
 * is. A reassuring timestamp pointing at a file that does not exist is the difference between
 * knowing you are unprotected and believing you are covered.
 *
 * `toPrune` inherits it: it never proposes deleting a file that is already gone, and a `keep` of
 * zero or below prunes nothing — a config typo must not be a way to wipe every backup at once.
 */
import { dirname, join } from 'path'
import { appendFile, mkdir, readFile } from 'fs/promises'
import type { HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from '../config'
import type { BackupLayer } from './backup-plan'

/**
 * APPEND-ONLY, and `.jsonl` rather than `.json` because of it.
 *
 * The obvious shape — a JSON array, read-modify-written by `recordBackup` — is the registry race
 * `registry.ts` documents and this project has MEASURED: agentop runs as several processes (a
 * cockpit, the daemon, every one-shot command), and a record written by a short-lived one has been
 * observed erased by a longer-lived one. Here the loss is quiet and lands on exactly the question
 * this module exists to answer: the history would say you last backed up longer ago than you did.
 *
 * A lock would mitigate it. Appending removes it: one short line written with `O_APPEND` is atomic,
 * so two processes recording at once both survive with no coordination at all.
 *
 * Nothing rewrites the file, and that costs nothing, because the module already holds the rule that
 * makes rewriting unnecessary — a record whose file is gone is MARKED, not dropped. Pruning deletes
 * the FILES; the records stay, and `markPresence` reports them absent from then on. At roughly 200
 * bytes a record, a daily backup writes 73 KB a year.
 */
export const BACKUPS_FILE = join(AGENTISTICS_DATA_DIR, 'backups.jsonl')

export interface BackupRecord {
  /** ISO. */
  at: string
  path: string
  layers: BackupLayer[]
  harnesses: HarnessId[]
  /** What the sources weighed on disk. */
  bytesUncompressed: number
  /** The archive's REAL size, measured after writing. The only compressed figure in the system. */
  archiveBytes: number
  sha256: string
  durationMs: number
  /**
   * How many paths the walk skipped — a symlink it would not follow, or something it could not
   * read. A COUNT rather than the list, because the list is unbounded (a home directory can hold
   * thousands of symlinks) and this file is append-only history.
   *
   * It is here so `agentop backup status` can say a backup was incomplete. Absent on a record
   * written before the field existed, which reads as "not known", never as zero.
   */
  skipped?: number
}

export interface BackupHistoryEntry extends BackupRecord {
  present: boolean
}

/** Newest first, each marked with whether its file is still on disk. */
export function markPresence(
  records: BackupRecord[], exists: (path: string) => boolean,
): BackupHistoryEntry[] {
  return records
    .map(r => ({ ...r, present: exists(r.path) }))
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** The newest backup that is actually there, or null. */
export function lastBackup(entries: BackupHistoryEntry[]): BackupHistoryEntry | null {
  return entries.find(e => e.present) ?? null
}

/**
 * When each harness was last covered by a backup that still exists.
 *
 * Deliberately order-INDEPENDENT: it keeps the maximum rather than the first hit. `markPresence`
 * does sort, but a function whose answer depends on its caller having sorted is one that silently
 * becomes wrong the day some other caller does not.
 */
export function lastPerHarness(entries: BackupHistoryEntry[]): Partial<Record<HarnessId, string>> {
  const out: Partial<Record<HarnessId, string>> = {}
  for (const e of entries) {
    if (!e.present) continue
    for (const h of e.harnesses) {
      const seen = out[h]
      if (!seen || e.at > seen) out[h] = e.at
    }
  }
  return out
}

/** Records whose files should be deleted to honour `keep`. Never one that is already gone. */
export function toPrune(entries: BackupHistoryEntry[], keep: number): BackupHistoryEntry[] {
  if (keep <= 0) return []
  return entries.filter(e => e.present).slice(keep)
}

/**
 * Every recorded backup. A line that will not parse is SKIPPED, not thrown on: an append
 * interrupted by a crash or a full disk leaves a torn last line, and one bad line must not cost the
 * user every record before it.
 */
export async function readBackups(file = BACKUPS_FILE): Promise<BackupRecord[]> {
  const text = await readFile(file, 'utf-8').catch(() => '')
  const out: BackupRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as BackupRecord)
    } catch {
      // torn or hand-edited line — the records around it are still good
    }
  }
  return out
}

/** Append one record. Atomic by construction; see BACKUPS_FILE. */
export async function recordBackup(record: BackupRecord, file = BACKUPS_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(record) + '\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/backup-store.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/backup-store.ts packages/server/server/backup/backup-store.test.ts
git commit -m "feat(backup): um backup registrado cujo arquivo sumiu não é um backup

A data é conferida contra o disco antes de aparecer, e é por harness. Uma data
tranquilizadora apontando para um arquivo que não existe é a diferença entre
saber que você está desprotegido e acreditar que está coberto.

toPrune herda a regra: nunca propõe apagar o que já sumiu, e um keep zero não
apaga nada — um erro de configuração não pode ser um jeito de zerar tudo."
```

---

## Task 6: `schedule.ts` — is a run due, and what the UI may say

**Files:**
- Create: `packages/server/server/backup/schedule.ts`
- Test: `packages/server/server/backup/schedule.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ScheduleId`, `SCHEDULE_IDS`, `SCHEDULE_MS`, `ScheduleInput`, `ScheduleVerdict`, `ScheduleStatus`, `isDue(input)`, `scheduleStatus(input)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/schedule.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { isDue, scheduleStatus } from './schedule'

const DAY = 86_400_000
const now = Date.parse('2026-09-04T12:00:00.000Z')

test('a schedule that is off is never due', () => {
  expect(isDue({ schedule: 'off', lastAt: null, nowMs: now, serverRunning: true }).due).toBe(false)
})

test('a daily schedule with no previous run is due immediately', () => {
  const v = isDue({ schedule: 'daily', lastAt: null, nowMs: now, serverRunning: true })
  expect(v.due).toBe(true)
})

test('a daily schedule is not due before the interval elapses', () => {
  const v = isDue({
    schedule: 'daily', lastAt: new Date(now - DAY / 2).toISOString(), nowMs: now, serverRunning: true,
  })
  expect(v.due).toBe(false)
  if (!v.due) expect(v.reason).toBe('not-yet')
})

test('a daily schedule is due once the interval has elapsed', () => {
  const v = isDue({
    schedule: 'daily', lastAt: new Date(now - DAY - 1).toISOString(), nowMs: now, serverRunning: true,
  })
  expect(v.due).toBe(true)
})

test('weekly is seven days, not seven of anything else', () => {
  const base = { schedule: 'weekly' as const, nowMs: now, serverRunning: true }
  expect(isDue({ ...base, lastAt: new Date(now - 6 * DAY).toISOString() }).due).toBe(false)
  expect(isDue({ ...base, lastAt: new Date(now - 8 * DAY).toISOString() }).due).toBe(true)
})

test('an unparseable lastAt is treated as never run, not as now', () => {
  expect(isDue({ schedule: 'daily', lastAt: 'garbage', nowMs: now, serverRunning: true }).due).toBe(true)
})

// The rule the spec commits the UI to. Nothing here runs without the daemon, so a "next at 03:00"
// on a machine whose server is stopped is a promise the product cannot keep. Same N/A-versus-a-
// confident-0 discipline HARNESS_CAPABILITIES applies to metrics.
test('with the server stopped nothing is due and the status is `inactive`, with no next time', () => {
  const input = { schedule: 'daily' as const, lastAt: null, nowMs: now, serverRunning: false }
  expect(isDue(input).due).toBe(false)
  const s = scheduleStatus(input)
  expect(s.kind).toBe('inactive-no-server')
  expect(s.nextAtMs).toBeNull()
})

test('with the server running the status names the next time', () => {
  const s = scheduleStatus({
    schedule: 'daily', lastAt: new Date(now - DAY / 2).toISOString(), nowMs: now, serverRunning: true,
  })
  expect(s.kind).toBe('next')
  expect(s.nextAtMs).toBe(now + DAY / 2)
})

test('an off schedule reports off, not a missing next time', () => {
  expect(scheduleStatus({ schedule: 'off', lastAt: null, nowMs: now, serverRunning: true }).kind).toBe('off')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/schedule.test.ts`
Expected: FAIL — `Cannot find module './schedule'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/schedule.ts`:

```ts
/**
 * schedule.ts — PURE. Whether a scheduled backup is due, and what a surface is allowed to say.
 *
 * The scheduled run rides along with the daemon `agentop server` already starts — the argument
 * `events/daemon.ts` records, applied to a second job: it is the long-lived thing that already
 * exists, is already covered by `agentop autostart`, and is never a process the user has to
 * remember to start. A backup is not itself long-lived, so a system timer would also have worked;
 * riding along wins because it is ONE mechanism on every platform, and because the server is what
 * produces the metrics — stopped, there is nothing new to save.
 *
 * That choice has a cost, and `scheduleStatus` is where the product pays it honestly: with the
 * server stopped there is no next run, and the status says `inactive-no-server` rather than
 * printing a time that will not arrive. The same N/A-versus-a-confident-0 rule
 * `HARNESS_CAPABILITIES` applies to metrics, applied to a promise.
 */

export type ScheduleId = 'off' | 'daily' | 'weekly'

export const SCHEDULE_IDS: ScheduleId[] = ['off', 'daily', 'weekly']

const DAY_MS = 86_400_000

/** null = never fires. A Record so a new id cannot be added without giving it an interval. */
export const SCHEDULE_MS: Record<ScheduleId, number | null> = {
  off: null,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
}

export interface ScheduleInput {
  schedule: ScheduleId
  /** ISO of the last run, or null. Unparseable reads as never — a corrupt timestamp must not
   *  suppress backups forever, which is what treating it as "now" would do. */
  lastAt: string | null
  nowMs: number
  serverRunning: boolean
}

export type ScheduleVerdict =
  | { due: true }
  | { due: false; reason: 'off' | 'not-yet' | 'no-server' }

export type ScheduleStatus =
  | { kind: 'off'; nextAtMs: null }
  | { kind: 'inactive-no-server'; nextAtMs: null }
  | { kind: 'next'; nextAtMs: number }

function lastMs(lastAt: string | null): number | null {
  if (!lastAt) return null
  const t = Date.parse(lastAt)
  return Number.isFinite(t) ? t : null
}

export function isDue(input: ScheduleInput): ScheduleVerdict {
  const every = SCHEDULE_MS[input.schedule]
  if (every === null) return { due: false, reason: 'off' }
  if (!input.serverRunning) return { due: false, reason: 'no-server' }
  const last = lastMs(input.lastAt)
  if (last === null) return { due: true }
  return input.nowMs - last >= every ? { due: true } : { due: false, reason: 'not-yet' }
}

export function scheduleStatus(input: ScheduleInput): ScheduleStatus {
  const every = SCHEDULE_MS[input.schedule]
  if (every === null) return { kind: 'off', nextAtMs: null }
  if (!input.serverRunning) return { kind: 'inactive-no-server', nextAtMs: null }
  const last = lastMs(input.lastAt)
  return { kind: 'next', nextAtMs: last === null ? input.nowMs : last + every }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/schedule.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/schedule.ts packages/server/server/backup/schedule.test.ts
git commit -m "feat(backup): a agenda, e o preço dela dito em voz alta

Pega carona no daemon que o agentop server já roda — um mecanismo em todas as
plataformas, e é o servidor que produz as métricas: parado, não há o que salvar.

O custo é que com o servidor parado nada roda, então o status diz 'inativa'
em vez de imprimir um horário que não vai chegar. Mesma disciplina do N/A
contra o 0 confiante."
```

---

## Task 7: `restore-plan.ts` — write, skip, clone, resume

**Files:**
- Create: `packages/server/server/backup/restore-plan.ts`
- Test: `packages/server/server/backup/restore-plan.test.ts`

**Interfaces:**
- Consumes: `RepoEntry`, `restoreCommands`, `expandHome` (Task 4).
- Produces: `RestoreAction`, `RepoStepState`, `RepoStep`, `RestoreState`, `StagedFile`, `planMetrics(staged, localMtime)`, `planRepos(entries, state, destExists, homeDir)`, `rewriteHome(text, oldHome, newHome)`, `emptyRestoreState()`, `remaining(steps)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/restore-plan.test.ts`:

```ts
import { test, expect } from 'bun:test'
import type { RepoEntry } from './repo-manifest'
import { planMetrics, planRepos, remaining, rewriteHome, type RestoreState } from './restore-plan'

const entry = (over: Partial<RepoEntry> & { key: string }): RepoEntry => ({
  cloneUrl: 'git@github.com:org/repo.git', mainPath: '~/proj', mainBranch: 'main',
  worktrees: [], bundle: null, dirty: [], note: null,
  ...over,
})

// --- metrics --------------------------------------------------------------------------------

test('a file the machine does not have is written', () => {
  const a = planMetrics([{ rel: '.agentistics/sessions/claude/a.json', mtimeMs: 100 }], new Map())
  expect(a).toEqual([{ kind: 'write', rel: '.agentistics/sessions/claude/a.json' }])
})

test('a file older than the local copy is skipped, naming why', () => {
  const local = new Map([['.agentistics/sessions/claude/a.json', 200]])
  const a = planMetrics([{ rel: '.agentistics/sessions/claude/a.json', mtimeMs: 100 }], local)
  expect(a).toEqual([{ kind: 'skip', rel: '.agentistics/sessions/claude/a.json', reason: 'newer-local' }])
})

test('a file newer than the local copy is written', () => {
  const local = new Map([['.agentistics/sessions/claude/a.json', 100]])
  const a = planMetrics([{ rel: '.agentistics/sessions/claude/a.json', mtimeMs: 200 }], local)
  expect(a[0]!.kind).toBe('write')
})

// Claude owns stats-cache.json and rewrites it. Ours goes where applyArchivedStats already reads
// it with per-field max, never additive — an existing rule reused rather than a new one invented.
test('stats-cache.json is redirected into the archive stats dir, never over Claude own', () => {
  const a = planMetrics([{ rel: '.claude/stats-cache.json', mtimeMs: 100 }], new Map())
  expect(a).toEqual([{
    kind: 'write',
    rel: '.claude/stats-cache.json',
    redirectTo: '.agentistics/archive/stats-cache/stats-cache.json',
  }])
})

// --- repos ----------------------------------------------------------------------------------

const fresh = (): RestoreState => ({ repos: {} })

test('a repo with nothing recorded is pending, and carries its commands', () => {
  const steps = planRepos([entry({ key: 'github.com/org/repo' })], fresh(), () => false, '/home/n')
  expect(steps[0]!.state).toBe('pending')
  expect(steps[0]!.commands[0]).toBe('git clone git@github.com:org/repo.git /home/n/proj')
})

test('a repo already done is not attempted again — this is what makes rerunning safe', () => {
  const state: RestoreState = { repos: { 'github.com/org/repo': { state: 'done' } } }
  const steps = planRepos([entry({ key: 'github.com/org/repo' })], state, () => false, '/home/n')
  expect(steps[0]!.state).toBe('done')
  expect(remaining(steps)).toHaveLength(0)
})

test('a repo that failed is retried on the next run', () => {
  const state: RestoreState = { repos: { 'github.com/org/repo': { state: 'failed', reason: 'auth' } } }
  const steps = planRepos([entry({ key: 'github.com/org/repo' })], state, () => false, '/home/n')
  expect(remaining(steps)).toHaveLength(1)
  expect(steps[0]!.previousFailure).toBe('auth')
})

test('a destination that already exists is skipped with a reason, never overwritten', () => {
  const steps = planRepos([entry({ key: 'github.com/org/repo' })], fresh(), () => true, '/home/n')
  expect(steps[0]!.state).toBe('skipped')
  expect(steps[0]!.reason).toBe('destination-exists')
  expect(steps[0]!.commands).toEqual([])
})

test('every note that cannot be cloned is skipped, and says which note', () => {
  for (const note of ['gone', 'not-a-repo', 'no-remote', 'outside-home'] as const) {
    const steps = planRepos([entry({ key: `k-${note}`, note })], fresh(), () => false, '/home/n')
    expect(steps[0]!.state).toBe('skipped')
    expect(steps[0]!.reason).toBe(note)
  }
})

test('too-large is NOT a skip — the repo clones, minus its local-only history', () => {
  const steps = planRepos([entry({ key: 'k', note: 'too-large' })], fresh(), () => false, '/home/n')
  expect(steps[0]!.state).toBe('pending')
  expect(steps[0]!.commands.length).toBeGreaterThan(0)
})

// --- $HOME rewrite --------------------------------------------------------------------------

test('the home prefix is rewritten when the two differ', () => {
  const j = '{"project_path":"/home/old/proj","current_cwd":"/home/old/proj/wt"}'
  expect(rewriteHome(j, '/home/old', '/home/new'))
    .toBe('{"project_path":"/home/new/proj","current_cwd":"/home/new/proj/wt"}')
})

test('an identical home is a no-op — the text is returned untouched', () => {
  const j = '{"project_path":"/home/same/proj"}'
  expect(rewriteHome(j, '/home/same', '/home/same')).toBe(j)
})

// /home/old must not match inside /home/older. A bare string replace does, and would corrupt
// every path of an unrelated user whose name starts the same way.
test('a home that is a prefix of another directory name is not rewritten', () => {
  const j = '{"a":"/home/older/proj","b":"/home/old/proj"}'
  expect(rewriteHome(j, '/home/old', '/home/new'))
    .toBe('{"a":"/home/older/proj","b":"/home/new/proj"}')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/restore-plan.test.ts`
Expected: FAIL — `Cannot find module './restore-plan'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/restore-plan.ts`:

```ts
/**
 * restore-plan.ts — PURE. What a restore would do, decided before anything is written.
 *
 * The whole point of computing this separately is that `agentop restore` can PRINT it. A restore
 * that starts working and reports afterwards gives the user no moment at which to say no.
 *
 * Four rules:
 *
 *  1. **A merge never overwrites something newer.** The same discipline `writeConsolidated`
 *     already applies. A machine that has been running for a week before someone remembers to
 *     restore must not lose that week.
 *  2. **`stats-cache.json` is never written over Claude's own.** Claude owns that file and rewrites
 *     it; ours is redirected into `ARCHIVE_STATS_DIR`, where `applyArchivedStats` already reads it
 *     with per-field `max`, never additive. An existing rule reused rather than a new one invented.
 *  3. **A destination that exists is skipped WITH A REASON.** Cloning over someone's work is the
 *     one failure a backup tool must never have.
 *  4. **The resume is by repo key, and only `done` and `skipped` stop a retry.** A `failed` repo is
 *     attempted again on the next run — that is what makes `agentop restore --repos` safe to run
 *     until it converges.
 */
import { expandHome, restoreArgv, restoreCommands, type RepoEntry, type RepoNote } from './repo-manifest'

/** Where a restored `stats-cache.json` actually lands. Mirrors `ARCHIVE_STATS_DIR` in config.ts;
 *  this module stays pure, so the path is expressed $HOME-relative here. */
export const STATS_REDIRECT = '.agentistics/archive/stats-cache/stats-cache.json'

export interface StagedFile {
  rel: string
  mtimeMs: number
}

export type RestoreAction =
  | { kind: 'write'; rel: string; redirectTo?: string }
  | { kind: 'skip'; rel: string; reason: 'newer-local' }

/**
 * Which staged files to write. `localMtime` maps a $HOME-relative path to the local file's mtime;
 * an absent key means the machine does not have it.
 */
export function planMetrics(staged: StagedFile[], localMtime: Map<string, number>): RestoreAction[] {
  return staged.map<RestoreAction>(f => {
    if (f.rel === '.claude/stats-cache.json') {
      return { kind: 'write', rel: f.rel, redirectTo: STATS_REDIRECT }
    }
    const local = localMtime.get(f.rel)
    if (local !== undefined && local > f.mtimeMs) {
      return { kind: 'skip', rel: f.rel, reason: 'newer-local' }
    }
    return { kind: 'write', rel: f.rel }
  })
}

export type RepoStepState = 'pending' | 'done' | 'skipped'

export interface RepoStep {
  key: string
  mainPath: string
  state: RepoStepState
  /** Why it is skipped, or why it was not attempted. */
  reason?: RepoNote | 'destination-exists'
  /** The reason recorded by a previous failed attempt, so the report can say what went wrong. */
  previousFailure?: string
  /** What RUNS — structured argv, never joined. */
  argv: string[][]
  /** What PRINTS — the same plan, joined. */
  commands: string[]
}

export interface RestoreState {
  repos: Record<string, { state: 'done' | 'failed' | 'skipped'; reason?: string }>
}

export function emptyRestoreState(): RestoreState {
  return { repos: {} }
}

export function planRepos(
  entries: RepoEntry[],
  state: RestoreState,
  destExists: (absPath: string) => boolean,
  homeDir: string,
  /** Where the archive was extracted. Empty while PRINTING a plan (nothing is extracted yet). */
  assetDir = '',
): RepoStep[] {
  return entries.map<RepoStep>(e => {
    const base = { key: e.key, mainPath: e.mainPath }
    const prior = state.repos[e.key]

    if (prior?.state === 'done') return { ...base, state: 'done', argv: [], commands: [] }
    if (prior?.state === 'skipped') {
      return { ...base, state: 'skipped', reason: e.note ?? undefined, argv: [], commands: [] }
    }

    // `too-large` is a real, cloneable repository; every other note means there is nothing to clone.
    if (e.note && e.note !== 'too-large') {
      return { ...base, state: 'skipped', reason: e.note, argv: [], commands: [] }
    }

    if (destExists(expandHome(e.mainPath, homeDir))) {
      return { ...base, state: 'skipped', reason: 'destination-exists', argv: [], commands: [] }
    }

    return {
      ...base,
      state: 'pending',
      previousFailure: prior?.state === 'failed' ? (prior.reason ?? 'unknown') : undefined,
      argv: restoreArgv(e, homeDir, assetDir),
      commands: restoreCommands(e, homeDir),   // printed form stays archive-relative
    }
  })
}

/** The steps a run would actually attempt. */
export function remaining(steps: RepoStep[]): RepoStep[] {
  return steps.filter(s => s.state === 'pending')
}

/**
 * Rewrite an old $HOME prefix to the new one inside a restored JSON document.
 *
 * A no-op when they are equal. The boundary check matters: a bare replace of `/home/old` also hits
 * `/home/older`, corrupting every path belonging to an unrelated user whose name starts the same
 * way. Only a path separator, a quote, or the end of the string may follow.
 */
export function rewriteHome(text: string, oldHome: string, newHome: string): string {
  if (oldHome === newHome || !oldHome) return text
  const escaped = oldHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`${escaped}(?=["/\\\\]|$)`, 'g'), newHome)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/restore-plan.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/restore-plan.ts packages/server/server/backup/restore-plan.test.ts
git commit -m "feat(backup): o plano do restore, decidido antes de escrever qualquer coisa

Existe separado para o agentop restore poder IMPRIMI-LO: um restore que começa
a trabalhar e relata depois não dá à pessoa nenhum momento para dizer não.

Merge nunca sobrescreve algo mais novo; stats-cache.json vai para o dir de
archive onde o applyArchivedStats já o lê com max por campo; destino existente
é pulado COM MOTIVO; e só done e skipped impedem uma nova tentativa, o que é o
que torna seguro rodar --repos até convergir."
```

---

## Task 8: `repo-probe.ts` — asking live git

**Files:**
- Create: `packages/server/server/backup/repo-probe.ts`
- Test: `packages/server/server/backup/repo-probe.test.ts`

**Interfaces:**
- Consumes: `DirFacts` (Task 4); `normalizeGitRemote` from `@agentistics/core`.
- Produces: `probeDir(path)`, `probeAll(paths, concurrency?)`, `createBundle(mainDir, out, opts)`, `capturePatch(dir)`, `listUntracked(dir)`, `candidatePaths(sessions)`.

> The repo store records `git_remote` on only 89 of 282 paths, which is a limitation of the store, not of reality. This module ignores the store's opinion and asks git, using the store only for the LIST of directories worth asking about. It never mocks the filesystem: the tests build a real git repository in a temp dir, because the thing under test is the interaction with git.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/repo-probe.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { candidatePaths, capturePatch, createBundle, listUntracked, probeDir } from './repo-probe'

let root = ''
let repo = ''
let wt = ''

// `cwd` is NOT enough, and this is not theoretical — it happened twice on this branch. Git fires a
// pre-commit hook with GIT_DIR / GIT_INDEX_FILE / GIT_PREFIX exported, and neither `cwd` nor `-C`
// overrides an inherited GIT_DIR. Run under husky from a linked worktree, `makeOrigin`'s `git init`
// and `git config user.email` below executed against the REAL SHARED repository: they rewrote this
// fleet's git identity and committed a fixture file onto the branch. `repo-probe.test.ts` carries
// the same guard for the same reason; GIT_COMMON_DIR is here too because it redirects
// --git-common-dir on its own (measured).
const git = (cwd: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[k]
  return execFileSync('git', args, { cwd, encoding: 'utf8', env })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentistics-probe-'))
  repo = join(root, 'proj')
  wt = join(root, 'wt')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'remote', 'add', 'origin', 'git@github.com:org/repo.git')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'one')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt)
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

test('a checkout reports its remote, branch, head, common dir and top level', async () => {
  const f = await probeDir(repo)
  expect(f.exists).toBe(true)
  expect(f.remote).toBe('github.com/org/repo')
  expect(f.cloneUrl).toBe('git@github.com:org/repo.git')
  expect(f.branch).toBe('main')
  expect(f.head).toMatch(/^[0-9a-f]{7,40}$/)
  expect(f.topLevel).toBe(repo)
  expect(f.commonDir).toBe(join(repo, '.git'))
})

// The exact fact groupRepos keys on. A worktree's common dir must be the MAIN checkout's .git,
// resolved to an absolute path — git prints a relative one from inside a worktree.
test('a worktree reports the MAIN checkout git dir as its common dir, absolute', async () => {
  const f = await probeDir(wt)
  expect(f.commonDir).toBe(join(repo, '.git'))
  expect(f.topLevel).toBe(wt)
  expect(f.branch).toBe('feat/x')
})

test('a directory that is not a repo reports exists with no common dir', async () => {
  const plain = join(root, 'plain')
  mkdirSync(plain)
  const f = await probeDir(plain)
  expect(f.exists).toBe(true)
  expect(f.commonDir).toBeNull()
})

// The discriminator is whether the directory EXISTS, never whether git answered. A removed
// worktree makes every `git -C` fail, and calling that "not a repo" invents a project.
test('a directory that does not exist reports exists:false and never runs git', async () => {
  const f = await probeDir(join(root, 'nope'))
  expect(f.exists).toBe(false)
  expect(f.commonDir).toBeNull()
})

test('a bundle of the unpushed history is written and is smaller than the full one', async () => {
  const partial = join(root, 'p.bundle')
  const full = join(root, 'f.bundle')
  expect(await createBundle(repo, partial, { full: false, maxBytes: 100_000_000 })).toBe('written')
  expect(await createBundle(repo, full, { full: true, maxBytes: 100_000_000 })).toBe('written')
  expect(statSync(partial).size).toBeGreaterThan(0)
})

// A ceiling that is enforced after writing would still have spent the disk. `too-large` deletes
// what it wrote and says so, so the caller can mark the repo and move on.
test('a bundle over the ceiling reports too-large and leaves no file behind', async () => {
  const out = join(root, 'huge.bundle')
  expect(await createBundle(repo, out, { full: true, maxBytes: 1 })).toBe('too-large')
  expect(() => statSync(out)).toThrow()
})

// `empty` means "every local commit is already on the remote" — a happy answer. A real failure
// wearing that answer tells the user their unpushed work was checked and found safe.
test('a bundle that genuinely FAILS is not reported as empty', async () => {
  const res = await createBundle(repo, '/proc/definitely/not/writable.bundle', {
    full: true, maxBytes: 100_000_000,
  })
  expect(res).toBe('failed')
})

test('a clean tree says clean; a dirty one carries the diff', async () => {
  expect(await capturePatch(repo)).toEqual({ kind: 'clean' })
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  const res = await capturePatch(repo)
  expect(res.kind).toBe('patch')
  if (res.kind === 'patch') {
    expect(res.text).toContain('-one')
    expect(res.text).toContain('+two')
  }
  git(repo, 'checkout', '--', 'a.txt')
})

// The failure this module exists to prevent, arriving in the reassuring direction: a tree we could
// not read must never be reported with the same value as a tree that had nothing in it.
test('a tree that cannot be read is `unavailable`, never `clean`', async () => {
  const res = await capturePatch(join(root, 'not-a-repo-at-all'))
  expect(res.kind).toBe('unavailable')
  if (res.kind === 'unavailable') expect(res.reason.length).toBeGreaterThan(0)
})

// Measured: GIT_COMMON_DIR alone, with no GIT_DIR set, redirects `rev-parse --git-common-dir` —
// the ONE fact groupRepos keys on. A backup run from inside a git hook inherits variables like it.
//
// This test only DISCRIMINATES because `gitEnv()` is rebuilt per call. An earlier version captured
// the environment once at module load, and this test then passed identically against a build with
// the strip reverted — it was measuring nothing. If you are tempted to hoist `gitEnv()` back to a
// module constant for performance, this test is what you would be switching off.
test('an inherited GIT_COMMON_DIR cannot redirect the probe', async () => {
  const other = join(root, 'other')
  mkdirSync(other)
  git(other, 'init', '-q', '-b', 'main')
  const saved = process.env.GIT_COMMON_DIR
  process.env.GIT_COMMON_DIR = join(other, '.git')
  try {
    const f = await probeDir(repo)
    expect(f.commonDir).toBe(join(repo, '.git'))
  } finally {
    if (saved === undefined) delete process.env.GIT_COMMON_DIR
    else process.env.GIT_COMMON_DIR = saved
  }
})

test('untracked files are listed, and ignored ones are not', async () => {
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
  writeFileSync(join(repo, 'ignored.txt'), 'x')
  writeFileSync(join(repo, 'new.txt'), 'y')
  const un = await listUntracked(repo)
  expect(un.kind).toBe('files')
  if (un.kind === 'files') {
    expect(un.files).toContain('new.txt')
    expect(un.files).not.toContain('ignored.txt')
  }
  rmSync(join(repo, '.gitignore'))
  rmSync(join(repo, 'ignored.txt'))
  rmSync(join(repo, 'new.txt'))
})

// The same failure class as capturePatch's: a tree whose untracked state could not be established
// must not read as a tree that had none, or `buildRepoManifest` skips the directory entirely.
test('a directory git cannot read is `unavailable`, never an empty list', async () => {
  const un = await listUntracked(join(root, 'not-a-repo-at-all'))
  expect(un.kind).toBe('unavailable')
  if (un.kind === 'unavailable') expect(un.reason.length).toBeGreaterThan(0)
})

// --- candidatePaths (pure) --------------------------------------------------------------------

test('candidate paths are deduped and prefer current_cwd over project_path', () => {
  const paths = candidatePaths([
    { project_path: '/a', current_cwd: '/a/wt' },
    { project_path: '/a', current_cwd: '/a/wt' },
    { project_path: '/b' },
  ])
  expect(paths.sort()).toEqual(['/a', '/a/wt', '/b'])
})

test('a session with no usable path contributes nothing', () => {
  expect(candidatePaths([{ project_path: '' }, {}])).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/repo-probe.test.ts`
Expected: FAIL — `Cannot find module './repo-probe'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/repo-probe.ts`:

```ts
/**
 * repo-probe.ts — IO. What live git says about the directories the store knows about.
 *
 * The consolidate store records `git_remote` on only 89 of 282 paths on the reference machine, and
 * that is a limitation of the STORE — the field is stamped where the Claude walk happened to
 * resolve it. So this module asks git, and uses the store only for the LIST of directories worth
 * asking about.
 *
 * Two rules carried over from `repo-facts.ts`, both of which were bugs there first:
 *
 *  - **A directory that is GONE is not a directory outside a repository.** The discriminator is
 *    whether it EXISTS, never whether git answered. `ExitWorktree --remove` leaves a session
 *    registered at a path that names nothing, every `git -C` fails, and calling that "not a repo"
 *    invents a project standing beside the real one.
 *  - **`--git-common-dir` is the key, and it must be absolutised.** Run inside a worktree, git
 *    prints it RELATIVE to that worktree; left relative, two worktrees of one checkout produce two
 *    different keys and the grouping silently fails.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { unlink } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { normalizeGitRemote } from '@agentistics/core'
import { createLimiter } from '../utils'
import type { DirFacts } from './repo-manifest'

const run = promisify(execFile)

/**
 * The environment every git child gets.
 *
 * Two jobs. It never lets git PROMPT — a credential prompt inside a backup hangs the whole run.
 * And it REMOVES the variables that would make `-C` a lie.
 *
 * `git -C <path>` does NOT override an inherited `GIT_DIR`, and a hook is exactly where one is
 * inherited: git fires `pre-commit` with `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_PREFIX` exported, so
 * a backup invoked from a hook would probe every directory against the HOOK's repository.
 * `GIT_COMMON_DIR` is in the list for a sharper reason — measured: on its own, with no `GIT_DIR`
 * set, it silently redirects `rev-parse --git-common-dir`, which is the ONE fact `groupRepos` keys
 * on. (`GIT_OBJECT_DIRECTORY`, `GIT_NAMESPACE` and `GIT_CEILING_DIRECTORIES` were measured too and
 * do not redirect it; they are left alone rather than cargo-culted into the list.)
 */
const HIJACKERS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR'] as const

/**
 * Built PER CALL, deliberately, not captured once at module load.
 *
 * A module-load snapshot is wrong twice over. In production it misses anything that sets these
 * variables after import — a spawn wrapper, a nested hook, a test harness. And it makes the strip
 * UNTESTABLE: a test that sets `process.env.GIT_COMMON_DIR` and then calls the probe would be
 * mutating an object the module had already copied, so it passes identically whether the strip is
 * present or reverted. That was measured — the regression test for this very fix was green against
 * a build with the fix removed. Rebuilding a small object per git call costs nothing next to
 * spawning a process.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of HIJACKERS) delete env[k]
  return env
}

export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: string }

/**
 * Run git and say what happened.
 *
 * The distinction this returns is the whole point. Folding a FAILURE into the same value as a
 * SUCCESS WITH EMPTY OUTPUT is how `createBundle` came to report a permission error as "everything
 * is already pushed" and `capturePatch` came to report a 200 MB dirty tree as clean. Both are
 * silent, and both are silent in the reassuring direction.
 */
async function gitRun(cwd: string, args: string[], timeout = 10_000): Promise<GitResult> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { env: gitEnv(), timeout, maxBuffer: 64 * 1024 * 1024 })
    return { ok: true, stdout: stdout.trim() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: msg.split('\n').slice(0, 2).join(' ').slice(0, 200) }
  }
}

/** For the probes where a failure legitimately means "git has no answer about this directory". */
async function git(cwd: string, args: string[], timeout = 10_000): Promise<string | null> {
  const r = await gitRun(cwd, args, timeout)
  return r.ok ? r.stdout : null
}

export async function probeDir(path: string): Promise<DirFacts> {
  const empty: DirFacts = {
    path, exists: false, commonDir: null, topLevel: null, cloneUrl: '', remote: '', branch: '', head: '',
  }
  if (!existsSync(path)) return empty

  const common = await git(path, ['rev-parse', '--git-common-dir'])
  if (common === null) return { ...empty, exists: true }

  const [topLevel, cloneUrl, branch, head] = await Promise.all([
    git(path, ['rev-parse', '--show-toplevel']),
    git(path, ['config', '--get', 'remote.origin.url']),
    git(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(path, ['rev-parse', 'HEAD']),
  ])

  return {
    path,
    exists: true,
    // Absolutise: from inside a worktree git prints this relative to the worktree.
    commonDir: isAbsolute(common) ? common : resolve(path, common),
    topLevel: topLevel ?? null,
    cloneUrl: cloneUrl ?? '',
    remote: normalizeGitRemote(cloneUrl ?? '') || '',
    branch: branch === 'HEAD' ? '' : (branch ?? ''),
    head: head ?? '',
  }
}

export async function probeAll(paths: string[], concurrency = 8): Promise<DirFacts[]> {
  const limit = createLimiter(concurrency)
  return Promise.all(paths.map(p => limit(() => probeDir(p))))
}

export type BundleResult = 'written' | 'empty' | 'too-large' | 'failed'

/**
 * Write a bundle of this repository's history.
 *
 * `full: false` writes only what the remote does not have (`--all --not --remotes`) — 265 KB
 * against 30 MB for `--all` on the reference repository, which is why saving every unpushed branch
 * costs effectively nothing. `full: true` is for a repository with no remote, which has no other
 * home.
 *
 * The ceiling is enforced by DELETING an oversized bundle: checking first would need a size git
 * will not predict, and leaving the file would spend the disk the ceiling exists to protect.
 */
export async function createBundle(
  mainDir: string, out: string, opts: { full: boolean; maxBytes: number },
): Promise<BundleResult> {
  const args = opts.full
    ? ['bundle', 'create', out, '--all']
    : ['bundle', 'create', out, '--all', '--not', '--remotes']

  const res = await gitRun(mainDir, args, 120_000)
  if (!res.ok) {
    await unlink(out).catch(() => {})
    // `git bundle` refuses an EMPTY ref set with a non-zero exit and a specific message. That case
    // is not a failure — it means every local commit is already on the remote, the common and happy
    // case. Everything else (a permission error, a full disk, a 120s timeout on a huge repository)
    // is a REAL failure and must be reported as one.
    //
    // The match errs toward `failed`: an unrecognised message becomes `failed`, which costs the
    // user one visible line naming the repository. The opposite mistake — a real failure reported
    // as `empty` — tells them their unpushed work was checked and found to be already safe.
    return /empty bundle/i.test(res.reason) ? 'empty' : 'failed'
  }
  let size = 0
  try { size = statSync(out).size } catch { return 'failed' }
  if (size === 0) { await unlink(out).catch(() => {}); return 'empty' }
  if (size > opts.maxBytes) { await unlink(out).catch(() => {}); return 'too-large' }
  return 'written'
}

export type PatchResult =
  /**
   * No PATCH to write. That covers a genuinely clean tree AND a tree whose only changes are
   * untracked files — `git status` sees those, `git diff HEAD` does not. It never means "nothing to
   * back up here": the untracked list is collected separately by `listUntracked`, and a caller that
   * read `clean` as "skip this directory" would drop it.
   */
  | { kind: 'clean' }
  | { kind: 'patch'; text: string }
  | { kind: 'unavailable'; reason: string }

/**
 * The working tree's uncommitted state.
 *
 * Asked in TWO steps on purpose. `git status --porcelain` is cheap and bounded, and it answers
 * "is this tree dirty" — a question that must be answered even when the diff itself cannot be
 * produced. Only then is the diff taken, which is the part that can exceed a 64 MB buffer or a 30s
 * timeout on a tree with large modified assets.
 *
 * One step would fold those together: an oversized diff came back as an error, an error came back
 * as `null`, and `null` also meant clean — so a working tree full of uncommitted work was backed up
 * as though it had none. That is the exact loss this whole module exists to prevent, arriving
 * silently and in the reassuring direction.
 */
export async function capturePatch(dir: string): Promise<PatchResult> {
  const status = await gitRun(dir, ['status', '--porcelain'], 15_000)
  if (!status.ok) return { kind: 'unavailable', reason: `git status failed: ${status.reason}` }
  if (!status.stdout) return { kind: 'clean' }

  const diff = await gitRun(dir, ['diff', 'HEAD', '--binary'], 30_000)
  if (!diff.ok) return { kind: 'unavailable', reason: `git diff failed: ${diff.reason}` }
  // Dirty per status but an empty diff means the changes are all untracked files, which travel as
  // a LIST rather than as content — `listUntracked` reports them and there is no patch to write.
  return diff.stdout ? { kind: 'patch', text: diff.stdout + '\n' } : { kind: 'clean' }
}

export type UntrackedResult =
  | { kind: 'files'; files: string[] }
  | { kind: 'unavailable'; reason: string }

/**
 * Untracked, not-ignored files, relative to the repository root.
 *
 * Discriminated for the same reason `capturePatch` is: this call COLLECTS BACKUP CONTENT, unlike
 * the probe calls where "git has no answer about this directory" is itself a legitimate answer.
 * Folding a permission error or a corrupted index into an empty list means a tree whose untracked
 * state was never established gets skipped as though it had none — the reassuring direction again.
 */
export async function listUntracked(dir: string): Promise<UntrackedResult> {
  const res = await gitRun(dir, ['ls-files', '--others', '--exclude-standard'])
  if (!res.ok) return { kind: 'unavailable', reason: `git ls-files failed: ${res.reason}` }
  return { kind: 'files', files: res.stdout ? res.stdout.split('\n').filter(Boolean) : [] }
}

/** Every directory worth probing, from the session store. PURE. */
export function candidatePaths(
  sessions: { project_path?: string; current_cwd?: string }[],
): string[] {
  const set = new Set<string>()
  for (const s of sessions) {
    if (s.project_path) set.add(s.project_path)
    if (s.current_cwd) set.add(s.current_cwd)
  }
  return [...set]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/repo-probe.test.ts`
Expected: PASS — 10 tests. (Requires `git` on PATH. If `git worktree add` fails, the sandbox git is older than 2.5 — install a newer one; the feature depends on worktrees existing.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/repo-probe.ts packages/server/server/backup/repo-probe.test.ts
git commit -m "feat(backup): pergunta ao git ao vivo, e usa o store só para saber onde perguntar

O store grava git_remote em 89 de 282 caminhos — limitação do store, não da
realidade. Duas regras herdadas do repo-facts.ts, que foram bugs lá primeiro:
um diretório que SUMIU não é um diretório fora de um repositório (o
discriminador é existir, nunca o git ter respondido), e o --git-common-dir
precisa ser absolutizado, porque dentro de uma worktree o git o imprime
relativo e duas worktrees do mesmo checkout viram duas chaves diferentes."
```

---

## Task 9: `backup.ts` — walking, sizing, writing

**Files:**
- Create: `packages/server/server/backup/backup.ts`
- Test: `packages/server/server/backup/backup.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: `BackupOptions`, `BackupResult`, `walkSources(homeDir, sources)`, `runBackup(options)`, `archiverFor()`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/backup.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { archiverFor, runBackup, walkSources } from './backup'
import { decodeManifest, MANIFEST_NAME } from './manifest'

let home = ''
let dest = ''

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agentistics-home-'))
  dest = mkdtempSync(join(tmpdir(), 'agentistics-dest-'))
  mkdirSync(join(home, '.agentistics/sessions/claude'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.agentistics/sessions/claude/a.json'), '{"session_id":"a","project_path":"/x"}')
  writeFileSync(join(home, '.agentistics/tags.json'), '[]')
  writeFileSync(join(home, '.agentistics/cache.db'), 'X'.repeat(5000))          // regenerable
  writeFileSync(join(home, '.claude/stats-cache.json'), '{}')
  writeFileSync(join(home, '.claude/.credentials.json'), '{"secret":"nope"}')   // secret
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(dest, { recursive: true, force: true })
})

test('the walk sizes real files and attributes them to a layer and a harness', async () => {
  const { files, sizes } = await walkSources(home, [
    { rel: '.agentistics/sessions/claude', layer: 'metrics', harness: 'claude' },
  ])
  expect(files.map(f => f.rel)).toEqual(['.agentistics/sessions/claude/a.json'])
  expect(sizes.metrics.byHarness.claude).toBeGreaterThan(0)
  expect(sizes.metrics.files).toBe(1)
})

test('the walk drops excluded files and never counts them toward a size', async () => {
  const { files, sizes } = await walkSources(home, [
    { rel: '.agentistics', layer: 'metrics', harness: null },
  ])
  const rels = files.map(f => f.rel)
  expect(rels).toContain('.agentistics/tags.json')
  expect(rels).not.toContain('.agentistics/cache.db')
  expect(sizes.metrics.bytes).toBeLessThan(5000)
})

test('a missing source is not an error — it contributes nothing and is not reported', async () => {
  const { files, skipped } = await walkSources(home, [{ rel: '.codex', layer: 'raw', harness: 'codex' }])
  expect(files).toEqual([])
  expect(skipped).toEqual([])
})

// `stat` dereferences and `lstat` does not, and the difference is a hang. A link to one of its own
// ancestors is an ordinary dotfiles-manager artifact, and following it recurses forever in a tool
// whose whole job is walking someone's home directory.
test('a symlink is not followed, and is reported rather than dropped', async () => {
  const dir = join(home, '.agentistics/sessions/claude')
  symlinkSync(home, join(dir, 'loop'))
  try {
    const { files, skipped } = await walkSources(home, [
      { rel: '.agentistics/sessions/claude', layer: 'metrics', harness: 'claude' },
    ])
    expect(files.map(f => f.rel)).toEqual(['.agentistics/sessions/claude/a.json'])
    expect(skipped).toEqual([{ rel: '.agentistics/sessions/claude/loop', reason: 'symlink' }])
  } finally {
    rmSync(join(dir, 'loop'), { force: true })
  }
})

// THE test of this feature, and it must be written so it can fail.
//
// The first version asked for `layers: ['metrics']`, which reaches `.claude` through exactly ONE
// entry — the single file `.claude/stats-cache.json`. The walk therefore never visited
// `.claude/.credentials.json` at all, so `excludeFor` was never asked about it and the assertion
// passed for the same reason it would pass if the file did not exist. It would have stayed green
// with the entire secrets table deleted.
//
// `raw` is what puts the `.claude` DIRECTORY in the source list, which is the only arrangement
// under which the credential is a candidate and its exclusion is a real event.
test('a backup writes an archive, records a real size, and no credential is inside', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics', 'raw'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box',
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(existsSync(r.record.path)).toBe(true)
  expect(r.record.archiveBytes).toBeGreaterThan(0)
  expect(r.record.sha256).toMatch(/^[0-9a-f]{64}$/)

  const listing = execFileSync('tar', ['-tf', r.record.path], { encoding: 'utf8' })
  expect(listing).toContain('.agentistics/sessions/claude/a.json')
  expect(listing).toContain(MANIFEST_NAME)
  // Proof the walk actually entered the directory holding the credential — without this the two
  // assertions below are about a file that was never a candidate.
  expect(listing).toContain('.claude/stats-cache.json')
  // The rule that matters most in this whole plan.
  expect(listing).not.toContain('.credentials.json')
  expect(listing).not.toContain('cache.db')
})

// The repos layer's whole promise. Before this was wired the bundle path in the manifest named a
// file that existed only on the machine being replaced.
test('the repos assets travel inside the archive, under their archive-relative names', async () => {
  const assetRoot = mkdtempSync(join(tmpdir(), 'agentistics-assets-'))
  mkdirSync(join(assetRoot, 'repos'), { recursive: true })
  writeFileSync(join(assetRoot, 'repos/example.bundle'), 'BUNDLE')
  writeFileSync(join(assetRoot, 'repos/example__main.patch'), 'PATCH')

  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics', 'repos'], harnesses: ['claude'],
    repos: [], assetRoot, agentopVersion: 'test', hostname: 'box',
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const listing = execFileSync('tar', ['-tf', r.record.path], { encoding: 'utf8' })
  expect(listing).toContain('repos/example.bundle')
  expect(listing).toContain('repos/example__main.patch')
  rmSync(assetRoot, { recursive: true, force: true })
})

test('an absent assetRoot is not an error — a metrics-only backup has no assets', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box',
  })
  expect(r.ok).toBe(true)
})

test('the manifest inside the archive round-trips and records the old $HOME', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box',
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const text = execFileSync('tar', ['-xOf', r.record.path, MANIFEST_NAME], { encoding: 'utf8' })
  const m = decodeManifest(text)
  expect(m.ok).toBe(true)
  if (m.ok) {
    expect(m.manifest.homeDir).toBe(home)
    expect(m.manifest.harnesses).toEqual(['claude'])
    expect(m.manifest.omittedSecrets.length).toBeGreaterThan(0)
  }
})

test('an archiver is resolved, and it names the extension it will actually produce', () => {
  const a = archiverFor()
  expect(['zstd', 'gzip', 'none']).toContain(a.kind)
  if (a.kind !== 'none') expect(a.extension.startsWith('.tar.')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/backup.test.ts`
Expected: FAIL — `Cannot find module './backup'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/backup.ts`:

```ts
/**
 * backup.ts — IO. Walk the sources, measure them, hand tar an explicit file list, record what
 * happened.
 *
 * ## tar receives a LIST, never an exclude pattern
 *
 * The exclusion rules live in `backup-plan.ts` and are tested there, including the grep that no
 * credential can pass. Handing tar `--exclude` globs would create a SECOND expression of those
 * rules, in a different language, with different escaping — and the one that runs would be the
 * untested one. So the walk applies `excludeFor` per file and tar is given the survivors through
 * `-T`. A file that is not in the list cannot be in the archive.
 *
 * ## The only compressed number in the system is measured here
 *
 * `archiveBytes` is `statSync` on the finished file. Nothing predicts it (see `backup-size.ts`).
 */
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { createReadStream, existsSync, statSync } from 'fs'
import { lstat, mkdir, readdir, writeFile, unlink } from 'fs/promises'
import { join, relative } from 'path'
import type { HarnessId } from '@agentistics/core'
import { excludeFor, omittedSecrets, planSources, type BackupLayer, type SourceEntry } from './backup-plan'
import { addBytes, emptySizes, plannedTotal, type BackupSizes } from './backup-size'
import { encodeManifest, MANIFEST_NAME, type BackupManifest } from './manifest'
import { recordBackup, type BackupRecord } from './backup-store'
import type { RepoEntry } from './repo-manifest'

const run = promisify(execFile)

export interface WalkedFile {
  rel: string
  bytes: number
  layer: BackupLayer
  harness: HarnessId | null
}

/** A path the walk could not read, or deliberately did not follow. Reported, never silent. */
export interface WalkSkip {
  rel: string
  reason: 'symlink' | 'unreadable'
  detail?: string
}

/**
 * Walk every source, applying the exclusion rules per file.
 *
 * A MISSING source contributes nothing and is not an error — a machine that never installed codex
 * is not a fault. Two other cases are NOT the same thing and are recorded:
 *
 * **Symlinks are not followed.** `stat` dereferences; `lstat` does not, and the difference matters
 * twice. A link pointing at one of its own ancestors — an ordinary dotfiles-manager artifact —
 * sends this recursion around forever, in a tool whose entire job is walking an arbitrary person's
 * home directory. And a link pointing OUTSIDE `$HOME` would copy its target's bytes into the
 * archive under an innocent `$HOME`-relative name, which is the exclusion table's own problem
 * arriving through a side door.
 *
 * **A directory that cannot be read is recorded, not skipped in silence.** A permission error deep
 * inside an otherwise-fine tree would otherwise produce a smaller backup that reports complete
 * success — the same failure-wearing-good-news shape this feature has had to remove three times
 * already.
 */
export async function walkSources(
  homeDir: string, sources: SourceEntry[],
): Promise<{ files: WalkedFile[]; sizes: BackupSizes; skipped: WalkSkip[] }> {
  const sizes = emptySizes()
  const files: WalkedFile[] = []
  const skipped: WalkSkip[] = []

  const visit = async (abs: string, src: SourceEntry, isRoot: boolean): Promise<void> => {
    const rel = relative(homeDir, abs).split('\\').join('/')
    if (excludeFor(rel)) return

    let st
    try {
      st = await lstat(abs)
    } catch (e) {
      // A source ROOT that is absent is the ordinary "this harness is not installed" case. The same
      // failure on a path we reached by reading its parent's entry is a real read error.
      if (!isRoot) skipped.push({ rel, reason: 'unreadable', detail: errText(e) })
      return
    }

    if (st.isSymbolicLink()) { skipped.push({ rel, reason: 'symlink' }); return }

    if (st.isDirectory()) {
      let entries: string[]
      try {
        entries = await readdir(abs)
      } catch (e) {
        skipped.push({ rel, reason: 'unreadable', detail: errText(e) })
        return
      }
      for (const e of entries) await visit(join(abs, e), src, false)
      return
    }
    if (!st.isFile()) return
    files.push({ rel, bytes: st.size, layer: src.layer, harness: src.harness })
    addBytes(sizes, src.layer, src.harness, st.size)
  }

  for (const src of sources) await visit(join(homeDir, src.rel), src, true)
  return { files, sizes, skipped }
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200)
}

export type Archiver =
  | { kind: 'zstd'; extension: '.tar.zst'; flag: '--zstd' }
  | { kind: 'gzip'; extension: '.tar.gz'; flag: '-z' }
  | { kind: 'none'; extension: '.tar'; flag: null }

/** Which compression this machine can actually produce. Never guessed: a `.tar.zst` written by a
 *  tar that ignored `--zstd` is a file nothing can open. */
export function archiverFor(): Archiver {
  const probe = (args: string[]): boolean => {
    try {
      execFileSync('tar', args, { stdio: 'ignore' })
      return true
    } catch { return false }
  }
  if (probe(['--zstd', '--version'])) return { kind: 'zstd', extension: '.tar.zst', flag: '--zstd' }
  if (probe(['-z', '--version'])) return { kind: 'gzip', extension: '.tar.gz', flag: '-z' }
  return { kind: 'none', extension: '.tar', flag: null }
}

export interface BackupOptions {
  homeDir: string
  destDir: string
  layers: BackupLayer[]
  harnesses: HarnessId[]
  repos: RepoEntry[]
  agentopVersion: string
  hostname: string
  /**
   * Directory holding the repos layer's ASSETS — the bundles and patches, already laid out as
   * `<assetRoot>/repos/…` exactly as they must appear inside the archive.
   *
   * They cannot come from the $HOME walk: they are produced during the backup and live nowhere in
   * $HOME. Without this they never enter the tar, `RepoEntry.bundle` names a file that only exists
   * on the machine being replaced, and every unpushed branch the manifest promises is lost — which
   * is the single thing the repos layer exists to save.
   */
  assetRoot?: string
  /** Called with each progress line. Defaults to a no-op so tests are silent. */
  onLine?: (line: string) => void
}

export type BackupResult =
  /**
   * `skipped` is on the RESULT, not only in the log.
   *
   * `onLine` defaults to a no-op, so a caller that does not wire it — the scheduled run, anything
   * headless, any future surface reading the result after the fact — would get an `ok: true` that
   * looks identical whether the walk skipped a permission-denied directory or skipped nothing.
   * That is the same "reports complete success over a real gap" this walk was changed to stop
   * doing, arriving one layer up.
   */
  | { ok: true; record: BackupRecord; sizes: BackupSizes; skipped: WalkSkip[] }
  | { ok: false; reason: string }

/** sha256 over the sorted `path:bytes` list. Deterministic, and independent of the archive. */
export function manifestDigest(files: WalkedFile[]): string {
  const lines = files.map(f => `${f.rel}:${f.bytes}`).sort().join('\n')
  return createHash('sha256').update(lines).digest('hex')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((res, rej) => {
    createReadStream(path).on('data', d => hash.update(d)).on('end', () => res()).on('error', rej)
  })
  return hash.digest('hex')
}

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const log = opts.onLine ?? (() => {})
  const started = Date.now()

  const archiver = archiverFor()
  if (archiver.kind === 'none') log('tar has no compression here — writing an uncompressed .tar')

  const sources = planSources({ layers: opts.layers, harnesses: opts.harnesses })
  log(`planning ${sources.length} sources`)
  const { files, sizes, skipped } = await walkSources(opts.homeDir, sources)
  log(`${files.length} files, ${plannedTotal(sizes, opts.layers)} bytes before compression`)

  // Named, never counted-and-forgotten: a backup that quietly left things out is a backup whose
  // completeness the user cannot reason about.
  for (const s of skipped) {
    log(s.reason === 'symlink'
      ? `skipped ${s.rel} — a symlink; its target is either already in the walk or deliberately outside it`
      : `skipped ${s.rel} — could not be read: ${s.detail ?? 'unknown'}`)
  }

  await mkdir(opts.destDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archivePath = join(opts.destDir, `agentistics-backup-${opts.hostname}-${stamp}${archiver.extension}`)

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    agentopVersion: opts.agentopVersion,
    hostname: opts.hostname,
    homeDir: opts.homeDir,
    platform: process.platform,
    layers: opts.layers,
    harnesses: opts.harnesses,
    sizes,
    groups: [{
      name: 'files',
      files: files.length,
      bytes: plannedTotal(sizes, opts.layers),
      // A digest of the FILE LIST, not of the archive: the manifest travels inside the archive, so
      // hashing the archive from here is circular. This catches an archive that was rebuilt or
      // edited — the case a byte count alone misses. The whole-archive hash lives on BackupRecord,
      // for the person verifying the file they carried.
      sha256: manifestDigest(files),
    }],
    repos: opts.repos,
    omittedSecrets: omittedSecrets().map(r => ({ path: r.pattern, restoreWith: r.restoreWith ?? '' })),
  }

  // Staged beside the archive, added under its own name, removed afterwards. Writing it into
  // $HOME would put our bookkeeping in the user's home directory.
  const manifestPath = join(opts.destDir, MANIFEST_NAME)
  const listPath = join(opts.destDir, `.agentistics-filelist-${stamp}`)
  await writeFile(manifestPath, encodeManifest(manifest))
  await writeFile(listPath, files.map(f => f.rel).join('\n') + '\n')

  try {
    const flags = archiver.flag ? [archiver.flag] : []
    // Three roots in one archive: the manifest (staged beside the output), the repos assets
    // (produced during this run), and the $HOME tree (the explicit file list).
    const assets = opts.assetRoot && existsSync(join(opts.assetRoot, 'repos'))
      ? ['-C', opts.assetRoot, 'repos']
      : []
    await run('tar', [
      ...flags, '-cf', archivePath,
      '-C', opts.destDir, MANIFEST_NAME,
      ...assets,
      '-C', opts.homeDir, '-T', listPath,
    ], { maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    // A failed tar can leave a PARTIAL archive, and it carries a real backup's extension. Nothing
    // recorded it, so nothing would ever delete it, and it would sit in the destination directory
    // looking exactly like a backup somebody could try to restore from.
    await unlink(archivePath).catch(() => {})
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    // One cleanup path for the staged files, on every outcome.
    await unlink(listPath).catch(() => {})
    await unlink(manifestPath).catch(() => {})
  }

  if (!existsSync(archivePath)) return { ok: false, reason: 'tar reported success but wrote nothing' }

  const record: BackupRecord = {
    at: manifest.createdAt,
    path: archivePath,
    layers: opts.layers,
    harnesses: opts.harnesses,
    bytesUncompressed: plannedTotal(sizes, opts.layers),
    archiveBytes: statSync(archivePath).size,   // measured, never predicted
    sha256: await sha256File(archivePath),
    durationMs: Date.now() - started,
    skipped: skipped.length,
  }
  await recordBackup(record)
  log(`wrote ${archivePath}`)
  return { ok: true, record, sizes, skipped }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/backup.test.ts`
Expected: PASS — 6 tests. The credential assertion is the one that matters; if it fails, stop and fix `backup-plan.ts` rather than the test.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/backup.ts packages/server/server/backup/backup.test.ts
git commit -m "feat(backup): o tar recebe uma LISTA de arquivos, nunca padrões de exclusão

As regras de exclusão moram no backup-plan.ts e são testadas lá, incluindo o
grep de que nenhuma credencial passa. Dar globs --exclude ao tar criaria uma
SEGUNDA expressão das mesmas regras, em outra linguagem, com outro escape — e a
que rodaria seria a não testada. O walk aplica excludeFor por arquivo e o tar
recebe os sobreviventes via -T: o que não está na lista não pode estar no
arquivo. O tamanho comprimido é um statSync no arquivo pronto."
```

---

## Task 10: `restore.ts` — verify, stage, merge, clone

**Files:**
- Create: `packages/server/server/backup/restore.ts`
- Test: `packages/server/server/backup/restore.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 7, 9.
- Produces: `RESTORE_STATE_FILE`, `readManifestOf(archive)`, `verifyArchive(archive, manifest)`, `restoreMetrics(opts)`, `restoreRepos(opts)`, `readRestoreState()`, `writeRestoreState(state)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/restore.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runBackup } from './backup'
import { readManifestOf, restoreMetrics, restoreRepos, verifyArchive } from './restore'
import type { BackupManifest } from './manifest'
import type { RepoEntry } from './repo-manifest'

let oldHome = ''
let newHome = ''
let dest = ''
let archive = ''

beforeAll(async () => {
  oldHome = mkdtempSync(join(tmpdir(), 'agentistics-old-'))
  newHome = mkdtempSync(join(tmpdir(), 'agentistics-new-'))
  dest = mkdtempSync(join(tmpdir(), 'agentistics-arch-'))
  mkdirSync(join(oldHome, '.agentistics/sessions/claude'), { recursive: true })
  mkdirSync(join(oldHome, '.claude'), { recursive: true })
  writeFileSync(
    join(oldHome, '.agentistics/sessions/claude/a.json'),
    JSON.stringify({ session_id: 'a', project_path: `${oldHome}/proj` }),
  )
  writeFileSync(join(oldHome, '.claude/stats-cache.json'), '{"totalCostUSD":42}')
  const r = await runBackup({
    homeDir: oldHome, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'old',
  })
  if (!r.ok) throw new Error(r.reason)
  archive = r.record.path
})

afterAll(() => {
  for (const d of [oldHome, newHome, dest]) rmSync(d, { recursive: true, force: true })
})

test('the manifest is readable straight out of the archive', async () => {
  const m = await readManifestOf(archive)
  expect(m.ok).toBe(true)
  if (m.ok) expect(m.manifest.homeDir).toBe(oldHome)
})

test('a truncated archive is refused before anything is written', async () => {
  const broken = join(dest, 'broken.tar.zst')
  const bytes = readFileSync(archive)
  writeFileSync(broken, bytes.subarray(0, Math.floor(bytes.length / 2)))
  const m = await readManifestOf(archive)
  expect(m.ok).toBe(true)
  if (!m.ok) return
  const v = await verifyArchive(broken, m.manifest)
  expect(v.ok).toBe(false)
})

test('an intact archive verifies', async () => {
  const m = await readManifestOf(archive)
  expect(m.ok).toBe(true)
  if (!m.ok) return
  const v = await verifyArchive(archive, m.manifest)
  expect(v.ok).toBe(true)
})

test('metrics land in the new home and the old $HOME prefix is rewritten', async () => {
  const r = await restoreMetrics({ archive, homeDir: newHome })
  expect(r.ok).toBe(true)
  const restored = join(newHome, '.agentistics/sessions/claude/a.json')
  expect(existsSync(restored)).toBe(true)
  const doc = JSON.parse(readFileSync(restored, 'utf8')) as { project_path: string }
  expect(doc.project_path).toBe(`${newHome}/proj`)
})

// Claude owns that file. Ours goes where applyArchivedStats already reads it with per-field max.
test('stats-cache.json never lands on top of Claude own copy', async () => {
  mkdirSync(join(newHome, '.claude'), { recursive: true })
  writeFileSync(join(newHome, '.claude/stats-cache.json'), '{"totalCostUSD":1}')
  await restoreMetrics({ archive, homeDir: newHome })
  expect(readFileSync(join(newHome, '.claude/stats-cache.json'), 'utf8')).toBe('{"totalCostUSD":1}')
  expect(existsSync(join(newHome, '.agentistics/archive/stats-cache/stats-cache.json'))).toBe(true)
})

test('a newer local file survives the restore, and is reported as skipped', async () => {
  const target = join(newHome, '.agentistics/sessions/claude/a.json')
  writeFileSync(target, '{"session_id":"a","local":true}')
  const future = new Date(Date.now() + 60_000)
  utimesSync(target, future, future)

  const r = await restoreMetrics({ archive, homeDir: newHome })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.skipped).toBeGreaterThan(0)
  expect(JSON.parse(readFileSync(target, 'utf8')).local).toBe(true)
})

test('a restore leaves no staging directory behind', async () => {
  await restoreMetrics({ archive, homeDir: newHome })
  expect(existsSync(join(newHome, '.agentistics/restore-staging'))).toBe(false)
})

// --- the repo phase -----------------------------------------------------------------------------
//
// It is the resumable half of the feature and was reaching production verified only by reading it.
// These run real git against a real repository, because what is under test is the interaction.

// `cwd` is NOT enough, and this is not theoretical — it happened twice on this branch. Git fires a
// pre-commit hook with GIT_DIR / GIT_INDEX_FILE / GIT_PREFIX exported, and neither `cwd` nor `-C`
// overrides an inherited GIT_DIR. Run under husky from a linked worktree, `makeOrigin`'s `git init`
// and `git config user.email` below executed against the REAL SHARED repository: they rewrote this
// fleet's git identity and committed a fixture file onto the branch. `repo-probe.test.ts` carries
// the same guard for the same reason; GIT_COMMON_DIR is here too because it redirects
// --git-common-dir on its own (measured).
const git = (cwd: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[k]
  return execFileSync('git', args, { cwd, encoding: 'utf8', env })
}

/** A real repository to clone FROM. */
function makeOrigin(at: string): string {
  mkdirSync(at, { recursive: true })
  git(at, 'init', '-q', '-b', 'main')
  git(at, 'config', 'user.email', 't@t')
  git(at, 'config', 'user.name', 't')
  writeFileSync(join(at, 'a.txt'), 'one\n')
  git(at, 'add', 'a.txt')
  git(at, 'commit', '-q', '-m', 'one')
  return at
}

const entry = (over: Partial<RepoEntry> & { key: string; cloneUrl: string; mainPath: string }): RepoEntry => ({
  mainBranch: 'main', worktrees: [], bundle: null, dirty: [], note: null, ...over,
})

async function manifestWith(repos: RepoEntry[]): Promise<BackupManifest> {
  const m = await readManifestOf(archive)
  if (!m.ok) throw new Error('fixture archive has no readable manifest')
  return { ...m.manifest, repos }
}

test('a repo is cloned, and a second run does not attempt it again', async () => {
  const origin = makeOrigin(join(dest, 'origin-ok'))
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t1-'))
  try {
    const manifest = await manifestWith([entry({ key: 'ok', cloneUrl: origin, mainPath: '~/proj' })])

    const first = await restoreRepos({ manifest, homeDir: target, archive })
    expect(first.attempted).toBe(1)
    expect(first.succeeded).toBe(1)
    expect(first.failures).toEqual([])
    expect(readFileSync(join(target, 'proj/a.txt'), 'utf8')).toBe('one\n')

    // `done` is terminal — this is what makes re-running safe rather than destructive.
    const second = await restoreRepos({ manifest, homeDir: target, archive })
    expect(second.attempted).toBe(0)
    expect(second.succeeded).toBe(0)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// A restore of 89 repositories WILL partially fail. Re-running until it converges is the whole
// design, and that only works if `failed` is retried while `done` is not.
test('a failure is recorded by name and retried on the next run', async () => {
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t2-'))
  try {
    const manifest = await manifestWith([
      entry({ key: 'bad', cloneUrl: join(dest, 'no-such-repo-anywhere'), mainPath: '~/gone' }),
    ])

    const first = await restoreRepos({ manifest, homeDir: target, archive })
    expect(first.attempted).toBe(1)
    expect(first.succeeded).toBe(0)
    expect(first.failures).toHaveLength(1)
    expect(first.failures[0]!.key).toBe('bad')
    expect(first.failures[0]!.reason.length).toBeGreaterThan(0)

    const second = await restoreRepos({ manifest, homeDir: target, archive })
    expect(second.attempted).toBe(1)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// The resume bookkeeping belongs to the machine being restored INTO. Anchored to the operator's own
// $HOME, two different restore targets sharing a repository key overwrite each other's progress.
test('the resume state is written under the home being restored into', async () => {
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t3-'))
  try {
    const manifest = await manifestWith([
      entry({ key: 'bad', cloneUrl: join(dest, 'nope'), mainPath: '~/gone' }),
    ])
    await restoreRepos({ manifest, homeDir: target, archive })
    expect(existsSync(join(target, '.agentistics/restore-state.json'))).toBe(true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a destination that already exists is skipped with a reason, never cloned over', async () => {
  const origin = makeOrigin(join(dest, 'origin-occupied'))
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t4-'))
  try {
    mkdirSync(join(target, 'proj'), { recursive: true })
    writeFileSync(join(target, 'proj/MINE.txt'), 'do not touch')

    const manifest = await manifestWith([entry({ key: 'occ', cloneUrl: origin, mainPath: '~/proj' })])
    const r = await restoreRepos({ manifest, homeDir: target, archive })

    expect(r.attempted).toBe(0)
    expect(r.skipped).toEqual([{ key: 'occ', reason: 'destination-exists' }])
    expect(readFileSync(join(target, 'proj/MINE.txt'), 'utf8')).toBe('do not touch')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('the repo phase leaves no staging directory behind', async () => {
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t5-'))
  try {
    const manifest = await manifestWith([
      entry({ key: 'bad', cloneUrl: join(dest, 'nope'), mainPath: '~/gone' }),
    ])
    await restoreRepos({ manifest, homeDir: target, archive })
    expect(existsSync(join(target, '.agentistics/restore-staging'))).toBe(false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/restore.test.ts`
Expected: FAIL — `Cannot find module './restore'`

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/backup/restore.ts`:

```ts
/**
 * restore.ts — IO. Verify, stage, merge, then clone.
 *
 * ## Nothing is written before the bytes are proven
 *
 * `verifyArchive` runs first, and a truncated or altered archive is a REFUSAL, not a partial
 * restore. A half-restored machine is worse than an unrestored one: it looks done.
 *
 * ## Staging, not extraction into place
 *
 * tar extracts into `$HOME/.agentistics/restore-staging`, and only then does the merge apply
 * `planMetrics`' decisions file by file. Extracting straight into `$HOME` would make tar the thing
 * deciding what gets overwritten — and tar has no opinion about which copy is newer, which is the
 * one rule this merge exists to enforce. The staging directory is removed on every exit path,
 * success or failure.
 *
 * ## The repo phase is separate, and resumable
 *
 * It is network and disk, and it will partially fail — a renamed repository, an archived one, SSH
 * not set up yet. Each result is written to `restore-state.json` as it happens, so re-running
 * attempts only what is unfinished, and every failure is reported as a LINE naming the repo and
 * the reason. A count of successes without the list of what did not come back is not a report.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from 'fs/promises'
import { dirname, join, relative } from 'path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { safeReadJson } from '../utils'
import { decodeManifest, MANIFEST_NAME, type BackupManifest, type DecodedManifest } from './manifest'
import { gitEnv } from './repo-probe'
import {
  emptyRestoreState, planMetrics, planRepos, remaining, rewriteHome,
  type RepoStep, type RestoreState, type StagedFile,
} from './restore-plan'

const run = promisify(execFile)

/**
 * Where the resume bookkeeping lives — derived from the `$HOME` being restored INTO, not from this
 * process's own.
 *
 * Every other stateful path here (`staging`, `assetDir`) is built from the `homeDir` argument, and
 * this one broke the pattern: a restore aimed at another user, a container, or one target of a
 * scripted multi-target run wrote its `done`/`failed` state onto the operator's machine — where two
 * different targets sharing a repository key would then overwrite each other's progress.
 */
export function restoreStateFile(homeDir: string): string {
  return join(homeDir, '.agentistics', 'restore-state.json')
}

/** The ordinary case: this machine restoring into itself. */
export const RESTORE_STATE_FILE = join(AGENTISTICS_DATA_DIR, 'restore-state.json')

const STAGING = '.agentistics/restore-staging'

/** Read the manifest without extracting the archive. */
export async function readManifestOf(archive: string): Promise<DecodedManifest> {
  try {
    const { stdout } = await run('tar', ['-xOf', archive, MANIFEST_NAME], { maxBuffer: 64 * 1024 * 1024 })
    return decodeManifest(stdout)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/**
 * Prove the archive is intact. Two checks, because they fail differently: tar must be able to LIST
 * it end to end (catches truncation), and the entry count must be AT LEAST what the manifest
 * recorded.
 *
 * A floor, deliberately, not an equality — the doc used to claim equality and the code has always
 * been a floor, which is the honest one: the archive legitimately holds MORE entries than the
 * manifest's file count (the manifest itself, the `repos/` assets, and whatever directory entries
 * tar chose to emit). An equality check would refuse every backup carrying a repos layer. Content
 * is proven separately by `verifyStaged`'s digest, after extraction and before any merge.
 */
export async function verifyArchive(archive: string, manifest: BackupManifest): Promise<VerifyResult> {
  let listing: string
  try {
    const { stdout } = await run('tar', ['-tf', archive], { maxBuffer: 256 * 1024 * 1024 })
    listing = stdout
  } catch (e) {
    return { ok: false, reason: `archive is unreadable or truncated: ${e instanceof Error ? e.message : String(e)}` }
  }
  const entries = listing.split('\n').filter(l => l.trim() && !l.endsWith('/'))
  const expected = (manifest.groups[0]?.files ?? 0) + 1   // + the manifest itself
  if (entries.length < expected) {
    return { ok: false, reason: `archive holds ${entries.length} entries, the manifest recorded ${expected}` }
  }
  return { ok: true }
}

/**
 * The second half of verification, run against the STAGED files once they are extracted: the
 * manifest's digest is over `path:bytes`, so it catches an archive whose contents were changed
 * while its entry count stayed the same. Kept separate from `verifyArchive` because it needs the
 * extraction to have happened, and a mismatch there still aborts before anything is merged.
 */
export function verifyStaged(
  staged: { rel: string; bytes: number }[], manifest: BackupManifest,
): VerifyResult {
  const expected = manifest.groups[0]?.sha256 ?? ''
  if (!expected) return { ok: true }   // an older manifest carried no digest
  const lines = staged.map(f => `${f.rel}:${f.bytes}`).sort().join('\n')
  const actual = createHash('sha256').update(lines).digest('hex')
  return actual === expected
    ? { ok: true }
    : { ok: false, reason: 'the archive contents do not match the manifest digest' }
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((res, rej) => {
    createReadStream(path).on('data', d => hash.update(d)).on('end', () => res()).on('error', rej)
  })
  return hash.digest('hex')
}

async function walkStaged(root: string): Promise<(StagedFile & { bytes: number })[]> {
  const out: (StagedFile & { bytes: number })[] = []
  const visit = async (abs: string): Promise<void> => {
    const st = await stat(abs).catch(() => null)
    if (!st) return
    if (st.isDirectory()) {
      for (const e of await readdir(abs).catch(() => [] as string[])) await visit(join(abs, e))
      return
    }
    out.push({ rel: relative(root, abs).split('\\').join('/'), mtimeMs: st.mtimeMs, bytes: st.size })
  }
  await visit(root)
  return out.filter(f => f.rel !== MANIFEST_NAME)
}

export interface RestoreMetricsOptions {
  archive: string
  homeDir: string
  onLine?: (line: string) => void
}

export type RestoreMetricsResult =
  | { ok: true; written: number; skipped: number; manifest: BackupManifest }
  | { ok: false; reason: string }

export async function restoreMetrics(opts: RestoreMetricsOptions): Promise<RestoreMetricsResult> {
  const log = opts.onLine ?? (() => {})
  const staging = join(opts.homeDir, STAGING)

  const decoded = await readManifestOf(opts.archive)
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason === 'too-new'
      ? `this archive was written by a newer agentop (manifest version ${decoded.found}); upgrade before restoring`
      : `the archive's manifest is ${decoded.reason}` }
  }
  const manifest = decoded.manifest

  const verified = await verifyArchive(opts.archive, manifest)
  if (!verified.ok) return { ok: false, reason: verified.reason }

  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await run('tar', ['-xf', opts.archive, '-C', staging], { maxBuffer: 16 * 1024 * 1024 })

    const staged = await walkStaged(staging)

    // The digest check happens HERE, after extraction and before the merge — it needs the files,
    // and a mismatch must still stop everything before a single byte is written into $HOME.
    const digest = verifyStaged(staged, manifest)
    if (!digest.ok) return { ok: false, reason: digest.reason }

    const localMtime = new Map<string, number>()
    for (const f of staged) {
      const st = await stat(join(opts.homeDir, f.rel)).catch(() => null)
      if (st) localMtime.set(f.rel, st.mtimeMs)
    }

    const actions = planMetrics(staged, localMtime)
    let written = 0
    let skipped = 0

    for (const a of actions) {
      if (a.kind === 'skip') {
        skipped++
        log(`skip ${a.rel} — the local copy is newer`)
        continue
      }
      const from = join(staging, a.rel)
      const to = join(opts.homeDir, a.redirectTo ?? a.rel)
      await mkdir(dirname(to), { recursive: true })

      // Only JSON documents can carry an absolute path that needs rewriting; everything else is
      // copied byte for byte. Rewriting an arbitrary file would corrupt binaries.
      if (a.rel.endsWith('.json') && manifest.homeDir !== opts.homeDir) {
        const text = await readFile(from, 'utf8')
        await writeFile(to, rewriteHome(text, manifest.homeDir, opts.homeDir))
      } else {
        await copyFile(from, to)
      }
      written++
    }

    log(`${written} written, ${skipped} skipped`)
    return { ok: true, written, skipped, manifest }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

export async function readRestoreState(file = RESTORE_STATE_FILE): Promise<RestoreState> {
  return (await safeReadJson<RestoreState>(file)) ?? emptyRestoreState()
}

export async function writeRestoreState(state: RestoreState, file = RESTORE_STATE_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2))
}

export interface RestoreReposOptions {
  manifest: BackupManifest
  homeDir: string
  /** The archive itself — the repos phase extracts its `repos/` assets before running anything. */
  archive: string
  only?: string
  onLine?: (line: string) => void
}

export interface RestoreReposResult {
  attempted: number
  succeeded: number
  failures: { key: string; reason: string }[]
  skipped: { key: string; reason: string }[]
}

export async function restoreRepos(opts: RestoreReposOptions): Promise<RestoreReposResult> {
  const log = opts.onLine ?? (() => {})
  const stateFile = restoreStateFile(opts.homeDir)
  const state = await readRestoreState(stateFile)
  const entries = opts.only
    ? opts.manifest.repos.filter(r => r.key === opts.only)
    : opts.manifest.repos

  // The bundles and patches live inside the archive. Extract just that subtree — `git fetch` needs
  // a real file, and the manifest names it archive-relative precisely so it can be placed anywhere.
  const assetDir = join(opts.homeDir, STAGING)
  await rm(assetDir, { recursive: true, force: true })
  await mkdir(assetDir, { recursive: true })
  const needsAssets = entries.some(e => e.bundle || e.dirty.some(d => d.patch))
  if (needsAssets) {
    await run('tar', ['-xf', opts.archive, '-C', assetDir, 'repos'], { maxBuffer: 16 * 1024 * 1024 })
      .catch(() => log('no repos assets in this archive — cloning without local-only history'))
  }

  const steps = planRepos(entries, state, p => existsSync(p), opts.homeDir, assetDir)
  const result: RestoreReposResult = { attempted: 0, succeeded: 0, failures: [], skipped: [] }

  for (const s of steps) {
    if (s.state === 'skipped') result.skipped.push({ key: s.key, reason: String(s.reason) })
  }

  // Everything below is wrapped so the staging directory goes on EVERY exit path — the same
  // invariant `restoreMetrics` already holds. Without it an uncaught throw inside the loop (a
  // disk-write failure in `writeRestoreState`, say) leaves the staging tree behind.
  try {
  for (const step of remaining(steps)) {
    result.attempted++
    if (step.previousFailure) log(`retrying ${step.key} (last failed: ${step.previousFailure})`)
    const failure = await runSteps(step, opts.homeDir, log)
    if (failure) {
      result.failures.push({ key: step.key, reason: failure })
      state.repos[step.key] = { state: 'failed', reason: failure }
      log(`FAILED ${step.key} — ${failure}`)
    } else {
      result.succeeded++
      state.repos[step.key] = { state: 'done' }
      log(`ok ${step.key} -> ${step.mainPath}`)
    }
    // Written after every repo, not at the end: an interrupted run must not lose what it did.
    await writeRestoreState(state, stateFile)
  }

  // Untracked files were never carried, and a diff we could not capture was never carried either
  // (see RepoDirty). Name both, so "not restored" is a fact the user reads rather than a silence
  // they discover.
  for (const e of entries) {
    for (const d of e.dirty) {
      if (d.patchUnavailable) {
        log(`note ${e.key}: the uncommitted state of ${d.path} could NOT be read — ${d.patchUnavailable}`)
      }
      if (d.untracked.length) {
        log(`note ${e.key}: ${d.untracked.length} untracked file(s) in ${d.path} were listed, not carried:`)
        for (const u of d.untracked.slice(0, 20)) log(`       ${u}`)
        if (d.untracked.length > 20) log(`       … and ${d.untracked.length - 20} more`)
      }
    }
  }

  } finally {
    await rm(assetDir, { recursive: true, force: true }).catch(() => {})
  }
  return result
}

/**
 * Run one repo's commands in order. Returns the failure reason, or null on success.
 *
 * It walks `step.argv` — structured, never a split string — so a path containing a space survives,
 * and no shell is involved at any point. `step.commands` is the same plan joined, and exists only
 * to be printed.
 */
async function runSteps(step: RepoStep, homeDir: string, log: (l: string) => void): Promise<string | null> {
  for (let i = 0; i < step.argv.length; i++) {
    const [bin, ...args] = step.argv[i]!
    if (!bin) continue
    try {
      log(`  ${step.commands[i] ?? bin}`)
      await run(bin, args, {
        cwd: homeDir,
        // `cwd` does NOT override an inherited GIT_DIR. `agentop restore --repos` can run from a
        // git hook, and there it would clone into the hook's repository instead of the target.
        // Same rule as the probe's, imported rather than restated — a second copy is a second
        // place to forget GIT_COMMON_DIR.
        env: gitEnv(),
        timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return msg.split('\n').slice(0, 3).join(' ').slice(0, 300)
    }
  }
  return null
}
```

> **Why `runSteps` walks `argv` and not `commands`:** the two come from one source in
> `repo-manifest.ts` — `restoreArgv` is what runs, `restoreCommands` is the same plan joined for a
> person to read. A path containing a space cannot be recovered from a joined string, and joining
> then re-splitting is exactly how a wrong argv gets in. No shell is involved at any point, so a
> path is never an injection surface.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/server/backup/restore.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/backup/restore.ts packages/server/server/backup/restore.test.ts
git commit -m "feat(backup): nada é escrito antes dos bytes serem provados

Um arquivo truncado é RECUSA, não restore parcial: uma máquina meio restaurada
é pior que uma não restaurada, porque parece pronta. O tar extrai para uma
staging e só então o merge aplica as decisões arquivo a arquivo — extrair
direto no \$HOME faria o tar decidir o que sobrescrever, e o tar não tem
opinião sobre qual cópia é mais nova, que é a única regra que esse merge existe
para impor. O estado dos repos é escrito a cada repo, não no fim: uma execução
interrompida não pode perder o que já fez."
```

---

## Task 11: `cli-backup.ts` — the two commands, the strings, the daemon hook

**Files:**
- Create: `packages/server/server/backup/daemon.ts`
- Create: `packages/server/server/cli-backup.ts`
- Modify: `packages/server/bin/cli.ts` (beside the `events` block, ~line 445)
- Modify: `packages/server/server/preferences.ts` (the `Preferences` interface, ~line 78)
- Modify: `packages/server/server/otel-watcher.ts` (~line 618, beside `startEventProducer`)
- Modify: `packages/server/server/cli-i18n.ts`
- Test: `packages/server/server/backup/cli-backup.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `BackupPrefs`, `readBackupPrefs(prefs)`, `parseBackupArgs(argv)`, `runBackupCli(args)`, `runRestoreCli(args)`, `startScheduledBackup(log)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/backup/cli-backup.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { parseBackupArgs, readBackupPrefs } from '../cli-backup'

test('bare `agentop backup` runs with the default layers and every harness', () => {
  const a = parseBackupArgs([])
  expect(a.kind).toBe('run')
  if (a.kind !== 'run') return
  expect(a.layers).toEqual(['metrics', 'repos'])
  expect(a.harnesses.length).toBeGreaterThan(0)
})

test('layers are opt-in and additive', () => {
  const a = parseBackupArgs(['--with-archive', '--with-raw'])
  if (a.kind !== 'run') throw new Error('expected run')
  expect(a.layers).toEqual(['metrics', 'repos', 'archive', 'raw'])
})

test('a harness selection narrows, and an unknown harness is a usage error', () => {
  const a = parseBackupArgs(['--harness', 'claude,codex'])
  if (a.kind !== 'run') throw new Error('expected run')
  expect(a.harnesses).toEqual(['claude', 'codex'])

  const bad = parseBackupArgs(['--harness', 'gpt'])
  expect(bad.kind).toBe('error')
})

test('`--plan` asks for the plan and nothing else', () => {
  const a = parseBackupArgs(['--plan'])
  if (a.kind !== 'run') throw new Error('expected run')
  expect(a.planOnly).toBe(true)
})

test('--max-bundle takes megabytes, and refuses anything that is not a positive number', () => {
  const a = parseBackupArgs(['--max-bundle', '50'])
  if (a.kind !== 'run') throw new Error('expected run')
  expect(a.maxBundleBytes).toBe(50 * 1024 * 1024)
  expect(parseBackupArgs(['--max-bundle', 'big']).kind).toBe('error')
  expect(parseBackupArgs(['--max-bundle', '0']).kind).toBe('error')
})

test('the schedule subcommand takes only the known ids', () => {
  expect(parseBackupArgs(['schedule', 'daily']).kind).toBe('schedule')
  expect(parseBackupArgs(['schedule', 'hourly']).kind).toBe('error')
})

test('an absent backup preference block yields safe defaults, not a crash', () => {
  const p = readBackupPrefs({})
  expect(p.schedule).toBe('off')
  expect(p.keep).toBeGreaterThan(0)
  expect(p.layers).toEqual(['metrics', 'repos'])
})

// A schedule that carried `raw` would be 2.4 GB per run. The default must not be able to become
// that by accident, so a stored preference is clamped on READ, the way sessionPollMs is.
test('a stored schedule that names `raw` is honoured, but the default never does', () => {
  expect(readBackupPrefs({ backup: { scheduleLayers: ['metrics', 'raw'] } } as never).scheduleLayers)
    .toEqual(['metrics', 'raw'])
  expect(readBackupPrefs({}).scheduleLayers).toEqual(['metrics', 'repos'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/server/backup/cli-backup.test.ts`
Expected: FAIL — `Cannot find module '../cli-backup'`

- [ ] **Step 3a: Add the preference block**

In `packages/server/server/preferences.ts`, inside `export interface Preferences` (after `sessionPollMs`), add:

```ts
  /** How this machine backs itself up. Absent reads as `schedule: 'off'` — a machine must not
   *  start writing gigabytes because it was upgraded. See backup/schedule.ts. */
  backup?: {
    schedule?: 'off' | 'daily' | 'weekly'
    /** Layers a MANUAL run writes. */
    layers?: ('metrics' | 'repos' | 'archive' | 'raw')[]
    /** Layers a SCHEDULED run writes. Deliberately separate: `raw` is 2.4 GB a copy, so a daily
     *  schedule that inherited a manual run's layers would fill a disk. */
    scheduleLayers?: ('metrics' | 'repos' | 'archive' | 'raw')[]
    harnesses?: string[]
    destDir?: string
    keep?: number
    maxBundleBytes?: number
  }
```

- [ ] **Step 3b: Write `cli-backup.ts`**

Create `packages/server/server/cli-backup.ts`:

```ts
/**
 * cli-backup.ts — `agentop backup` and `agentop restore`.
 *
 * Every decision is already made by a pure module: `backup-plan.ts` says what goes in,
 * `repo-manifest.ts` says how a repository is rebuilt, `restore-plan.ts` says what a restore would
 * do, `schedule.ts` says whether one is due. This file parses argv, calls, and prints.
 *
 * The one rule it owns is about printing: **a failure is a LINE naming the thing and the reason.**
 * A run that clones 89 repositories will partially fail, and a count of successes without the list
 * of what did not come back is not a report.
 */
import { hostname, tmpdir } from 'os'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import { readPreferences, writePreferences, type Preferences } from './preferences'
import { CURRENT_VERSION } from './version'
import type { BackupLayer } from './backup/backup-plan'
import { formatBytes, plannedTotal } from './backup/backup-size'
import { markPresence, readBackups, lastBackup, lastPerHarness, toPrune } from './backup/backup-store'
import { runBackup } from './backup/backup'
import { probeAll, candidatePaths, createBundle, capturePatch, listUntracked } from './backup/repo-probe'
import { groupRepos, expandHome, type RepoEntry } from './backup/repo-manifest'
import { planRepos } from './backup/restore-plan'
import { readManifestOf, restoreMetrics, restoreRepos, readRestoreState } from './backup/restore'
import { SCHEDULE_IDS, scheduleStatus, type ScheduleId } from './backup/schedule'
import { loadConsolidated } from './consolidate'

const DEFAULT_LAYERS: BackupLayer[] = ['metrics', 'repos']
const DEFAULT_KEEP = 7
const DEFAULT_MAX_BUNDLE = 200 * 1024 * 1024

export interface BackupPrefs {
  schedule: ScheduleId
  layers: BackupLayer[]
  scheduleLayers: BackupLayer[]
  harnesses: HarnessId[]
  destDir: string
  keep: number
  maxBundleBytes: number
}

/** Read the preference block, clamped. Absent reads as OFF — a machine must not start writing
 *  gigabytes because it was upgraded. */
export function readBackupPrefs(p: Preferences): BackupPrefs {
  const b = p.backup ?? {}
  const layers = (b.layers as BackupLayer[] | undefined) ?? DEFAULT_LAYERS
  return {
    schedule: SCHEDULE_IDS.includes(b.schedule as ScheduleId) ? (b.schedule as ScheduleId) : 'off',
    layers,
    scheduleLayers: (b.scheduleLayers as BackupLayer[] | undefined) ?? DEFAULT_LAYERS,
    harnesses: (b.harnesses as HarnessId[] | undefined)?.filter(h => HARNESS_ORDER.includes(h)) ?? [...HARNESS_ORDER],
    destDir: b.destDir ?? join(AGENTISTICS_DATA_DIR, 'backups'),
    keep: typeof b.keep === 'number' && b.keep > 0 ? b.keep : DEFAULT_KEEP,
    maxBundleBytes: typeof b.maxBundleBytes === 'number' && b.maxBundleBytes > 0
      ? b.maxBundleBytes : DEFAULT_MAX_BUNDLE,
  }
}

export type BackupArgs =
  | { kind: 'run'; layers: BackupLayer[]; harnesses: HarnessId[]; destDir?: string; maxBundleBytes?: number; planOnly: boolean }
  | { kind: 'schedule'; schedule: ScheduleId }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

export function parseBackupArgs(argv: string[]): BackupArgs {
  const [first, ...rest] = argv

  if (first === 'help' || first === '--help' || first === '-h') return { kind: 'help' }
  if (first === 'status') return { kind: 'status' }
  if (first === 'schedule') {
    const id = rest[0]
    if (!id || !SCHEDULE_IDS.includes(id as ScheduleId)) {
      return { kind: 'error', message: `schedule takes one of: ${SCHEDULE_IDS.join(', ')}` }
    }
    return { kind: 'schedule', schedule: id as ScheduleId }
  }

  const args = first === undefined ? [] : argv
  const layers: BackupLayer[] = [...DEFAULT_LAYERS]
  if (args.includes('--with-archive')) layers.push('archive')
  if (args.includes('--with-raw')) layers.push('raw')

  let harnesses: HarnessId[] = [...HARNESS_ORDER]
  const hi = args.indexOf('--harness')
  if (hi !== -1) {
    const list = (args[hi + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const bad = list.filter(h => !HARNESS_ORDER.includes(h as HarnessId))
    if (bad.length) {
      return { kind: 'error', message: `unknown harness: ${bad.join(', ')} (known: ${HARNESS_ORDER.join(', ')})` }
    }
    harnesses = HARNESS_ORDER.filter(h => list.includes(h))
  }

  const di = args.indexOf('--dest')
  const destDir = di !== -1 ? args[di + 1] : undefined

  // A repository with no remote has no other home, so it gets a FULL bundle — and a full bundle of
  // a large repository is tens of megabytes. The ceiling is what stops one such repo dominating the
  // archive; over it, the repo is reported by name rather than silently omitted.
  let maxBundleBytes: number | undefined
  const mi = args.indexOf('--max-bundle')
  if (mi !== -1) {
    const mb = Number(args[mi + 1])
    if (!Number.isFinite(mb) || mb <= 0) {
      return { kind: 'error', message: '--max-bundle takes a size in megabytes, e.g. --max-bundle 200' }
    }
    maxBundleBytes = mb * 1024 * 1024
  }

  return { kind: 'run', layers, harnesses, destDir, maxBundleBytes, planOnly: args.includes('--plan') }
}

const USAGE = `Usage:
  agentop backup [--with-archive] [--with-raw] [--harness a,b] [--dest DIR]
                 [--max-bundle MB] [--plan]
  agentop backup schedule <off|daily|weekly>
  agentop backup status
  agentop restore <archive> [--repos] [--only <repo>]

Carry this machine's whole agentistics history to another one.

  A backup always holds your computed metrics and a repository manifest that can rebuild every
  checkout, worktree, unpushed branch and uncommitted diff. --with-archive adds the mirrored
  transcripts; --with-raw adds the harness directories themselves.

  Live credentials are NEVER included. \`restore\` prints each one and the command that
  re-establishes it.`

/**
 * Build the repository manifest: probe every directory the store knows, bundle, patch.
 *
 * `stageRoot` is the directory whose `repos/` subtree is handed to `runBackup` as `assetRoot` and
 * copied verbatim into the archive. Every `bundle` and `patch` recorded on a `RepoEntry` is
 * therefore an ARCHIVE-RELATIVE path (`repos/…`), never a path on this machine — the restore
 * resolves it against wherever it extracted.
 */
async function buildRepoManifest(
  prefs: BackupPrefs, stageRoot: string, log: (l: string) => void,
): Promise<RepoEntry[]> {
  const reposDir = join(stageRoot, 'repos')
  await mkdir(reposDir, { recursive: true })
  const sessions = [...(await loadConsolidated()).values()]
  const paths = candidatePaths(sessions)
  log(`probing ${paths.length} directories with git`)
  const facts = await probeAll(paths)
  const entries = groupRepos(facts, HOME_DIR)

  for (const e of entries) {
    if (e.note === 'gone' || e.note === 'not-a-repo' || e.note === 'outside-home') continue
    const main = expandHome(e.mainPath, HOME_DIR)
    const safe = e.key.replace(/[^A-Za-z0-9._-]/g, '_')

    // A repo with no remote has no other home, so it needs its whole history.
    const rel = `repos/${safe}.bundle`
    const res = await createBundle(main, join(stageRoot, rel), {
      full: e.note === 'no-remote', maxBytes: prefs.maxBundleBytes,
    })
    if (res === 'written') e.bundle = rel
    else if (res === 'too-large') { e.note = 'too-large'; log(`  ${e.key}: bundle over the ceiling — cloning without local-only history`) }

    for (const dir of [e.mainPath, ...e.worktrees.map(w => w.path)]) {
      const abs = expandHome(dir, HOME_DIR)
      const patch = await capturePatch(abs)
      const listed = await listUntracked(abs)
      const untracked = listed.kind === 'files' ? listed.files : []

      // A tree we could not read is RECORDED as unread, never as clean or empty. Either half
      // failing is enough: skipping a directory whose state was never established is the silence
      // this whole module is built to avoid. The restore prints the reason.
      const unread = patch.kind === 'unavailable' ? patch.reason
        : listed.kind === 'unavailable' ? listed.reason
        : null
      if (unread) {
        log(`  ${e.key}: ${dir} could not be read — ${unread}`)
        e.dirty.push({ path: dir, patch: null, untracked, patchUnavailable: unread })
        continue
      }
      if (patch.kind === 'clean' && !untracked.length) continue

      let patchRel: string | null = null
      if (patch.kind === 'patch') {
        // One patch per WORKING TREE, not per repo: a checkout and each of its worktrees are
        // different trees with different uncommitted work, and one file per repo would have them
        // overwrite each other.
        const dirSlug = dir.replace(/[^A-Za-z0-9._-]/g, '_')
        patchRel = `repos/${safe}__${dirSlug}.patch`
        await writeFile(join(stageRoot, patchRel), patch.text)
      }
      // `untracked` is a LIST of names and never the contents — see RepoDirty in repo-manifest.ts.
      e.dirty.push({ path: dir, patch: patchRel, untracked })
    }
  }
  return entries
}

export async function runBackupCli(argv: string[]): Promise<number> {
  const parsed = parseBackupArgs(argv)
  const log = (l: string) => console.log(l)

  if (parsed.kind === 'help') { console.log(USAGE); return 0 }
  if (parsed.kind === 'error') { console.error(parsed.message); console.error(); console.error(USAGE); return 1 }

  const prefs = readBackupPrefs(await readPreferences())

  if (parsed.kind === 'schedule') {
    const p = await readPreferences()
    await writePreferences({ ...p, backup: { ...(p.backup ?? {}), schedule: parsed.schedule } })
    log(`schedule: ${parsed.schedule}`)
    if (parsed.schedule !== 'off') {
      log('Scheduled backups run inside `agentop server`. With the server stopped, none run.')
    }
    return 0
  }

  if (parsed.kind === 'status') {
    const entries = markPresence(await readBackups(), p => existsSync(p))
    const last = lastBackup(entries)
    log(last
      ? `last backup: ${last.at} · ${formatBytes(last.archiveBytes)} · ${last.path}`
      : 'last backup: none (no recorded backup whose file is still on disk)')
    // An incomplete backup must not read as a complete one. `undefined` is not zero: a record
    // written before this field existed does not know, and says so.
    if (last && last.skipped === undefined) {
      log('  (this record predates skip tracking — whether anything was skipped is not known)')
    } else if (last?.skipped) {
      log(`  WARNING: ${last.skipped} path(s) were skipped — re-run \`agentop backup\` to see which`)
    }
    const per = lastPerHarness(entries)
    for (const h of HARNESS_ORDER) log(`  ${h.padEnd(12)} ${per[h] ?? 'never'}`)
    const s = scheduleStatus({
      schedule: prefs.schedule, lastAt: last?.at ?? null, nowMs: Date.now(),
      serverRunning: existsSync(join(AGENTISTICS_DATA_DIR, 'events-producer.json')),
    })
    log(s.kind === 'inactive-no-server'
      ? 'schedule: inactive — the server is not running, so nothing will fire'
      : s.kind === 'off' ? 'schedule: off' : `schedule: next at ${new Date(s.nextAtMs).toISOString()}`)
    return 0
  }

  const destDir = parsed.destDir ?? prefs.destDir
  const effective = { ...prefs, maxBundleBytes: parsed.maxBundleBytes ?? prefs.maxBundleBytes }
  // A temp staging root, removed on every exit path: the bundles and patches belong in the
  // archive, not left lying beside it.
  const stageRoot = await mkdtemp(join(tmpdir(), 'agentistics-backup-'))
  const repos = parsed.layers.includes('repos')
    ? await buildRepoManifest(effective, stageRoot, log)
    : []

  if (parsed.planOnly) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
    log(`layers:    ${parsed.layers.join(', ')}`)
    log(`harnesses: ${parsed.harnesses.join(', ')}`)
    log(`repos:     ${repos.filter(r => !r.note).length} cloneable, ${repos.filter(r => r.note).length} noted`)
    log(`dest:      ${destDir}`)
    log('(nothing was written — drop --plan to run it)')
    return 0
  }

  let result
  try {
    result = await runBackup({
      homeDir: HOME_DIR, destDir, layers: parsed.layers, harnesses: parsed.harnesses,
      repos, assetRoot: stageRoot, agentopVersion: CURRENT_VERSION, hostname: hostname(), onLine: log,
    })
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
  }
  if (!result.ok) { console.error(`backup failed: ${result.reason}`); return 1 }

  log(`before compression: ${formatBytes(plannedTotal(result.sizes, parsed.layers))}`)
  log(`archive:            ${formatBytes(result.record.archiveBytes)}`)
  log(`sha256:             ${result.record.sha256}`)

  // Pruning deletes the FILES and leaves the records. The store is append-only (see BACKUPS_FILE)
  // and already holds the rule that makes rewriting unnecessary: a record whose file is gone is
  // reported absent by `markPresence` from then on, which is the truth and is what the history is
  // for. Rewriting the file to drop them would reintroduce exactly the read-modify-write race the
  // append-only shape exists to remove.
  const entries = markPresence(await readBackups(), p => existsSync(p))
  for (const old of toPrune(entries, prefs.keep)) {
    await rm(old.path, { force: true }).catch(() => {})
    log(`pruned ${old.path}`)
  }
  return 0
}

export async function runRestoreCli(argv: string[]): Promise<number> {
  const log = (l: string) => console.log(l)
  const archive = argv[0]
  if (!archive || archive === '--help') { console.log(USAGE); return archive ? 0 : 1 }
  if (!existsSync(archive)) { console.error(`no such archive: ${archive}`); return 1 }

  const reposPhase = argv.includes('--repos')
  const oi = argv.indexOf('--only')
  const only = oi !== -1 ? argv[oi + 1] : undefined

  const decoded = await readManifestOf(archive)
  if (!decoded.ok) {
    console.error(decoded.reason === 'too-new'
      ? `this archive was written by a newer agentop (manifest version ${decoded.found}) — upgrade first`
      : `the archive's manifest is ${decoded.reason}`)
    return 1
  }
  const manifest = decoded.manifest

  if (!reposPhase) {
    const r = await restoreMetrics({ archive, homeDir: HOME_DIR, onLine: log })
    if (!r.ok) { console.error(`restore failed: ${r.reason}`); return 1 }
    log(`metrics: ${r.written} written, ${r.skipped} skipped (a newer local copy always wins)`)

    log('')
    log('These were NOT in the backup. Re-establish each:')
    for (const s of manifest.omittedSecrets) log(`  ${s.path.padEnd(38)} ${s.restoreWith}`)

    log('')
    const steps = planRepos(manifest.repos, await readRestoreState(), p => existsSync(p), HOME_DIR)
    const pending = steps.filter(s => s.state === 'pending')
    log(`Repository plan: ${pending.length} to clone, ${steps.length - pending.length} skipped.`)
    for (const s of steps.filter(x => x.state === 'skipped')) log(`  skip ${s.key} — ${s.reason}`)
    log('')
    log('Run `agentop restore <archive> --repos` to execute it. It is resumable.')
    return 0
  }

  const r = await restoreRepos({ manifest, homeDir: HOME_DIR, archive, only, onLine: log })
  log('')
  log(`${r.succeeded}/${r.attempted} repositories restored.`)
  for (const f of r.failures) log(`  FAILED ${f.key} — ${f.reason}`)
  for (const s of r.skipped) log(`  skipped ${s.key} — ${s.reason}`)
  if (r.failures.length) log('Re-run the same command to retry only the failures.')
  return r.failures.length ? 1 : 0
}
```

- [ ] **Step 3c: Write `backup/daemon.ts`**

Create `packages/server/server/backup/daemon.ts`:

```ts
/**
 * daemon.ts — the scheduled backup, riding along with the daemon that is already running.
 *
 * Same reasoning as `events/daemon.ts`, and the same discipline: it NEVER takes the daemon down
 * with it. A backup that throws reports the reason once and the watcher carries on doing what it
 * was already doing. The scheduled backup is an addition to that process, never a condition of it.
 *
 * The check is cheap (a preference read and a date comparison), so it runs on a plain interval
 * rather than trying to be clever about when to wake up.
 */
import { hostname, tmpdir } from 'os'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { HOME_DIR } from '../config'
import { readPreferences } from '../preferences'
import { CURRENT_VERSION } from '../version'
import { readBackupPrefs } from '../cli-backup'
import { markPresence, readBackups, lastBackup } from './backup-store'
import { isDue } from './schedule'
import { runBackup } from './backup'

const CHECK_MS = 15 * 60_000

export interface ScheduledBackup { stop(): void }

/** Set `AGENTISTICS_BACKUP=0` to keep the daemon from ever running one. */
const enabled = (): boolean => process.env.AGENTISTICS_BACKUP !== '0'

export function startScheduledBackup(log: (line: string) => void = console.log): ScheduledBackup | null {
  if (!enabled()) { log('[backup] disabled (AGENTISTICS_BACKUP=0)'); return null }

  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const prefs = readBackupPrefs(await readPreferences())
      const entries = markPresence(await readBackups(), p => existsSync(p))
      const last = lastBackup(entries)
      // serverRunning is true by construction: this code only runs inside the daemon.
      const verdict = isDue({
        schedule: prefs.schedule, lastAt: last?.at ?? null, nowMs: Date.now(), serverRunning: true,
      })
      if (!verdict.due) return

      log(`[backup] scheduled run: layers ${prefs.scheduleLayers.join(', ')}`)
      const r = await runBackup({
        homeDir: HOME_DIR,
        destDir: prefs.destDir,
        layers: prefs.scheduleLayers,
        harnesses: prefs.harnesses,
        repos: [],   // the repo manifest is a manual concern: it shells out to git 282 times
        agentopVersion: CURRENT_VERSION,
        hostname: hostname(),
        onLine: l => log(`[backup] ${l}`),
      })
      log(r.ok ? `[backup] wrote ${r.record.path}` : `[backup] failed: ${r.reason}`)
    } catch (e) {
      log(`[backup] not run: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => { void tick() }, CHECK_MS)
  return { stop: () => clearInterval(timer) }
}
```

> **Deliberate limitation, stated:** a scheduled run carries no repository manifest. Building one shells out to git across 282 directories and writes bundles; doing that unattended every day is load the user did not ask for. `agentop backup` (manual) is where the manifest is built. If this proves wrong in use, the fix is a `scheduleRepos` preference, not making it the silent default.

- [ ] **Step 3d: Wire the dispatch**

In `packages/server/bin/cli.ts`, immediately after the `if (command === 'events') { … }` block (~line 449), add:

```ts
if (command === 'backup') {
  const { runBackupCli } = await import('../server/cli-backup.ts')
  const code = await runBackupCli(args)
  process.exit(code)
}

if (command === 'restore') {
  const { runRestoreCli } = await import('../server/cli-backup.ts')
  const code = await runRestoreCli(args)
  process.exit(code)
}
```

In `packages/server/server/otel-watcher.ts`, immediately after `const events = await startEventProducer()` (~line 619), add:

```ts
  // The scheduled backup rides along for the same reason the event producer does — see
  // backup/daemon.ts. Never fatal to this daemon.
  const { startScheduledBackup } = await import('./backup/daemon')
  const backups = startScheduledBackup()
```

and in the same file's `shutdown`, after `await events?.stop()`:

```ts
    backups?.stop()
```

- [ ] **Step 3e: Add the CLI strings**

In `packages/server/server/cli-i18n.ts`, add to the strings object (follow the file's existing EN/PT shape exactly — read the neighbouring `events` entries first):

```ts
  backupScheduleOff: { en: 'schedule: off', pt: 'agenda: desligada' },
  backupScheduleNoServer: {
    en: 'schedule: inactive — the server is not running, so nothing will fire',
    pt: 'agenda: inativa — o servidor não está rodando, então nada vai disparar',
  },
  backupSecretsOmitted: {
    en: 'These were NOT in the backup. Re-establish each:',
    pt: 'Estes NÃO estavam no backup. Restabeleça cada um:',
  },
  backupNoneOnDisk: {
    en: 'last backup: none (no recorded backup whose file is still on disk)',
    pt: 'último backup: nenhum (nenhum registro cujo arquivo ainda esteja no disco)',
  },
```

Then replace the corresponding literal English strings in `cli-backup.ts` with lookups, following how `cli-events.ts` resolves its language.

- [ ] **Step 4: Run the whole suite**

```bash
bun tsc --noEmit
bun test packages/server/server/backup/
bun run cli backup --plan
bun run cli backup status
```

Expected: `tsc` clean; every backup test passes; `--plan` prints layers, harnesses, a repo count and a destination and writes nothing; `status` prints `last backup: none …` plus a line per harness reading `never`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/cli-backup.ts packages/server/server/backup/daemon.ts \
        packages/server/server/backup/cli-backup.test.ts packages/server/bin/cli.ts \
        packages/server/server/otel-watcher.ts packages/server/server/preferences.ts \
        packages/server/server/cli-i18n.ts
git commit -m "feat(backup): agentop backup e agentop restore, e a agenda dentro do daemon

O CLI não decide nada — parseia, chama e imprime. A regra que ele possui é
sobre imprimir: uma falha é uma LINHA nomeando a coisa e o motivo. Um restore
que clona 89 repositórios vai falhar em parte, e uma contagem de sucessos sem a
lista do que não voltou não é um relatório.

A agenda pega carona no otel-watcher e nunca derruba o daemon com ela."
```

---

## Task 12: move the CHAT block into its own settings section (independent)

**Files:**
- Modify: `packages/web/src/pages/settings/PreferencesSettings.tsx` (remove the Chat section, ~lines 267–330 plus its now-unused imports and draft fields)
- Modify: `packages/web/src/pages/settings/ChatSettings.tsx` (receive it, gated)
- Modify: `packages/web/src/lib/settingsSections.ts` (`SettingsViewer.localChat`, and the `chat` case)
- Modify: `packages/web/src/pages/settings/SettingsPage.tsx` (pass `localChat` into the viewer)
- Test: `packages/web/src/lib/settingsSections.test.ts`

**Interfaces:**
- Produces: `SettingsViewer` gains `localChat?: boolean`.

> **The gate is two gates.** `ChatSettings.tsx` holds the enable switch itself, so hiding the whole section when chat is OFF makes the switch unreachable — a one-way door. `chatEnabled` gates the sound and model ROWS; `capabilities.localChat` gates the SECTION. That is exactly the distinction `chat-gate.ts` already draws between "your profile allows this" and "you have it off".

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/settingsSections.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { visibleSettingsSections } from './settingsSections'

const ids = (v: Parameters<typeof visibleSettingsSections>[0]) =>
  visibleSettingsSections(v).map(s => s.id)

test('chat is offered on a machine whose profile allows it', () => {
  expect(ids({ central: false, localChat: true })).toContain('chat')
})

// The section holds the enable switch. Hiding it when chat is merely OFF would make the switch
// unreachable — the user could never turn it back on.
test('chat stays visible when the profile allows it and the user has it off', () => {
  expect(ids({ central: false, localChat: undefined })).toContain('chat')
})

test('chat is absent when the exposure profile denies localChat — there is nothing to switch', () => {
  expect(ids({ central: false, localChat: false })).not.toContain('chat')
})

test('chat is absent on a central, as before', () => {
  expect(ids({ central: true, localChat: true })).not.toContain('chat')
})

test('the other sections are unaffected by the new field', () => {
  expect(ids({ central: false, localChat: false })).toContain('preferences')
  expect(ids({ central: false, localChat: false })).toContain('notifications')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/src/lib/settingsSections.test.ts`
Expected: FAIL — `localChat` is not a property of `SettingsViewer`, and the `chat` case ignores it.

- [ ] **Step 3a: Gate the section**

In `packages/web/src/lib/settingsSections.ts`:

```ts
export interface SettingsViewer {
  central: boolean
  role?: 'owner' | 'member'
  isManager?: boolean
  /** `CAPS.localChat` from /api/team/session. `false` means the exposure profile denies chat
   *  entirely, so the section has nothing to offer. `undefined` (not yet loaded) shows it —
   *  hiding a section on a slow fetch is worse than showing one that is briefly empty. */
  localChat?: boolean
}
```

and change the `chat` case:

```ts
      // Two gates, not one. `chatEnabled` (the user's switch) gates the ROWS inside the section;
      // this gates the SECTION. Collapsing them would hide the enable switch whenever chat is off,
      // which is a one-way door: there would be no way to turn it back on.
      case 'chat': return !v.central && v.localChat !== false
```

- [ ] **Step 3b: Pass the capability in**

In `packages/web/src/pages/settings/SettingsPage.tsx`, extend the viewer:

```ts
  const viewer: SettingsViewer = {
    central: ctx.isCentral,
    role: ctx.me?.role,
    isManager: ctx.me?.memberships.some(m => m.role === 'manager'),
    localChat: ctx.capabilities?.localChat,
  }
```

If `AppContext` has no `capabilities`, add it in `packages/web/src/lib/app-context.ts` as
`capabilities?: { localChat?: boolean }` and populate it in `App.tsx` from the existing
`/api/team/session` fetch. Read `App.tsx` first — if the capability is already in context under
another name, use that name rather than adding a second source.

- [ ] **Step 3c: Move the block**

Cut the entire Chat section from `PreferencesSettings.tsx` — the `<SectionHeader label="Chat" />`
through the end of the chat-model list — plus:
- the `CHAT_MODELS` / `DEFAULT_CHAT_MODEL` import (line 6)
- the `CHAT_SOUNDS` / `DEFAULT_CHAT_SOUND_ID` / `findChatSound` import (line 7)
- the `chatModel`, `chatSoundEnabled`, `chatSoundId` draft fields (lines ~43-45)
- `previewSound` and `previewCtxRef` (~line 115) if nothing else uses them
- the `Volume2` / `VolumeX` icon imports if nothing else uses them

Paste it into `ChatSettings.tsx`, after the existing `<Divider />`, wrapped so it appears only when
chat is on:

```tsx
      {enabled === true && (
        <>
          <Divider />
          <SectionHeader label={pt ? 'Som e modelo' : 'Sound and model'} />
          {/* … the moved block, verbatim … */}
        </>
      )}
```

`ChatSettings.tsx` already owns `enabled`, `capable` and `pt`. It will need the preference
read/write for `chatModel` / `chatSoundEnabled` / `chatSoundId` — reuse the same
`fetch('/api/preferences', { method: 'PUT', … })` shape the file already uses for `chatEnabled`,
and keep the existing save/reset buttons working in `PreferencesSettings.tsx` for the fields that
stayed.

- [ ] **Step 4: Verify**

```bash
bun tsc --noEmit
bun test packages/web/src/lib/settingsSections.test.ts
bun run dev
```

Then in the browser at `http://localhost:47292/settings/chat`, confirm all three states:
1. chat ON → the switch, plus the sound row and the model list
2. chat OFF → the switch only, and turning it on reveals the rest without a reload
3. `AGENTISTICS_PROFILE=public bun run dev` → the Chat entry is absent from the settings menu

Also confirm `settings/preferences` no longer shows a Chat heading, and its Save/Reset still work.

Verify at 390px: `document.documentElement.scrollWidth <= window.innerWidth` on both pages.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/settingsSections.ts packages/web/src/lib/settingsSections.test.ts \
        packages/web/src/pages/settings/ChatSettings.tsx \
        packages/web/src/pages/settings/PreferencesSettings.tsx \
        packages/web/src/pages/settings/SettingsPage.tsx packages/web/src/lib/app-context.ts
git commit -m "fix(web): som e modelo do chat vão para a aba do chat, atrás de dois gates

O bloco morava em Preferências enquanto a seção Chat já existia. E o gate é
DOIS gates: chatEnabled esconde as linhas de som e modelo, capabilities.
localChat esconde a seção — que é a distinção que o chat-gate.ts já faz entre
'seu perfil permite' e 'você tem desligado'. Juntar os dois esconderia o
próprio interruptor sempre que o chat estivesse desligado, e aí não haveria
como religá-lo."
```

---

## Done when

- [ ] `bun tsc --noEmit` is clean and `bun test` is green.
- [ ] `agentop backup --plan` prints a plan and writes nothing.
- [ ] `agentop backup --with-raw` produces an archive; `tar -tf` on it shows **no** `.credentials.json`, `auth.json`, `oauth_creds.json` or `cache.db`.
- [ ] `agentop backup status` names a real last backup, and says `never` for a harness never included.
- [ ] `agentop restore <archive>` on a scratch `$HOME` restores the metrics, prints the omitted secrets, and prints the repo plan **without touching a repository**.
- [ ] `agentop restore <archive> --repos` clones, and running it a second time attempts only what failed.
- [ ] Settings → Chat shows the sound and model only when chat is on, and the section disappears only under a `public` profile.

## Not in this plan (Plan 2)

The cockpit `backup` tab and the web Settings → Backup section. They call the same host and add no
rules; writing them now would mean inventing a `BackupHost` signature this plan might change.

## Deviations from the spec, and why

Two, both deliberate. Recorded here rather than left for a reader to discover as a gap.

1. **`--dir` (write a directory instead of a single archive) is not implemented.** The spec offered
   it as an escape hatch beside the single-file default. Nothing in the restore path needs it, no
   requirement asked for it, and every extra output shape is another thing the verify step has to
   understand. If a real need appears, it is a small addition to `runBackup`'s tail. YAGNI.

2. **Untracked file CONTENTS do not travel — only their names.** The spec said "and their
   contents, subject to the size ceiling". That was wrong, and the reason is Task 1's own decision:
   an untracked `.env`, `credentials.json` or service-account key sitting in a working tree is
   exactly the class of file the exclusion table exists to keep out of the archive, and it is
   invisible to that table because it lives under a repository path rather than a known dotfile.
   Carrying the contents would smuggle back in through the `repos` layer precisely what the secrets
   decision keeps out of the `raw` layer. The restore prints them by name, so "not restored" is a
   fact the user reads rather than a silence they discover.

3. **A scheduled run carries no repository manifest.** Building one shells out to git across 282
   directories and writes bundles. Doing that unattended every day is load the user did not ask
   for, and the manifest's value is highest at the moment someone is about to reformat — which is a
   manual moment. `agentop backup` builds it; the daemon does not. Stated in `backup/daemon.ts`
   itself, with the fix if it proves wrong: a `scheduleRepos` preference, not a silent default.

Everything else in the spec is implemented by a task above, including the parts most easily lost:
the per-harness size and last-backup columns (Tasks 2 and 5), the "a recorded backup whose file is
gone says so" rule (Task 5), the "inactive, never a next time" schedule status (Task 6), the
`stats-cache.json` redirect (Tasks 7 and 10), and the credential grep over the module's own source
(Task 1).
