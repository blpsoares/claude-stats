# Sessions overhaul — Plan 3: the new-session wizard, and the session that must actually work

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one-page new-session modal into a four-step wizard with a review, give step 3 attachments, and — the part the user actually reported — make a session started from the UI come up running and usable, by removing the second, unvalidated spawn path.

**Architecture:** A pure reducer (`wizardSteps.ts`) decides what each step needs and whether it can advance, so "can I continue" is testable without rendering. The server side gets smaller, not bigger: the browser stops calling `POST /api/fleet/spawn` and calls the validated `POST /api/fleet/new`, which is planned by the pure `fleet-spawn.ts`.

**Tech Stack:** Bun, TypeScript (strict), React 18 + Vite, `bun test`, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-sessions-workspace-overhaul-design.md` (Phase 4).

**Depends on:** Plan 1 Task 1 (`harnessModels.ts`), Task 2 (`models` on the payload), Task 3 (the marks).

## Global Constraints

- Everything in this project is in **English**: code, comments, commit messages, PR text.
- Conventional Commits; commit after every task; `bun tsc --noEmit` and `bun test` green each time.
- **A spawn is the most powerful thing this server does.** Every check in `fleet-spawn.ts` exists because its absence fails silently. Refuse, never repair.
- **`attach` is not a field of a spawn request and never can be** — attaching needs a real tty, which an HTTP caller has none of.
- **A model is never validated against a list**; an effort always is (it is a closed enum from the CLI's own `--help`).
- **N/A, never a confident 0** — a question the harness cannot answer is skipped, not shown disabled.
- 44px targets are mobile-only; verify the wizard at 390px.
- **Do not use browser automation.** Use `curl`; ask the user to open the page.
- Stage **explicit paths**, never `git add -A`.

---

### Task 22: `wizardSteps.ts` — what each step needs

**Files:**
- Create: `packages/web/src/lib/wizardSteps.ts`
- Create: `packages/web/src/lib/wizardSteps.test.ts`

**Interfaces:**
- Produces: `WizardDraft`, `StepId = 'assistant' | 'where' | 'message' | 'review'`, `STEP_ORDER: StepId[]`, `stepReady(step, draft, harness): { ok: boolean; missing?: string }`, `visibleQuestions(harness): { model: boolean; effort: boolean }`, `nextStep(step)`, `prevStep(step)`, `clearForHarness(draft, harness): WizardDraft`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'bun:test'
import {
  STEP_ORDER, clearForHarness, nextStep, prevStep, stepReady, visibleQuestions,
  type WizardDraft,
} from './wizardSteps'

const claude = {
  id: 'claude', label: 'Claude Code',
  models: [{ id: 'opus', label: 'Opus 5' }],
  supportsModel: true, efforts: ['low', 'high'],
}
const codex = { id: 'codex', label: 'Codex', models: [], supportsModel: true, efforts: [] }
const empty: WizardDraft = {
  harness: '', cwd: '', task: '', model: '', effort: '', prompt: '', label: '', attachments: [],
}

describe('STEP_ORDER', () => {
  it('is assistant, where, message, review', () => {
    expect(STEP_ORDER).toEqual(['assistant', 'where', 'message', 'review'])
  })
})

describe('stepReady', () => {
  it('blocks step 1 until an assistant is chosen, and says what is missing', () => {
    const out = stepReady('assistant', empty, null)
    expect(out.ok).toBe(false)
    expect(out.missing).not.toBe('')
  })
  it('accepts step 1 with only an assistant — model, effort and name are optional', () => {
    expect(stepReady('assistant', { ...empty, harness: 'claude' }, claude).ok).toBe(true)
  })
  it('blocks step 2 until a directory is chosen', () => {
    expect(stepReady('where', { ...empty, harness: 'claude' }, claude).ok).toBe(false)
    expect(stepReady('where', { ...empty, harness: 'claude', cwd: '/home/u/p' }, claude).ok).toBe(true)
  })
  it('never blocks step 3 — the first message is optional', () => {
    expect(stepReady('message', { ...empty, harness: 'claude', cwd: '/home/u/p' }, claude).ok).toBe(true)
  })
  it('accepts review only when every earlier step does', () => {
    expect(stepReady('review', { ...empty, harness: 'claude' }, claude).ok).toBe(false)
    expect(stepReady('review', { ...empty, harness: 'claude', cwd: '/home/u/p' }, claude).ok).toBe(true)
  })
})

describe('visibleQuestions', () => {
  it('asks for a model only when the harness names some', () => {
    expect(visibleQuestions(claude).model).toBe(true)
    // supportsModel is true for codex, but it names no models — a dropdown whose only entry is
    // "the assistant's default" is a control that cannot be used.
    expect(visibleQuestions(codex).model).toBe(false)
  })
  it('asks for an effort only when the CLI prints a closed set', () => {
    expect(visibleQuestions(claude).effort).toBe(true)
    expect(visibleQuestions(codex).effort).toBe(false)
  })
  it('asks nothing extra when there is no harness yet', () => {
    expect(visibleQuestions(null)).toEqual({ model: false, effort: false })
  })
})

describe('navigation', () => {
  it('walks forward and back without falling off either end', () => {
    expect(nextStep('assistant')).toBe('where')
    expect(nextStep('review')).toBe('review')
    expect(prevStep('assistant')).toBe('assistant')
    expect(prevStep('review')).toBe('message')
  })
})

describe('clearForHarness', () => {
  it('drops a model and an effort the new assistant does not accept', () => {
    const d = { ...empty, harness: 'codex', model: 'opus', effort: 'high' }
    expect(clearForHarness(d, codex)).toMatchObject({ model: '', effort: '' })
  })
  it('keeps a model the new assistant does name', () => {
    const d = { ...empty, harness: 'claude', model: 'opus', effort: 'high' }
    expect(clearForHarness(d, claude)).toMatchObject({ model: 'opus', effort: 'high' })
  })
  it('never touches the answers that belong to any assistant', () => {
    const d = { ...empty, harness: 'codex', cwd: '/p', task: 't', prompt: 'go', label: 'n' }
    expect(clearForHarness(d, codex)).toMatchObject({ cwd: '/p', task: 't', prompt: 'go', label: 'n' })
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/sessions-overhaul
bun test packages/web/src/lib/wizardSteps.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/web/src/lib/wizardSteps.ts`:

```ts
/**
 * wizardSteps.ts — PURE: what the new-session wizard asks, in what order, and when it may advance.
 *
 * Separated from the rendering so "can I continue", "what is missing" and "what did they choose"
 * are answerable without a DOM. A wizard whose gating lives in JSX is a wizard nothing can check,
 * and this one gates the most powerful act the server performs.
 *
 * TWO RULES CARRIED OVER FROM THE TERMINAL WIZARD, both load-bearing:
 *
 * - The assistants offered are the ones `availableHarnesses()` found ON PATH. Anything else starts
 *   a tmux session that dies on `command not found` behind a screen nobody is watching.
 * - `model` and `effort` are SKIPPED, not shown-and-disabled, where the harness cannot take them.
 *   `efforts` is a closed set read from each CLI's own `--help`. A model question is skipped where
 *   the harness NAMES no models, even if it accepts `--model`: a dropdown whose only entry is "the
 *   assistant's default" is a control that cannot be used, while an absent one says "we cannot name
 *   these for you".
 */

export type StepId = 'assistant' | 'where' | 'message' | 'review'

export const STEP_ORDER: StepId[] = ['assistant', 'where', 'message', 'review']

export interface WizardHarness {
  id: string
  label: string
  models: { id: string; label: string }[]
  supportsModel: boolean
  efforts: string[]
}

export interface WizardDraft {
  harness: string
  cwd: string
  task: string
  model: string
  effort: string
  prompt: string
  label: string
  /** Paths already stored on the machine by `POST /api/fleet/attach`. */
  attachments: { name: string; path: string }[]
}

export interface StepState {
  ok: boolean
  /** What is missing, when it is not. Never an empty string when `ok` is false. */
  missing?: string
}

export function visibleQuestions(harness: WizardHarness | null): { model: boolean; effort: boolean } {
  if (!harness) return { model: false, effort: false }
  return {
    model: harness.supportsModel && harness.models.length > 0,
    effort: harness.efforts.length > 0,
  }
}

export function stepReady(step: StepId, draft: WizardDraft, harness: WizardHarness | null): StepState {
  switch (step) {
    case 'assistant':
      return harness && draft.harness !== ''
        ? { ok: true }
        : { ok: false, missing: 'assistant' }
    case 'where':
      return draft.cwd !== '' ? { ok: true } : { ok: false, missing: 'cwd' }
    // The first message is optional: a session started with none is a session waiting for you,
    // which is a perfectly ordinary thing to want.
    case 'message':
      return { ok: true }
    case 'review': {
      const a = stepReady('assistant', draft, harness)
      if (!a.ok) return a
      return stepReady('where', draft, harness)
    }
  }
}

export function nextStep(step: StepId): StepId {
  const i = STEP_ORDER.indexOf(step)
  return STEP_ORDER[Math.min(i + 1, STEP_ORDER.length - 1)]!
}

export function prevStep(step: StepId): StepId {
  const i = STEP_ORDER.indexOf(step)
  return STEP_ORDER[Math.max(i - 1, 0)]!
}

/**
 * Drop only the answers the NEW assistant cannot accept.
 *
 * Carrying `effort: 'high'` across to a harness whose set does not contain it would send a flag
 * the CLI rejects at spawn. Everything else — the directory, the task, the message, the name —
 * belongs to any assistant and going back a step must not silently discard it.
 */
export function clearForHarness(draft: WizardDraft, harness: WizardHarness | null): WizardDraft {
  const q = visibleQuestions(harness)
  const keepModel = q.model && harness!.models.some(m => m.id === draft.model)
  const keepEffort = q.effort && harness!.efforts.includes(draft.effort)
  return { ...draft, model: keepModel ? draft.model : '', effort: keepEffort ? draft.effort : '' }
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/web/src/lib/wizardSteps.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/lib/wizardSteps.ts packages/web/src/lib/wizardSteps.test.ts
git commit -m "feat(web): the new-session wizard's steps are a rule, not a render"
```

