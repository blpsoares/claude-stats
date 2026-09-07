# Security model

What protects an Agentistics instance, how the pieces fit together, and — as importantly —
what each control does **not** do.

This is the reference. Two neighbouring documents cover the other angles:
[exposure.md](exposure.md) is the operator runbook for publishing a central, and
[SECURITY.md](../SECURITY.md) is the vulnerability disclosure policy.

---

## 1. What is being protected

A central holds, for every developer and CI runner in an organisation: project paths, git
remotes, session titles and first prompts, token and cost aggregates, machine tokens (hashed),
account password hashes, and — only when `AGENTISTICS_CENTRAL_USER` is set — read-only mounts of
the host's `~/.claude`, `~/.codex`, `~/.gemini` and `~/.copilot`, which contain **raw
conversation transcripts**.

Members never push chat. Raw transcripts are fetched on demand over the reverse WebSocket and
are never stored centrally.

## 2. Threat model

Defended against:

| Attacker | Primary controls |
|---|---|
| **Unauthenticated internet** — scans the hostname, hits every route, brute-forces login, fuzzes tokens | capability guard, deny-by-default gate, rate limiting, security headers |
| **Authenticated low-privilege account** (legitimate or stolen) escalating to owner, to other teams' data, or to the host | role gate, per-team scoping, capability guard, step-up |
| **Malicious website in a logged-in user's browser** | `SameSite=Strict`, CSRF origin checks, CSP `frame-ancestors 'none'`, no wildcard CORS |
| **Compromised member machine** with a leaked machine token | per-machine tokens, individually revocable, sha256-hashed at rest |
| **Supply chain** — a malicious transitive dependency or tampered image | `bun audit` in CI, lockfile drift check, Dependabot |

Explicitly **out of scope** (see §7 for why this matters):

- A compromised **host**. Shell on the machine reads `central.env` and the Mongo volume.
- A malicious or compromised **owner account**. Owner is fully trusted by design.
- A compromised **Cloudflare account** or tunnel credential.
- Physical access.
- Vulnerabilities in the AI coding assistants whose data this project reads.

## 3. Trust boundaries

```
   internet ─┬─► Cloudflare edge  (WAF, rate limit, optional Access)
             │
             └─► tunnel (outbound-only; no inbound port on the host)
                   │
                   ▼
              ┌──────────────────────────────────────────┐
              │ container: uid 10001, read-only rootfs,   │
              │            cap_drop ALL, no-new-privs     │
              │  ┌────────────────────────────────────┐   │
              │  │ app: capability guard → rate limit │   │
              │  │      → CSRF → auth → role → MFA    │   │
              │  │      → step-up → handler → scoping │   │
              │  └────────────────────────────────────┘   │
              └───────────────┬──────────────────────────┘
                              │ compose network only
                              ▼
                        MongoDB (never published, never tunnelled)
```

Each boundary is independent. A failure of the application logic still meets a container with no
root, no capabilities and an immutable filesystem; a failure of the container still meets a host
with no inbound port open.

## 4. The request pipeline

Order matters, and every step is where it is for a reason
(`packages/server/server/index.ts`):

| # | Step | Why here |
|---|---|---|
| 1 | Path normalisation | `//api/x` must not slip past exact-match route tables |
| 2 | `INGEST_ONLY` short-circuit | a public ingest instance exposes nothing else, not even a 401 |
| 3 | Client IP resolution | everything below keys off it; forwarded headers only trusted under `AGENTISTICS_TRUST_PROXY` |
| 4 | **Rate limiting** | before any expensive work, so an unauthenticated caller cannot spend CPU |
| 5 | **CSRF** | before auth, so a cross-site request is refused without touching the session |
| 6 | **Capability guard** | before auth, so an exposed instance does not reveal whether the caller is authenticated |
| 7 | **Auth** — session cookie → principal | deny-by-default: everything under `/api` outside `AUTH_PUBLIC` |
| 8 | **Role** — owner-only admin paths | includes nested detail routes |
| 9 | **MFA enrolment** gate | a `public` owner without a second factor reaches only enrolment |
| 10 | **Step-up** | destructive operations need proof of presence, not just of identity |
| 11 | Handler | per-resource authority (tags by source, machines by ownership) |
| 12 | **Team scoping** of the response | a principal never receives another team's rows |
| 13 | Security headers stamped on the way out | in a wrapper, so a new route cannot forget them |

## 5. Identity and sessions

**Login** (`/api/iam/login`) verifies an argon2id hash and answers a generic 401 for both an
unknown e-mail and a wrong password, so it cannot be used to enumerate accounts. When a second
factor is enrolled it issues **no cookie**: it returns a five-minute HMAC challenge that grants
nothing on its own, exchanged at `/api/iam/login/mfa` for a session.

