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
  /**
   * `prefix` — the path STARTS WITH `pattern`. A string prefix, deliberately, not a directory
   * boundary: three rules depend on it matching a filename STEM rather than a directory
   * — `.agentistics/cache.db` must catch `cache.db-wal` and `cache.db-shm`, `.agentistics/git-stats.db`
   * the same, and `.agentistics/server-` must catch `server-47291.lock`. A boundary check would let
   * all of those through.
   *
   * The cost is that a path merely sharing a string prefix is excluded too (a hypothetical
   * `.claude/statsigmoid.json` would match the `.claude/statsig` rule). That direction is
   * over-exclusion, never a credential leak, which is the trade this filter must make: a file
   * wrongly kept out of a backup is recoverable, a credential wrongly let in is not.
   *
   * `contains` — `pattern` appears anywhere in the path.
   */
  match: 'prefix' | 'contains'
  reason: ExcludeReason
  /** For `secret` only: the command that re-establishes it. Required, and tested for. */
  restoreWith?: string
  /** Why this row exists. Rendered by `agentop backup --explain`. */
  why: string
}

/**
 * Credential paths, per harness.
 *
 * A Record, so a new harness cannot be added without a decision about its secrets — the same rule
 * `HARNESS_SORT` enforces for display order, applied to the one table where forgetting a harness
 * puts a key in a tarball. An empty array is a legitimate entry and means "this harness stores no
 * credential under its own directory"; it is a claim, so state the evidence in a comment.
 */
export const HARNESS_SECRETS: Record<HarnessId, ExcludeRule[]> = {
  claude: [
    {
      pattern: '.claude/.credentials.json', match: 'prefix', reason: 'secret',
      restoreWith: 'claude login',
      why: 'Claude Code OAuth credentials — a live session token.',
    },
  ],
  codex: [
    {
      pattern: '.codex/auth.json', match: 'prefix', reason: 'secret',
      restoreWith: 'codex login',
      why: 'Codex CLI credentials, including the id token whose payload carries the tier.',
    },
  ],
  gemini: [
    {
      pattern: '.gemini/oauth_creds.json', match: 'prefix', reason: 'secret',
      restoreWith: 'gemini  (sign in on first run)',
      why: 'Gemini CLI OAuth credentials.',
    },
    {
      pattern: '.gemini/gemini-credentials.json', match: 'prefix', reason: 'secret',
      restoreWith: 'gemini  (sign in on first run)',
      why: 'A second Gemini credential file the oauth_creds rule does not reach — verified present on a real machine.',
    },
    {
      pattern: '.gemini/google_accounts.json', match: 'prefix', reason: 'secret',
      restoreWith: 'gemini  (sign in on first run)',
      why: 'The signed-in Google account identifiers.',
    },
  ],
  copilot: [
    {
      pattern: '.copilot/token', match: 'contains', reason: 'secret',
      restoreWith: 'copilot  (sign in on first run)',
      why: 'Copilot CLI token files.',
    },
    {
      pattern: '.copilot/mcp-oauth-config', match: 'prefix', reason: 'secret',
      restoreWith: 're-authorise each MCP server from inside copilot',
      why: 'Per-MCP-server OAuth tokens. The `.copilot/token` rule does not reach `mcp-oauth-config/<x>.tokens.json`.',
    },
  ],
  antigravity: [
    {
      pattern: '.gemini/antigravity-cli/antigravity-oauth-token', match: 'prefix', reason: 'secret',
      restoreWith: 'agy  (sign in on first run)',
      why: 'Antigravity OAuth token. It lives under the Gemini directory, so no Gemini rule reaches it.',
    },
  ],
  kimi: [
    {
      pattern: '.kimi-code/config.toml', match: 'prefix', reason: 'secret',
      restoreWith: 'restore your api_key in ~/.kimi-code/config.toml',
      why: 'Holds `api_key` alongside ordinary settings. The whole file is excluded: over-excluding costs the user their Kimi settings, which are recoverable, while under-excluding costs them a key, which is not.',
    },
  ],
}

/** Secrets that are not scoped to one harness. */
const CROSS_HARNESS_SECRETS: ExcludeRule[] = [
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
  // This pattern can never match a real path — a `#` never appears in any filename this walks — so
  // it excludes nothing new. It exists only so `omittedSecrets()` names the tokens inside
  // `preferences.json` for the restore to print; the file itself is never walked at all (see
  // `ALWAYS`, above) because it travels REDACTED, staged by `cli-backup.ts`.
  {
    pattern: '.agentistics/preferences.json#team.token', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop member connect <url> <token>',
    why: 'The central tokens inside preferences.json. The file itself travels, redacted — see backup-plan.ts ALWAYS.',
  },
]

const REGENERABLE: ExcludeRule[] = [
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
]

const RUNTIME: ExcludeRule[] = [
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

export const EXCLUDE_RULES: ExcludeRule[] = [
  ...HARNESS_ORDER.flatMap(h => HARNESS_SECRETS[h]),
  ...CROSS_HARNESS_SECRETS,
  ...REGENERABLE,
  ...RUNTIME,
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
  // NOT here, deliberately. `preferences.json` travels REDACTED, staged by `cli-backup.ts`, because
  // it carries live central tokens (`team.token` and `team.connections[].token`) that exist nowhere
  // else on this machine. Walking it would put them in the archive verbatim — in the 4 MB default
  // backup the design says is safe to schedule and carry on a pendrive.
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
    } else if (rel.startsWith(r.pattern)) {
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
 * the metrics are read in. The `repos` layer contributes no source here; its content is produced
 * during the backup and lives nowhere in $HOME — a later task carries it into the archive through
 * a separate route.
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
