# The Sessions workspace (web)

`/sessions` — the browser front door onto the fleet. The aside on the left lists the sessions; the
centre holds either the **overview** (`FleetOverview`) or the open session's **chat**, **terminal**
and **right aside**. On a central it is the same workspace, showing the relayed fleet of whichever
machine the picker has chosen.

The names of the four surfaces are in [docs/surfaces.md](surfaces.md); what a session IS, how it is
started and what its states mean is [docs/session-manager.md](session-manager.md). This page is
about the web one specifically.

- Components: `packages/web/src/pages/SessionsPage.tsx`, `packages/web/src/components/sessions/`
- Terminal side: [terminal-channel.md](terminal-channel.md),
  [terminal-interactive.md](terminal-interactive.md),
  [terminal-write-channel.md](terminal-write-channel.md)
- On a central: [architecture.md § Managing a machine's sessions](architecture.md) and
  [security.md § 8c](security.md)

---

## The conversation

Read through `harness-transcript.ts` — five of the six harnesses have a reader, and the sixth's
absence is a **finding, not a gap** (see session-manager.md). A harness with no reader is refused
**in words that name it**, never with a blank pane.

**Every message says when it was sent.** **A selection offers `copy` beside `reply`** — quoting a
fragment back at the session is the common case, and copying it was a right-click away from being
impossible. One control per selection: the excerpt menu and the message menu used to both draw a
`reply`.

**Coming back to the tab re-reads the conversation.** A backgrounded tab's poll is throttled by the
browser, so returning to a session that had answered showed the last message you sent for several
seconds before catching up. `visibilitychange` now forces a read.

---

## Answering a dialog

**Most dialogs are not yes/no.** Claude's permission prompt is `1. Yes / 2. Yes, always / 3. No`,
and an `AskUserQuestion` can offer five answers that do different work. A key that "approves" takes
whichever row is **highlighted**, which on such a dialog is choosing for the user.

So the card:

- **shows the QUESTION**, not only the answers — `approvalTail` cuts at the blank line above the
  question rather than at the last rule, which cut the question away;
- **lists the options read off the screen** (`parseDialogOptions`), and refuses unless they come out
  exactly `1..n` — half-read options are worse than none, because they get offered;
- **re-reads the frame immediately before sending** (a poll is 5s old) and refuses when the options
  changed;
- marks which row the dialog currently has **highlighted** — a fact about the screen, never a
  recommendation.

**Writing your own answer.** An option whose label is "Type something" (`isFreeTextOption`) opens a
field instead of sending a digit: the digit selects the option, the host **waits for the pane to
move**, and only then types the text and submits. Sending both as one burst put the answer through
as `3jabuticaba` — and the API said `ok`, because a keystroke that lands is not a keystroke that was
understood.

A numbered dialog is only ever driven where `ApprovalSpec.choice` was **verified against a live
session** (claude alone). Everywhere else it is refused in a sentence naming what does work
(attach), because falling back to the bare confirm key is the defect.

---

## Switching the harness mode

The chip left of the recent-message button says which mode the session is in and advances to the
next one. `mode-spec.ts` (pure, server-side) holds the whole rule, **measured by driving a live
session** — claude 2.1.263: `shift+tab` (`BTab`) cycles `manual → accept edits → plan → auto`, and
each mode is matched on its **own name** because `manual`'s footer is the one that does not
advertise the cycle key.

- **It cycles, it does not pick.** No keystroke jumps to a named mode, so a menu of four would reach
  three of them by luck. The verb is "next mode", the chip says which one it is now, and both are
  true.
- **The mode is read from the FOOTER only** (`MODE_FOOTER_LINES`), for the same reason
  `attention-rules.ts` reads its markers there: this product is developed with this product, so a
  transcript quoting "plan mode on" is a certainty, not a risk.
- **The chip wears the mode's colour** (`modeStyle.ts`), on an **autonomy** gradient — manual
  neutral, plan blue, accept-edits orange, auto green. **None of them is the fault colour**: `auto`
  is how this product is normally used, and painting the ordinary state red is the cry-wolf that
  `withheldStyle.ts` and the connection pill's `stale` case both exist to avoid. An unknown id is
  neutral, never another mode's colour.
- **Every other harness is `null`** — a finding, not a gap. Nobody has driven one to see whether it
  has modes, what its footer says or which key moves it, and a guessed key sent into a live
  assistant is a keystroke nobody asked for.

---

## The composer

- **Dictation shows what it is hearing.** `interimResults` is on, the interim text is previewed, and
  the mic pulses while it is live — a control that records silently is one you cannot tell is broken.
- **It does not lose focus mid-sentence.** The poll re-rendered the view under the field.
- **`Enter` sends on a hardware keyboard and BREAKS THE LINE on a phone.** `shift+enter` needs a
  shift key a software keyboard does not have, so on a touch layout the return key is the only way
  to write a second line; sending is the button beside the field. `TtyChat` already split this way.
- **A prompt is refused while a dialog is open**, in words: a line typed into a permission prompt
  goes into that dialog's filter and the submit takes the highlighted option.
- The skills list is gone from the composer's overflow menu — the aside has a Skills tab of its own,
  and one list in two places is one list that drifts.

---

## The right aside

Files, Docs, Live, Gallery, Skills, Agents, Workflows, MCPs and PRs (`TabId` in
`ArtifactsAside.tsx`). Its bar **keeps what fits** and a grid holds the rest, rather than
overflowing.

**Workflows shows Dynamic Workflow runs as something HAPPENING.** They were readable before, but
only as history on the repo page, because the reader turned "has not reported back yet" into
`completed` — so a run in flight claimed to be over and there was nothing live to show. The state
is the pure `workflow-live.ts`, which ranks its evidence: the run's OWN end-of-run record (the only
source that can say `killed`), then the completion counts, then whether the session is alive
(three-valued — a caller that cannot see processes must not call a live run dead), then movement.
A launched run that stopped moving is `abandoned`, said in words. Measured across 17 real runs on
one machine, 4 had carried the wrong status. It polls only while a run is live.

