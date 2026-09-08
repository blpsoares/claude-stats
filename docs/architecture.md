# Architecture

## Monorepo layout

```
agentistics/
├── packages/
│   ├── core/                         # @agentistics/core — shared, publishable
│   │   └── src/
│   │       ├── types.ts              # All shared types + MODEL_PRICING + calcCost()
│   │       ├── format.ts             # fmt(), fmtCost(), fmtDuration(), fmtFull()
│   │       ├── chatUtils.ts          # formatToolName, TOOL_LABELS, extractNavLinks
│   │       ├── i18n.ts               # PT/EN translations, t()
│   │       ├── otel.ts               # OpenTelemetry metric definitions
│   │       └── index.ts              # Barrel re-export
│   │
│   ├── server/                       # @agentistics/server — CLI + HTTP server
│   │   ├── bin/
│   │   │   └── cli.ts                # Binary entry: agentop setup|server|tui|watch|central|member|autostart|upgrade|check-update
│   │   ├── server/
│   │   │   ├── index.ts              # Bun HTTP server — thin entry, delegates to modules
│   │   │   ├── config.ts             # Path constants + PORT + team env vars (TEAM_*, CENTRAL_USER)
│   │   │   ├── env-config.ts         # .env.config read/write/backup/restore
│   │   │   ├── utils.ts              # Shared FS helpers (createLimiter, safeRead*)
│   │   │   ├── git.ts                # Git stats via git log --numstat; workspace fallback scans subdirectories
│   │   │   ├── jsonl.ts              # JSONL session parser
│   │   │   ├── health.ts             # Health checks + warnings
│   │   │   ├── rates.ts              # Pricing scraper + BRL rate cache
│   │   │   ├── sse.ts                # SSE clients, chokidar watcher, serveStatic, broadcastNotification, triggerSseNotification
│   │   │   ├── data.ts               # Main orchestrator (buildApiResponse)
│   │   │   ├── agent-metrics.ts      # Agent tool_use metrics parser
│   │   │   ├── chat-tty.ts           # Nay chat: ensureNayChat, streamViaClaude
│   │   │   ├── otel-watcher.ts       # Chokidar + OTLP metrics export daemon
│   │   │   ├── preferences.ts        # ~/.agentistics preferences incl. team config (mode/endpoint/token/user)
│   │   │   ├── version.ts            # getVersionInfo() — current vs latest, drives update banners/notifications
│   │   │   ├── autostart.ts          # systemd user service + loginctl linger + ~/.bashrc update-check hook
│   │   │   ├── cli-setup.ts          # `agentop setup` wizard (solo/central/member + autostart offer)
│   │   │   ├── cli-central.ts        # `agentop central …` — thin wrapper over central.sh
│   │   │   ├── cli-member.ts         # `agentop member connect|leave|status` (whoami-verified, no browser)
│   │   │   └── (team mode, see below)
│   │   │       ├── team-tokens.ts        # mint / rotate / revoke / validate tokens (sha256 hashes only)
│   │   │       ├── team-store.ts         # Mongo team-session doc shape (org:memberId:harness:sessionId)
│   │   │       ├── team-stats.ts         # per-member statsCache store (exact Claude totals)
│   │   │       ├── team-ingest.ts        # POST /api/team/ingest → upsert + SSE-on-ingest (real-time central)
│   │   │       ├── team-source.ts        # central-side read of team sessions for buildApiResponse
│   │   │       ├── team-admin.ts         # members-panel admin routes (list/rename/rotate/revoke/policy)
│   │   │       ├── team-uploader.ts      # member→central push: sent-state, sync-signature reconcile, push-on-change, auto-reset on revoke
│   │   │       ├── team-watch.ts         # central: watch the team collection → SSE refresh
│   │   │       ├── team-agent.ts         # central WebSocket registry: presence signals, ping/pong latency, on-demand chat fetch
│   │   │       ├── team-agent-client.ts  # member side of the reverse-channel WebSocket
│   │   │       ├── team-presence.ts      # computePresence() — WS-authoritative online/offline + latency
│   │   │       └── central-config.ts     # Mongo central config: instanceId, pushIntervalSec, includeOfflineData
│   │   └── scripts/
│   │       ├── embed-dist.ts         # Embeds packages/web/dist/ → embedded-dist.generated.ts
│   │       └── ensure-type-stub.ts   # Creates type stub for CI (before full build)
│   │
│   ├── web/                          # @agentistics/web — React + Vite frontend
│   │   ├── src/
│   │   │   ├── App.tsx               # Router, global state, header
│   │   │   ├── pages/
│   │   │   │   ├── HomePage.tsx      # Main dashboard (KPIs, charts, sessions)
│   │   │   │   ├── CustomPage.tsx    # Custom layout builder (/custom)
│   │   │   │   ├── CostsPage.tsx     # Cost deep-dive
│   │   │   │   ├── ProjectsPage.tsx  # Projects overview
│   │   │   │   └── ToolsPage.tsx     # Tool metrics breakdown
│   │   │   ├── hooks/
│   │   │   │   ├── useData.ts        # Fetches /api/data + SSE + useDerivedStats()
│   │   │   │   └── useCustomLayout.ts # Layout state + persistence
│   │   │   ├── components/           # UI components (charts, cards, modals)
│   │   │   │   ├── TtyChat.tsx       # Nay chat panel (FAB + floating panel)
│   │   │   │   ├── PreferencesModal.tsx # Unified Settings modal (Preferences/Live/Install tabs)
│   │   │   │   ├── TeamLogin.tsx     # Central dashboard password login
│   │   │   │   ├── TeamMembers.tsx   # Members panel: mint/rotate/revoke/rename + presence column
│   │   │   │   ├── TeamSettings.tsx  # Central Settings → Team (interval/express, offline-data policy)
│   │   │   │   ├── DeployCentral.tsx # In-app central deploy/help panel
│   │   │   │   ├── PresenceFilter.tsx        # Central filter: online/offline members
│   │   │   │   ├── MemberConnectionStatus.tsx # Member-side connected/reconnecting pill
│   │   │   │   ├── NotificationToasts.tsx    # Auto-dismiss animated toasts
│   │   │   │   ├── NotificationBell.tsx      # Header bell: history + unread badge
│   │   │   │   ├── UpdateModal.tsx   # Mode-aware upgrade instructions modal
│   │   │   │   └── ...
│   │   │   ├── lib/
│   │   │   │   ├── app-context.ts    # AppContext interface (React context shape)
│   │   │   │   ├── componentCatalog.tsx # Catalog of custom layout components
│   │   │   │   ├── chatModels.ts     # CHAT_MODELS, DEFAULT_CHAT_MODEL
│   │   │   │   ├── chatSounds.ts     # CHAT_SOUNDS — 5 Web Audio API notification sounds
│   │   │   │   └── notifications.ts  # Notification store + render-time pt/en i18n (NOTIFICATION_TEXT by code)
│   │   │   └── tui/
│   │   │       └── index.ts          # Terminal TUI (standalone, no browser)
│   │   ├── public/
│   │   │   ├── icons/                # PWA icons (icon-192.png, icon-512.png)
│   │   │   └── ...                   # logo, favicon, etc.
│   │   ├── index.html
│   │   └── vite.config.ts            # Vite config with vite-plugin-pwa (devOptions.enabled: true)
│   │
│   ├── mcp/                          # @agentistics/mcp — MCP server, publishable to npm
│   │   └── agentistics-mcp.ts        # stdio transport, 12 tools, imports @agentistics/core
│   │
│   └── desktop/                      # Tauri v2 Windows installer
│       ├── src/main.rs               # Spawns agentop.exe sidecar, polls health, onboarding
│       ├── ui/index.html             # Loading screen + first-run onboarding UI
│       ├── capabilities/default.json # Tauri v2 permission declarations
│       ├── tauri.conf.json           # Window config, CSP, sidecar declaration
│       └── Cargo.toml
│
├── docs/                             # Extended documentation
├── grafana/                          # Pre-built Grafana dashboard JSON
├── central.sh                        # Team central lifecycle (docker compose): up/init/down/logs/status/restart/pull
├── docker/                           # Every compose file, one per thing you might run
│   ├── central.yml                   # Central, built from this checkout (Mongo NOT published to the host)
│   ├── central.image.yml             # Central, from the published GHCR image — its exact twin
│   ├── central.localdb.yml           # The bundled MongoDB (overlay)
│   ├── central.selfcontrib.yml       # Host harness dirs, read-only (overlay)
│   ├── central.ingest-only.yml       # Token-gated /api/team/ingest and nothing else (overlay)
│   └── machine.yml                   # One machine (solo or member) in a container
├── central.env                       # Generated by `central.sh init` (gitignored — secrets, chmod 600)
├── .env.config                       # Committed port defaults (PORT, VITE_PORT)
├── package.json                      # Root: workspaces + orchestration scripts
└── tsconfig.json                     # Root: paths alias for @agentistics/core
```