**The session cookie** is stateless: `expiryMs.accountId.sessionVersion.issuedAt.HMAC`. It is
`HttpOnly`, `SameSite=Strict`, `Path=/`, and — whenever it is `Secure` — carries the `__Host-`
prefix, which stops a sibling subdomain or a plain-HTTP network attacker from overwriting it.

Three clocks bound it:

| Clock | Value | Effect |
|---|---|---|
| Absolute | 7 days | hard ceiling regardless of activity |
| Idle | 12 hours | a cookie not reissued within the window is dead |
| Refresh | 15 minutes | active use reissues it, so a working session never hits the idle wall |

**Revocation is immediate.** Every account carries a `sessionVersion`; a password change, a
logout-all, enabling MFA or deleting the account bumps it, and every outstanding cookie —
and any outstanding step-up grant — dies with it. Role and team memberships are read **fresh
from the database on every request**, so a permission change takes effect on the next call, not
on the next login.

**Step-up** (`/api/iam/stepup`) covers what a session cannot: proof that the person is still
there. Creating, editing or deleting an account (role and memberships live there — it is where a
session becomes an owner), deleting a team, and changing a password each require a five-minute
grant obtained with the password or a TOTP code, presented in `X-Stepup`. It travels in a header
rather than a cookie deliberately — a cookie would ride along automatically, which is the property
being avoided.

The list is short by decision. Enrolling a machine, minting or rotating its token and registering
a repository are **not** gated: they are routine work on a growing fleet, reversible by revoking
the token they mint, and bounded by the account they belong to — while a prompt met daily is one
people learn to clear without reading, which is paid for by the three prompts that matter.
`stepup.test.ts` asserts the table exactly, so it cannot grow by accident.

Three tokens are signed with the same key over similar payloads — session, MFA challenge,
step-up grant — and only **domain separation** stops one being replayed as another. There is a
test asserting exactly that (`auth-principal.test.ts`, `stepup.test.ts`).

## 6. The controls, and what each one does not do

| Control | Does | Does **not** |
|---|---|---|
| **Exposure profile** (`exposure.ts`) | decides whether host-power routes exist at all; `public` revokes them permanently and ignores the opt-in flag; an unknown value fails closed | protect you from marking a public instance `local` — that env value is the trust anchor, which is why `doctor --exposed` re-checks against the strict bar |
| **Capability guard** (`capability-guard.ts`) | 403s `/api/exec`, `/api/chat-tty`, the whole `/api/fleet` prefix, host transcript readers and MCP admin before auth | cover a route nobody registered — an unregistered route is assumed harmless |
| **Rate limiting** (`rate-limit.ts`) | 5 logins / 15 min per IP with doubling backoff; a soft per-account bucket checked before the argon2 verify | survive a process restart, or coordinate across replicas — the edge limiter is the front line |
| **Password policy** (`@agentistics/core`, re-exported by `password-policy.ts`) | 8-char floor, one uppercase, one symbol, 1024 ceiling | a length floor beats composition rules (NIST SP 800-63B) — this is a deliberate product choice, taken knowing that; there is no breach-corpus or common-password check, so `Agentistics@123!` is accepted |
| **TOTP** (`totp.ts`) | RFC 6238 second factor with single-use, hashed recovery codes | help if the authenticator device itself is compromised |
| **Session cookie** | HttpOnly, Strict, `__Host-`, three clocks, instant revocation | stop a stolen cookie being used inside its window — that is what step-up narrows |
| **Step-up** (`stepup.ts`) | requires fresh proof for destructive operations | protect non-destructive reads; a stolen cookie can still read everything in scope |
| **CSRF** (`csrf.ts`) | rejects unsafe methods that carry a cookie without same-origin provenance | apply to Bearer clients, which carry no cookie and are exempt by definition |
| **CORS** (`cors.ts`) | exact-match allowlist; no ACAO at all for an unknown origin | matter to non-browser clients, which ignore CORS entirely |
| **CSP / headers** (`security-headers.ts`) | no inline script, `frame-ancestors 'none'`, HSTS under TLS, `no-store` on `/api` | prevent an XSS — it reduces what one can do |
| **Team scoping** (`team-scope.ts`) | filters sessions, projects, caches and presence to the principal's teams plus machines they own | apply to routes that do not go through it; new data routes must opt in |
| **Audit log** (`audit.ts`) | append-only, 180-day TTL, secret-shaped fields redacted before write | prevent anything — it is how you find out |
| **Resource limits** (`limits.ts`) | byte-counted bodies abandoned mid-stream, SSE cap, outbound timeouts | bound memory used by a legitimate large aggregation |
| **Error hygiene** (`errors.ts`) | generic code + correlation ref to the client | apply to logs, which keep the full message on purpose |
| **Container** | uid 10001, read-only rootfs, `cap_drop: ALL`, no-new-privileges, loopback bind | protect the app from a compromised host |

