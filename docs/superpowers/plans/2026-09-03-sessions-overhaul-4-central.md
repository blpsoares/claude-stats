# Sessions overhaul — Plan 4: the central reaches a machine's sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a central read a machine's session SCREENS, answer its approval dialogs, write to it, and start a session on it — each behind its own consent switch the machine's owner turns on, and none of it weakening the guarantees that made those things refused in the first place.

**Architecture:** Nothing is deleted. `machineActions.ts` already declares `allowRemoteScreens` as a parameter "so that turning them on is a change in ONE predicate rather than a new gate scattered across the member and the central" — this plan takes it at its word. The screen crosses by a second explicit allowlist beside `MACHINE_FLEET_ROW_KEYS`; the choice on an approval dialog is still read off the live frame by the **machine**; spawn is planned by the same `fleet-spawn.ts` the local route uses.

**Tech Stack:** Bun, TypeScript (strict), React 18 + Vite, Mongo (central only), `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-03-sessions-workspace-overhaul-design.md` (Phase 5).

**Depends on:** Plan 3 (the unified spawn plan). Plan 2 Task 21 is unrelated here: the stored conversation does not cross to a central at all (see Task 29).

## Global Constraints

- Everything in this project is in **English**: code, comments, commit messages, PR text.
- Conventional Commits; commit after every task; `bun tsc --noEmit` and `bun test` green each time.
- **Consent is per connection, off by default, and stated in words** on the connection card — never inferred, never defaulted on by a migration.
- **Absence is not a rule.** A field crosses only if it is on an allowlist. Never spread-and-delete: the next field added to `ControlSession` would leak silently on every machine.
- **The machine words every refusal.** A central composes no sentence of its own; `message` on a reply is always the machine's own already-localized text.
- **`approve` never presses a confirm key.** The options are read off the live frame by the machine, immediately before sending, and a dialog whose options changed is refused.
- **The member applies its sharing rules FIRST.** A session in a withheld repository never becomes a row, so it never carries a screen, and a directory in one never reaches the wizard.
- **Every new remote action writes an audit event.** No field carrying a credential is added.
- **Withdrawing `sessions` CLEARS the other switches from STORAGE**, rather than leaving them stored and merely resolving to false — a grant left behind returns the moment the first switch is flipped again, which is a grant nobody re-made.
- **The MACHINE re-checks everything.** Consent and the verb allowlist are re-read from preferences on every request in `performMachineAction`. The central's copy spares a round trip and nothing more: a check that runs only on the party whose behaviour cannot be verified is not a check.
- **`machineOwnedBy` is not `canManageMachine`.** The wider predicate administers a machine; the narrower one reaches into its sessions. An unknown machine answers `not-owner` exactly like one you do not own, so the route is not an existence oracle.
- **Four silences, four sentences**: `not-owner`, `refused`, `offline`, `silent`. An empty list may never stand in for any of them.
- **Do not use browser automation.** Use `curl` and the Mongo tools; ask the user to open the page.
- Stage **explicit paths**, never `git add -A`.

---

### Task 27: a third consent switch

**READ FIRST: two of the three switches already exist.** `packages/core/src/remoteSessions.ts` is
the module that owns this decision, and it already implements `allowRemoteSessions` and
`allowRemoteScreens` through `resolveRemoteConsent`, with the reasoning written out — including
why `screens` is gated on `sessions` and why absence reads as OFF. **Extend that module. Do not
create a second one**, and do not move the decision into `team.ts`: the fields are stored there,
the rule lives here.

**Files:**
- Modify: `packages/core/src/remoteSessions.ts` (add the third switch)
- Modify: `packages/core/src/remoteSessions.test.ts`
- Modify: `packages/core/src/team.ts:94-97` (the stored field, beside `allowRemoteSessions` / `allowRemoteScreens`) and its `migrateTeamConfig` entry at ~line 348
- Modify: `packages/server/server/preferences.ts` (read/write)
- Modify: the connection-card component rendering the existing two switches (`grep -rln allowRemoteScreens packages/web/src`)

