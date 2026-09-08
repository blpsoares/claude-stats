# Managing a machine's sessions from the central — design

**Status:** proposed, not implemented · **Branch:** `feat/web-sessions-parity`

## The ask

A per-machine switch, *"allow session management from the central"*, so that a person signed in to
the central can open the Sessions workspace for one of **their own** machines and act on it.

The switch — and the power it grants — must be **visible and usable only by the account that owns
that machine, never by the central's owner** on the strength of being the owner.

## Why this is a design document and not a ticket

Two of the pieces this needs were removed from this product on purpose, and the code says so:

- `team-agent.ts`'s header: *"On-demand chat retrieval over this channel has been removed — the
  central never requests or views member chat."* `GET /api/team/session-chat` is a **410 Gone**
  regardless of `TEAM_CENTRAL` (`index.ts:2309`).
- `fleet-web.ts` justifies `FleetPayload.rows` carrying the session **screen** and **transcript**
  with exactly one sentence: *"this route is `localShell` in `capability-guard.ts`, refused on a
  central and on every exposed profile, so it is not a new class of exposure. It is the same
  machine reading its own terminals."*

This feature is what makes that second sentence false. That is the whole difficulty, and it is not
plumbing.

## What already exists (verified in the tree, not assumed)

| Piece | Where | State |
|---|---|---|
| machine → owning accounts | `TokenDoc.accountId` / `accountIds`, `ownerIdsOf()` (`team-tokens.ts:60`) | **exists** |
| "may this principal manage this machine" | `canManageMachine()` (`iam-view.ts:175`) | exists, **wrong shape** — see §1 |
| central → member push | `notifyMember(memberId, payload)` (`team-agent.ts:250`) | exists, **fire-and-forget**, no reply |
| member → central messages | `onAgentMessage()` (`team-agent.ts:214`) | exists, accepts **exactly one** type (`live-sessions`), rejects the rest wholesale |
| member decodes a central frame | pure `decodeAgentFrame()` (`team-agent-client.ts:114`) | exists, knows `renamed` / `reassigned` |
| member-pushed live snapshot | `team-live.ts` | **the precedent**: the member *pushes*, the central never *asks*; in-memory, 25s TTL |
| central refuses the fleet | `index.ts:1017` (`TEAM_CENTRAL` → 404 `fleet_central`) | exists, unconditional |
| fleet needs host power | `capability-guard.ts:40-60` — every `/api/fleet*` path is `localShell` | exists; `localShell` is `false` on `lan` and `public` (`exposure.ts`) |

So the machine→account link is **already there**. What is missing is four things, and each one is a
decision.

---

## 1. `canManageMachine` is the wrong gate

```ts
export function canManageMachine(p, machine): boolean {
  if (p.role === 'owner') return true                 // ← the ask excludes this
  if (owners.includes(p.accountId)) return true
  return teams.some(t => canManageMachineTeam(p, t))  // ← and this
}
```

It is true for the central's owner and for any manager of a team the machine belongs to. The ask is
strictly narrower: **the owning account and nobody else.**

**Decision.** A new pure predicate beside it, not a flag on it:

```ts
/** The machine's OWN account, and only that. Deliberately narrower than canManageMachine, which
 *  an owner and a team manager both pass — renaming or re-assigning a machine is administration
 *  and belongs to them; typing into its sessions is not. */
export function machineOwnedBy(p: Principal, machine: {...}): boolean {
  return ownerIdsOf(machine).includes(p.accountId)
}
```

Narrowing `canManageMachine` in place is not an option: every existing caller (rename, rotate,
re-assign, `iam-handlers.ts:998-1030`) legitimately wants the wider reading, and `iam-view.ts:176`
records that the owner branch exists precisely to keep owners from being locked out of orphaned
machines.

**State the limit honestly.** The central's owner can read the token store, mint a token and
re-assign a machine's owning account. This gate is therefore *not* a cryptographic barrier against a
hostile central operator, and the UI must not imply that it is. What it does buy is the ordinary
case — an admin with legitimate access who is simply not this machine's user — and the guarantee
that the power is **off until someone chooses it**. That is worth having; overstating it is not.