## 7. Honest limits

- **The owner role is unbounded by design.** An owner reaches every team and every admin route.
  MFA and step-up raise the cost of using a stolen owner session; they do not cap its authority.
- **None of this has had an external audit or a penetration test.** The tests assert that the
  code does what its author intended. That is a check against anticipated mistakes, not against
  unanticipated ones.
- **A public repository does not weaken any of this** — every secret is operator-supplied at
  runtime and none is committed — but it does mean the defaults are read by attackers too, which
  is why they are the conservative ones. See [SECURITY.md](../SECURITY.md).
- **Configuration is the weakest link.** Most of these controls are switched on by an
  environment variable, and OWASP ranks security misconfiguration second among current risks.
  That is the entire reason `agentop doctor --exposed` exists and refuses to declare readiness
  on a check it could not verify.

## 8. Per-connection sharing rules — the guarantee, stated precisely

A member can restrict what each central connection receives, across **two dimensions** —
repository (`git_remote`) and project (`project_path`) — under one of **two modes**
(`share-rules.ts`, `team-rules.ts`, `team-forget-client.ts` — see
[architecture.md](architecture.md#per-connection-repository-sharing) for how it works):

- **`denylist`** ("share everything except…") — the default, and the same behaviour every
  existing `deniedRepos` config had before this shipped.
- **`allowlist`** ("share only…") — nothing reaches this central unless it matches a listed
  repo or project.

The typed rule list (`TeamConnection.sources: ShareSource[]`, plus `shareMode`) exists in exactly
three places — `~/.agentistics/preferences.json`, the in-memory `TeamConnection` on the member, and
the browser tab talking to that machine's own origin — and appears in **no** request body sent to
a central: `IngestBody` is unchanged, and `GET /api/team/status` exposes only `shareMode` and a
per-dimension **count** (`deniedRepos`/`deniedProjects`, or `allowedCount` in allowlist mode) —
never the values, same-origin only.

**What is guaranteed:** a central never learns *which* repositories or projects are hidden (or
allowed), nor how many, nor their names, sessions, prompts, titles, models or cost — **provided
that data was never pushed to it and had no activity before the attribution boundary.** This holds
identically in both modes: allowlist mode does not disclose the *complement* of what it shares
either — a central sees only what was let through, never a hint of what else exists.

**Allowlist mode is the safer default to choose for an untrusted central**, specifically because
of how it treats the unknown: a repository or project that appears on the machine *after* the rule
was set is **hidden** under allowlist (it matches nothing, so it is not shared) but **shared** under
denylist (it matches no *block*, so it goes through). Denylist requires the user to notice and add
every new thing they want hidden; allowlist requires them to notice and add every new thing they
want shared. For a central the user does not fully trust, the fail-closed direction is the one
where forgetting to update the rules leaks nothing new.

**One thing "share only…" must not be read as promising, and the UI must say so explicitly:
allowlist mode still ships the prehistory rollup.** Work done at or before Claude's own
`lastComputedDate` summarisation watermark cannot be decomposed by repository or project by
*anyone*, including this machine — the consolidate store is a strict subset of what Claude already
rolled up into `stats-cache.json`, and there is no per-session record left to filter. That block
travels to every connection, allowlist or denylist, as unattributed daily volume (tokens, cost,
session/message counts with no repo, no project, no session id, no prompt attached) — exactly as it
does today under a denylist. Choosing "share only project X" narrows everything *decomposable*, not
that rollup; the existing `prehistorySessions` marker (surfaced in the confirm modal and the read
view) reports its size so the user can judge how much of their history that covers. A stronger-
sounding mode name must never imply a stronger guarantee than the attribution boundary allows.

**What is NOT guaranteed, and must be said in the UI — do not present this feature as stronger
than this:**

1. **A repo that was already pushed is disclosed by its removal.** The central holds those
   documents with `git_remote`, `project_path`, `first_prompt`, `title`, `model`, tokens and cost,
   and the forget request names them by id. Deleting data you have already handed over is
   inherently observable — the strong promise above applies only to repos that were *never*
   shared with that central; the weak one applies to repos that were.
2. **Work done before the attribution boundary rides inside the prehistory block** as unattributed
   daily volume — no repo, no project, no session, no prompt attached to it — and **no later rule
   can withdraw it**, because there is no document left to name.
3. **The existence of a filter is observable.** A restricted machine's session documents stop
   covering its own filtered days, and a scoped delete is visible on the central's change stream.
   This is inherent to withholding data; there is no marker field creating it.
4. **Colluding centrals can reconstruct each other's denied set.** Two centrals (or one operator
   with accounts on both) seeing the same machine, with overlapping presence windows and
   overlapping shared-session sets, can take a set difference and recover the other's rules.
   Per-connection restrictions are confidential against a *single* central operator, not against
   collusion between them.
5. **CI ingest and the OpenTelemetry exporter are outside these rules entirely, in either mode.**
   A connection's sharing rules are a *member push* rule; they do not reach `agentop ci-push` (CI
   sessions are stamped server-side under a different `memberId`, keyed by repo) or
   `otel-watcher.ts`'s OTLP export. Blocking (or failing to allowlist) a repo on a member
   connection does not stop that repo's GitHub Actions runs or OTel metrics from reaching the same
   central by a different path.