**Interfaces:**
- Consumes: the existing `RemoteSessionConsent` and `resolveRemoteConsent`.
- Produces: `RemoteSessionConsent` gains `spawn: boolean`; `resolveRemoteConsent(allowSessions, allowScreens, allowSpawn)`; `NO_REMOTE_CONSENT` gains `spawn: false`. `TeamConnection` gains `allowRemoteSpawn?: boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/remoteSessions.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { NO_REMOTE_CONSENT, resolveRemoteConsent } from './remoteSessions'

describe('resolveRemoteConsent — spawn', () => {
  it('reads an absent switch as OFF, like the other two', () => {
    expect(resolveRemoteConsent(undefined, undefined, undefined))
      .toEqual({ sessions: false, screens: false, spawn: false })
    expect(NO_REMOTE_CONSENT).toEqual({ sessions: false, screens: false, spawn: false })
  })

  it('never lets the screens switch imply the spawn one', () => {
    expect(resolveRemoteConsent(true, true, undefined).spawn).toBe(false)
  })

  it('grants spawn on its own switch, with no screens consent at all', () => {
    // Spawn needs no screen: it is not gated on `screens`, only on `sessions`.
    expect(resolveRemoteConsent(true, false, true))
      .toEqual({ sessions: true, screens: false, spawn: true })
  })

  it('is gated on `sessions` exactly as `screens` already is', () => {
    // Reachable by hand-editing preferences.json, and the honest reading is "no": there is no
    // fleet for the new session to appear in.
    expect(resolveRemoteConsent(false, true, true))
      .toEqual({ sessions: false, screens: false, spawn: false })
  })
})
```

And in `packages/core/src/team.test.ts`:

```ts
it('leaves an existing connection with the new spawn switch OFF', () => {
  const out = migrateTeamConfig({
    mode: 'member', connections: [{ id: 'c1', allowRemoteSessions: true, allowRemoteScreens: true }],
  } as never)
  const c = (out as { connections: Record<string, unknown>[] }).connections[0]!
  expect(c['allowRemoteSpawn']).toBeFalsy()
})
```

- [ ] **Step 2: Run and watch them fail**

```bash
bun test packages/core/src/remoteSessions.test.ts packages/core/src/team.test.ts
```

- [ ] **Step 3: Extend the existing module**

In `packages/core/src/remoteSessions.ts`, add the third field and the third argument, and extend
the header's "TWO SWITCHES, NOT ONE" paragraph to three, keeping every sentence already there:

```ts
/**
 * - `allowRemoteSpawn` grants STARTING a session on this machine.
 *
 * It is a third switch rather than a clause of the second because reading a terminal and starting
 * a billable assistant are different questions. Someone who wants a colleague to see what their
 * machine is doing has not thereby agreed to let them spend money on it — and, unlike the other
 * two, this one is not about disclosure at all: nothing is revealed by it, and a process is
 * created. It is gated on `sessions` (a session started into a fleet the central may not list is
 * a session nobody can then see or stop) and NOT on `screens`, which it does not need.
 */
export interface RemoteSessionConsent {
  sessions: boolean
  screens: boolean
  /** A session may be STARTED here from the central. Never true while `sessions` is false. */
  spawn: boolean
}

export const NO_REMOTE_CONSENT: RemoteSessionConsent = {
  sessions: false, screens: false, spawn: false,
}

export function resolveRemoteConsent(
  allowSessions: boolean | undefined,
  allowScreens: boolean | undefined,
  allowSpawn: boolean | undefined,
): RemoteSessionConsent {
  const sessions = allowSessions === true
  return {
    sessions,
    screens: sessions && allowScreens === true,
    spawn: sessions && allowSpawn === true,
  }
}
```

Then add `allowRemoteSpawn?: boolean` to `TeamConnection` (`team.ts:94-97`, beside its two
siblings, with the same doc-comment shape) and to `migrateTeamConfig`'s entry copy (~line 348),
following the exact pattern of the line above it.