---

### Task 23: the wizard, four steps and a review

**Files:**
- Modify: `packages/web/src/components/sessions/NewSessionModal.tsx`

**Interfaces:**
- Consumes: `wizardSteps.ts` (Task 22), `HarnessMark` (Plan 1 Task 3), `models` on the `/api/fleet/new` payload (Plan 1 Task 2).

- [ ] **Step 1: Hold the draft and the step**

Replace the seven separate `useState` calls with one draft plus a step:

```tsx
const [step, setStep] = useState<StepId>('assistant')
const [draft, setDraft] = useState<WizardDraft>({
  harness: '', cwd: '', task: '', model: '', effort: '', prompt: '', label: '', attachments: [],
})
const harness = useMemo(
  () => harnesses?.find(h => h.id === draft.harness) ?? null,
  [harnesses, draft.harness],
)
const questions = visibleQuestions(harness)
const ready = stepReady(step, draft, harness)
```

Changing the assistant runs `setDraft(d => clearForHarness({ ...d, harness: id }, next))` — the
draft is never rebuilt from scratch, so nothing else is lost.

- [ ] **Step 2: Draw the step rail**

Above the body, a four-cell rail naming each step and marking the current one. A completed step is
clickable (going back is free); a later one is not (you cannot review answers you have not given).

```tsx
{STEP_ORDER.map((s, i) => {
  const done = STEP_ORDER.indexOf(step) > i
  return (
    <button
      key={s}
      onClick={() => { if (done) setStep(s) }}
      disabled={!done && s !== step}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 8,
        border: 'none', background: s === step ? 'var(--bg-elevated)' : 'transparent',
        color: s === step ? 'var(--text-primary)' : 'var(--text-tertiary)',
        cursor: done ? 'pointer' : 'default', fontFamily: 'inherit', fontSize: 12,
        fontWeight: s === step ? 700 : 500,
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 18, borderRadius: 9, fontSize: 10.5, fontWeight: 700,
        background: done || s === step ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
        color: done || s === step ? '#fff' : 'var(--text-tertiary)',
      }}>{i + 1}</span>
      {STEP_LABEL[s][pt ? 'pt' : 'en']}
    </button>
  )
})}
```

with

```tsx
const STEP_LABEL: Record<StepId, { en: string; pt: string }> = {
  assistant: { en: 'Assistant', pt: 'Assistente' },
  where: { en: 'Where', pt: 'Onde' },
  message: { en: 'Message', pt: 'Mensagem' },
  review: { en: 'Review', pt: 'Conferir' },
}
```

- [ ] **Step 3: Step 1 — assistant, model, effort, name**

Keep the existing assistant chips (now wearing the real marks) and the effort scale. The model
control becomes a list of `harness.models`, showing `label` and storing `id`:

```tsx
{questions.model && (
  <Field label={pt ? 'Modelo (opcional)' : 'Model (optional)'}>
    <select
      value={draft.model}
      onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
      style={{ …inputStyle, paddingLeft: 12, paddingRight: 30, appearance: 'none', cursor: 'pointer' }}
    >
      <option value="">{pt ? 'Padrão do assistente' : "The assistant's default"}</option>
      {/* The LABEL is shown and the ID is stored. Never the reverse: `modelSwitch.ts` records
          that a display name sent to a CLI is `Model '…' not found` — a silent no-op. */}
      {harness!.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select>
  </Field>
)}
```