### 8.1 Rules are per machine, and how a machine finds out

Sharing rules live on the machine that declares them. Restricting a repository on one laptop does
nothing on a second laptop signed in to the same account, which will keep pushing it.

A machine detects that situation **without disclosing anything**. It calls
`GET /api/team/account-repos`, which returns the distinct repositories the central holds *for the
caller's own account* and which of that account's machines pushed each one. The request names no
repository and carries no rule — it is byte-identical whether the caller just restricted something
or is idly refreshing — and the response is data the account already owns and can already read from
its dashboard. The comparison against the private rules happens **on the machine**
(`server/account-repos.ts`, `findStillShared`); the central never learns the outcome. The result is
the orange banner on the connection card naming the repository and the sibling machine.

Scope: the route is minted-token-only and scoped to the token's **owner accounts**
(`listSiblingMachines`), never by team and never globally — a token with no owner account sees only
itself. CI and repo tokens are excluded.

### 8.2 The sealed envelope — telling the other machines, through a central that cannot read it

§8.1 lets a machine *detect* the problem. Telling the account's OTHER machines is the opposite
direction, and it cannot be done without something crossing the central. So it crosses encrypted.

**Construction** (`envelope-crypto.ts`, composed from standard primitives, nothing invented):

```
E            = fresh X25519 keypair, one per message
dh1          = X25519(E.priv,      recipient.pub)     confidentiality + freshness
dh2          = X25519(sender.priv, recipient.pub)     sender authenticity
key          = HKDF-SHA256(ikm = dh1 ‖ dh2, salt = E.pub ‖ recipient.pub, info = header)
ciphertext   = AES-256-GCM(key, random 12-byte iv, aad = the full header)
```

This is the Noise `X` / X3DH-style composition. The ephemeral DH means the same rule set never
seals to the same bytes twice. The static-static DH is the **authenticator**: only a holder of the
sender's private key can produce a `dh2` the recipient reproduces. A signature was rejected
deliberately — it would prove authorship to anyone who ever obtained the plaintext, whereas the DH
authenticator is verifiable only by the intended recipient, and two machines of one account need no
transferable proof of what they told each other. The whole header is the GCM AAD, so the central
cannot re-address, relabel or re-date an envelope it relays.

**The recipient checks the header it authenticated.** Binding sender, recipient, instance and time
into the AAD proves the central cannot *rewrite* them; it says nothing about the central *choosing*
the routing fields it reports beside the ciphertext. `open()` therefore requires the caller to state
the sender the transport claimed, this machine's own id, and the connection's instanceId, and
refuses on any disagreement **before** any key agreement. The sender's pin is looked up by the id
**inside the seal**, never the one supplied beside it. Without this, a central could publish a
directory entry under a machine id it invented pointing at a real peer's key, then relay that peer's
genuine envelopes under the invented identity: pin matches, GCM verifies, and the proposal is filed
as authored by a machine that does not exist under a display name the central chose.

**Replay is refused by memory, not by freshness alone.** Every opened envelope's digest — SHA-256 of
`ciphertext ‖ tag`, never the central's own envelope id, which it mints and can vary — is persisted
in the inbox and **is not cleared by dismissing a proposal**. Ignoring a proposal is therefore
permanent. Without it, a pre-restriction envelope (`denylist` with no sources = share everything)
could be replayed after the sender tightened up, offering the user a one-click downgrade.
`createdAt` is additionally bounded (`ENVELOPE_FRESH_MS`, 7 days, with an hour of clock skew) as the
backstop against a central withholding an envelope and delivering it much later. Days rather than
minutes is deliberate: the mailbox exists *because* peers are offline, so a minutes-wide window
would drop exactly the messages the channel was built to deliver. The card also renders the
proposal's age and calls out anything over a day old.