## 2. The central must RELAY, never PRODUCE

Lifting the `TEAM_CENTRAL` 404 at `index.ts:1017` does not give an unanswered question — it gives a
**wrong answer**. `readFleet()` reads the tmux server and `/proc` of *the box serving the request*,
so a central would serve its own processes under a member's page. That is verbatim the bug the
existing comment names. `capability-guard.ts` would refuse it anyway (`localShell` is false on
`lan`/`public`), and that refusal is correct and must stay.

**Decision.** New routes under their own prefix — `/api/team/machine-fleet` and
`/api/team/machine-fleet/act` — and the `/api/fleet*` block at `index.ts:1017` is **left exactly as
it is**. The new routes touch no host, so they are not `localShell`; but CLAUDE.md's rule is that an
unregistered route is assumed harmless, so the decision not to register them is written into
`capability-guard.ts` as a comment beside the fleet entries, and `capability-guard.test.ts` pins
that `/api/team/machine-fleet` resolves to `null` **on purpose** rather than by omission.

## 3. The reverse channel has no request/response

Everything on it today is one-directional and uncorrelated. `notifyMember` pushes and forgets;
`onAgentMessage` accepts one unsolicited type. A relay needs a *question* and an *answer that can be
matched to it*.

**Decision.** The narrowest possible correlation, and nothing reusable-in-general:

- central → member: `{ type: 'fleet-request', rid, op: 'read' | 'act', action?, id?, text?, choice? }`
- member → central: `{ type: 'fleet-reply', rid, ok, ... }`

Rules, each mirroring one that already exists on this channel:

- **The member never names itself.** The machine id and display name come from the authenticated
  socket (`ws.data.memberId`), exactly as `onAgentMessage` already does for `live-sessions` — a
  member cannot answer on another machine's behalf.
- **Malformed is rejected wholesale**, never partially applied (same clause, same reason).
- **A reply with no matching in-flight `rid` is dropped.** An unsolicited `fleet-reply` is not a
  fact about anything.
- **Bounded**: one in-flight read plus one in-flight action per machine, and a timeout. A central
  that can queue work on a member is a central that can wedge it.
- **The member re-checks its own switch on every frame.** The central asking is never the
  authority; the machine answering is. A switch turned off mid-session must take effect on the next
  frame, not at the next handshake.

## 4. The payload is the security model, not a detail

`FleetPayload.rows` is `ControlSession`, which carries:

| Field | What it is | Relay? |
|---|---|---|
| `chatTurns` | the transcript, verbatim, role-tagged | **never** — this is precisely what the 410 closed |
| `lastLines` | the session's terminal screen | **not in this feature** — a screen is chat with the formatting left on |
| `approvalLines` + `dialogOptions` | the permission dialog being asked | see below |
| id / title / harness / cwd / project / state / task / note / model / verbs | the row | yes, subject to §5 |

