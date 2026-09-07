# Sessions overhaul — Plan 1: foundations and the list

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the session list its missing controls — reorderable pins, a right-click menu, filters that actually narrow, "active only" as a real filter dimension on both pages, a heatmap on the landing screen, and a collapsed rail that shows sessions instead of the dashboard's nav.

**Architecture:** Everything new is a pure module plus a thin renderer. Arrangement rules stay in `@agentistics/tui/control/session-fleet` (the cockpit's own), verb availability stays in the server's `sessionActions`, and this plan adds no second implementation of either. Two new pure modules (`harnessModels.ts`, `planPinMove`) and one new component (`SessionRowMenu`).

**Tech Stack:** Bun, TypeScript (strict), React 18 + Vite, `bun test`, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-sessions-workspace-overhaul-design.md` (Phases 0, 1, 1b).

## Global Constraints

- Everything in this project is in **English**: code, comments, commit messages, PR text.
- Commits follow **Conventional Commits**. Commit after every task.
- `bun tsc --noEmit` and `bun test` must be green at the end of every task (the pre-commit hook runs both).
- **Never mock the filesystem.** The tested functions are pure.
- **`stats-cache.json` is Claude-only.** Never aggregate a non-Claude harness from it.
- **N/A, never a confident 0.** An absent capability is stated in words; a control that cannot work is absent with its reason, never present and inert.
- **Do not use browser automation to verify** — it hangs in this environment. Use `curl`, and ask the user to open the page.
- 44px touch targets are the **mobile** figure only (`useIsMobile()`, breakpoint 768). Do not apply them on desktop.
- Any `<input>` visible on mobile must compute to ≥16px; the global guard in `index.css` handles it — do not override it inline.
- Work happens in the worktree `.claude/worktrees/sessions-overhaul` on branch `feat/sessions-overhaul`. Stage **explicit paths**, never `git add -A` — other sessions share this repository.

---

### Task 1: `harnessModels.ts` — the model table gains display names

**Files:**
- Create: `packages/core/src/harnessModels.ts`
- Create: `packages/core/src/harnessModels.test.ts`
- Modify: `packages/core/src/index.ts` (add the barrel re-export)

**Interfaces:**
- Consumes: `HarnessId` from `packages/core/src/types.ts`.
- Produces: `ModelOption { id: string; label: string; verifiedAt: string; source: string }`, `HARNESS_MODELS: Record<HarnessId, ModelOption[]>`, `modelsFor(harness: string): ModelOption[]`, `modelLabel(harness: string, id: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/harnessModels.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { HARNESS_MODELS, modelLabel, modelsFor } from './harnessModels'
import { SPAWN_SPECS_MODEL_IDS } from './harnessModels'

describe('HARNESS_MODELS', () => {
  it('gives claude the four aliases its CLI accepts, with the names it prints', () => {
    expect(modelsFor('claude').map(m => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(modelLabel('claude', 'opus')).toBe('Opus 5')
    expect(modelLabel('claude', 'haiku')).toBe('Haiku 4.5')
  })

  it('carries provenance on every entry — a pair with no source may not exist', () => {
    for (const [harness, options] of Object.entries(HARNESS_MODELS)) {
      for (const o of options) {
        expect(o.id, `${harness} id`).not.toBe('')
        expect(o.label, `${harness} label`).not.toBe('')
        expect(o.verifiedAt, `${harness}/${o.id} verifiedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(o.source, `${harness}/${o.id} source`).not.toBe('')
      }
    }
  })

  it('names every harness, so adding one breaks the build here', () => {
    for (const h of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi']) {
      expect(HARNESS_MODELS[h as keyof typeof HARNESS_MODELS]).toBeDefined()
    }
  })

  it('has no entry for a harness whose CLI publishes no list', () => {
    // Measured 2026-09-02 and recorded in spawn-spec.ts: codex and gemini name nothing.
    expect(modelsFor('codex')).toEqual([])
    expect(modelsFor('gemini')).toEqual([])
  })

  it('falls back to the id when a label is unknown, never to an invented name', () => {
    expect(modelLabel('claude', 'claude-opus-5-20260101')).toBe('claude-opus-5-20260101')
    expect(modelLabel('nope', 'x')).toBe('x')
  })

  it('exports exactly the ids the spawn specs accept, so one list feeds both surfaces', () => {
    expect(SPAWN_SPECS_MODEL_IDS.claude).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/sessions-overhaul
bun test packages/core/src/harnessModels.test.ts
```

Expected: FAIL — `Cannot find module './harnessModels'`.

- [ ] **Step 3: Write the module**

Create `packages/core/src/harnessModels.ts`:

```ts
/**
 * harnessModels.ts — PURE: the models each harness offers, and the NAME each one goes by.
 *
 * `spawn-spec.ts` already holds the ids `--model` accepts, and its rule is the one this file
 * inherits verbatim: A VALUE APPEARS HERE ONLY IF THE CLI ITSELF NAMES IT — in `--help`, in a
 * listing subcommand, or by answering with it when driven. A plausible id sourced from anywhere
 * else is a guess, and a guess here fails after the session has already started.
 *
 * What this file adds is the second half of the pair. The picker used to print `opus` while the
 * harness's own `/model` prints `Opus 5`, so the two surfaces named the same model differently.
 * The LABEL is what a person reads; the ID is what is sent, always.
 *
 * The direction matters and has bitten before. `modelSwitch.ts` records it: `/model` matches the
 * id, so a display label typed into a live session answers `Model 'Opus 5' not found` — a silent
 * no-op the user reads as the switch having worked. Never send `label`.
 *
 * This is a convenience and never a validation set: `planSpawn` does not check membership, because
 * every one of these CLIs also accepts a full model name and several scope what is available to
 * the signed-in account.
 */

import type { HarnessId } from './types'

export interface ModelOption {
  /** What the CLI accepts. Sent verbatim. */
  id: string
  /** What the harness itself calls it on screen. Displayed, never sent. */
  label: string
  /** When the pair was established, `YYYY-MM-DD`. */
  verifiedAt: string
  /** The exact command or output that established it. */
  source: string
}

/**
 * A `Record`, never an array or a partial: TypeScript accepts an array literal with a member
 * missing, and CLAUDE.md records five surfaces that silently lost a harness exactly that way.
 */
export const HARNESS_MODELS: Record<HarnessId, ModelOption[]> = {
  // VERIFIED 2026-09-02 against claude 2.1.259 by driving the CLI:
  //   `claude --model <alias> -p ok` is accepted for all four;
  //   `claude -p "/model <alias>"` answers `Set model to \`Fable 5.1\` | \`Opus 5\` |
  //   \`Sonnet 5\` | \`Haiku 4.5\`` for the same four.
  // `mythos` is deliberately ABSENT: both front doors reject it on this version.
  claude: [
    { id: 'fable', label: 'Fable 5.1', verifiedAt: '2026-09-02', source: 'claude -p "/model fable" → Set model to `Fable 5.1`' },
    { id: 'opus', label: 'Opus 5', verifiedAt: '2026-09-02', source: 'claude -p "/model opus" → Set model to `Opus 5`' },
    { id: 'sonnet', label: 'Sonnet 5', verifiedAt: '2026-09-02', source: 'claude -p "/model sonnet" → Set model to `Sonnet 5`' },
    { id: 'haiku', label: 'Haiku 4.5', verifiedAt: '2026-09-02', source: 'claude -p "/model haiku" → Set model to `Haiku 4.5`' },
  ],
  // `codex --help` prints "-m, --model <MODEL>" with no values, and no subcommand lists any.
  // Nothing to name honestly.
  codex: [],
  // `gemini --help` names no models; the string is forwarded verbatim to the Google API, which is
  // what rejects an unknown one. Nothing the CLI itself names.
  gemini: [],
  // Measured 2026-09-02: of copilot's three shipped ids only `auto` was accepted; the other two —
  // and copilot's OWN help example — came back `Model "…" from --model flag is not available.`
  copilot: [
    { id: 'auto', label: 'Auto', verifiedAt: '2026-09-02', source: "copilot --help: \"use 'auto' to let Copilot pick\"; the only id accepted when driven" },
  ],
  // `agy models` is the only real listing command here, and it names the effort-suffixed ids.
  // Caveat kept honest: `agy models` FETCHES, so this is a snapshot of what it answered.
  antigravity: [
    { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (low)', verifiedAt: '2026-08-13', source: 'agy models' },
    { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (medium)', verifiedAt: '2026-08-13', source: 'agy models' },
    { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (high)', verifiedAt: '2026-08-13', source: 'agy models' },
  ],
  // Kimi routes per request and its CLI publishes no list of accepted `--model` values.
  kimi: [],
}

/** The ids only, keyed by harness — what `spawn-spec.ts`'s `modelSuggestions` must equal. */
export const SPAWN_SPECS_MODEL_IDS: Record<HarnessId, string[]> = Object.fromEntries(
  Object.entries(HARNESS_MODELS).map(([h, opts]) => [h, opts.map(o => o.id)]),
) as Record<HarnessId, string[]>

/** Total: an unknown harness has no models, which is not the same as an error. */
export function modelsFor(harness: string): ModelOption[] {
  return HARNESS_MODELS[harness as HarnessId] ?? []
}

/**
 * The name to show for an id.
 *
 * Falls back to the ID ITSELF, never to an invented name: a session can legitimately run a full
 * model name this table does not list, and printing a guessed label over it would be the confident
 * -zero defect in words.
 */
export function modelLabel(harness: string, id: string): string {
  return modelsFor(harness).find(m => m.id === id)?.label ?? id
}
```

- [ ] **Step 4: Add the barrel export**

In `packages/core/src/index.ts`, add beside the other re-exports:

```ts
export * from './harnessModels'
```

- [ ] **Step 5: Run the tests**

```bash
bun test packages/core/src/harnessModels.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Pin the two lists together**

The whole point is that `spawn-spec.ts` and this table cannot drift. Add to
`packages/server/server/sessions/spawn-spec.test.ts`:

```ts
import { SPAWN_SPECS_MODEL_IDS } from '@agentistics/core'

it('offers exactly the ids harnessModels names, so the picker and the flag agree', () => {
  for (const [harness, spec] of Object.entries(SPAWN_SPECS)) {
    if (!spec) continue
    expect(spec.modelSuggestions ?? [], harness).toEqual(
      SPAWN_SPECS_MODEL_IDS[harness as keyof typeof SPAWN_SPECS_MODEL_IDS] ?? [],
    )
  }
})
```

- [ ] **Step 7: Run it, and reconcile whichever side is wrong**

```bash
bun test packages/server/server/sessions/spawn-spec.test.ts
```

If it fails, the `spawn-spec.ts` list is the authority on **which ids exist** — copy its ids into
`HARNESS_MODELS` and supply a label and a source for each. Never the reverse: do not add an id to
`spawn-spec.ts` to make this test pass.

- [ ] **Step 8: Full gate and commit**

```bash
bun tsc --noEmit && bun test
git add packages/core/src/harnessModels.ts packages/core/src/harnessModels.test.ts packages/core/src/index.ts packages/server/server/sessions/spawn-spec.test.ts
git commit -m "feat(core): a model carries the NAME its harness prints, beside the id its CLI takes"
```

---

### Task 2: the models reach the browser

**Files:**
- Modify: `packages/server/server/sessions/spawn-web.ts` (the `WebHarnessOption` interface and `webHarnesses`)
- Test: `packages/server/server/sessions/spawn-web.test.ts` (create if absent)

**Interfaces:**
- Consumes: `ModelOption`, `modelsFor` (Task 1).
- Produces: `WebHarnessOption` gains `models: ModelOption[]`, **beside** the existing `modelSuggestions: string[]`.

- [ ] **Step 1: Write the failing test**

Create or extend `packages/server/server/sessions/spawn-web.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { webHarnesses } from './spawn-web'

const host = {
  async startableHarnesses() {
    return [{
      id: 'claude', label: 'Claude Code',
      modelSuggestions: ['fable', 'opus', 'sonnet', 'haiku'],
      supportsModel: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }]
  },
} as never

describe('webHarnesses', () => {
  it('carries the labelled models beside the ids, so the picker can print a name', async () => {
    const [claude] = await webHarnesses(host)
    expect(claude!.models.map(m => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(claude!.models.find(m => m.id === 'opus')!.label).toBe('Opus 5')
  })

  it('keeps modelSuggestions, so an older client is unaffected', async () => {
    const [claude] = await webHarnesses(host)
    expect(claude!.modelSuggestions).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/sessions/spawn-web.test.ts
```

Expected: FAIL — `models` is undefined.

- [ ] **Step 3: Implement**

In `packages/server/server/sessions/spawn-web.ts`, add the import and the field:

```ts
import { modelsFor, type ModelOption } from '@agentistics/core'

export interface WebHarnessOption {
  id: string
  label: string
  /**
   * The ids alone. KEPT for one release: the VS Code extension reads this field, and a client on
   * an older build is exactly the one that would break silently.
   */
  modelSuggestions: string[]
  /** The same models, each with the NAME the harness prints. See `harnessModels.ts`. */
  models: ModelOption[]
  supportsModel: boolean
  efforts: string[]
}

export async function webHarnesses(host: StartHost): Promise<WebHarnessOption[]> {
  if (!host.startableHarnesses) return []
  const found = await host.startableHarnesses()
  return found.map(h => ({ ...h, models: modelsFor(h.id) }))
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/server/server/sessions/spawn-web.test.ts
```

Expected: PASS.

- [ ] **Step 5: Confirm the live route carries it**

With a server running on this machine:

```bash
curl -s 'http://localhost:47291/api/fleet/new?lang=en' | head -c 600
```

Expected: each harness object carries a `models` array whose entries have `id` and `label`.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/server/server/sessions/spawn-web.ts packages/server/server/sessions/spawn-web.test.ts
git commit -m "feat(server): the harness options carry each model's own name"
```

---

### Task 3: the vendor marks

**Files:**
- Create: `packages/web/public/harness/codex.svg`, `gemini.svg`, `copilot.svg`, `antigravity.svg`, `kimi.svg`, `claude.svg` (or `.png` where no vector is published)
- Create: `packages/web/public/harness/SOURCES.md`
- Modify: `packages/web/src/components/sessions/HarnessMark.tsx`

**Interfaces:**
- Produces: `MARK_FILE: Record<string, string>` with all six harnesses.

- [ ] **Step 1: Fetch each vendor's own mark**

For each of the six, find the vendor's published brand asset (press kit, brand page, or the
project's own repository) and prefer SVG. Save to `packages/web/public/harness/<id>.svg`.

Do **not** redraw, trace, or approximate a mark. If a vendor publishes none, leave that harness
without a file — the monogram still covers it — and record the search in `SOURCES.md`.

- [ ] **Step 2: Record provenance**

Create `packages/web/public/harness/SOURCES.md`:

```markdown
# Harness marks — where each file came from

A file with no row here may not be committed. The rule is the same one `MODEL_PRICING` and
`contextWindows.ts` follow: a value that cannot state its source is a guess, and a guess about
somebody's trademark is worse than obviously not being one.

| file | harness | source URL | retrieved | notes |
|---|---|---|---|---|
| `claude.svg` | Claude Code | <url> | 2026-09-03 | replaces the older `claudeLogo.png` |
| `codex.svg` | Codex CLI | <url> | 2026-09-03 | |
| `gemini.svg` | Gemini CLI | <url> | 2026-09-03 | |
| `copilot.svg` | GitHub Copilot CLI | <url> | 2026-09-03 | |
| `antigravity.svg` | Antigravity (agy) | <url> | 2026-09-03 | |
| `kimi.svg` | Kimi Code | <url> | 2026-09-03 | |

Marks are the property of their respective owners and are used here to identify the tool whose
sessions are being shown.
```

Replace each `<url>` with the real one. A row left as `<url>` is a plan failure.

- [ ] **Step 3: Wire them up**

In `packages/web/src/components/sessions/HarnessMark.tsx`, replace the `MARK_FILE` constant and
update the header comment:

```ts
/**
 * Vendor assets present in this repository, with their provenance in
 * `public/harness/SOURCES.md`. A harness absent here falls back to its monogram — which STAYS,
 * for the next harness added before its mark is found. Deleting it would render a broken image.
 */
const MARK_FILE: Record<string, string> = {
  claude: '/harness/claude.svg',
  codex: '/harness/codex.svg',
  gemini: '/harness/gemini.svg',
  copilot: '/harness/copilot.svg',
  antigravity: '/harness/antigravity.svg',
  kimi: '/harness/kimi.svg',
}
```

Delete from the file header the paragraph beginning "WHAT IS AND IS NOT A LOGO HERE" and replace
it with a short one saying the marks are the vendors' own, sourced in `SOURCES.md`, and that the
monogram remains the fallback.

- [ ] **Step 4: Check every mark at its smallest size, on both themes**

`HarnessMark` is drawn at 14–28px. Run the dev server and look at the session list:

```bash
bun run dev
```

Ask the user to open `http://localhost:47292/sessions` and confirm each mark is legible at the row
size and does not vanish on the dark theme. A mark that disappears keeps the neutral
`var(--bg-elevated)` plate `HarnessMark` already applies to images.

- [ ] **Step 5: Leave the old asset alone for now**

Do not delete `packages/web/public/claudeLogo.png` in this task — other surfaces reference it.
Grep before removing it in a later cleanup:

```bash
grep -rn "claudeLogo" packages --include=*.ts --include=*.tsx --include=*.html
```

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/public/harness packages/web/src/components/sessions/HarnessMark.tsx
git commit -m "feat(web): each assistant wears its own mark, with the source recorded"
```

---

### Task 4: `planPinMove` — the pinned order is a rule, not a gesture

**Files:**
- Modify: `packages/web/src/lib/pinnedSessions.ts`
- Test: `packages/web/src/lib/pinnedSessions.test.ts` (create if absent)

**Interfaces:**
- Produces: `planPinMove(current: readonly string[], from: number, to: number): string[]` and `movePinnedSession(from: number, to: number): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test'
import { planPinMove } from './pinnedSessions'

describe('planPinMove', () => {
  it('moves a pin down', () => {
    expect(planPinMove(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
  })
  it('moves a pin up', () => {
    expect(planPinMove(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })
  it('is a no-op when nothing moves', () => {
    expect(planPinMove(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })
  it('leaves the list untouched for an index that does not exist', () => {
    expect(planPinMove(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
    expect(planPinMove(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(planPinMove([], 0, 0)).toEqual([])
  })
  it('never changes membership', () => {
    const out = planPinMove(['a', 'b', 'c', 'd'], 3, 1)
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/web/src/lib/pinnedSessions.test.ts
```

Expected: FAIL — `planPinMove is not a function`.

- [ ] **Step 3: Implement**

Add to `packages/web/src/lib/pinnedSessions.ts`:

```ts
/**
 * PURE: reorder the pinned set.
 *
 * Total — an index outside the list returns it unchanged rather than throwing or silently
 * appending. A drag can end anywhere, including outside the list, and a reorder that invents a
 * position is worse than one that does nothing.
 *
 * Membership is never touched here: only `planPinToggle` adds or removes.
 */
export function planPinMove(current: readonly string[], from: number, to: number): string[] {
  const next = [...current]
  if (from < 0 || from >= next.length) return next
  if (to < 0 || to >= next.length) return next
  if (from === to) return next
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/** Reorder and persist. Subscribers are notified exactly as `togglePinnedSession` notifies them. */
export function movePinnedSession(from: number, to: number): void {
  const next = planPinMove(current, from, to)
  if (next.length === current.length && next.every((x, i) => x === current[i])) return
  current = next
  persist()
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/web/src/lib/pinnedSessions.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/lib/pinnedSessions.ts packages/web/src/lib/pinnedSessions.test.ts
git commit -m "feat(web): the pinned set has an order, and one rule that decides it"
```

---

### Task 5: dragging a pinned session

**Files:**
- Modify: `packages/web/src/components/nav/SessionsAside.tsx` (the pinned band, ~lines 300–330, and `SessionRow`)
- Modify: `packages/web/src/index.css` (the drop indicator)

**Interfaces:**
- Consumes: `movePinnedSession` (Task 4).

- [ ] **Step 1: Hold the drag in local state**

In `SessionsAside`, beside `pinNotice`:

```tsx
/** Which pinned row is being dragged, and where it would land. Local: a drag is not shared state. */
const [dragFrom, setDragFrom] = useState<number | null>(null)
const [dragOver, setDragOver] = useState<number | null>(null)
```

- [ ] **Step 2: Make the pinned rows draggable**

Replace the pinned band's `pinnedRows.map(...)` body with:

```tsx
{pinnedRows.map((s, i) => (
  <div
    key={`pin-${s.id}`}
    draggable
    onDragStart={e => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move' }}
    onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(i) }}
    onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
    onDrop={e => {
      e.preventDefault()
      if (dragFrom !== null) movePinnedSession(dragFrom, i)
      setDragFrom(null); setDragOver(null)
    }}
    style={{
      // The drop target is shown as an EDGE, not by moving the rows: a list that reflows under
      // the cursor moves the target you were aiming at.
      boxShadow: dragOver === i && dragFrom !== null && dragFrom !== i
        ? 'inset 0 2px 0 var(--anthropic-orange)'
        : undefined,
      opacity: dragFrom === i ? 0.45 : 1,
    }}
  >
    <SessionRow
      session={s}
      selected={rowSelected(s, sessionId)}
      pinned
      {...(tap ? { tap } : {})}
      onPin={() => flip(s)}
      onOpen={() => (onOpenRow ? onOpenRow(s) : navigate(`/sessions/${s.id}`))}
      onMoveBy={d => movePinnedSession(i, i + d)}
    />
  </div>
))}
```

- [ ] **Step 3: Give the keyboard the same move**

In `SessionRow`'s props add `onMoveBy?: (delta: number) => void`, and on the row `<button>` add:

```tsx
onKeyDown={e => {
  // alt+arrows, so the plain arrows keep whatever the browser and the list do with them. A
  // reorder that exists only for a mouse is a reorder half the readers do not have.
  if (onMoveBy && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    onMoveBy(e.key === 'ArrowUp' ? -1 : 1)
  }
}}
```

- [ ] **Step 4: Make the touch target real**

The drag handle on touch is the row itself; ensure the wrapper `<div>` inherits `minHeight: tap`
from `SessionRow` (it already sets it) and add `touchAction: 'none'` to the wrapper **only when
`tap` is set**, so a drag does not scroll the list on a phone.

- [ ] **Step 5: Verify by hand**

```bash
bun run dev
```

Ask the user to open `http://localhost:47292/sessions`, pin three sessions, drag the third to the
top, and reload the page. Expected: the order survives the reload. Then focus a pinned row and
press `alt+↓`.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/nav/SessionsAside.tsx packages/web/src/index.css
git commit -m "feat(web): pinned sessions can be put in the order you want them"
```

---

### Task 6: the row's context menu

**Files:**
- Create: `packages/web/src/components/sessions/SessionRowMenu.tsx`
- Create: `packages/web/src/lib/rowMenu.ts`
- Create: `packages/web/src/lib/rowMenu.test.ts`
- Modify: `packages/web/src/components/nav/SessionsAside.tsx`

**Interfaces:**
- Consumes: `FleetRow['verbs']` (`{ action, label, enabled, reason? }[]`), `useFleet().act`.
- Produces: `rowMenuEntries(verbs, state): MenuEntry[]` where `MenuEntry = { action: string; label: string; enabled: boolean; reason?: string }`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/rowMenu.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { rowMenuEntries } from './rowMenu'

const verbs = [
  { action: 'rename', label: 'Rename', enabled: true },
  { action: 'interrupt', label: 'Stop the turn', enabled: true },
  { action: 'kill', label: 'End session', enabled: true },
  { action: 'resume', label: 'Reopen', enabled: false, reason: 'No conversation to reopen.' },
  { action: 'note', label: 'Note', enabled: true },
]

describe('rowMenuEntries', () => {
  it('offers rename, stop and reopen, in that order', () => {
    expect(rowMenuEntries(verbs, 'working').map(e => e.action)).toEqual(['rename', 'interrupt', 'resume'])
  })

  it('stops a running turn with interrupt and a stopped one with kill', () => {
    expect(rowMenuEntries(verbs, 'working')[1]!.action).toBe('interrupt')
    expect(rowMenuEntries(verbs, 'waiting')[1]!.action).toBe('kill')
  })

  it('keeps a refused verb, disabled, with its reason — never drops it', () => {
    const resume = rowMenuEntries(verbs, 'working').find(e => e.action === 'resume')!
    expect(resume.enabled).toBe(false)
    expect(resume.reason).toBe('No conversation to reopen.')
  })

  it('omits a verb the row does not carry at all', () => {
    expect(rowMenuEntries([{ action: 'rename', label: 'Rename', enabled: true }], 'lost')
      .map(e => e.action)).toEqual(['rename'])
  })

  it('is empty for a row with no verbs, so the caller can decline to open a menu', () => {
    expect(rowMenuEntries([], 'external')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/web/src/lib/rowMenu.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the rule**

Create `packages/web/src/lib/rowMenu.ts`:

```ts
/**
 * rowMenu.ts — PURE: what the right-click menu on a session row offers.
 *
 * It COMPOSES NOTHING. Every entry is one of the row's own `verbs`, which the server already
 * resolved through the same `sessionActions` the cockpit resolves every keypress against, and
 * which arrive already localized with their `enabled` flag and their `reason`. A second table here
 * would be a second set of rules for one gesture — the defect `task-reopen.ts` exists to have
 * fixed once.
 *
 * A verb the row cannot take stays in the menu, DISABLED, with its reason. A menu that silently
 * loses half its entries reads as a broken feature, and an absence explains nothing — the same
 * call `fleet-row.ts` makes for a verb it refuses.
 *
 * "Stop" is two different verbs. On a row that is mid-turn it is `interrupt` (stop what it is
 * doing, keep the session); everywhere else it is `kill` (end it). Offering both would ask the
 * reader to know the difference before they have read the row.
 */

export interface RowVerb {
  action: string
  label: string
  enabled: boolean
  reason?: string
}

export type MenuEntry = RowVerb

/** States where the session is mid-turn, so "stop" means the TURN and not the session. */
const MID_TURN = new Set(['working'])

export function rowMenuEntries(verbs: readonly RowVerb[], state: string): MenuEntry[] {
  const find = (a: string) => verbs.find(v => v.action === a)
  const stop = MID_TURN.has(state) ? find('interrupt') : find('kill')
  return [find('rename'), stop, find('resume')].filter((v): v is RowVerb => v !== undefined)
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/web/src/lib/rowMenu.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Draw the menu**

Create `packages/web/src/components/sessions/SessionRowMenu.tsx`:

```tsx
/**
 * SessionRowMenu — the right-click menu on a session row.
 *
 * A portal, so it escapes the aside's `overflow` clipping, positioned at the pointer and flipped
 * when it would leave the viewport. It closes on an outside `mousedown` (on the press, not on a
 * release that may land somewhere else), on `Escape`, and after any entry is taken; focus returns
 * to the row.
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { MenuEntry } from '../../lib/rowMenu'

export interface SessionRowMenuProps {
  x: number
  y: number
  entries: MenuEntry[]
  onPick: (action: string) => void
  onClose: () => void
}

export function SessionRowMenu({ x, y, entries, onPick, onClose }: SessionRowMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])

  // Flipped rather than clamped: a menu pinned to the viewport edge covers the row it belongs to.
  const w = 210
  const left = x + w > window.innerWidth ? Math.max(4, x - w) : x
  const top = y + entries.length * 34 + 12 > window.innerHeight
    ? Math.max(4, y - (entries.length * 34 + 12))
    : y

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed', top, left, width: w, zIndex: 600,
        background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
        padding: 4, boxShadow: 'var(--ag-shadow-pop)',
      }}
    >
      {entries.map(e => (
        <button
          key={e.action}
          role="menuitem"
          disabled={!e.enabled}
          // The reason is on the entry itself, so a disabled row explains itself on hover instead
          // of leaving the reader to guess.
          title={e.reason}
          onClick={() => { if (e.enabled) { onPick(e.action); onClose() } }}
          style={{
            display: 'flex', alignItems: 'center', width: '100%', gap: 8,
            padding: '8px 10px', borderRadius: 7, border: 'none', textAlign: 'left',
            background: 'transparent', fontFamily: 'inherit', fontSize: 12.5,
            color: e.enabled ? 'var(--text-primary)' : 'var(--text-tertiary)',
            cursor: e.enabled ? 'pointer' : 'default',
          }}
          onMouseEnter={ev => { if (e.enabled) ev.currentTarget.style.background = 'var(--bg-elevated)' }}
          onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
        >
          {e.label}
        </button>
      ))}
      {/* A row with a refused verb says why here too, not only on hover: a tooltip is a fact only
          a mouse can reach. */}
      {entries.some(e => !e.enabled && e.reason) && (
        <p style={{
          margin: '4px 6px 2px', fontSize: 10.5, lineHeight: 1.4, color: 'var(--text-tertiary)',
        }}>
          {entries.find(e => !e.enabled && e.reason)!.reason}
        </p>
      )}
    </div>,
    document.body,
  )
}
```

- [ ] **Step 6: Open it from the row**

`SessionsAside` needs the fleet row (which carries `verbs`) and `act`. Both already exist in
`useFleet`; the aside currently receives neither, so add two optional props and pass them from
`App.tsx` and `SessionsPage.tsx` where `useFleet()` is already called:

```tsx
/** The fleet's action performer and the verb-carrying rows, for the row menu. Absent on a
 *  surface that cannot act — the menu is then not opened at all rather than opened inert. */
rowsById?: Map<string, { verbs: { action: string; label: string; enabled: boolean; reason?: string }[] }>
act?: (req: { id: string; action: string; text?: string }) => Promise<{ ok: boolean; message: string }>
```

On the row `<button>`:

```tsx
onContextMenu={e => {
  const verbs = rowsById?.get(session.id)?.verbs
  if (!verbs || verbs.length === 0) return   // let the browser's own menu through
  e.preventDefault()
  setMenu({ x: e.clientX, y: e.clientY, id: session.id, state: session.state, verbs })
}}
```

Long-press on touch: start a 500 ms timer in `onTouchStart`, cancel it in `onTouchMove` /
`onTouchEnd`, and open the menu at the touch point when it fires.

`rename` opens the existing rename flow (`SessionActions`' rename prompt); the other two call
`act({ id, action })` and surface the returned `message` through the aside's existing
`pinNotice`-style status line — renamed to `notice`, since it is no longer only about pins.

- [ ] **Step 7: Verify by hand, on a machine and on a central**

```bash
bun run dev
```

Ask the user to right-click a running session (expect Rename / Stop the turn / Reopen, with Reopen
disabled and explained), and a `lost` one (expect Rename / End session / Reopen, with Reopen
enabled).

- [ ] **Step 8: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/lib/rowMenu.ts packages/web/src/lib/rowMenu.test.ts packages/web/src/components/sessions/SessionRowMenu.tsx packages/web/src/components/nav/SessionsAside.tsx packages/web/src/App.tsx packages/web/src/pages/SessionsPage.tsx
git commit -m "feat(web): right-click a session and act on it, in the row's own words"
```

---

### Task 7: every fleet filter must actually narrow

**Files:**
- Modify: `packages/web/src/lib/fleetFilter.ts`
- Modify: `packages/web/src/lib/fleetFilter.test.ts`
- Modify: `packages/web/src/components/nav/SessionsAside.tsx` (the ignored-dimension line)

**Interfaces:**
- Produces: `ignoredDimensions(filters: Filters, lang: 'en' | 'pt'): string | null`.

- [ ] **Step 1: Measure before changing anything**

With a server running, capture a real fleet and the dashboard's filter options:

```bash
curl -s 'http://localhost:47291/api/fleet?lang=en' > /tmp/fleet.json
node -e "const f=require('/tmp/fleet.json');const r=f.rows;console.log('rows',r.length);
for (const k of ['harness','project','projectGroup','repo','model','cwd'])
  console.log(k, JSON.stringify([...new Set(r.map(x=>x[k]).filter(Boolean))].slice(0,8)))"
```

Write the result into the task's commit message. This is the evidence that each dimension was
checked against real rows rather than against a fixture.

- [ ] **Step 2: Write a failing test per dimension, using those real shapes**

Extend `packages/web/src/lib/fleetFilter.test.ts` with one test per applied dimension, each using
a row shaped like what step 1 printed. The repo has already been bitten here once — `matchesRepo`
exists because the dashboard's chips are canonical remote keys (`github.com/org/repo`) while a
fleet row carries the short name (`org/repo`), so repo filtering returned an empty list every
time. Assert both vocabularies:

```ts
it('matches a repo filter given as a canonical remote key', () => {
  const rows = [row({ repo: 'blpsoares/agentistics' })]
  const out = filterFleet({ rows, filters: f({ repos: ['github.com/blpsoares/agentistics'] }), activeOnly: false })
  expect(out.rows).toHaveLength(1)
})

it('matches a repo filter given as the short name', () => {
  const rows = [row({ repo: 'blpsoares/agentistics' })]
  const out = filterFleet({ rows, filters: f({ repos: ['blpsoares/agentistics'] }), activeOnly: false })
  expect(out.rows).toHaveLength(1)
})

it('matches a project filter given as a full path, a name, or a group', () => {
  const rows = [row({ project: 'agentistics', projectGroup: 'work', cwd: '/home/u/agentistics' })]
  for (const p of ['agentistics', 'work', '/home/u/agentistics']) {
    expect(filterFleet({ rows, filters: f({ projects: [p] }), activeOnly: false }).rows).toHaveLength(1)
  }
})

it('never lets a project filter on a parent directory sweep in every session', () => {
  const rows = [row({ cwd: '/home/u/agentistics' })]
  expect(filterFleet({ rows, filters: f({ projects: ['/home/u'] }), activeOnly: false }).rows).toHaveLength(0)
})

it('withholds a row whose model is unknown when a model filter is set', () => {
  const rows = [row({ model: undefined })]
  expect(filterFleet({ rows, filters: f({ models: ['opus'] }), activeOnly: false }).rows).toHaveLength(0)
})
```

- [ ] **Step 3: Run them**

```bash
bun test packages/web/src/lib/fleetFilter.test.ts
```

Any failure is a real defect in `filterFleet`. Fix it **in `fleetFilter.ts` and nowhere else** —
that module is the single place these semantics live.

- [ ] **Step 4: Write the failing test for the ignored dimensions**

```ts
import { ignoredDimensions } from './fleetFilter'

describe('ignoredDimensions', () => {
  it('names a date range the fleet cannot answer', () => {
    expect(ignoredDimensions(f({ dateRange: '7d' }), 'en'))
      .toBe('The date range does not narrow a live fleet.')
  })
  it('names several at once, in one sentence', () => {
    const s = ignoredDimensions(f({ dateRange: '7d', tags: ['t1'] }), 'en')!
    expect(s).toContain('date range')
    expect(s).toContain('tags')
  })
  it('is null when nothing set is ignored', () => {
    expect(ignoredDimensions(f({ harnesses: ['claude'] }), 'en')).toBeNull()
    expect(ignoredDimensions(f({ dateRange: 'all' }), 'en')).toBeNull()
  })
})
```

- [ ] **Step 5: Implement it**

Add to `packages/web/src/lib/fleetFilter.ts`:

```ts
/**
 * The dimensions that are SET and that this fleet cannot answer, in one sentence.
 *
 * The module's header records why each is ignored, and none of that changes. What changes is that
 * it is now SAID: a filter that appears to apply and does not is indistinguishable from one that
 * is broken, and every ignored dimension here was reported as exactly that at least once.
 *
 * `dateRange: 'all'` is not a filter, so it raises nothing.
 */
export function ignoredDimensions(filters: Filters, lang: 'en' | 'pt'): string | null {
  const pt = lang === 'pt'
  const named: string[] = []
  if (filters.dateRange && filters.dateRange !== 'all') named.push(pt ? 'o período' : 'the date range')
  if ((filters.tags?.length ?? 0) > 0) named.push(pt ? 'as tags' : 'tags')
  if ((filters.users?.length ?? 0) > 0) named.push(pt ? 'os membros' : 'members')
  if ((filters.teams?.length ?? 0) > 0) named.push(pt ? 'os times' : 'teams')
  if ((filters.machines?.length ?? 0) > 0) named.push(pt ? 'as máquinas' : 'machines')
  if (named.length === 0) return null
  const list = named.length === 1
    ? named[0]!
    : `${named.slice(0, -1).join(', ')} ${pt ? 'e' : 'and'} ${named[named.length - 1]}`
  return pt
    ? `${list.charAt(0).toUpperCase()}${list.slice(1)} não estreita uma frota viva.`
    : `${list.charAt(0).toUpperCase()}${list.slice(1)} does not narrow a live fleet.`
}
```

Adjust the expected strings in step 4's test to match this exact wording if they differ.

- [ ] **Step 6: Draw it above the list**

In `SessionsAside`, next to the `stale` notice (which is already rendered above the scroller for
the same reason — a caveat about every row below must not scroll away), add:

```tsx
{ignoredNote && (
  <p role="status" style={{
    margin: '0 2px', padding: '7px 9px', borderRadius: 8,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
    fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)',
  }}>
    {ignoredNote}
  </p>
)}
```

with `const ignoredNote = useMemo(() => ignoredDimensions(filters, lang), [filters, lang])`.

- [ ] **Step 7: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/lib/fleetFilter.ts packages/web/src/lib/fleetFilter.test.ts packages/web/src/components/nav/SessionsAside.tsx
git commit -m "fix(web): every fleet filter narrows, and the ones that cannot say so"
```

Include the step-1 measurement in the commit body.

---

### Task 8: "active only" becomes a filter dimension

**Files:**
- Modify: `packages/web/src/components/FiltersBar.tsx` (the `Dimension` union, the `+ Filtro` menu, the value picker)
- Modify: `packages/web/src/App.tsx` (both `FiltersBar` call sites)

**Interfaces:**
- Consumes: the existing `activeOnly` / `onActiveOnlyChange` props — no new props.
- Produces: `'activeOnly'` as a member of `Props['only']` and of the internal `Dimension` union.

- [ ] **Step 1: Move the control into the menu**

In `packages/web/src/components/FiltersBar.tsx`:

1. Add `'activeOnly'` to the `only?: Array<…>` union (line ~69) and to the internal `Dimension`
   union (line ~147).
2. Delete the standalone pill rendered around line ~387 (the one styled with
   `activeOnly ? '1px solid rgba(217,119,6,0.5)'`).
3. Offer `activeOnly` in the `+ Filtro` menu **only when `onActiveOnlyChange` is defined** — the
   existing rule, unchanged: *"Absent on every surface that has no fleet — the control is then not
   rendered at all rather than rendered inert."*
4. Picking it toggles immediately (it is a boolean, not a value list) and renders as a chip in the
   chip row with the other dimensions, removable like them.

- [ ] **Step 2: Offer it on the dashboard too**

In `App.tsx`, both `FiltersBar` call sites currently pass
`activeOnly={inSessionsWorkspace ? activeOnly : undefined}`. Replace both with the plain
`activeOnly={activeOnly}` / `onActiveOnlyChange={setActiveOnly}`, and add `'activeOnly'` to
`filterDimsForRoute` for the dashboard routes.

The default is unchanged: `useState(inSessionsWorkspace)` — on in the sessions workspace, off on
the dashboard.

- [ ] **Step 3: Withhold it where no fleet can be read**

`App.tsx` already calls `useFleet(...)` and holds `headerFleet`. Pass
`onActiveOnlyChange={fleetReadable ? setActiveOnly : undefined}` where

```tsx
// An exposed profile and a central with no machine chosen both report `unsupported`. Offering the
// dimension there would be a filter whose only possible answer is "nothing".
const fleetReadable = !headerFleetUnsupported
```

- [ ] **Step 4: Verify by hand**

```bash
bun run dev
```

Ask the user to confirm: on `/sessions` the switch is inside `+ Filtro` and defaults on; on `/`
it is in the same menu and defaults off; the chip appears in the chip row and can be removed.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/FiltersBar.tsx packages/web/src/App.tsx
git commit -m "feat(web): active only is a filter dimension, on both pages"
```

---

### Task 9: "active only" on the dashboard means what it says

**Files:**
- Create: `packages/web/src/lib/activeConversations.ts`
- Create: `packages/web/src/lib/activeConversations.test.ts`
- Modify: `packages/web/src/hooks/useData.ts` (`useDerivedStats`)
- Modify: `packages/web/src/App.tsx` (the cache-blind sentence)

**Interfaces:**
- Consumes: `ControlSession[]` from `useFleet`, `SessionMeta[]` from `AppData`.
- Produces: `runningConversationIds(rows): Set<string>` and `keepRunning(sessions, ids): SessionMeta[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test'
import { keepRunning, runningConversationIds } from './activeConversations'

const row = (o: Partial<{ state: string; conversationId: string }>) =>
  ({ state: 'working', ...o }) as never

describe('runningConversationIds', () => {
  it('collects only the conversations that are running now', () => {
    const ids = runningConversationIds([
      row({ state: 'working', conversationId: 'a' }),
      row({ state: 'waiting', conversationId: 'b' }),
      row({ state: 'exited', conversationId: 'c' }),
    ])
    expect([...ids].sort()).toEqual(['a', 'b'])
  })

  it('ignores a running row with no conversation link — it names nothing to intersect', () => {
    expect(runningConversationIds([row({ state: 'working' })]).size).toBe(0)
  })
})

describe('keepRunning', () => {
  it('keeps only the stored sessions whose conversation is live', () => {
    const s = [{ session_id: 'a' }, { session_id: 'z' }] as never[]
    expect(keepRunning(s, new Set(['a'])).map((x: never) => (x as { session_id: string }).session_id))
      .toEqual(['a'])
  })

  it('keeps nothing when nothing is running, rather than everything', () => {
    const s = [{ session_id: 'a' }] as never[]
    expect(keepRunning(s, new Set())).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/web/src/lib/activeConversations.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/web/src/lib/activeConversations.ts`:

```ts
/**
 * activeConversations.ts — PURE: which STORED sessions are running right now.
 *
 * "Active only" means one thing on the Sessions page (keep the rows in an active state) and has to
 * mean the same thing on the dashboard, where the rows are stored metrics rather than live
 * processes. The bridge is the conversation id: a live row that knows which conversation it is
 * writing names exactly one stored session.
 *
 * A running row with NO conversation link is ignored rather than guessed at. `spawn-spec.ts`
 * records why the link is exact where it exists and absent where it cannot: for codex, kimi,
 * gemini and agy no link can ever be recorded, and the harness-and-directory inference that
 * `claimResume` falls back to gives every session of one repository the same conversation. A
 * dashboard total is read at a glance and believed; an inferred one would silently attribute one
 * session's spend to another.
 *
 * The consequence the caller must carry: this scope is CACHE-BLIND. `stats-cache.json` has no
 * per-conversation granularity, so a filtered total must come from per-session sums — the same
 * rule the project and repo dimensions already follow.
 */

import type { SessionMeta } from '@agentistics/core'

const ACTIVE = new Set(['working', 'waiting', 'waiting-approval'])

export function runningConversationIds(
  rows: readonly { state: string; conversationId?: string }[],
): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (!ACTIVE.has(r.state)) continue
    if (r.conversationId === undefined || r.conversationId === '') continue
    out.add(r.conversationId)
  }
  return out
}

export function keepRunning(sessions: readonly SessionMeta[], ids: ReadonlySet<string>): SessionMeta[] {
  return sessions.filter(s => ids.has(s.session_id))
}
```

- [ ] **Step 4: Apply it in `useDerivedStats`**

`useDerivedStats` already has a cache-blind branch for project/repo/tag/model/date scopes. Add
`activeOnly` to the set of scopes that force it, and filter the session list through `keepRunning`
before the sums. Find the existing `cacheBlindScope` usage and extend it — do not add a second
branch:

```ts
// A live-fleet intersection has no cache granularity of any kind: `stats-cache.json` is keyed by
// day and model, never by conversation. Treating it as cache-backed would report the CACHE's
// totals under a scope the cache cannot express — the same scope reporting a fraction of itself,
// which CLAUDE.md records as the defect `resolveMachineCacheScope` exists to prevent.
const cacheBlind = cacheBlindScope(filters) || activeOnly
```

- [ ] **Step 5: Say it on the page**

Where the dashboard already prints its cache-blind note, add `activeOnly` to the condition and the
sentence:

- EN: "Showing only conversations running right now — these totals are summed per session."
- PT: "Mostrando só as conversas rodando agora — estes totais são somados por sessão."

- [ ] **Step 6: Verify the arithmetic by hand**

```bash
bun run dev
```

Ask the user to turn the switch on with one session running and confirm: the session count drops
to the number of live conversations, the cost is non-zero, and the sentence appears. A zero cost
with a non-zero count means the sums are reading the wrong list.

- [ ] **Step 7: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/lib/activeConversations.ts packages/web/src/lib/activeConversations.test.ts packages/web/src/hooks/useData.ts packages/web/src/App.tsx
git commit -m "feat(web): active only narrows the dashboard to what is running, and says how"
```

---

### Task 10: the heatmap on the landing screen

**Files:**
- Modify: `packages/web/src/components/sessions/FleetOverview.tsx`
- Modify: `packages/web/src/pages/SessionsPage.tsx`

**Interfaces:**
- Consumes: `derived.heatmapData: { date: string; value: number; sessions: number; tools: number }[]` from `AppContext` — already filter-aware, built by `useDerivedStats`.
- Produces: `FleetOverviewProps` gains `heatmap?: HeatmapDay[]`.

- [ ] **Step 1: Thread the data in**

In `SessionsPage.tsx`, `ctx` already carries `derived`. Pass it:

```tsx
<FleetOverview
  lang={pt ? 'pt' : 'en'}
  rows={fleet.rows}
  loading={loading}
  unsupported={unsupported}
  heatmap={derived.heatmapData}
  {...(fleet.unavailable ? { unavailable: fleet.unavailable } : {})}
/>
```

- [ ] **Step 2: Draw it**

In `FleetOverview.tsx`, under the `Stat` grid:

```tsx
{/* ONE calendar for every harness in view, not one strip each — the per-harness split lives in
    the day tooltip, which is where a comparison is actually made.

    It reads `derived.heatmapData`, which `useDerivedStats` has ALREADY narrowed by every active
    filter. That is the requirement, not a convenience: a heatmap beside filtered stats that is
    itself unfiltered puts two numbers on one screen under two different rules, which is the same
    defect as a cache-backed total beside a session-summed one. */}
{heatmap && heatmap.length > 0 && (
  <section style={{ marginBottom: 22 }}>
    <h2 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>
      {pt ? 'Atividade' : 'Activity'}
    </h2>
    <ActivityHeatmap data={heatmap} weeks={26} />
  </section>
)}
{heatmap && heatmap.length === 0 && (
  // Never an all-zero grid: an empty measurement and "nothing in this window" are different
  // facts, and a grid of empty cells reads as the first while meaning the second.
  <p style={{ margin: '0 0 22px', fontSize: 12, color: 'var(--text-tertiary)' }}>
    {pt
      ? 'Nenhuma atividade no período e nos filtros escolhidos.'
      : 'No activity in the chosen window and filters.'}
  </p>
)}
```

- [ ] **Step 3: Keep the alignment**

The section sits inside `FleetOverview`'s existing `PAGE_INSET` / `PAGE_MAX_WIDTH` container. Do
not give it its own max width: those two constants exist because the body and the filter row above
must move together, and a third geometry is how they drifted 53px apart before.

- [ ] **Step 4: Verify it reacts to the filters**

```bash
bun run dev
```

Ask the user to open `/sessions` with nothing selected, note the heatmap, then set a harness chip
and confirm the grid changes. If it does not, `derived.heatmapData` is being read before the
filters are applied — fix the wiring, not the component.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/sessions/FleetOverview.tsx packages/web/src/pages/SessionsPage.tsx
git commit -m "feat(web): the sessions landing screen shows the fleet's activity, under the same filters"
```

---

### Task 11: the collapsed aside shows sessions

**Files:**
- Create: `packages/web/src/components/nav/SessionsRail.tsx`
- Create: `packages/web/src/components/sessions/SessionFacts.tsx`
- Modify: `packages/web/src/components/nav/SessionsAside.tsx` (extract the row's body into `SessionFacts`)
- Modify: `packages/web/src/App.tsx` (the `mode === 'sessions' && !collapsed` branch, ~line 1081)

**Interfaces:**
- Produces: `SessionFacts({ session, dense }: { session: ControlSession; dense?: boolean })` — the title, state, harness, model, task and project block, used by BOTH the open row and the rail's tooltip.

- [ ] **Step 1: Extract the row's body, so there is one card**

Cut the contents of `SessionRow`'s inner `<span>` (title, state, harness, model, task) into a new
`packages/web/src/components/sessions/SessionFacts.tsx` and have `SessionRow` render it. Nothing
about the row changes on screen; this is the move that makes the next step honest.

```tsx
/**
 * SessionFacts — what a session row says about itself.
 *
 * Shared by the open list and by the collapsed rail's tooltip, deliberately: the tooltip has to
 * carry exactly what the row carries, and two implementations of one card is how they come to
 * disagree — the same argument `rowMenu.ts` makes about the verbs and `task-reopen.ts` makes about
 * reopening.
 */
```

- [ ] **Step 2: Run the tests and look at the list**

```bash
bun tsc --noEmit && bun test
bun run dev
```

Ask the user to confirm the session list looks exactly as it did. Commit this move on its own:

```bash
git add packages/web/src/components/sessions/SessionFacts.tsx packages/web/src/components/nav/SessionsAside.tsx
git commit -m "refactor(web): one card describes a session, wherever it is drawn"
```

- [ ] **Step 3: Build the rail**

Create `packages/web/src/components/nav/SessionsRail.tsx`:

```tsx
/**
 * SessionsRail — the sessions workspace, in a 64px column.
 *
 * The aside used to withhold this body when collapsed, and `App.tsx` recorded why: "a 64px rail
 * cannot show a session's title, and a list of unlabelled dots is a list nobody can read." So it
 * fell through to the DASHBOARD's nav — Home, Costs, Tools — which is the one thing the sessions
 * workspace certainly is not.
 *
 * The objection is answered rather than overruled: the glyph never carries the fact alone. The
 * mark says which assistant, the dot says whether it wants somebody, and the TOOLTIP carries
 * exactly what the open row carries, by rendering the same `SessionFacts`.
 *
 * Hover-only is acceptable HERE AND ONLY HERE: `SideNav` is not rendered below the mobile
 * breakpoint, so there is no touch reader being asked to hover. It opens on keyboard focus too.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { sessionNotify } from '@agentistics/tui/control/session-fleet'
import { HarnessMark } from '../sessions/HarnessMark'
import { SessionFacts } from '../sessions/SessionFacts'

/** How many marks the rail draws before it says how many more there are. */
const RAIL_MAX = 12

export function SessionsRail({ rows, lang, selectedId }: {
  rows: readonly ControlSession[]
  lang: 'pt' | 'en'
  selectedId?: string
}) {
  const navigate = useNavigate()
  const [tip, setTip] = useState<{ top: number; left: number; session: ControlSession } | null>(null)
  const shown = rows.slice(0, RAIL_MAX)
  const more = rows.length - shown.length

  return (
    <nav className="ag-noscroll" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      overflowY: 'auto', overflowX: 'hidden', flex: 1, paddingTop: 4,
    }}>
      {shown.map(s => (
        <button
          key={s.id}
          onClick={() => navigate(`/sessions/${s.id}`)}
          aria-label={s.title}
          onMouseEnter={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setTip({ top: r.top, left: r.right + 10, session: s })
          }}
          onFocus={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setTip({ top: r.top, left: r.right + 10, session: s })
          }}
          onMouseLeave={() => setTip(null)}
          onBlur={() => setTip(null)}
          style={{
            position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 40, height: 40, borderRadius: 10, border: 'none', cursor: 'pointer',
            background: s.id === selectedId ? 'var(--bg-elevated)' : 'transparent',
            boxShadow: s.id === selectedId ? 'inset 0 0 0 1px var(--border)' : undefined,
          }}
        >
          <HarnessMark harness={s.harness} size={22} />
          {/* The same dot the open row draws, and for the same reason: it marks a row that WANTS
              somebody, and it never carries that alone — the tooltip says it in words. */}
          {sessionNotify(s) && (
            <span aria-hidden style={{
              position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: 4,
              background: 'var(--anthropic-orange)', boxShadow: '0 0 0 2px var(--bg-surface)',
            }} />
          )}
        </button>
      ))}
      {more > 0 && (
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', paddingTop: 2 }}>+{more}</span>
      )}
      {tip && createPortal(
        <div role="tooltip" style={{
          position: 'fixed', top: Math.min(tip.top, window.innerHeight - 140), left: tip.left,
          width: 260, zIndex: 500, pointerEvents: 'none',
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '9px 11px', boxShadow: 'var(--ag-shadow-pop)',
        }}>
          <SessionFacts session={tip.session} lang={lang} />
        </div>,
        document.body,
      )}
    </nav>
  )
}
```

- [ ] **Step 4: Reach it from `App.tsx`**

Replace the branch at `packages/web/src/App.tsx:1081`:

```tsx
{mode === 'sessions' ? (
  collapsed ? (
    <SessionsRail rows={railRows} lang={pt ? 'pt' : 'en'} {...(sessionId ? { selectedId: sessionId } : {})} />
  ) : (
    <>
      {isCentral && <div style={{ padding: '0 2px 8px' }}><CentralSessions lang={pt ? 'pt' : 'en'} /></div>}
      <SessionsAside … />
    </>
  )
) : (
  <nav …>{/* the dashboard's own nav, unchanged */}</nav>
)}
```

`railRows` is the open list's order — pinned first, then active, then inactive — computed once in
`SideNav` so the rail and the list cannot disagree:

```tsx
// The SAME order the open list draws, so collapsing the aside never reshuffles the sessions.
// Pinned first (that is what pinning is for), then `sortSessions(…, DEFAULT_ORDER)` — the ranking
// the terminal cockpit breaks ties on, so "sorted by status" means one thing everywhere.
const railRows = useMemo(() => {
  const kept = filterFleet({ rows: fleet.rows, filters: sessionsFilters, activeOnly: sessionsActiveOnly }).rows
  const pinnedSet = new Set(getPinnedIds())
  const key = (r: ControlSession) => r.conversationId ?? r.id
  return [
    ...kept.filter(r => pinnedSet.has(key(r))),
    ...sortSessions(kept.filter(r => !pinnedSet.has(key(r))), DEFAULT_ORDER),
  ]
}, [fleet.rows, sessionsFilters, sessionsActiveOnly])
```

- [ ] **Step 5: Verify by hand**

```bash
bun run dev
```

Ask the user to open `/sessions`, collapse the aside, and confirm: the rail shows assistant marks
(not Home/Costs/Tools), hovering one opens a card with the title, state, harness, model and task,
clicking one opens that session, and the workspace switch at the top still works.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/nav/SessionsRail.tsx packages/web/src/App.tsx
git commit -m "fix(web): collapsed, the sessions workspace shows sessions — not the dashboard's nav"
```

---

## Plan 1 self-review

- **Spec coverage.** Phase 0 → Tasks 1–4. Phase 1.1 → Task 5. 1.2 → Task 6. 1.3 → Task 7. 1.4 →
  Tasks 8–9. 1.5 → Task 10. Phase 1b → Task 11.
- **Interfaces.** `ModelOption`/`modelsFor`/`modelLabel` (Task 1) are consumed by Task 2 and by
  Plan 2's Task 18 and Plan 3's wizard. `planPinMove`/`movePinnedSession` (Task 4) by Task 5.
  `rowMenuEntries` (Task 6) by nothing later. `runningConversationIds`/`keepRunning` (Task 9) by
  nothing later. `SessionFacts` (Task 11) by nothing later. `ignoredDimensions` (Task 7) by
  nothing later.
- **Order.** Tasks 1–4 are independent of each other. 5 needs 4. 6, 7, 10, 11 are independent. 9
  needs 8.