**Key distribution and its honest limit.** Each machine generates its keypair locally and publishes
only the public half (`POST /api/team/keys`, authenticated by its existing minted token). Nothing to
type, working the moment a second machine joins — which is what the product required.

> **A central that publishes a public key it controls, under any machine id, reads that channel.**
> This is not a narrow first-sight race. The central does not need to *substitute* an existing key:
> it can simply **invent a machine** at any time under a key it holds. A peer that never existed has
> no prior key to contradict, so trust-on-first-use accepts it, and from that moment every
> restriction message is encrypted to the central as well as to the real siblings. No fully
> automatic scheme closes this: two parties whose only channel is the adversary cannot bootstrap a
> secret without a pre-shared secret or out-of-band verification.

What is done instead — the point of every item below is that trust can be established
automatically, but never **silently**:

- **Pin on first sight.** The first time B sees A's key it stores it (`envelope-keys.ts`). If it
  ever changes, B **refuses to decrypt** — it does not guess between a reinstall and an attack —
  raises a red alarm on the connection card and a `member.peer_key_changed` notification, and
  **leaves the envelope on the central** so resolving the key does not cost the message. A sender
  likewise refuses to seal *to* a changed key. The pin is per connection: the same machine id on two
  centrals is two different machines.
- **A sender must be in the directory.** An envelope from a machine the key directory did not just
  list is refused outright, pinned or not. This closes the cheaper twin of the fabricated-peer
  attack: rather than *publishing* a peer (which is announced, below), a central can *omit* one and
  seal under an id it invented — no directory entry means no pin, and an unpinned sender would
  otherwise skip the pin comparison entirely and be filed as an apply-ready proposal with no
  notification at all. There is no legitimate race, because a sender publishes its own key before
  it deposits.
- **Announce every new pin.** The first time a peer is pinned — including a fabricated one — the
  connection card and a `member.peer_pinned` notification name it: "a new machine of your account
  will now receive your sharing rules". Same alarm class as a changed key. Silent
  trust-establishment *is* the exposure, so this is the mitigation for the limit above, not a
  nicety.
- **Show the fingerprints.** The expanded connection card lists this machine's own fingerprint and
  every pinned peer's, so a user who cares can compare two machines they own. Never required.
- **One bad key cannot disable the channel.** A directory entry whose key cannot be used is skipped
  and counted, not thrown — an unguarded `seal()` in the peer loop would have let a central publish
  one junk key and silently stop every sibling from ever being told anything.

**What the central inevitably learns, and this is not implied away:** that a machine deposited a
sealed envelope, when, for whom, and how big it was. Since the channel carries only rule changes,
"an envelope exists" ≈ "that machine changed its rules" — which the scoped delete
(`POST /api/team/forget`) arriving at the same instant already reveals, so it concedes nothing new.
It does **not** reveal which repository, in which direction, or whether the peer acted on it.

**Propose, never apply.** A decrypted message NEVER changes the receiving machine's rules. It is
stored as a proposal (`envelope-inbox.ts`), raises a notification, and waits for an explicit click
that runs the ordinary `PATCH /api/team/connections/:id` — the same validated path a hand-edited
rule takes. There is no apply endpoint anywhere on the server, and `envelope-client.test.ts` asserts
that the inbox module exposes no such function: a machine that silently reconfigures another
because a message arrived would be a remote-control channel, and this is not one.

**One keypair per machine, not per central.** A machine publishes the same public key to every
central it connects to, so two centrals comparing notes can confirm they are looking at the same
physical machine. That is accepted rather than fixed: the machine already presents the same
`git_remote` set and the same statsCache shape to both, so per-connection keys would not make it
unlinkable, only harder to reason about. An envelope still cannot cross centrals — the instanceId is
bound into the AAD and re-checked on arrival.

**Mailbox scoping.** Deposit/fetch/ack are minted-token-only. The SENDER is stamped from the token,
never read from the body; the RECIPIENT must be a machine of the caller's own account
(`allowedRecipients`), so the mailbox is not a write primitive against strangers; a refused
recipient is silently skipped rather than named, because naming it would answer "does this machine
belong to my account". Retention is bounded by age (in step with the recipient's freshness window) and per-recipient
count, and revoking a machine's token drops its published key and all of its mail. The private key
never leaves the machine, never enters a log, an audit event or any response body.

**Rotating a token is a change of identity, and is treated as one.** `memberId = sha256(token)`, so
rotation renames the machine in every collection keyed by that id. `rotateToken` carries the
history across — sessions, memberStats, workflows, the tags pinned to the machine, and the
published envelope key — and the enumeration of what is keyed by a machine id lives in
`rotate-identity.ts`. Two things it deliberately does **not** do:

- **It never re-addresses a sealed envelope.** The whole header is the GCM AAD and `open` compares
  every routing field against what the transport claimed. Mail addressed to the old id therefore
  yields `recipient_mismatch` no matter who relays it, so it is **deleted** rather than left to
  expire (the audit event reports the count — it is a loss, not a move). Mail *sent* by the old id
  still opens exactly as sealed and is left untouched; re-stamping its sender would turn a true,
  deliverable announcement into `sender_mismatch`. The loss is bounded: every message is a full
  snapshot that its sender re-announces on its next rules change, and facts already collected live
  in the machine's own inbox and survive.
- **It never carries a sibling's pin across.** To a sibling the rotated machine is a machine it has
  never seen: it pins on first sight and **announces** it, exactly as above. Continuity cannot be
  established here without a claim the central could forge — a "formerly `<oldId>`" field is a
  central assertion by construction, and "the key is the same, so the machine is the same" is no
  better, because a public key is public: a central can list an invented machine carrying a key it
  copied from a real one, and treating a familiar key as proof of continuity would let it suppress
  the very announcement that defends against fabricated peers. A sound proof exists in principle
  (the old private key signing the new id) but rotation is initiated on the central and the machine
  learns its new id only afterwards, so it cannot sign it in advance. The rotation dialog says the
  siblings will see a new machine instead of implying they will not.
`GET /api/team/proposals` returns a sibling's full source list, so it is registered in
`capability-guard.ts` and is unreachable on an internet-exposed instance.

## 8b. The fleet routes — starting an assistant is the strongest thing this server does

`/api/fleet` and everything under it is host power under another name. Reading the fleet CAPTURES
each live session's screen — a coding assistant's terminal, transcript and all. `/api/fleet/act`
types into it, answers a permission prompt for it, or kills it. `/api/fleet/stream` streams that
screen continuously. `/api/fleet/attach` hands out the command that ENTERS it. And
`/api/fleet/input` sends RAW KEYSTROKES into a live one, and
`/api/fleet/new` **starts a fresh coding assistant, with a prompt, in a directory the request
names** — billable, on this machine, with whatever access the assistant itself has.

Three things bound it, and only one of them is wording:

1. **`localShell`, registered as a PREFIX.** The whole `/api/fleet` subtree maps to `localShell` in
   `capability-guard.ts`, so it is 403 on a `lan` or `public` profile *before* the auth gate,
   whoever is authenticated. It is a prefix and not five names on purpose: a route that is not
   registered is assumed harmless, so the next fleet route someone adds must be guarded by having
   been added at all, never by having remembered a second table. `capability-guard.test.ts` asserts
   a path nobody has written yet resolves to `localShell`, and that a near-miss (`/api/fleetwide`)
   does not.
2. **404 on a central.** A central aggregates many machines and hosts none of their sessions, so a
   fleet read there would be that box's own processes answering under someone else's page. The
   guard is a prefix too, for the same reason.
3. **What a start request may ask for** (`fleet-spawn.ts`, pure and tested). The directory must be
   ABSOLUTE — a relative path resolves against the server's own working directory, so the session
   would open somewhere nobody named. The harness must be one this machine can start. An `effort`
   must be in the closed enum the CLI itself prints. Nothing is repaired: a request naming a model
   on a harness with no model flag is refused, because a session that is not the one asked for is
   worse than no session.

`POST /api/fleet/new` is the one fleet call that takes a directory from the request body.
`resume` deliberately refuses to — reopening names an existing conversation, so a directory in the
body could only ever contradict it, and accepting one would let a caller start an assistant
anywhere on this machine. Starting IS the act of choosing where work happens and has nothing else
to read it from; that is why the bound above is exposure rather than argument.

`GET /api/fleet/attach` returns a ticket (`argv` + the real detach key) and never attaches: the
server has no tty. It checks SCOPE first — the row must be one this machine manages and must be
running — because `attachSession` composes the command from whatever id it is given without asking
whether that session exists.

**Raw keystrokes.** `POST /api/fleet/input` types characters with no submit, or presses one named
key, in a session this machine manages. It is the same power a terminal has once attached, reached
through the same `localShell` gate and the same scope check, and its one rule is in the pure
`fleet-input.ts`: a key name outside tmux's own vocabulary is REFUSED, never forwarded, because
`send-keys` does not fail cleanly on an unknown name — it sends the string, so a bogus key becomes
typed text in somebody's live session. Unlike `prompt` it does not refuse an open dialog: a KEY is
what answers a dialog, and the caller is looking at the frame while they press it.