`approvalLines` is the honest problem. CLAUDE.md's rule for `approve` is that **the screen showing
the dialog *is* the safety** — *"the keystroke that answers cannot know which option it is
taking"*, and `parseDialogOptions` exists because a claude permission prompt is `1. Yes / 2. Yes,
always / 3. No` and an `AskUserQuestion` can offer five answers that do different work. So:

- Relaying the dialog reopens the transcript channel for exactly the text most likely to be
  sensitive (it quotes the command, the file, the question).
- Offering `approve` **without** the dialog is the accident the cockpit's whole design exists to
  prevent.

**Decision — two switches, not one.** They are different questions and must be asked separately:

1. **`allowRemoteSessions`** — "let my account manage this machine's sessions from the central".
   Grants the rows and the verbs that carry no screen: `rename`, `note`, `task`, `interrupt`,
   `kill`, `resume`, `openTask`, `finishTask`.
2. **`allowRemoteScreens`** — "let the central read this machine's session screens". Separate,
   independently revocable, **off** even when (1) is on. Only this unlocks `lastLines`,
   `approvalLines`, `dialogOptions`, and therefore `approve` and `prompt`.

Without (2), `approve` and `prompt` are **present and disabled with a sentence** — the `FleetVerb`
contract already carries `enabled: false` + `reason` for exactly this, and `fleet-row.ts:84` records
why a refused verb is drawn rather than removed.

Both follow `chat-gate.ts`'s rule verbatim: **absent reads as OFF**, and the switch may only ever
narrow what the exposure profile already allows.

## 5. The sharing rules apply, and the MEMBER applies them

A session in a repository this machine withholds from this central must not appear in the relayed
fleet either — otherwise the Sessions panel is a bypass of `share-rules.ts`. The filter runs on the
**member**, through `sessionShared()`, because the member is the only party holding the rules and
the only one whose application of them can be trusted. `team-live.ts` already establishes this
shape for snapshots.

Consequence to state in the UI: a member with an allowlist may return a fleet that is legitimately
shorter than what is running. "Some sessions are not shared with this central" is a sentence, not an
absence.

## 6. Three different silences, three different sentences

Never an empty fleet standing in for a fact nobody established:

- the machine is **offline** (no socket — `team-agent.ts` already knows this within ~8s);
- the machine is online and **the switch is off**;
- the machine is online and runs a **version with no relay** (it will simply never reply — the
  timeout is the only signal, so the sentence must say "did not answer", not "has none").

Same rule as `HARNESS_CAPABILITIES` and `liveEmptyNotice`: N/A in words, never a confident `0`.

## 7. Audit on the central, notification on the machine

Every relayed action is a person acting on a machine they are not sitting at. It is audited on the
central (`machine.fleet_action`, new — `machine.update` means the token document changed and must
not be overloaded), and the **machine says so too**: `notifications.ts` already renders codes at
render time, so `machine.session_acted` with the actor and the verb belongs there. An action that is
invisible on the machine it happened to is the failure mode this whole feature has to avoid.

## 8. Step-up is deliberately NOT extended

`stepup.ts`'s `PROTECTED` is exactly three entries and `stepup.test.ts` asserts the table exactly,
because *"a prompt people meet daily is a prompt they clear without reading, and every other prompt
pays for it"*. Managing one's own session is routine work. The consent here is the switch — asked
once, reversible, and off by default. Flipping the switch is arguably a candidate; acting through it
is not.

## Phasing

Each phase is shippable and reversible on its own.

- **Phase 1 — consent, with nothing relayed.** `machineOwnedBy` + the two switches in the member's
  preferences + the machine reporting their state in its existing handshake + the central's machine
  row showing it. The Sessions panel for a member machine says, in words, that it is off or that the
  machine has not answered. No new channel, no new payload. *This is where the design stops being
  theoretical and can be tested.*
- **Phase 2 — the correlated read.** `fleet-request`/`fleet-reply`, the reduced row (§4), the
  member-side sharing filter (§5), the three silences (§6).
- **Phase 3 — the screenless verbs**, plus the audit and the machine-side notification (§7).
- **Phase 4 — screens, behind `allowRemoteScreens`.** Optional, and reasonable never to build.

## Non-negotiables carried from CLAUDE.md

- **Mobile in the same change**, not after — the machine row, the switches and any fleet panel.
- **One implementation of each rule**: the verbs come from `sessionActions` and the row from
  `fleet-row.ts`; the central re-derives nothing.
- **`packages/web` never imports `packages/server`** — the switches' shape belongs in
  `@agentistics/core` beside `TeamConnection`.
- **Every new pure decision gets a test**: `machineOwnedBy`, the frame decoder, the row reduction.
  The row reduction test is the important one — it must fail if `chatTurns` or `lastLines` ever
  appears in a relayed payload.

## Open question for the user

§4's two-switch split is the proposal, and it means **`approve` does not work remotely in the first
release**. The alternative is one switch that relays the dialog. The split is recommended: approving
a permission prompt you cannot read is the one thing the cockpit's design most explicitly refuses,
and "allow session management" is not informed consent to "stream my terminal to the central".