The session name moves here, beside the assistant, because it is the same question ("what is this
session"). Its placeholder stays the task or "Derived", and the hint stays: with no name, the
session uses whatever the assistant calls itself.

- [ ] **Step 4: Step 2 — project and task**

Unchanged from today's modal: the search field, the project list with `FolderGit2` for a
repository and `Folder` for a plain directory (read from the store's own answer, never guessed
from the path), and the task input with its `datalist`.

- [ ] **Step 5: Step 3 — message and attachments**

The textarea, plus the attachment control from Task 24.

- [ ] **Step 6: Step 4 — the review**

Every answer, grouped by the step it came from, each group with an "Edit" link back to that step:

```tsx
<ReviewRow label={pt ? 'Assistente' : 'Assistant'} value={harness?.label ?? ''} onEdit={() => setStep('assistant')} />
<ReviewRow label={pt ? 'Modelo' : 'Model'}
  // The label again, and "the assistant's default" rather than a blank: an empty cell on a review
  // screen reads as a question that was missed rather than one deliberately left open.
  value={draft.model === '' ? (pt ? 'Padrão do assistente' : "The assistant's default")
                            : (harness?.models.find(m => m.id === draft.model)?.label ?? draft.model)}
  onEdit={() => setStep('assistant')} />
<ReviewRow label={pt ? 'Onde' : 'Where'} value={draft.cwd} onEdit={() => setStep('where')} />
<ReviewRow label={pt ? 'Tarefa' : 'Task'} value={draft.task || '—'} onEdit={() => setStep('where')} />
<ReviewRow label={pt ? 'Primeira mensagem' : 'First message'} value={draft.prompt || '—'} onEdit={() => setStep('message')} />
<ReviewRow label={pt ? 'Anexos' : 'Attachments'} value={draft.attachments.map(a => a.name).join(', ') || '—'} onEdit={() => setStep('message')} />
```

- [ ] **Step 7: The footer**

`Back` (absent on step 1), and `Next` / `Start session` on the last step. `Next` is disabled when
`!ready.ok` and, when pressed while disabled, focuses the missing control rather than doing
nothing.

- [ ] **Step 8: Escape asks, once anything has been entered**

```tsx
// A wizard that discards four steps of answers on a stray Escape is a wizard people stop
// trusting. With an empty draft it closes immediately — there is nothing to lose.
const dirty = draft.harness !== '' || draft.cwd !== '' || draft.prompt !== '' || draft.task !== ''
```

- [ ] **Step 9: Verify at two widths**

```bash
bun run dev
```

Ask the user to walk all four steps at desktop width and at 390px, go back from the review and
change the assistant, and confirm the directory and message survive.

- [ ] **Step 10: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/sessions/NewSessionModal.tsx
git commit -m "feat(web): starting a session is a wizard that shows you what you chose"
```

---

### Task 24: attachments in step 3

**Files:**
- Modify: `packages/web/src/components/sessions/NewSessionModal.tsx`

**Interfaces:**
- Consumes: `POST /api/fleet/attach` (multipart), which returns the stored path; `MAX_ATTACHMENT_BYTES` (20 MB).

- [ ] **Step 1: Reuse the composer's upload, verbatim**

`SessionChat.tsx` already uploads a file to `POST /api/fleet/attach?lang=…` and appends the
returned path to the message. Lift that call into a small helper both use — do not write a second
uploader. Read `SessionChat.tsx`'s `pick(files)` and its `onPaste` handler and move the shared part
to `packages/web/src/lib/attachFiles.ts`:

```ts
/**
 * attachFiles.ts — putting a file where a session can read it.
 *
 * This is NOT what "attach" means in a chat application, and both surfaces say so: the file is
 * written on the MACHINE running the session, and what goes into the message is its PATH. A
 * session is a process on a computer, and the only thing it can open is a file on that computer.
 */
export async function attachFiles(files: FileList | null, lang: 'en' | 'pt'): Promise<{
  attached: { name: string; path: string }[]
  errors: string[]
}>
```

- [ ] **Step 2: Take a paste as well as a pick**

On the step-3 textarea:

```tsx
onPaste={e => {
  const files = e.clipboardData?.files
  if (!files || files.length === 0) return   // an ordinary text paste is left alone
  e.preventDefault()
  void add(files)
}}
```

- [ ] **Step 3: Say what an attachment is, where it is shown**

Under the chips, the same sentence the composer uses:

```tsx
<span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
  {pt
    ? 'gravados nesta máquina; o caminho vai na mensagem'
    : 'stored on this machine; the path goes in the message'}
</span>
```

- [ ] **Step 4: Compose the message at start**

The paths are appended to `prompt` when the request is built, one per line, so what the session
receives is the message plus the files it can open. If `prompt` is empty and there are
attachments, the message is the paths alone — which is a perfectly good first message.

- [ ] **Step 5: Verify**

```bash
bun run dev
```

Ask the user to attach a file and to paste a screenshot into the field, then start the session and
confirm the paths arrived in the first message and that the files exist at those paths.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/lib/attachFiles.ts packages/web/src/components/sessions/NewSessionModal.tsx packages/web/src/components/sessions/SessionChat.tsx
git commit -m "feat(web): the wizard's first message can carry files, by one uploader not two"
```

---

### Task 25: reproduce the session that comes up unusable

**Files:** determined by the finding.

**REQUIRED SUB-SKILL:** `superpowers:systematic-debugging`. Do not patch before the cause is known.

The report: *"I already tried creating sessions through the UI and it created it as inactive and
there is simply no way to interact with it."*

- [ ] **Step 1: Reproduce from the API, not the UI**

This separates "the request is wrong" from "the UI is wrong". With a server running:

```bash
curl -s -X POST 'http://localhost:47291/api/fleet/spawn?lang=en' \
  -H 'Content-Type: application/json' \
  -d '{"harness":"claude","cwd":"'"$HOME"'/agentistics","label":"spawn-probe"}'
```

Record the exact response, including whether it carries an `id`.

- [ ] **Step 2: Ask the fleet what it thinks of that session**

```bash
curl -s 'http://localhost:47291/api/fleet?lang=en' > /tmp/fleet-after.json
node -e "const f=require('/tmp/fleet-after.json');
const r=f.rows.find(x=>x.title.includes('spawn-probe')||x.id==='<the id from step 1>');
console.log(JSON.stringify({id:r?.id,state:r?.state,stateLabel:r?.stateLabel,conversationId:r?.conversationId,verbs:r?.verbs?.map(v=>v.action+':'+v.enabled)},null,2));
console.log('lastLines:', (r?.lastLines??[]).join('\n'))"
```

`lastLines` is the answer to most of this: if the pane holds a usage error, the argv was wrong.

- [ ] **Step 3: Ask tmux directly**

```bash
tmux -L agentop list-sessions
tmux -L agentop capture-pane -p -t <the tmux session name> | tail -20
```

`remain-on-exit on` means a dead process leaves its pane behind — so a pane that exists proves
nothing about a process that lives. `list-panes -F '#{pane_dead}'` is what distinguishes them.

- [ ] **Step 4: Compare the two spawn paths on the same input**

```bash
curl -s -X POST 'http://localhost:47291/api/fleet/new?lang=en' \
  -H 'Content-Type: application/json' \
  -d '{"harness":"claude","cwd":"'"$HOME"'/agentistics","label":"spawn-probe-2"}'
```

If this one produces a usable session and `/api/fleet/spawn` does not, the cause is in
`spawn-web.ts`'s unvalidated reading of the body, and Task 26 is the fix. If both fail
identically, the cause is below both, in `spawnManaged`.

- [ ] **Step 5: Check the UI's own last step**

Whatever the server does, the modal navigates to `/sessions/<id>` the moment the response
arrives, while the fleet poll runs every 5 s. If the row is not there yet the page shows *"That
session is no longer in this machine's list."* — which reads exactly like a session that was
created and cannot be interacted with. Confirm or eliminate this by watching the page after a
successful spawn: if the row appears within a poll interval, the fix is to hold the navigation
until the row arrives (or to seed it), not to change the spawn.

- [ ] **Step 6: Write down the cause before fixing it**

State it in one sentence, with the evidence from the steps above, in the task's eventual commit
body. Then fix it, and add a test if the fix lives in a pure function.

- [ ] **Step 7: Clean up the probes**

```bash
tmux -L agentop kill-session -t <each probe session>
```

- [ ] **Step 8: Commit**

```bash
bun tsc --noEmit && bun test
git commit -m "fix(server): a session started from the dashboard comes up running"
```

---

### Task 26: one spawn path

**Files:**
- Modify: `packages/web/src/components/sessions/NewSessionModal.tsx` (the request)
- Modify: `packages/server/server/index.ts` (delete the dead `GET` handler; narrow `POST /api/fleet/spawn`)
- Modify: `packages/server/server/sessions/spawn-web.ts` (remove `spawnFromWeb`)
- Modify: `packages/server/server/sessions/fleet-web.ts` if `readNewOptions` needs the `models` field

- [ ] **Step 1: Point the wizard at the validated route**

In `NewSessionModal.tsx`, `start()` posts to `/api/fleet/new` instead of `/api/fleet/spawn`. The
body shape is unchanged — `FleetSpawnBody` accepts exactly `harness`, `cwd`, `task`, `prompt`,
`model`, `effort`, `label`.

```tsx
const res = await fetch(`/api/fleet/new?lang=${lang}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    harness: draft.harness,
    cwd: draft.cwd,
    ...(draft.task ? { task: draft.task } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(promptWithAttachments ? { prompt: promptWithAttachments } : {}),
    ...(draft.label ? { label: draft.label } : {}),
  }),
})
```

- [ ] **Step 2: Delete the unreachable `GET` handler**

`packages/server/server/index.ts` registers `GET /api/fleet/new` **twice** — at roughly line 1153
(delegating to `readNewOptions`) and again at roughly line 1261 (delegating to
`webHarnesses`/`webProjects`/`webTasks`). The second can never run. Before deleting it, confirm the
survivor answers everything the browser needs:

```bash
curl -s 'http://localhost:47291/api/fleet/new?lang=en&q=' | head -c 400
```

It must carry `harnesses` (with `models`, per Plan 1 Task 2), `projects` and `tasks`. If
`readNewOptions` is missing any of them, add it there — that is the handler that runs — and only
then delete the second block.

- [ ] **Step 3: Narrow `POST /api/fleet/spawn` to what still uses it**

That handler carries two things: a spawn and `reopenFell`. Remove the spawn branch and keep the
other, with a comment recording why:

```ts
/**
 * Reopen everything that fell.
 *
 * The SPAWN branch that used to live here is gone. It read its fields with
 * `String(v['…'] ?? '')` and performed none of `fleet-spawn.ts`'s checks, while
 * `POST /api/fleet/new` — the route the VS Code extension already used — performs all of them.
 * Two validations for one act is the duplication this repository is built against, and the weaker
 * one was the browser's.
 */