**It does not reload from zero when it is closed and reopened.** Tabs seed from `asideCache`, so
skills, PRs and skill bodies survive a close — reopening used to re-fetch everything and stall.

**The Live feed's rows open again**: the step id had been dropped, so a row had nothing to resolve.
On mobile the open-file shortcut is a **17px icon in the action colour** — the touch target had
grown to 44px while the glyph stayed 11px in tertiary grey, which on a phone is an empty square. It
only appears when the file is still in the Files list: offering to open a deleted file is a button
whose only outcome is a refusal.

---

## On a phone

Full parity, not a subset — the aside, the metrics screen and the filters are all there.

- **`+ Filter`** replaces the config icon, the same control the desktop has, opening the filter
  sheet.
- **A `Sessions | Metrics` segmented control** puts `FleetOverview` on the phone: the cards two up,
  the activity calendar and the trend chart. (The per-assistant rows stack there — the desktop's
  fixed widths left 20px for the bar in a 300px pane.)
- **The aside slides**, mounted and translated rather than conditionally rendered, and wears the
  desktop's `FileText` icon with **no count**.
- **The magnifier button lives in the bar**, not floating over the conversation.

### Reaching it from a phone, and what that costs

The dashboard is served over plain HTTP by default, and on a phone that decides more than it looks
like it does. **Notifications, the service worker and installability all require a SECURE CONTEXT.**
Reached as `http://100.109.247.39:47292` — a Tailscale address, which is the usual way — the origin
is not one: `navigator.serviceWorker` is undefined, the app cannot really install, and the
notification permission can never be granted however many times it is asked for. That is a browser
rule, not a setting, and nothing in this product can substitute for it.

`tailscale serve` is the fix, because it hands out a real certificate for the machine's own name:

```bash
tailscale serve --bg 47292      # then open https://<machine>.<tailnet>.ts.net
```

**And on iOS the browser matters after that.** Every iOS browser is WebKit underneath, but only a web
app added to the Home Screen **from Safari** actually runs standalone — and only a standalone one is
given the Notification API at all. A shortcut added from Chrome opens inside Chrome and never will
be. So the order is: HTTPS first, then add it from Safari. Doing the second first lands in the same
place.

Settings → Notifications states whichever of these is in the way, one sentence each
(`supportFrom` in `lib/sessionNotifications.ts`), and withholds the permission button wherever
pressing it could not do anything — including when the permission is already `denied`, which the
browser will never re-prompt for.

### The document must not bounce here, and the keyboard must not strand it

The workspace is a fixed-height column whose conversation, list and aside each scroll inside
themselves — so a flick that runs off the end of one of them has nowhere to chain but the document,
which bounces the whole page (the header dragged out from under the status bar). And iOS scrolls
the page to bring the caret into view when the keyboard opens, which is the part that WORKS — the
composer riding up with it — but does not always undo it, so the composer and the fixed bar both
come back a little higher than they went. Both were reported together.

Both fixes are **non-structural**, and that is the point:

- `overscroll-behavior: none` on the document in this workspace (`html.ag-viewport-locked`), plus
  `contain` on every inner scroller. Paint-only: no box, no containing block, no unit changes.
- The scroll is **put back when the keyboard closes**. iOS keeps doing the caret scroll.

**Preventing the scroll structurally was tried twice and reverted.** `position: fixed` on the body
is the usual iOS scroll-lock recipe, and it also moves the initial containing block onto the SMALL
viewport — so every viewport unit and every `position: fixed` descendant in the tree starts
measuring against a different box. `100dvh` then overflowed the locked box and `#root`'s clip took
the foot of the column off the screen; sizing the shell to `visualViewport.height` instead ended it
above the floor with the bottom bar anchored to that edge. Three position reports in an hour, from
two different numbers and one wrong idea: **a layout that is correct must not be re-anchored to fix
a scroll.** `mobileViewport.ts` now measures one thing — is the keyboard up — and sizes nothing.

Every other page keeps the window as its scroller, deliberately: they are columns of cards that grow
past the fold.

---

## What the workspace shares with the cockpit

**One poller, many readers.** The cockpit and the web used to run separate polls and disagree about
how many sessions existed — four in one, three in the other. `GET /api/fleet/snapshot` serves the
RAW `SessionSnapshot` (`shared-snapshot.ts`), and `agentop session ls`, `agentop hooks context` and
the cockpit all read it when a server is up. A one-shot command never stamps the heartbeat.

Every `enabled` flag, verb label and refusal sentence arrives already decided from the server, which
resolves them through the same `sessionActions` the cockpit resolves every keypress against — the
web holds no rule of its own about what a session may take.