## Request lifecycle

```
Browser → GET /api/data
  → packages/server/server/index.ts (Bun.serve)
    → server/data.ts (buildApiResponse)
      ├── server/jsonl.ts       (parse raw JSONL sessions)
      ├── server/agent-metrics.ts (extract agent invocations)
      ├── server/git.ts         (git stats per project)
      └── server/health.ts      (warnings)
    → JSON response

Browser → GET /api/events  (SSE)
  → server/sse.ts (sseClients stream)
    chokidar watches ~/.claude/ → pushes "update" event on change
  → browser calls /api/data again

Browser → POST /api/chat-tty  (Nay)
  → server/chat-tty.ts (streamViaClaude)
    → Bun.spawn(['claude', '--print', '--output-format', 'stream-json'])
      → claude reads NAY_CHAT_DIR/CLAUDE.md + .claude/settings.json
      → MCP tools → GET http://localhost:47291/api/data
    → stream-json chunks → SSE stream → TtyChat.tsx
```

## Team Mode

Team Mode lets one machine ("central") aggregate coding-assistant usage metrics from many machines ("members"). Members push **computed metrics only** — session/agent/token/cost aggregates plus their statsCache — **never chat transcripts** (raw chat is fetched on demand over a reverse WebSocket, not stored centrally). Data lives in Mongo, which is **not published to the host** (reachable only inside the compose network).

