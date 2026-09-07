# Session management is its own grant, separate from linking a machine

**Status:** proposed · **Date:** 2026-09-03

## The problem, in one sentence

Linking an account to a machine currently grants that account everything, including the right to
read, drive and end that machine's sessions — so an act performed for administration or metrics
silently hands over the machine's terminal work.

## What is true today

`iam-handlers.ts` attaches a machine's `remoteConsent` — and with it the whole session surface —
under exactly one predicate:

```ts
...(machineOwnedBy(principal, m) ? { remoteConsent: machineConsent(m.id) } : {}),
```

and `machineOwnedBy` is purely `machine.accountIds.includes(p.accountId)`.

Two consequences worth stating plainly, because one of them is already correct and should not be
"fixed" by accident:

- **An instance owner does NOT get session access today.** `machineOwnedBy` has no role
  short-circuit, deliberately, unlike `canManageMachine`. A machine belonging to someone else shows
  "Out of reach" to an owner, which is the behaviour the reporter's own screenshot shows working.
- **Every linked account DOES.** `accountIds` is one list serving two questions — "who administers
  this machine" and "who may reach into its sessions" — and the second is far narrower than the
  first.

## The rule

Session access to a machine (list, interact, create, end) belongs to:

1. the account(s) the machine was **created for**, automatically; and
2. any account **explicitly granted session management** on that machine, afterwards.

Nothing else. Being an instance owner grants **metrics on every machine and no sessions on any**.

Granting is the **machine owner's** decision alone — not the instance owner's. An owner may still
link accounts (administration), and may not hand out session access.

## Model

`MachineDoc` gains one field:

```ts
/** Accounts allowed to reach this machine's SESSIONS. A subset of `accountIds`, never wider. */
sessionAccountIds?: string[]
```

- **At mint**, it is seeded with the creation accounts: a machine created for your account is one
  you manage sessions on, with nothing to click.
- **On a later link**, the new account joins `accountIds` and NOT `sessionAccountIds`, unless the
  granter explicitly asks for it in the same act.
- **Absent reads as "only the creation account"**, never as "everyone linked" — see Migration.
- It may never contain an account absent from `accountIds`; the write path intersects, so removing a
  link removes the grant with it rather than leaving a dangling one.

## The gate

`machineSessionsAllowed(p, machine)` replaces `machineOwnedBy` at the three session call sites
(`iam-handlers.ts`'s `remoteConsent`, and both `machineOwnedBy` checks in `machine-fleet-route.ts`):

```
sessionAccountIds present  →  sessionAccountIds.includes(p.accountId)
sessionAccountIds absent   →  accountIds[0] === p.accountId        // see Migration
```

`machineOwnedBy` itself stays exactly as it is and keeps its current callers: it is the right
predicate for "is this my machine" wherever that is genuinely the question. The new function is
narrower and is the ONLY one the session surface may ask.

An account without the grant is answered `not-owner` — the same code an unknown machine gets, so
the route stays a non-oracle.

## Migration

No stored machine records who was linked at creation. `accountIds[0]` is the closest honest proxy:
the code already treats it as the machine's identity (`nextUser = accountIds[0]`, the name the
machine displays under). So an absent `sessionAccountIds` reads as **that one account**.

This is deliberately not "everyone currently linked" (which would preserve the hole) and not
"nobody" (which would take a working machine away from its owner with no warning and no way back
except an admin who may not grant it). Every other linked account loses session access and can be
granted it back in one click by the owner.

## UI

- The machine's edit drawer gains, per linked account, a switch: **"allow this account to manage
  and interact with this machine's sessions"**. Off by default on a newly added account.
- Turning it **on** opens a confirmation naming exactly what is being handed over: the session
  list, the verbs (rename, note, task, interrupt, kill, resume, open/finish task) and the ability
  to start sessions — and that the session's screen and conversation still never leave the machine.
  Turning it **off** needs no confirmation: withdrawing access is not the dangerous direction.
- The switch is absent (not disabled) for a principal who may not grant, with the reason in words —
  a disabled control that explains nothing is indistinguishable from a broken one.

## What this does not change

- The machine's own consent switches (`allowRemoteSessions` / `allowRemoteScreens`) are unaffected
  and remain the FIRST gate: the machine decides whether any central may drive it at all, and this
  grant only decides which accounts on that central may ask.
- `approve` / `prompt` stay absent from the relay: they cannot be offered without the screen.
- Metrics, projects, repositories and every other aggregate stay exactly as scoped today.

## Tests

- `machineSessionsAllowed`: creation account yes; a later-linked account no; a granted account yes;
  an instance owner who is neither, no; an unknown machine, no.
- The absent-field migration reading, pinned as its own case.
- The intersection on write: a grant for an account not in `accountIds` is refused, and unlinking
  drops the grant.
- `authz-gate.test.ts` / `capability-guard.test.ts` unchanged — no new route.