if (url.pathname === '/api/fleet/spawn' && req.method === 'POST') {
  // …reopenFell only; anything else is a 400 naming the route that starts sessions.
}
```

A spawn body arriving here answers `400` with a message naming `POST /api/fleet/new`, rather than
silently doing nothing.

- [ ] **Step 4: Remove `spawnFromWeb`**

Delete it from `spawn-web.ts` along with `SpawnWebRequest` and `SpawnWebResult`, and update that
module's header: the paragraph promising "the same host the terminal cockpit drives" stays true of
`reopenFellFromWeb`, which remains.

- [ ] **Step 5: Confirm nothing else called it**

```bash
grep -rn "fleet/spawn\|spawnFromWeb\|SpawnWebRequest" packages --include=*.ts --include=*.tsx
```

Expected: only the `reopenFell` caller and this plan's own edits. The VS Code extension
(`packages/vscode`) must be untouched — it uses `POST /api/fleet/new`.

- [ ] **Step 6: Verify end to end**

```bash
bun run dev
```

Ask the user to start a session through the wizard and confirm, without touching a terminal:

- the row appears as running;
- the terminal view shows its live screen;
- a message sent from the composer reaches it.

That is the acceptance for the whole plan.

- [ ] **Step 7: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/sessions/NewSessionModal.tsx packages/server/server/index.ts packages/server/server/sessions/spawn-web.ts packages/server/server/sessions/fleet-web.ts
git commit -m "refactor(server): one route starts a session, and it is the one that checks the request"
```

---

## Plan 3 self-review

- **Spec coverage.** Phase 4.1 → Tasks 22–24. Phase 4.2 → Tasks 25–26.
- **Interfaces.** `wizardSteps.ts` (22) is consumed by 23. `attachFiles` (24) by 23 and by
  `SessionChat`. Task 26 consumes the `models` field from Plan 1 Task 2 through the surviving
  `readNewOptions`.
- **Order.** 22 → 23 → 24. 25 must run before 26 — a fix applied before the cause is known is a
  guess, and the whole point of 25 is that the cause may not be in the spawn route at all.