### Roles

Every machine picks one role, persisted at `preferences.team.mode`:

- **solo** — local only, nothing leaves the machine (the default).
- **central** — the aggregator. Runs as a Docker service via `central.sh` (default port `48080`, distinct from a solo/dev server's `47291`). Serves the team dashboard behind a password.
- **member** — pushes its computed metrics to a central's `/api/team/ingest`.

### central.sh + `agentop central`

`central.sh` (repo root) wraps `docker compose` with the project name and env file pre-set; `agentop central <up|init|down|logs|status|restart|pull>` shells out to it (`server/cli-central.ts`, stdio inherited so interactive prompts and log streaming work). Key subcommands:

- **`init`** — interactive: prompts each value, auto-generates the secrets with `openssl`, detects the Tailscale IP as a suggestion, writes `central.env` (`chmod 600`).
- **`up`** — ensures `central.env` exists (offers `init`), then builds and `--force-recreate`s the containers.
- **`down`** — stops the containers but **keeps the data volume** (only `down -v` wipes it, which mints a new `instanceId` — see reconciliation below).

`central.env` variables: `APP_PORT` (default `48080`), `BIND_IP` (default `127.0.0.1` — this host only, which is all a tunnel or reverse proxy needs; set `0.0.0.0` for the LAN or a Tailscale IP for a private tailnet), `AGENTISTICS_TEAM_SESSION_SECRET` (HMAC cookie key — **never** derived from the password; leave empty and a random one is generated and persisted), `AGENTISTICS_EXPOSURE` (`local`/`lan`/`public` — see [exposure.md](exposure.md)), `AGENTISTICS_TRUST_PROXY`, `AGENTISTICS_ALLOWED_ORIGINS`. The full security model — threat model, trust boundaries, request pipeline and the limits of each control — is in [security.md](security.md), `AGENTISTICS_TEAM_ORG`, `AGENTISTICS_TEAM_INGEST_TOKEN` (optional shared secret), `AGENTISTICS_CENTRAL_USER` (set when the central also contributes its own machine's data).

### Restart policy — both services survive a host reboot

Both the `app` **and** the `mongo` services carry `restart: unless-stopped` (in `docker/central.yml`, `docker/central.image.yml` and the compose materialized by `cli-central.ts`). Without it on `mongo`, a host reboot that crashes Mongo (e.g. an OOM kill under WSL) leaves the `app` back up but pointed at a dead database — the dashboard then shows **zero members** even though the data volume (`mongo_data`) is intact.

**Migrating an already-running central** (the policy only takes effect once the container is recreated):
- After upgrading, run `agentop central up` once — it re-materializes the compose and `--force-recreate`s Mongo with the policy baked in.
- Or apply it live, without any recreate or downtime: `docker update --restart unless-stopped team-mode-mongo-1`.

### Member identity

A member does **not** name itself — the display name is set by the central when it mints the token, and the member resolves it via `GET /api/team/whoami` (`server/cli-member.ts`, `memberConnect`). Sessions are keyed centrally by a stable `memberId` (the token's sha256 hash), so renaming a member keeps history. `agentop member connect` never writes a half-config: it only persists `preferences.team` after whoami accepts the token.

### Push model — central-owned interval + push-on-change

The **central owns the cadence** (`server/central-config.ts`, `pushIntervalSec`; normal floor 15s, default 30s, express down to 5s via `EXPRESS_MIN_SEC`). Members fetch it from `GET /api/team/policy` each cycle and can only follow it — there is no member-side override that goes faster. On top of the periodic timer, `server/team-uploader.ts` also does **push-on-change**: the file watcher calls `notifyDataChanged()`, which schedules a debounced push (coalesces bursts, never sooner than the central's interval since the last success). Members push their **supplemented** statsCache (the one the local dashboard shows, gap-filled past the stale `lastComputedDate`), not the raw `~/.claude/stats-cache.json`, so central totals match the member's own dashboard exactly.

### Batch size and its timeout — one decision, not two

A push splits its sessions into batches, and **a batch is the unit of durable progress**: the
sent-state advances only after the central ACCEPTS one. A batch that can never complete therefore
records nothing, and the next cycle sends exactly the same sessions again — forever.

That is not hypothetical. A batch size of 200 was chosen in one place and a flat 15s ingest timeout
in another, with nothing checking that one fit the other. A real remote central costs ~195 ms per
session (Mongo upserts + stats + SSE fan-out, over the public internet), so 200 sessions need ~39s.
Measured on a live member: **1.260 consecutive failures, a sent-state still `{}`, and
`lastSuccessAt: null`** — a machine that had never once pushed while its central answered every
other request in under a second.

So `server/ingest-batch.ts` (**pure**) owns both numbers:

- **The timeout is DERIVED from the batch** (`ingestTimeoutMs(n)`), never stated beside it, so they
  cannot drift apart again. It stays bounded (`MAX_TIMEOUT_MS`) because the timeout's original job
  is to guarantee a `MAX_CONCURRENT_PUSHES` slot is released when a wedged proxy accepts a
  connection and never answers.
- **The batch adapts** (`nextBatchSize`): a derived timeout still rests on an estimate of someone
  else's hardware, so a failed push halves the batch and a successful one grows it back toward the
  ceiling. A central slower than the estimate converges on a size it can serve instead of retrying
  an impossible request. Growth is gradual on purpose — jumping straight back to the ceiling would
  fail, drop to the floor and fail again, which is the same non-convergence in a slower loop.
- **The ceiling is far below the old 200.** Smaller batches cost round trips and buy durable
  progress: a member whose network drops mid-push keeps every batch already accepted.

### Real-time central

A member push lands in `server/team-ingest.ts`, which upserts the sessions/stats and then calls `triggerSseNotification()` — the central's dashboards refresh live over SSE without polling. This is why the "Live" toggle is **hidden on a central**. `server/team-watch.ts` also watches the team collection as a fallback SSE source.

### Presence — WebSocket-authoritative

Presence is computed by `server/team-presence.ts` from the reverse-channel WebSocket registry in `server/team-agent.ts`:

- A member is **online** while its WebSocket is live (source of truth). Killing the app drops the socket → **offline within ~8s** (`SOCKET_GRACE_MS`, absorbs brief reconnects).
- Once a member has *ever* held a socket this run, the socket signal is trusted; a **heartbeat window** (`server/team-presence.ts`) is only the fallback for pure-HTTP members that never opened a socket.
- **Latency** comes from WebSocket ping/pong RTT (`PING_INTERVAL_MS`; a socket missing `MAX_MISSED_PONGS` pings is force-closed so a hard-killed machine still flips offline).
- The central admin gets a "machine connected" notification (throttled per member).

The members panel (`TeamMembers.tsx`, central Settings → Team) can **mint**, **rotate** (new credential that migrates the member's sessions+stats to the new identity, preserving history), **revoke** (confirmation modal; cascade-deletes that member's data), and **rename**. There is a per-central "show offline members' data" policy (`includeOfflineData`) and filters for members / harnesses / projects / presence.

### Auto-reconciliation (self-healing sync)

`server/team-uploader.ts` fingerprints the push target as `sha256(endpoint \0 token \0 instanceId)` and stores it in the sync file. When the fingerprint changes — the central DB was wiped (`down -v` → new `instanceId`), the token was revoked and re-added, or the endpoint changed — the member clears its sent-state and **re-pushes its full history** on the next cycle (idempotent upserts, so no double-counting). No manual `team-sent.json` deletion. A persistent 401/403 (revoked token) trips `handleAuthError` after a couple of cycles: the member **auto-resets to solo** and emits a "removed from central" notification. A `null` instanceId (old/unreachable central) never triggers a spurious reset.

### Notifications

`packages/web/src/lib/notifications.ts` is a small external store rendered by `NotificationToasts.tsx` (auto-dismiss, animated) and `NotificationBell.tsx` (history + unread badge). Notifications carry a `code` (+ `meta`) and are localized **at render time** (`NOTIFICATION_TEXT`, pt/en) so they follow the language toggle. The server emits them via `broadcastNotification()` (SSE). Fired on member auth/connection errors, "removed from central", "machine connected", and "update available".

### Per-connection repository sharing

A member can push to more than one central (`preferences.team.connections: TeamConnection[]`) and can restrict what each connection receives **per connection** — a repo or project hidden from central A can still go to central B. Rules apply across **two dimensions** — repository (`git_remote`) and project (`project_path`) — and each connection picks one of **two modes**: `denylist` ("share everything except…", the default and the legacy behaviour) or `allowlist` ("share only…"). The full design is `docs/superpowers/specs/2026-07-28-multi-central-and-repo-sharing-design.md` plus its Plan 4 addendum; this is what shipped from it. Three layers:

- **The pure decision layer — `server/share-rules.ts`.** `sessionShared(session, rules, index)` is the one predicate that decides whether a session may leave the machine for a given connection, where `rules` is `{ mode: 'denylist' | 'allowlist', sources: ReadonlySet<string> }` keyed as `` `${type}:${value}` `` (`repo:<canonical key>`, `project:<project_path>`, or the fixed `none:` bucket for sessions that resolve to no repository at all). A session **matches** a source when: `repo` — its canonical repo key equals the value (including via `buildPathRepoIndex`, for adapters that never stamp a remote); `project` — its `project_path` equals the value; `none` — it resolves to no repository. In **denylist** mode a session is shared unless it matches SOME source ("deny wins across dimensions": matching a blocked repo denies it even if its project is not listed). In **allowlist** mode a session is shared only if it matches SOME source — and an allowlist with an EMPTY source set shares NOTHING, deliberately; the opposite reading is exactly the one that would leak everything. The `conflictPaths` rule (a directory known to hold more than one repo) survives unchanged in both modes: denylist shares such a path only if every repo under it is shared; allowlist shares it only if some repo is allowed and none is excluded — a workspace holding a shared and a blocked repo would otherwise leak the blocked one's `first_prompt` under the shared key. `filterShared` / `filterSharedWorkflows` apply the predicate to sessions and workflow runs; a run whose owning session is unknown is dropped, never kept. `buildSplitStatsCache` is the attribution-split half — see below. Every function is pure and fails closed: uncertain attribution means "not shared", never "shared by default".
- **The push path — `server/team-rules.ts` + `server/team-uploader.ts`.** `planRulesReconcile` is the pure detector that runs every push cycle per connection: it diffs the current denylist's signature against the last-persisted one, computes which previously-sent session/run ids the *current* denylist now excludes (`forgetIds`/`forgetRuns` — see below), and advances the seal ledger (see the attribution split). `team-uploader.ts` calls `filterShared`/`filterSharedWorkflows` before every push and `buildSplitStatsCache` before every statsCache push — a restricted connection never sees the unfiltered store.
- **The central — `server/team-forget.ts` + `server/team-capabilities.ts`.** `POST /api/team/forget` deletes named sessions (+ their workflow runs) scoped to the token's own `memberId`; `GET /api/team/policy` advertises `capabilities: [..., 'forget.sessions']` so a member can tell whether a central understands the route at all.

**The attribution split.** `stats-cache.json`'s aggregates cannot be filtered per-session — a day's row is a sum, not a list. `buildSplitStatsCache` (`share-rules.ts`) solves this by splitting the cache at **`attributionBoundary(real)`: the day *after* Claude's own `lastComputedDate` rollup watermark**, not wherever the consolidate store happens to begin. Days at or before the watermark are Claude's rollup verbatim — nobody, including this machine, can decompose them by repository, because the store is measurably a strict subset of what Claude already rolled up. Days at or after it are rebuilt from-scratch from the (denylist-filtered) session store, which is exact because the same store produced the field being subtracted from. **Totals never shrink**: the prehistory block travels unfiltered, only the decomposable window is filtered, which is what keeps a restricted machine's own dashboard numbers reconcilable with what it pushes.

As Claude's watermark advances, a day that is decomposable today becomes part of the untouchable rollup tomorrow — so each cycle, while a day is still decomposable, the denied delta for that day is measured and, the moment the watermark crosses it, **sealed**: kept forever and subtracted from the rollup row from then on. Un-blocking a repo does not un-seal a day; a sealed day's excluded volume cannot be restored to a central because there is no longer a decomposable row to add it back to.

**The split cache is selected by the declared rule, `sourcesRestrict(conn.shareMode, conn.sources)` — never by comparing filtered vs. unfiltered counts.** A count-based switch fails open on a cold consolidate store (`0 < 0` is false) and flips without any corresponding user action. Allowlist mode is **always** a restriction, even with an empty source list — that is the strictest case, not the absence of one; denylist mode is a restriction only once it names at least one source (the legacy `hasRestrictions` behaviour, kept for the read migration). On the restricted path there is **no fallback to the unsplit cache, ever**: `buildSplitStatsCache` returns `null` whenever it cannot build a faithful split (no attribution boundary, an unreadable real cache, the cold-store signature), and the push omits `statsCache` entirely rather than shipping the unfiltered one. `withUnresolvedSources` — the fail-closed default applied the moment a connection acquires its first restriction — applies to **denylist mode only**: in allowlist mode the unattributed (`none:`) bucket is already hidden by default like everything not explicitly listed, so there is nothing to add.

**The removal sequence** (`team-forget-client.ts`'s `runForgetSequence`, triggered by `planRulesReconcile` finding `forgetIds`/`forgetRuns`) is what withdraws sessions already pushed before a repo was blocked:

0. capability check (`connectionCanForget`) + `GET /api/team/whoami` proves which identity the central will act on — the trigger is **denial, never absence**: a session merely missing from a short-read store is never mistaken for a session that became denied.
1. write the removal journal to disk **before** the first delete — a crash mid-sequence resumes from the journal at boot; deleting an already-deleted id is a no-op.
2. `POST /api/team/forget { sessionIds }` in batches of 500, asserting on the response **body** (`ok === true`), never on `res.ok` — a reverse proxy can turn a 404 into a 200 HTML page.
3. advance the sent-state **per acked batch**, never up front, so an interrupted sequence is resumable rather than self-defeating.
4. push the rebuilt split statsCache in the same cycle.
5. delete the journal only once the cache push has landed.

The central-side delete is a **scoped delete of named sessions**, never a purge — the member's `memberStats` document is never touched, so no *other* machine's machine/team filter degrades while a removal runs. `POST /api/team/forget` is minted-token-only with no legacy `{org,user}` fallback (deliberately unlike `POST /api/team/leave`), and a central that does not advertise `forget.sessions` gets `canForget: false` and a disabled rules editor — never a fallback to a destructive full purge.

See [security.md](security.md) for the precise guarantee this gives a user, and its five explicit non-guarantees.

### Managing a machine's sessions from a central

A person signed in to a central can see and act on the sessions of a machine **their own account
owns**. It is off until the machine turns it on, and it is the machine — never the central — that
decides what it will answer.

**Two switches, not one** (`remoteSessions.ts`, `@agentistics/core`). The first grants the session
LIST and the verbs that need no screen; the second additionally lets the session's TERMINAL travel.
They are separate because they are different questions: "let me rename a session from my phone" is
not consent to "stream my terminal to the central", and on-demand chat retrieval was removed from
this channel on purpose (`team-agent.ts`; `GET /api/team/session-chat` is a 410). Absent reads as
OFF, and withdrawing the first clears the second rather than leaving it stored and inert — a grant
left behind comes back the moment the first is switched on again, which is a grant nobody re-made.

**The machine announces; the central never asks.** Consent travels as an unsolicited
`remote-consent` frame on the existing reverse WebSocket, on connect and the instant a switch moves,
and the central holds it in memory for the socket's lifetime only (`machine-consent.ts`). A machine
that is gone is not making a statement, so "has not said" and "says no" stay different answers —
one sends the owner to check whether the machine is running, the other to the switch.

**The relayed row is built by an allowlist** (`reduceMachineFleetRow`, `@agentistics/core`), not by
deleting the fields known to be dangerous today: a spread-and-delete leaks the next field somebody
adds to `ControlSession`. The screen, the conversation and the permission dialog cannot cross. The
member applies its own sharing rules FIRST, so a session in a withheld repository never becomes a
row, and what was withheld is reported as a count rather than silently subtracted.

**Verbs are decided and worded by the machine.** `machineActions.ts` is a closed allowlist — an
action it does not know is refused — and it deliberately excludes `approve` and `prompt`, which
cannot be offered honestly without the screen. The member re-checks consent and the verb on every
request: a central is the party whose behaviour a machine cannot verify, so a check that runs only
there is not a check. Every relayed action is audited on the central (`machine.session_action`) and
announced on the machine itself.

Three routes, and none of them touches the host: `GET /api/team/machine-fleet`,
`POST /api/team/machine-fleet/act`, plus the `fleet-request`/`fleet-reply` correlation over the
reverse channel (`machine-fleet-relay.ts`). The `TEAM_CENTRAL` block on `/api/fleet*` and its
`localShell` entry in `capability-guard.ts` are untouched — a central answering `/api/fleet` from
its own box would serve its own processes under a member's name.

See [security.md](security.md) and
`docs/superpowers/specs/2026-09-02-central-session-management-design.md` for the design and its
stated limits.

## Repository dimension (group by git remote)

Metrics can be grouped **by repository** — the git remote — independently of the local checkout path or which machine produced the session. So a repo's usage aggregates across every dev's laptop *and* its CI runs, even though those live on different machines with different paths.

### The key — `normalizeGitRemote`

`normalizeGitRemote(url)` in `@agentistics/core` collapses any remote form (https / ssh / scp / git, with or without credentials / port / `.git`) into a stable, **protocol-less** key `host/org/repo` (e.g. `github.com/org/repo`). It is the **single source of truth** — repos are never keyed by parsing the local path. `repoShortName(remote)` drops the host for display (`org/repo`); a session with no resolvable remote falls into the "no linked repository" bucket (shown, never hidden).

### How it is captured and threaded

- `server/git.ts getGitRemote(projectPath)` reads `remote.origin.url` and normalizes it (same Windows/WSL + no-prompt guards as the other git helpers).
- `server/data.ts scanProjectDir` resolves the remote **once per project** and **stamps `SessionMeta.git_remote` onto every session** (plus `ServerProject.gitRemote`). Because it lives on the session, the remote travels into the consolidate store → team uploader → Mongo — the central has no filesystem access to members' repos, so per-session is the only place it can live.
- Frontend: `useDerivedStats` builds `repoStats` (per-remote aggregate) and honors a `Filters.repos` filter, scoping cost/tokens session-side like a project filter. The **Repositories** page (`RepositoriesPage` → `RepoDetailPage`) renders cards → per-repo detail (Overview / Members / Actions / Sessions / Workflows).

### GitHub Actions — `SessionMeta.ci` + repo registration

An ephemeral Claude Code Actions runner pushes its metrics with `agentop ci-push` → `POST /api/team/ingest`, so a repo's dashboard shows **local devs + cloud agents together**. Attribution is **server-authoritative**: the central stamps `git_remote` + `ci: true` + `user = github-actions` from a *verified* identity (`stampCiSessions`) — a runner can never mis-report its repo. Two auth paths:

- **Keyless GitHub OIDC (recommended)** — the runner presents a short-lived GitHub-signed JWT; the central verifies it against GitHub's JWKS (`server/team-oidc.ts`, via `jose`: issuer / audience / expiry) and checks the `repository` claim against the **registered-repos allowlist**. No secret stored. Enabled by `AGENTISTICS_OIDC_AUDIENCE` on the central.
- **Repo-bound static token (fallback)** — minted by registration, stored only as a sha256 hash, sent as `Authorization: Bearer`.

**Registering a repo** is an admin action (central **Settings → Team → Repositories**, the `TeamRepos` panel, or `POST /api/team/repos`). It allowlists the normalized remote and mints the fallback CI token; the panel also generates a ready-to-paste workflow push step. Re-registering **rotates** the token; unregistering revokes it (both drop that repo's CI data). CI sessions are keyed by `ciMemberId` (`repo:<remote>`) and power the **Repositories → Actions** view.

### Ingest-only hardening

A cloud runner needs the central reachable without exposing the dashboard. `AGENTISTICS_INGEST_ONLY=1` makes a central serve **only** `POST /api/team/ingest` (404 for everything else, gated right after the OPTIONS handler in `index.ts`) — run it as a public ingest instance sharing Mongo with a separate private dashboard instance.

See [`docs/github-actions.md`](./github-actions.md) for the end-to-end GitHub Actions setup.

## CLI (`agentop`)

`packages/server/bin/cli.ts` is the single command surface for the compiled binary:

| Command | What it does |
|---------|--------------|
| `setup` | Interactive first-run wizard — pick solo / central / member, then optionally enable autostart (`server/cli-setup.ts`). Bare `agentop` on a TTY when the machine is unconfigured launches this. |
| `server` | Dashboard + background daemon (`SERVE_STATIC=1`; API + embedded frontend + otel-watcher on one port). |
| `tui` | Standalone terminal dashboard. |
| `watch` | OTel metrics daemon only. |
| `central <up\|init\|down\|logs\|status\|restart\|pull>` | Wraps `central.sh` (`server/cli-central.ts`). |
| `member <connect\|leave\|status>` | Configure this machine as a member (`server/cli-member.ts`). `connect --endpoint <url> --token <tok> [--org <o>]` verifies via whoami before saving. |
| `autostart <server\|central\|watch> <enable\|disable\|status>` | Register a mode to start with the system (`server/autostart.ts`). Linux/WSL: a systemd **user** service + `loginctl enable-linger`, and installs a `~/.bashrc` hook running `agentop check-update` on terminal open. macOS/Windows print a manual step. `autostart status` (no mode) lists all. |
| `upgrade` | Self-update to the latest version. |
| `check-update` | Prints the "update available" banner only when outdated; silent when current (this is what the `.bashrc` hook runs). |

**Update detection** is everywhere: on any command run (banner via `checkVersionAndWarn`), on boot/terminal (the `.bashrc` hook), and on the dashboard (bell notification + a **mode-aware** `UpdateModal.tsx` with the exact upgrade+restart command — central: `bun run up:central`; member: `agentop upgrade` then `systemctl --user restart agentop-server`). A periodic (~6h) server re-check pushes the update notification over SSE. All version logic lives in `server/version.ts`.

## Binary build pipeline

```
bun run build           →  packages/web/dist/                              (Vite)
bun run build:assets    →  packages/server/server/embedded-dist.generated.ts
bun build --compile     →  release/agentop                                 (self-contained binary)
```

The binary embeds the full Bun runtime + all JS/TS code + frontend assets. No external dependencies needed — `agentop server` binds two ports with one shared request handler: the **web dashboard on 47292** (the URL you open) and the **api + mcp on 47291**. Because both ports run the same handler, the dashboard served from 47292 makes same-origin `/api/*` calls that resolve locally.

In dev mode, the API runs on port 47291 and Vite serves the frontend with hot reload on port 47292 — the same web-on-92 / api-on-91 split.

## Windows desktop app

The Tauri app (`packages/desktop/`) is a native Windows wrapper:

1. On launch, reads config from `%APPDATA%\Agentistics\config.json`
2. If not configured: shows onboarding screen — auto-detects `%USERPROFILE%\.claude` and WSL paths via `\\wsl.localhost\{distro}\home\*\.claude`
3. Once configured: spawns `agentop.exe` as a sidecar with `CLAUDE_DIR` env var
4. Polls `http://localhost:47291/api/health` every 250ms (up to 30s), then navigates the WebView to the dashboard
5. On window close: kills the sidecar process

CI builds the installer on `windows-latest` after the Linux runner cross-compiles `agentop.exe`.

## Port configuration

Ports are configured in `.env.config` at the repository root:

```ini
PORT=47291      # api + mcp (binary mode also binds PORT+1 = 47292 for the web dashboard)
VITE_PORT=47292 # Vite dev server (dev mode only)
```

Edit via the `</>` button in the header or directly in the file (restart required).

## Calculation functions — single source of truth

All layers import from `@agentistics/core` (`packages/core/src/types.ts`). Never inline pricing calculations.

| Function | Usage |
|----------|-------|
| `MODEL_PRICING` | Pricing table, USD per 1M tokens |
| `getModelPrice(modelId)` | Resolves price by model ID (exact then partial match) |
| `calcCost(usage, modelId)` | Total cost from a `ModelUsage` record |
| `blendedCostPerToken(modelUsage)` | Weighted average rate — used in `useData.ts` for filtered views and PDF export |

## Tech stack

### Frontend (`packages/web/`)

| Library | Version | Usage |
|---------|---------|-------|
| React | 19.2 | UI |
| Vite | 8.0 | Build tool + dev server |
| TypeScript | 5 | Strict typing |
| Recharts | 3.8 | Area charts, bar charts |
| react-markdown | 10.x | Markdown rendering in Nay chat |
| lucide-react | 1.7 | SVG icons |
| date-fns | 4.1 | Date manipulation |
| html2canvas + jspdf | 1.4 / 4.2 | PDF export |

### Backend (`packages/server/`)

| Technology | Usage |
|-----------|-------|
| Bun | HTTP server, subprocess spawning, file I/O |
| chokidar | File watching for live updates and OTel daemon |
| @modelcontextprotocol/sdk | MCP server implementation |
| @opentelemetry/* | Metrics export (optional) |

### Desktop (`packages/desktop/`)

| Technology | Usage |
|-----------|-------|
| Tauri v2 | Native window + WebView wrapper |
| Rust | Sidecar spawn, health polling, config management |
| tauri-plugin-shell | Sidecar process lifecycle |
| reqwest | HTTP health check in Rust async |

## Key design decisions

**No database** — all data read directly from Claude Code's local files. Zero setup, zero schema migrations, always fresh.

**Single API endpoint** — `/api/data` returns everything in one call. The frontend derives all views from this response using `useDerivedStats()`. Filtering is purely client-side.

**`stats-cache.json` for aggregates, JSONL for details** — the stats cache is fast (pre-computed by Claude Code) but has no project granularity. Project breakdowns are computed from individual session records.

**Nay runs as a subprocess** — `claude --print` is spawned by the server, not called via API. Nay inherits the full Claude Code CLI environment without extra integration work.

**Binary embeds the frontend** — `agentop server` serves both API and UI from a single process on a single port. No Nginx needed.

**`@agentistics/core` as shared package** — types, pricing functions, and formatters live in one place. Server, web, and MCP all import from `@agentistics/core`. Nothing is duplicated.

**PWA installable** — `vite-plugin-pwa` makes the web app installable as a PWA (enabled even in dev mode via `devOptions: { enabled: true }`). API calls are always `NetworkOnly`; static assets are cached. Icons live at `packages/web/public/icons/`.

**Unified Settings modal** — `PreferencesModal.tsx` replaced separate modals with a single tabbed interface: Preferences (lang/theme/currency/sounds), Live (update interval), and Install (web PWA + desktop download). The old Environment (port config) tab was removed.

**Team Mode ships no per-machine secrets to the wire** — members push computed metrics only, never chat; tokens are stored **only as sha256 hashes** (`server/team-tokens.ts`) and never logged; the central's session cookie secret is kept separate from the dashboard password; auth comparisons are constant-time; Mongo is not published to the host; and `BIND_IP` can pin the listener to a private tailnet (Tailscale encrypts the transport, so plain http inside it is fine). See the "Team Mode" section above.

**`files_modified` takes max of two sources** — `server/jsonl.ts` tracks unique file paths from Edit/Write/MultiEdit tool calls, then takes `Math.max(gitFileStats.filesModified, claudeFilesModified.size)`. The FILES KPI in `useData.ts` prefers the session-level count and only falls back to project-level git stats if sessions show 0.

**`getProjectGitStats` handles workspace folders** — if a project path is not itself a git repo, `server/git.ts` scans one level of subdirectories and aggregates stats from all git repos found there. This covers workspace folders like `~/zuke` that contain multiple repos.