- [ ] **Step 4: Fix every caller of `resolveRemoteConsent`**

```bash
bun tsc --noEmit
```

Each call site gains the third argument, read from the connection. Never a literal `true`.

- [ ] **Step 5: Put the third switch on the connection card**

Beside the two that are already there, one more, **off**, with the sentence saying exactly what it
grants:

- **Start sessions** — EN: "Let this central start new assistant sessions on this machine. They run here, and they cost what they cost." PT: "Deixa este central iniciar novas sessões de assistente nesta máquina. Elas rodam aqui, e custam o que custarem."

It is disabled while the sessions switch is off, with that stated — a switch that silently does
nothing is the defect this repository is written against. Match the existing two switches' markup
exactly rather than inventing a third style.

- [ ] **Step 6: Verify the round trip**

```bash
curl -s http://localhost:47291/api/preferences | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
const p=JSON.parse(s);for(const c of p.team?.connections??[])
console.log(c.id, {sessions:c.allowRemoteSessions,screens:c.allowRemoteScreens,spawn:c.allowRemoteSpawn})})"
```

Ask the user to toggle each switch and re-run it.

- [ ] **Step 7: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/core/src/remoteSessions.ts packages/core/src/remoteSessions.test.ts packages/core/src/team.ts packages/core/src/team.test.ts packages/server/server/preferences.ts packages/web/src/components/team
git commit -m "feat(team): a third consent switch, because reading a screen and spending money are different questions"
```

---

### Task 28: the verb tables know about them

**Files:**
- Modify: `packages/core/src/machineActions.ts`
- Modify: `packages/core/src/machineActions.test.ts`

**Interfaces:**
- Consumes: `RemoteSessionConsent` (Task 27), now three-field.
- Produces: `remoteActionAllowed(action, consent)` and `remoteActionRefusal(action, consent)` gain the `screens` and `spawn` branches; `REMOTE_SPAWN_ACTIONS = ['spawn'] as const`.

- [ ] **Step 1: Write the failing tests, pinning the tables exactly**

```ts
import { describe, expect, it } from 'bun:test'
import {
  REMOTE_SCREEN_ACTIONS, REMOTE_SCREENLESS_ACTIONS, REMOTE_SPAWN_ACTIONS,
  remoteActionAllowed, remoteActionRefusal,
} from './machineActions'

const none = { sessions: false, screens: false, spawn: false }
const list = { sessions: true, screens: false, spawn: false }
const screens = { sessions: true, screens: true, spawn: false }
const spawn = { sessions: true, screens: false, spawn: true }

describe('the tables', () => {
  // Pinned EXACTLY, so adding a verb is a product decision and not a drive-by.
  it('names the screenless verbs', () => {
    expect([...REMOTE_SCREENLESS_ACTIONS]).toEqual([
      'rename', 'note', 'task', 'interrupt', 'kill', 'resume', 'openTask', 'finishTask',
    ])
  })
  it('names the screen verbs', () => {
    expect([...REMOTE_SCREEN_ACTIONS]).toEqual(['approve', 'prompt'])
  })
  it('names the spawn verbs', () => {
    expect([...REMOTE_SPAWN_ACTIONS]).toEqual(['spawn'])
  })
})

describe('remoteActionAllowed', () => {
  it('refuses everything with no sessions consent', () => {
    for (const a of ['rename', 'prompt', 'approve', 'spawn']) {
      expect(remoteActionAllowed(a, none), a).toBe(false)
    }
  })
  it('allows the screenless verbs on the sessions consent alone', () => {
    expect(remoteActionAllowed('rename', list)).toBe(true)
    expect(remoteActionAllowed('kill', list)).toBe(true)
  })
  it('still refuses prompt and approve without the screens consent', () => {
    expect(remoteActionAllowed('prompt', list)).toBe(false)
    expect(remoteActionAllowed('approve', list)).toBe(false)
  })
  it('allows them with it', () => {
    expect(remoteActionAllowed('prompt', screens)).toBe(true)
    expect(remoteActionAllowed('approve', screens)).toBe(true)
  })
  it('keeps spawn on its OWN switch — screens does not imply it', () => {
    expect(remoteActionAllowed('spawn', screens)).toBe(false)
    expect(remoteActionAllowed('spawn', spawn)).toBe(true)
  })
  it('refuses an action no table names — the allowlist is closed', () => {
    expect(remoteActionAllowed('rm-rf', { sessions: true, screens: true, spawn: true })).toBe(false)
  })
})