**Framing.** On a `local` profile the dashboard now allows exactly one frame-ancestor,
`vscode-webview:`, so the VS Code extension can show it in an editor tab; `X-Frame-Options` is
omitted on that profile because `DENY` cannot express "one scheme" and would simply win. A web
page's origin is `http:` or `https:` and cannot be forged into another scheme, so no page gains the
ability to frame anything, and `lan` / `public` are untouched — they keep `frame-ancestors 'none'`
and the legacy header. `security-headers.test.ts` pins both directions.

## 8c. Managing a machine's sessions from a central — what is guaranteed, and what is not

Reaching into another machine's live sessions is the most powerful thing a central can be asked to
relay. Four things make it safe enough to offer, and one thing it explicitly does not promise.

**It is off until the machine turns it on.** Absent consent reads as OFF — the same rule
`chat-gate.ts` applies to the local shell, and deliberately not the `shareMode` migration rule that
treats absence as the old default. Treating absence as ON here would hand every already-connected
machine to its central on upgrade.

**Only the machine's OWN accounts.** `machineOwnedBy` (`iam-view.ts`) is deliberately narrower than
the `canManageMachine` that governs renaming, rotating and re-assigning a machine: administering a
machine belongs to whoever runs the instance, reaching into its live sessions belongs to its user.
An instance owner who is not this machine's account is refused, and gets the same `not-owner`
answer as a stranger — so the route is not an oracle for which machines a central holds.

**The screen and the conversation never travel.** The relayed row is built by an ALLOWLIST of keys
(`reduceMachineFleetRow`), so `lastLines`, `chatTurns`, `approvalLines` and `dialogOptions` cannot
cross even as a future field somebody adds to `ControlSession`. `machineFleet.test.ts` feeds a row
carrying all of them and asserts none survives. This is what keeps the 410 on
`GET /api/team/session-chat` meaningful.

**`approve` and `prompt` are refused, and not merely disabled.** Neither can be offered honestly
without the screen: a permission prompt is `1. Yes / 2. Yes, always / 3. No`, an `AskUserQuestion`
can offer five answers that do different work, and a keystroke that answers cannot know which
option it is taking. A button over a dialog nobody can read is the accident `parseDialogOptions`
exists to prevent.

**The machine is the authority, not the central.** Consent, the verb allowlist **and this
connection's sharing rules** are re-read on the member on every request. The central's copy of
those checks exists only to spare a round trip and answer the user instantly; a check that runs
only on the party whose behaviour cannot be verified is not a check.

**A withheld session cannot be acted on, and for one release it could be.** The two consent
switches are machine-wide: they say whether sessions may be managed at all, and nothing about
WHICH. The rules in §8 say which. Both must hold, and only the first one did — the read half
filtered rows through `cwdShared` while the act half resolved the id against the machine's raw
fleet, so a central could `kill`, `rename`, `resume` or re-task a session in a repository its
member had explicitly withheld from it. A rule enforced when you look and not when you act is not
a rule. `performMachineAction` now resolves the target through the same predicate the rows went
through, and refuses an id it cannot resolve — an unresolvable target has no directory to judge,
and passing it through would leave every verb reachable by naming an id the fleet does not list.

**The task verbs are refused entirely while anything is withheld.** `openTask` acts on the piece of
WORK a row is filed under, expanding across the whole registry, and a task routinely spans
repositories — so on a restricted connection it reached sessions the central was never shown,
started assistants in their directories and reported how many. Refusing only when a task provably
spans a withheld row would answer, one visible row at a time, "does this one share work with the
hidden half" — an oracle, and the same correlation §8 exists to deny. So the verbs are refused for
every restricted connection and are absent from the relayed rows; the refusal names no repository
and no count, disclosing nothing beyond the machine-level `withheld` figure the reply already
carries. Open or finish the task on the machine itself.

**The stated non-guarantee.** Whoever runs the central administers machines and can re-assign one
to another account. This switch is what stops session access being on without its owner choosing
it — it is **not** a lock against a hostile central operator, and no surface claims otherwise: the
confirmation dialog says so before the switch is turned on. A guarantee that hides its own edge is
the kind people stop believing the first time they find the edge themselves.

Everything relayed is audited on the central (`machine.session_action`, its own action rather than
a flavour of `machine.update`, so an audit can answer "who killed my session") and announced on the
machine itself — an action invisible on the machine it happened to is the failure this feature has
to avoid. The session id is recorded and the text never is: a rename or a note is the user's own
words about their own work.

## 9. Verifying it yourself

Each control has tests next to it; these are the ones worth reading first:

| Question | Test |
|---|---|
| Can a route become public by accident? | `authz-gate.test.ts` — asserts the exact `AUTH_PUBLIC` set |
| Can a low-privilege account see another team? | `authz-gate.test.ts` → *data scoping (BOLA)* |
| Is the TOTP implementation real? | `totp.test.ts` — RFC 6238 published vectors |
| Can one signed token be replayed as another? | `auth-principal.test.ts`, `stepup.test.ts` |
| Does a bad exposure value fail open? | `exposure.test.ts` |
| Is the lockout a DoS against a colleague? | `rate-limit.test.ts` |
| Is a fleet route nobody has written yet already guarded? | `capability-guard.test.ts` — the `/api/fleet` prefix |
| Can a start request open a session somewhere nobody named? | `fleet-spawn.test.ts` |

```bash
bun test                    # the whole suite
agentop doctor --exposed    # the deployment's own state
```

And end to end, against a running instance: the checklist at the end of
[exposure.md](exposure.md).

## Billing detection — a narrow window onto the most sensitive files

`GET /api/billing/detect` proposes how this machine is billed by reading
`~/.claude.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json` and
`~/.claude/.credentials.json`. Those files also hold live OAuth access and refresh tokens, the
user's mail address, and account and organization identifiers.

**The whitelist is the boundary, and it is enforced by the type and by a test.**
`BillingSignals` (`@agentistics/core/billingDetect.ts`) is a narrow, flat interface listing exactly
the fields that may be extracted: three routing environment variables, the presence of an API key,
`apiKeyHelper`, three `oauthAccount` fields, two credential fields and a pair of usage totals.
Nothing else can be expressed, so nothing else can be carried.

The reader (`packages/server/server/billing-detect.ts`) copies values with a `pick()` that takes a
fixed key list rather than spreading a parsed object — a spread would carry whatever the file
happens to contain, which is the failure mode being designed against. `ANTHROPIC_API_KEY` is
reduced to the literal `'set'`: its presence is the signal, its value is a credential there is no
reason to hold, not even in memory.

`billing-detect.test.ts` enforces this two ways:

1. **A source-text guard.** It reads both modules' own source and fails if either so much as
   *names* a forbidden field. A field the code cannot name is a field it cannot leak. This is
   deliberately cruder than a behavioural test — it fails on a comment, a type or a fixture.
2. **A shape walk** over the real result, asserting the key set is a subset of `BillingSignals`
   and that no value is long, contains `@`, or carries a credential-shaped prefix.

**Codex's plan lives inside a bearer token, and only its payload is read.** `~/.codex/auth.json`
holds an OAuth pair and an optional API key beside the one fact wanted — the ChatGPT tier, which
OpenAI writes nowhere else but as a claim inside the ID token. `readJwtClaim` splits the token,
base64url-decodes the **payload segment only**, and returns the one named claim; the token string
never leaves that function and is not stored, logged or put in `CodexSignals`, which carries two
fields total (`planType`, and `apiKey: 'set'` as a presence). The source-text guard is extended
with `access_token` and `refresh_token` accordingly, so the module cannot name the pair sitting
beside what it reads.

The signature is deliberately **not** verified: verifying would need OpenAI's keys over the
network, and the question here is not whether the token is genuine but what the user's own machine
already believes about their plan. A forged token in someone's own home directory mis-prices only
their own dashboard, and the result is a proposal they confirm.

**macOS is not probed.** The credentials there live in the login Keychain, and this product does
NOT shell out to `security` to reach them — that raises a system prompt, and a metrics dashboard
has no business asking someone to unlock their keychain. An absent signal is absent, and the
detection chain falls through to the next one.

**Exposure.** The route is registered in `capability-guard.ts` under `localTranscripts` rather
than a capability of its own: its answer is host configuration read out of private files, and
there is no deployment that should read a transcript but not this. It additionally returns 404 on
a central, which aggregates many machines and would only ever see its operator's own setup.
`capability-guard.test.ts` pins both the mapping and a near-miss path, so a typo in the
registration fails loudly rather than quietly leaving a host-reading route unguarded.

**Nothing detected is authoritative and nothing is written.** Every result carries
`proposalOnly: true`; the user confirms it, and confirming creates an ordinary hand-entered period
through the same validation as any other. Detection can only see the CURRENT state, while the
billing timeline most needs to know when a plan STARTED — which no file records. Auto-applying
would price months the user was on something else.

**The timeline never travels.** `Preferences.billing` is local: it is not in `IngestBody`, not in
a team document, not in an audit event. What someone pays is theirs, and a central cannot price a
fleet from one operator's timeline anyway.