describe('remoteActionRefusal', () => {
  it('says which consent is missing, so the UI can send someone to the right switch', () => {
    expect(remoteActionRefusal('prompt', none)).toBe('no-consent')
    expect(remoteActionRefusal('prompt', list)).toBe('needs-screen')
    expect(remoteActionRefusal('spawn', list)).toBe('needs-spawn')
    expect(remoteActionRefusal('rename', list)).toBeNull()
    expect(remoteActionRefusal('nonsense', list)).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
bun test packages/core/src/machineActions.test.ts
```

- [ ] **Step 3: Implement**

Update `packages/core/src/machineActions.ts`. Replace the header paragraph that says the screen
actions "are not implemented yet" with what is now true, keeping the reasoning that made them
gated:

```ts
/**
 * `approve` and `prompt` are gated on `screens`, and the reason has not changed: THE DIALOG BEING
 * READABLE IS THE SAFETY. A permission prompt is `1. Yes / 2. Yes, always / 3. No`; an
 * `AskUserQuestion` can offer five answers that do different work; a key that "approves" takes
 * whichever row is HIGHLIGHTED. One user was offered a destructive key over a question they never
 * asked. So these verbs are available exactly when the screen they act on is — and never on the
 * strength of a switch about something else.
 *
 * `spawn` has a switch of its own. It needs no screen at all, which is precisely why it could not
 * ride on the screens one: starting a billable assistant on somebody's machine is a different
 * question from watching what one is doing.
 */
export const REMOTE_SPAWN_ACTIONS = ['spawn'] as const

export function remoteActionAllowed(
  action: string,
  consent: { sessions: boolean; screens: boolean; spawn: boolean },
): boolean {
  if (!consent.sessions) return false
  if ((REMOTE_SCREENLESS_ACTIONS as readonly string[]).includes(action)) return true
  if ((REMOTE_SCREEN_ACTIONS as readonly string[]).includes(action)) return consent.screens
  if ((REMOTE_SPAWN_ACTIONS as readonly string[]).includes(action)) return consent.spawn
  // Closed: an action this module does not know is REFUSED. A new `FleetActionId` added upstream
  // must be listed here on purpose before it can be driven from a central.
  return false
}

export function remoteActionRefusal(
  action: string,
  consent: { sessions: boolean; screens: boolean; spawn: boolean },
): 'no-consent' | 'needs-screen' | 'needs-spawn' | 'unknown' | null {
  if (!consent.sessions) return 'no-consent'
  if ((REMOTE_SCREENLESS_ACTIONS as readonly string[]).includes(action)) return null
  if ((REMOTE_SCREEN_ACTIONS as readonly string[]).includes(action)) {
    return consent.screens ? null : 'needs-screen'
  }
  if ((REMOTE_SPAWN_ACTIONS as readonly string[]).includes(action)) {
    return consent.spawn ? null : 'needs-spawn'
  }
  return 'unknown'
}
```

- [ ] **Step 4: Fix every caller the signature change breaks**

```bash
bun tsc --noEmit
```

Each call site passing `{ sessions, screens }` gains `spawn`. Take the value from
`resolveRemoteConsent(...)` — never from a literal, and never defaulted to `true`.

- [ ] **Step 5: Add the refusal sentence for `needs-spawn`**

Wherever `needs-screen` is turned into words on the central, add the new code beside it:

- EN: "That machine has not allowed this central to start sessions on it."
- PT: "Essa máquina não permitiu que este central inicie sessões nela."

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/core/src/machineActions.ts packages/core/src/machineActions.test.ts
git commit -m "feat(core): the remote verb tables know all three consents, and stay closed"
```

---

### Task 29: the screen crosses, by its own allowlist

**Files:**
- Modify: `packages/core/src/machineFleet.ts`
- Modify: `packages/core/src/machineFleet.test.ts`
- Modify: `packages/server/server/sessions/machine-fleet.ts` (the member side that builds the reply)

**Interfaces:**
- Produces: `MACHINE_FLEET_SCREEN_KEYS`, `MachineFleetRow` gains the four optional screen fields, `reduceMachineFleetRow(row, opts: { screens: boolean })`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'bun:test'
import { MACHINE_FLEET_SCREEN_KEYS, reduceMachineFleetRow } from './machineFleet'

const full = {
  id: 's1', title: 'T', harness: 'claude', state: 'waiting-approval', stateLabel: 'needs you',
  project: 'p', cwd: '/p', verbs: [],
  lastLines: ['$ ls', 'a  b'],
  // Present on the input and expected to survive NEITHER consent — see the module header.
  chatTurns: [{ role: 'user', text: 'hi' }],
  approvalLines: ['1. Yes', '2. No'],
  dialogOptions: ['Yes', 'No'],
  // A field nobody has allowlisted, standing in for the next one somebody adds.
  secretFuture: 'must not travel',
}

describe('reduceMachineFleetRow', () => {
  it('carries NO screen when the consent is off', () => {
    const out = reduceMachineFleetRow(full, { screens: false }) as Record<string, unknown>
    for (const k of MACHINE_FLEET_SCREEN_KEYS) expect(out[k], k).toBeUndefined()
  })

  it('carries the screen when it is on', () => {
    const out = reduceMachineFleetRow(full, { screens: true }) as Record<string, unknown>
    expect(out['lastLines']).toEqual(['$ ls', 'a  b'])
    expect(out['dialogOptions']).toEqual(['Yes', 'No'])
  })

  it('never carries the stored CONVERSATION, with either consent', () => {
    // The 410 stands. `remoteSessions.ts`: "the transcript stays where the 410 put it."
    for (const screens of [true, false]) {
      expect((reduceMachineFleetRow(full, { screens }) as Record<string, unknown>)['chatTurns'],
        `screens=${screens}`).toBeUndefined()
    }
  })

  it('never carries a field on no list, with the consent on or off', () => {
    for (const screens of [true, false]) {
      const out = reduceMachineFleetRow(full, { screens }) as Record<string, unknown>
      expect(out['secretFuture'], `screens=${screens}`).toBeUndefined()
    }
  })

  it('still carries the row fields either way', () => {
    for (const screens of [true, false]) {
      expect((reduceMachineFleetRow(full, { screens }) as { title: string }).title).toBe('T')
    }
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
bun test packages/core/src/machineFleet.test.ts
```

- [ ] **Step 3: Implement**

In `packages/core/src/machineFleet.ts`:

```ts
/**
 * The SCREEN keys — a second allowlist, and separate from the row's on purpose.
 *
 * These are three of the four fields the module's own header calls out as the reason a relayed row
 * was reduced at all: the terminal (`lastLines`) and the permission dialog (`approvalLines`,
 * `dialogOptions`). They cross only when the machine's owner has turned the screens consent on for
 * THIS connection.
 *
 * `chatTurns` IS NOT HERE, and its absence is the decision, not an oversight. On-demand chat
 * retrieval was REMOVED from the reverse channel on purpose (`GET /api/team/session-chat` is a
 * 410), and `remoteSessions.ts` records that neither switch grants it: "the transcript stays where
 * the 410 put it." The screen is that transcript with the formatting left on, so a central with
 * the screens consent can already READ what a session is saying — but it reads a terminal, live,
 * for as long as it is watching, rather than being handed the stored conversation. Those are
 * different powers, and only one of them has been agreed to. Adding `chatTurns` here would reverse
 * a documented decision and needs to be asked for by name.
 *
 * An allowlist and not a spread-and-delete, for the reason the row list already records: the
 * difference matters in the future, not today. A spread leaks the next field somebody adds to
 * `ControlSession`, silently and on every machine; a list simply does not carry it until someone
 * adds it here on purpose.
 */
export const MACHINE_FLEET_SCREEN_KEYS = [
  'lastLines', 'approvalLines', 'dialogOptions',
] as const

export type MachineFleetScreenKey = typeof MACHINE_FLEET_SCREEN_KEYS[number]
```

Add the four optional fields to `MachineFleetRow`, and extend the reducer:

```ts
export function reduceMachineFleetRow(
  row: Record<string, unknown>,
  opts: { screens: boolean } = { screens: false },
): MachineFleetRow {
  // …the existing row-key loop, unchanged…
  if (opts.screens) {
    for (const key of MACHINE_FLEET_SCREEN_KEYS) {
      if (row[key] !== undefined) out[key] = row[key]
    }
  }
  // …the existing required-string block, unchanged…
}
```

The default is `{ screens: false }` so an unconverted call site loses the screen rather than
leaking it.

- [ ] **Step 4: Pass the consent on the member side**

In `packages/server/server/sessions/machine-fleet.ts`, where the reply is built, pass
`{ screens: resolveRemoteConsent(conn.allowRemoteSessions, conn.allowRemoteScreens, conn.allowRemoteSpawn).screens }`. The sharing rules still run first: a session in a
withheld repository never becomes a row at all, so it never reaches this line.

- [ ] **Step 5: Verify the size of what crosses**

A screen is much larger than a row, and the reply crosses a WebSocket with a timeout. Measure on a
real fleet:

```bash
node -e "const f=require('/tmp/fleet.json');
const j=r=>JSON.stringify(r).length;
console.log('rows', f.rows.length,
 'row bytes', f.rows.reduce((n,r)=>n+j({id:r.id,title:r.title,state:r.state}),0),
 'screen bytes', f.rows.reduce((n,r)=>n+j({l:r.lastLines,a:r.approvalLines}),0))"
```

If the screen payload is large enough to threaten `FLEET_REPLY_TIMEOUT_MS` (12 s), cap
`lastLines` at the member before it crosses and record the cap in the header. A
reply that times out is reported as `silent`, which would blame the machine for the central's
appetite.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/core/src/machineFleet.ts packages/core/src/machineFleet.test.ts packages/server/server/sessions/machine-fleet.ts
git commit -m "feat(team): a machine's screen can cross to a central, by a list and a switch"
```

---

### Task 30: `prompt` and `approve` from a central

**Files:**
- Modify: `packages/server/server/machine-fleet-route.ts` (the action route)
- Modify: `packages/server/server/sessions/machine-fleet.ts` (the member's handler)
- Modify: `packages/web/src/components/sessions/SessionPanel.tsx` / `SessionChat.tsx` / `ApprovalCard.tsx` (they already act through `act`; the change is that the central now has one)

- [ ] **Step 1: Let the two verbs through the route**

`machine-fleet-route.ts` already calls `remoteActionAllowed(action.action, consent)` and answers
`refused` when it says no. With Task 28 in place the two verbs pass on their own switch, and the
route needs only to thread the third consent field.

- [ ] **Step 2: Make the member re-read before it answers**

On the member, `approve` must go through the same path the local route uses — `answerSession` in
`fleet-web.ts` — and not a shortcut:

```ts
/**
 * The choice is read off the LIVE frame here, on the machine, immediately before it is sent, and
 * the request is REFUSED if the options changed. That check is what makes a remote approval
 * honest: a poll is five seconds old, and five seconds is long enough for a dialog to be replaced
 * by a different one with the same shape.
 *
 * A numbered dialog on a harness with no verified way to select by number is refused in words
 * naming what does work, exactly as it is locally. Falling back to the confirm key is the defect —
 * it takes whichever option is highlighted.
 */
```

The central sends `{ action: 'approve', id, text: '<the option number>' }` and nothing else. It
never sends a key.

- [ ] **Step 3: Write the failing test for the staleness refusal**

In the member-side test file for `machine-fleet.ts`:

```ts
it('refuses an approval whose options no longer match the live frame', async () => {
  // The central saw "1. Only my fix / 2. Promote everything"; the session has since moved on to a
  // different question with the same number of options.
  const out = await handleMachineAction(
    { action: 'approve', id: 's1', text: '2' },
    { frameOptions: ['Stop here', 'Continue'], seenOptions: ['Only my fix', 'Promote everything'] },
  )
  expect(out.ok).toBe(false)
  expect(out.message).not.toBe('')
})
```

Adapt the call to the module's real signature; the assertion is what matters — a changed dialog is
refused, in words.

- [ ] **Step 4: The panel needs no branch**

`SessionChat` and `ApprovalCard` already act through `act(...)` and already render what the row
carries. With the screen fields crossing (Task 29) and the verbs allowed (Task 28), a central's
panel works because the row now answers the same questions a machine's row does. Verify that no
component reads `isCentral` to decide whether to draw the composer — if one does, remove the
branch: what decides is `row.verbs`, which already carries the refusal and its reason.

- [ ] **Step 5: Verify with two installs**

Ask the user to open the central's Sessions page with a machine chosen, and confirm:

- with the screens switch **off**: the list works, the composer is absent **with a sentence**, and
  the approval card says the machine has not allowed it;
- with it **on**: the terminal shows the live screen, the conversation renders, a message sent
  arrives, and an approval dialog lists its real options and takes the one picked.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/server/server/machine-fleet-route.ts packages/server/server/sessions/machine-fleet.ts packages/web/src/components/sessions
git commit -m "feat(team): a central can answer a session, with the machine reading the dialog"
```

---

### Task 31: starting a session from a central

**Files:**
- Modify: `packages/server/server/machine-fleet-route.ts` (a spawn action)
- Modify: `packages/server/server/sessions/machine-fleet.ts` (the member's handler)
- Modify: `packages/web/src/components/nav/SessionsAside.tsx` (drop `hideNew` on a central when consented)
- Modify: `packages/web/src/components/sessions/NewSessionModal.tsx` (the machine it targets)

**Interfaces:**
- Consumes: `planFleetSpawn` / `FleetSpawnBody` from `packages/server/server/sessions/fleet-spawn.ts` (Plan 3).

- [ ] **Step 1: The member plans it with the same planner**

```ts
/**
 * A spawn asked for by a central is planned by `planFleetSpawn` — the SAME pure module the local
 * route uses — so the browser, the extension and a central all get one validation. A second one
 * here would be a second set of rules for the most powerful act this server performs.
 *
 * The directory is still checked absolute, the harness still has to be one this machine can start,
 * and an effort outside the CLI's own closed enum is still refused in a sentence. None of that is
 * relaxed because the caller is trusted: the caller being trusted is what got the request this
 * far.
 */
```

- [ ] **Step 2: The project list crosses through the sharing rules**

The wizard needs directories, and a directory is usually a repository's name. Answer the central's
`new-options` question with `webProjects(host, q)` **filtered by that connection's sharing rules**,
the same rules a fleet row passes through:

```ts
// A machine that withholds a repository from this central must not disclose its path through the
// picker. The rules run here for the same reason they run before a row is built — the row is not
// the only thing that names a directory.
```

Write a test that a project under a denied repo does not appear in the relayed list.

- [ ] **Step 3: Offer the button, but only where it can work**

`SessionsAside` currently takes `hideNew` and the central always passes it, with the reason
recorded: *"a button whose only outcome is a refusal is a button that teaches the wrong thing."*
That stays true — so the button appears on a central **only** when the chosen machine's relayed
capabilities say spawn is consented, and is otherwise absent with the sentence from Task 28's
`needs-spawn`.

The machine therefore has to report its consent. Add to `MachineFleetReply`:

```ts
/** What this machine has agreed to let this central do. Reported so the central can offer only
 *  what will work — and SAY what it is not offering, rather than leaving a hole. */
consent: { sessions: boolean; screens: boolean; spawn: boolean }
```

- [ ] **Step 4: The wizard names the machine**

On a central the wizard's header says which machine the session will start on — the one
`CentralSessions` has chosen. A session started on the wrong computer is not recoverable by
undoing anything in this UI.

- [ ] **Step 5: Verify**

Ask the user, with two installs:

- spawn switch **off**: no "New session" button on the central, and the reason readable;
- spawn switch **on**: the wizard runs, names the machine, and the session appears in that
  machine's own list as running.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/server/server/machine-fleet-route.ts packages/server/server/sessions/machine-fleet.ts packages/core/src/machineFleet.ts packages/web/src/components/nav/SessionsAside.tsx packages/web/src/components/sessions/NewSessionModal.tsx
git commit -m "feat(team): a central can start a session on a machine that has said it may"
```

---

### Task 32: audit, and write the guarantee down

**Files:**
- Modify: `packages/server/server/audit.ts` (the event names)
- Modify: `packages/server/server/machine-fleet-route.ts` (emit them)
- Modify: `docs/security.md`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Audit every remote action**

One event per action performed on a machine's session from a central, carrying the machine id, the
action, the session id and the outcome — and **no** field carrying a credential or a screen. The
pure builder already redacts secret-shaped fields; do not rely on that as a reason to pass one.

```ts
// A screen line is not audit material: it is somebody's terminal, and an audit log is read by
// people who were never granted the screens consent.
```

- [ ] **Step 2: Write the failing test**

```ts
it('records a remote action without carrying any of the screen', () => {
  const e = buildAuditEvent('machine.session.act', {
    machineId: 'm1', action: 'prompt', sessionId: 's1', ok: true,
    // deliberately passed, and deliberately not recorded
    lastLines: ['secret'], text: 'do the thing',
  })
  const json = JSON.stringify(e)
  expect(json).not.toContain('secret')
  expect(json).not.toContain('do the thing')
  expect(json).toContain('prompt')
})
```

- [ ] **Step 3: Document the three switches**

Add to `docs/security.md` a section stating, for each switch: what it grants, what it does not,
what still refuses regardless (a numbered dialog on an unverified harness; an approval whose
options changed; a session in a withheld repository), and that absence reads as off. A guarantee
that is not written down is a guarantee nobody can check.

- [ ] **Step 4: Update the architecture notes and CLAUDE.md**

`CLAUDE.md`'s `machineActions.ts` paragraph currently says `approve` and `prompt` "are not
implemented yet: the screen does not travel in this phase". Replace it with what is now true,
keeping the reasoning: they travel behind their own consent, the machine still reads the dialog,
and the confirm-key fallback is still the defect.

- [ ] **Step 5: Run the whole gate**

```bash
bun tsc --noEmit && bun test
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/server/audit.ts packages/server/server/machine-fleet-route.ts docs/security.md docs/architecture.md CLAUDE.md
git commit -m "docs(security): what each remote-session consent grants, and what still refuses"
```

---

## Plan 4 self-review

- **Spec coverage.** 5.2 → Tasks 27–28. 5.3 → Task 29. 5.4 → Task 30. 5.5 → Task 31. 5.6 → Task 32.
- **Interfaces.** The widened `resolveRemoteConsent` / `RemoteSessionConsent` (27) is consumed by 28, 29, 30, 31. `REMOTE_SPAWN_ACTIONS` and
  the widened `remoteActionAllowed` (28) by 30 and 31. `MACHINE_FLEET_SCREEN_KEYS` and the
  two-argument `reduceMachineFleetRow` (29) by 30. `MachineFleetReply.consent` (31) by the aside.
- **Order.** 27 → 28 → 29 → 30 → 31 → 32, strictly. Each one's tests depend on the previous one's
  signature.
- **Scope note.** This plan changes what one machine will do at another's request. If any task's
  verification cannot be run against two real installs, stop and say so rather than marking it
  done — a consent switch that has only been tested in a unit test is a consent switch nobody has
  seen refuse anything.
