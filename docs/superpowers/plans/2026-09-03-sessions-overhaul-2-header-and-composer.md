# Sessions overhaul — Plan 2: one header, and the composer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the sessions workspace's two stacked bars into one on desktop and into one bar plus a bottom sheet on mobile; make the composer blur what scrolls under it; make the microphone say why it failed and work on localhost; show each model by the name its harness prints; let a session's skills be invoked; and stop drawing the harness's own injected text inside the user's bubble.

**Architecture:** The header change is layout only — `FiltersBar` gains an `inline` mode and the sessions workspace stops rendering the second `<header>`. The composer work adds two pure modules (`harness-skills.ts` parsing, the dictation error table) and changes one existing pure module's signature (`chat-envelope.ts`).

**Tech Stack:** Bun, TypeScript (strict), React 18 + Vite, `bun test`, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-sessions-workspace-overhaul-design.md` (Phases 2, 3, 3b).

**Depends on:** Plan 1 Task 1 (`harnessModels.ts`) for Task 18 only. Everything else is independent.

## Global Constraints

- Everything in this project is in **English**: code, comments, commit messages, PR text.
- Commits follow **Conventional Commits**. Commit after every task.
- `bun tsc --noEmit` and `bun test` green at the end of every task.
- **N/A, never a confident 0** — an absent capability is a sentence, never an inert control.
- **No audio leaves the browser.** Dictation is the browser's own recogniser; this is not up for renegotiation in this work.
- **No guessed slash command.** A line typed into a live session must have been read from that CLI's own command table, with the version and date recorded — `modelSwitch.ts` is the worked example.
- **Verify at 390px:** `document.documentElement.scrollWidth <= window.innerWidth` must hold.
- 44px targets are mobile-only; inputs visible on mobile compute to ≥16px via the global guard in `index.css` — never overridden inline.
- **Do not use browser automation to verify.** Use `curl`; ask the user to open the page.
- Stage **explicit paths**, never `git add -A`.

---

### Task 12: `FiltersBar` gains an inline mode

**Files:**
- Modify: `packages/web/src/components/FiltersBar.tsx`

**Interfaces:**
- Produces: `Props` gains `inline?: boolean`.

- [ ] **Step 1: Add the prop and its contract**

```tsx
/**
 * Fit on ONE 44px row, beside other things.
 *
 * The sessions workspace draws this bar inside the fixed top strip rather than in a band of its
 * own, so it cannot spend vertical space: the date presets and the `+ Filtro` button stay on the
 * line, and the selected-value chip rows — which are what makes the bar two or three rows tall —
 * move into the `+ Filtro` popover, under the dimension they belong to.
 *
 * Distinct from `compact`, which tightens padding for a narrow MOBILE column and still lays out in
 * rows. A bar can be compact without being inline.
 */
inline?: boolean
```

- [ ] **Step 2: Implement it**

Inside `FiltersBar`, when `inline` is set:

1. The root becomes `display: flex; align-items: center; height: 34px; gap: 8` with
   `flexWrap: 'nowrap'` and `minWidth: 0`.
2. The `AnimatedRow` / `ChipRow` blocks are not rendered inline; instead the `+ Filtro` button
   carries the active-dimension count (it already does) and the popover lists each active
   dimension with its chips.
3. The date presets stay, unless `hideDateRange` is set.
4. Every child gets `flexShrink: 0` except the `+ Filtro` cluster, which is the one allowed to
   narrow.

- [ ] **Step 3: Confirm nothing else changed**

```bash
bun tsc --noEmit && bun test
bun run dev
```

Ask the user to check the dashboard's filter bar is untouched (no caller passes `inline` yet).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/FiltersBar.tsx
git commit -m "feat(web): the filter bar can fit on one row, for a header that has no band to spare"
```

---

### Task 13: one header on desktop

**Files:**
- Modify: `packages/web/src/App.tsx` (the `TopStrip` `trailing` composition ~line 1549, and the `<header>` render condition ~line 2696)

**Interfaces:**
- Consumes: `FiltersBar` `inline` (Task 12).

- [ ] **Step 1: Put the filters into the strip**

The strip already accepts a `trailing` node and already renders the session title, the chat/terminal
tabs and `SessionActions` there. Add the filters between the title and the tabs:

```tsx
const sessionTopBar = (inSessionsWorkspace && !isMobile) ? (
  <>
    {/* The title, when one is open. The strip carries the filters whether or not it is. */}
    {selectedFleetSession && (
      <div style={{ minWidth: 0, flexShrink: 1, display: 'flex', alignItems: 'baseline', gap: 7 }}>
        {/* …title and state, unchanged… */}
      </div>
    )}

    {/* THE FILTERS, in the centre. They are the element that gives up width FIRST: the title
        identifies what you are looking at and the actions are how you act on it, while a narrowed
        filter bar is still a filter bar — its own `+ Filtro` popover holds everything it drops. */}
    <div style={{ flex: 1, minWidth: 90, display: 'flex', justifyContent: 'center' }}>
      <FiltersBar
        inline
        hideDateRange={false}
        only={['harnesses', 'repos', 'projects', 'models', 'activeOnly']}
        activeOnly={activeOnly}
        onActiveOnlyChange={setActiveOnly}
        filters={filters}
        onChange={setFilters}
        projects={availableProjects}
        sessionCountByProject={sessionCountByProject}
        models={models}
        harnesses={fleetOptions.harnesses as typeof availableHarnesses}
        users={[]}
        lang={lang}
      />
    </div>

    {/* …the tabs and SessionActions, unchanged… */}
  </>
) : null
```

Note the condition changed: the strip's trailing content no longer requires `selectedFleetSession`,
because the filters belong there with nothing selected too.

- [ ] **Step 2: Stop rendering the second header in this workspace**

At `App.tsx:2696` the `<header>` is rendered when `(!inSessionsWorkspace || !isMobile)`. Change it
to render only outside the sessions workspace on desktop:

```tsx
{/* The sessions workspace has ONE bar now — the fixed strip above, which carries the filters
    itself (see `sessionTopBar`). This `<header>` is the dashboard's, and on mobile it is the
    sessions page's own; neither changes. */}
{(!inSessionsWorkspace || isMobile) && (
<header …>
```

and delete the `inSessionsWorkspace` branches inside the desktop `FiltersBar` call (the
`activeOnly` / harness-override ternaries) — that call site is now dashboard-only, so those
conditions are dead.

- [ ] **Step 3: Keep the body aligned with the row above it**

`FleetOverview` exports `PAGE_INSET = 32` and `PAGE_MAX_WIDTH = 1400`, and its header comment
records two failed attempts at this alignment: centred in a 980px box against a 1400px header put
the body 200px off at 1262px, and left-aligning it agreed only by accident because the header is
centred. The strip must therefore use the same geometry:

```tsx
maxWidth: PAGE_MAX_WIDTH, margin: '0 auto', padding: `0 ${PAGE_INSET}px`
```

Import the two constants rather than restating the numbers.

- [ ] **Step 4: Verify at three widths**

```bash
bun run dev
```

Ask the user to open `/sessions` at roughly 1440px, 1280px and 1024px, with and without a session
open, and confirm: one bar, the filters centred, the title truncating before the tabs do, the
actions menu never shrinking, and the body's left edge lining up with the filter row's.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/App.tsx
git commit -m "feat(web): the sessions workspace has one bar, and the filters ride in it"
```

---

### Task 14: one bar and a bottom sheet on mobile

**Files:**
- Create: `packages/web/src/components/sessions/FiltersSheet.tsx`
- Modify: `packages/web/src/pages/SessionsPage.tsx` (both mobile branches)

**Interfaces:**
- Produces: `FiltersSheet` — a full-screen bottom sheet wrapping the existing `FiltersBar` with `compact`.

- [ ] **Step 1: Build the sheet**

Create `packages/web/src/components/sessions/FiltersSheet.tsx`:

```tsx
/**
 * FiltersSheet — the filters, on a phone, out of the way until asked for.
 *
 * The mobile sessions page used to spend a fixed band of a 664px viewport on a filter row that is
 * consulted occasionally and read never. A sheet costs nothing until it is opened, and opened it
 * has the whole screen — which is the only place these controls have ever had enough room.
 *
 * It is the SAME `FiltersBar` in `compact` mode, not a second implementation: the dimensions, the
 * pickers and the chips are one control everywhere, and a phone-only copy would drift.
 */

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { FiltersBar } from '../FiltersBar'

export function FiltersSheet({ open, onClose, lang, children }: {
  open: boolean
  onClose: () => void
  lang: 'pt' | 'en'
  children: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [open, onClose])

  if (!open) return null
  const pt = lang === 'pt'
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={pt ? 'Filtros' : 'Filters'}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 400, background: 'var(--ag-scrim)',
        display: 'flex', alignItems: 'flex-end',
      }}
    >
      <div style={{
        width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', borderTopLeftRadius: 16, borderTopRightRadius: 16,
        borderTop: '1px solid var(--border)',
        // The sheet reaches the bottom edge of the screen, so it owns the home-indicator band.
        paddingBottom: 'var(--safe-bottom)',
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            {pt ? 'Filtros' : 'Filters'}
          </h2>
          <button
            onClick={onClose}
            aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 44, height: 44, marginRight: -8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={18} />
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 12px 16px' }}>
          {children}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: One bar on the list screen**

In `SessionsPage.tsx`'s mobile list branch, replace the fixed filter row with a bar carrying the
filter icon:

```tsx
<div style={{
  display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 10px',
  flexShrink: 0, paddingTop: 'var(--safe-top)',
  borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)',
}}>
  <span style={{ flex: 1, fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>
    {pt ? 'Sessões' : 'Sessions'}
  </span>
  <button
    onClick={() => setSheetOpen(true)}
    aria-label={pt ? 'Filtros' : 'Filters'}
    style={{
      position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 44, height: 44, border: 'none', background: 'transparent',
      color: 'var(--text-secondary)', cursor: 'pointer',
    }}
  >
    <SlidersHorizontal size={18} />
    {filterCount > 0 && (
      <span style={{
        position: 'absolute', top: 6, right: 4,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
        background: 'var(--anthropic-orange)', color: '#fff', fontSize: 10, fontWeight: 700,
      }}>{filterCount}</span>
    )}
  </button>
</div>
```

`filterCount` counts the set dimensions including `activeOnly`.

- [ ] **Step 3: The same icon on the open-session bar**

Add the identical button to the mobile session bar (the one with the back chevron), between the
title block and the chat/terminal tabs. Both bars open the same sheet.

- [ ] **Step 4: Render the sheet once**

At the bottom of both mobile branches:

```tsx
<FiltersSheet open={sheetOpen} onClose={() => setSheetOpen(false)} lang={pt ? 'pt' : 'en'}>
  <FiltersBar
    compact
    only={['harnesses', 'repos', 'projects', 'models', 'activeOnly']}
    activeOnly={activeOnly}
    onActiveOnlyChange={setActiveOnly}
    filters={filters}
    onChange={setFilters}
    projects={availableProjects}
    sessionCountByProject={sessionCountByProject}
    models={models}
    harnesses={availableHarnesses}
    users={[]}
    lang={lang}
  />
</FiltersSheet>
```

- [ ] **Step 5: Verify at 390px**

```bash
bun run dev
```

Ask the user to open the page at an iPhone-12 width and check, on both the list and an open
session:

- one bar, not two;
- the sheet opens, its controls are ≥44px, and the page does not zoom when a field is focused;
- `document.documentElement.scrollWidth <= window.innerWidth` (readable from the browser console);
- the list still scrolls — `SessionsPage.tsx` records this bug twice already: `flex: 1` on a child
  means nothing until its PARENT is a flex container, and both wrappers must keep
  `display: 'flex', flexDirection: 'column'`.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/sessions/FiltersSheet.tsx packages/web/src/pages/SessionsPage.tsx
git commit -m "feat(web): on a phone the filters live in a sheet, and the workspace has one bar"
```

---

### Task 15: the composer blurs what is behind it

**Files:**
- Modify: `packages/web/src/components/sessions/SessionChat.tsx` (the sticky composer container, ~line 564)
- Modify: `packages/web/src/components/SessionTerminal.tsx` (its input strip)
- Modify: `packages/web/src/index.css` (the shared class)

- [ ] **Step 1: Add one class, used by both views**

In `packages/web/src/index.css`:

```css
/*
 * The composer's ground.
 *
 * A conversation should pass UNDER the place you type and fade out, not be cut by a solid band.
 * Two layers do that: a blur over whatever is behind, and a gradient from transparent at the top
 * to the page's own colour at the bottom, so the text dissolves instead of ending at an edge.
 *
 * `mask-image` on the blur layer is what keeps the top edge soft: a uniform backdrop-filter has a
 * hard boundary of its own, which is the very edge this exists to remove.
 */
.ag-composer-ground {
  position: relative;
}
.ag-composer-ground::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--bg-base) 0%, transparent) 0%,
    color-mix(in srgb, var(--bg-base) 72%, transparent) 45%,
    var(--bg-base) 100%
  );
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 40%);
  mask-image: linear-gradient(to bottom, transparent 0%, black 40%);
}

/*
 * Where the effect cannot run, it degrades to TODAY'S behaviour — a solid ground — and never to
 * unreadable text over a live conversation.
 */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .ag-composer-ground::before {
    background: var(--bg-base);
    -webkit-mask-image: none;
    mask-image: none;
  }
}
```

- [ ] **Step 2: Use it in the chat composer**

On the sticky container in `SessionChat.tsx` (the one at `position: 'sticky', bottom: 0`), add
`className="ag-composer-ground"` and make its children sit above the pseudo-element:

```tsx
<div className="ag-composer-ground" style={{
  position: 'sticky', bottom: 0, flexShrink: 0,
  padding: '10px 20px 16px',
  background: 'transparent',
}}>
  <div style={{ position: 'relative', zIndex: 1 }}>
    {/* everything that is in there today */}
  </div>
</div>
```

The field itself keeps its own `--bg-elevated` surface and border. That is deliberate and already
recorded in this file: *"the thing people recognise as 'where I type' is a bounded field, not a
strip."* The blur is the ground behind the field, never the field.

- [ ] **Step 3: The same in the terminal view**

Apply the identical class to `SessionTerminal`'s input strip, so the two views do not disagree
about what the bottom of the screen looks like.

- [ ] **Step 4: Verify on both themes**

```bash
bun run dev
```

Ask the user to scroll a long conversation and confirm the messages fade under the composer rather
than being clipped, on the dark theme and on the light one, and that the field itself is still a
crisp bounded box.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/index.css packages/web/src/components/sessions/SessionChat.tsx packages/web/src/components/SessionTerminal.tsx
git commit -m "feat(web): the conversation passes under the composer instead of being cut by it"
```

---

### Task 16: the microphone says what went wrong

**Files:**
- Modify: `packages/web/src/lib/dictation.ts`
- Modify: `packages/web/src/lib/dictation.test.ts`
- Modify: `packages/web/src/components/sessions/SessionChat.tsx` (`toggleDictation`, the menu entry)

**Interfaces:**
- Produces: `dictationError(code: string, lang: 'en' | 'pt'): string` and `insecureAlternative(href: string): string | null`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/lib/dictation.test.ts`:

```ts
import { dictationError, insecureAlternative } from './dictation'

describe('dictationError', () => {
  it('names a refused permission', () => {
    expect(dictationError('not-allowed', 'en')).toContain('permission')
    expect(dictationError('not-allowed', 'pt')).toContain('permissão')
  })
  it('names the recognition service failing, which is not the same as a refusal', () => {
    expect(dictationError('network', 'en')).not.toBe(dictationError('not-allowed', 'en'))
  })
  it('names silence', () => {
    expect(dictationError('no-speech', 'en')).toContain('hear')
  })
  it('names a missing microphone', () => {
    expect(dictationError('audio-capture', 'en')).toContain('microphone')
  })
  it('never returns an empty string for a code it has not seen', () => {
    expect(dictationError('something-new', 'en').length).toBeGreaterThan(0)
    expect(dictationError('something-new', 'en')).toContain('something-new')
  })
})

describe('insecureAlternative', () => {
  it('offers the localhost equivalent of a LAN address', () => {
    expect(insecureAlternative('http://192.168.0.7:47292/sessions'))
      .toBe('http://localhost:47292/sessions')
  })
  it('offers nothing when the page is already on localhost', () => {
    expect(insecureAlternative('http://localhost:47292/sessions')).toBeNull()
    expect(insecureAlternative('http://127.0.0.1:47292/')).toBeNull()
  })
  it('offers nothing for a name it cannot rewrite safely', () => {
    expect(insecureAlternative('https://dash.example.com/sessions')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
bun test packages/web/src/lib/dictation.test.ts
```

- [ ] **Step 3: Implement**

Add to `packages/web/src/lib/dictation.ts`:

```ts
/**
 * Why the recogniser stopped, in words.
 *
 * `rec.onerror` used to be `() => { … }` — the event, and with it the reason, was DISCARDED. So a
 * refused permission, a recognition service that could not be reached, a missing microphone and a
 * moment of silence all looked identical from outside: the button lit up and went out. A control
 * that fails silently is indistinguishable from a broken one, which is the rule this whole module
 * was written against.
 *
 * `network` matters most: it is the common failure and it is NOT a refusal — the browser's speech
 * recognition reaches a remote service, and a machine that cannot get there has a working
 * microphone and no transcription. Telling someone to check their permissions there sends them to
 * fix the wrong thing.
 *
 * An unknown code is REPORTED, carrying the code itself. A new one must be visible, not swallowed.
 */
export function dictationError(code: string, lang: 'en' | 'pt'): string {
  const pt = lang === 'pt'
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return pt
        ? 'O navegador negou a permissão do microfone para esta página.'
        : 'The browser denied this page permission to use the microphone.'
    case 'network':
      return pt
        ? 'O serviço de reconhecimento do navegador não respondeu. O microfone está bem; a transcrição é que não chegou.'
        : 'The browser’s recognition service did not answer. The microphone is fine; the transcription is what did not arrive.'
    case 'no-speech':
      return pt
        ? 'Não ouvi nada. Tente falar mais perto do microfone.'
        : 'I did not hear anything. Try speaking closer to the microphone.'
    case 'audio-capture':
      return pt
        ? 'Nenhum microfone disponível para o navegador.'
        : 'No microphone is available to the browser.'
    case 'aborted':
      return pt ? 'O ditado foi interrompido.' : 'Dictation was interrupted.'
    default:
      return pt
        ? `O ditado parou: ${code}.`
        : `Dictation stopped: ${code}.`
  }
}

/**
 * The `localhost` address that would work, when the page is on a plain-HTTP LAN address.
 *
 * No browser grants a microphone on an insecure origin — `getUserMedia` and the Web Speech API are
 * both blocked — and `localhost` IS a secure context. A member machine's dashboard reached at
 * `http://192.168.x.y:47292` therefore has an exact equivalent one click away, and naming it is
 * more useful than naming the rule.
 *
 * Only a literal IPv4 host is rewritten. A hostname could be anything, and sending someone from
 * `dash.example.com` to `localhost` would be a guess about which machine they are sitting at.
 */
export function insecureAlternative(href: string): string | null {
  let url: URL
  try { url = new URL(href) } catch { return null }
  if (url.protocol !== 'http:') return null
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') return null
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) return null
  url.hostname = 'localhost'
  return url.toString()
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/web/src/lib/dictation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Use them in the composer**

In `SessionChat.tsx`, replace the two discarding handlers:

```tsx
rec.onerror = (e: { error?: string }) => {
  setListening(false)
  recognitionRef.current = null
  // The reason reaches the screen. A button that lights up and goes out with no explanation is
  // the defect this replaces.
  setNotice(dictationError(e?.error ?? 'unknown', pt ? 'pt' : 'en'))
}
rec.onend = () => { setListening(false); recognitionRef.current = null }
```

and in the "more options" menu, where `dictation.reason` is shown for the `insecure` state, append
the alternative when there is one:

```tsx
{dictation.state === 'insecure' && (() => {
  const alt = insecureAlternative(window.location.href)
  return alt === null ? null : (
    <a href={alt} style={{ fontSize: 11, color: 'var(--anthropic-orange)' }}>
      {pt ? `Abrir em ${alt}` : `Open at ${alt}`}
    </a>
  )
})()}
```

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/lib/dictation.ts packages/web/src/lib/dictation.test.ts packages/web/src/components/sessions/SessionChat.tsx
git commit -m "fix(web): when dictation stops, it says why — and names the address that would work"
```

---

### Task 17: reproduce and fix dictation on localhost

**Files:** determined by the finding. Likely `packages/web/src/components/sessions/SessionChat.tsx`.

**REQUIRED SUB-SKILL:** `superpowers:systematic-debugging`. Do not patch before the cause is known.

- [ ] **Step 1: Reproduce**

```bash
bun run dev
```

Ask the user to open `http://localhost:47292/sessions`, open a running session, open the composer's
more-options menu and press the microphone. Ask them to report exactly what happens and to paste
the console output.

- [ ] **Step 2: Establish the three facts, in order**

Ask the user to run in the browser console:

```js
console.log('secure:', window.isSecureContext,
            'api:', typeof (window.SpeechRecognition ?? window.webkitSpeechRecognition))
```

- `secure: false` on `localhost` would be a browser configuration problem, not a bug here — report
  it and stop.
- `api: undefined` means the browser has no Web Speech API (Firefox); `dictationSupport` should
  already be saying so. If it is not, that is the bug.
- Both fine means the recogniser starts and fails; Task 16's error reason now names it. Record the
  code.

- [ ] **Step 3: Test the two hypotheses already visible in the code**

Neither is a conclusion. Both are cheap to check.

1. **Duplicated text.** `onresult` walks `e.results` from index 0 on every event while
   `continuous = true`, so each event re-reads every previous result and appends the whole
   transcript again. If the symptom is repeated words, the fix is to start from
   `e.resultIndex`:

```tsx
rec.onresult = (e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
  let text = ''
  // From `resultIndex`, not from 0: with `continuous = true` the results list GROWS, and re-reading
  // it from the start appends every previous phrase again on every event.
  for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i]?.[0]?.transcript ?? ''
  if (!text.trim()) return
  setDraft(d => (d.trim() === '' ? text.trim() : `${d.replace(/\s+$/, '')} ${text.trim()}`))
}
```

2. **A `network` error ending it immediately.** If the recorded code is `network`, the recogniser
   is working and the service is unreachable. That is not fixable in this codebase; Task 16's
   sentence is the correct outcome, and this task's deliverable becomes: confirm the sentence
   appears, and record the finding in `dictation.ts`'s header.

- [ ] **Step 4: Fix the cause found, and cover it**

If the fix is in a pure function, add a test. If it is in the recogniser wiring, record the finding
and the version it was measured against in the file header — the convention every verified
behaviour in this repository follows.

- [ ] **Step 5: Confirm with the user**

Ask them to repeat step 1 and confirm dictation now works on `localhost`, or that the reason is
now stated.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/sessions/SessionChat.tsx packages/web/src/lib/dictation.ts
git commit -m "fix(web): dictation works on localhost, and the finding is recorded"
```

---

### Task 18: the model picker shows the harness's own names

**Files:**
- Modify: `packages/web/src/components/sessions/SessionChat.tsx` (the model menu)

**Interfaces:**
- Consumes: `models: ModelOption[]` on the `/api/fleet/new` harness objects (Plan 1, Task 2).

- [ ] **Step 1: Read the labelled list**

Replace the `modelSuggestions` state and its fetch with:

```tsx
/**
 * The models this harness offers, from `/api/fleet/new` — the SAME source the New session wizard
 * reads, so the two lists cannot disagree about what a harness accepts.
 *
 * The LABEL is displayed and the ID is sent. `modelSwitch.ts` records what happens if that is
 * reversed: `/model` matches the id, so "Opus 5" typed into a live session answers
 * `Model 'Opus 5' not found` — a silent no-op the user reads as a successful switch.
 */
const [models, setModels] = useState<{ id: string; label: string }[]>([])
useEffect(() => {
  if (modelReason || !row?.harness) return
  let alive = true
  fetch(`/api/fleet/new?lang=${pt ? 'pt' : 'en'}`)
    .then(r => (r.ok ? r.json() : null))
    .then((d: { harnesses?: { id: string; models?: { id: string; label: string }[] }[] } | null) => {
      if (!alive || !d?.harnesses) return
      setModels(d.harnesses.find(h => h.id === row.harness)?.models ?? [])
    })
    .catch(() => { /* no list, no picker — the control simply does not appear */ })
  return () => { alive = false }
}, [row?.harness, modelReason, pt])
```

- [ ] **Step 2: Render the label, send the id**

```tsx
{models.map(m => (
  <button key={m.id} onClick={() => { setMoreOpen(false); void switchModel(m.id) }} …>
    {m.label}
  </button>
))}
```

- [ ] **Step 3: Verify**

```bash
bun run dev
```

Ask the user to open a Claude session's model menu and confirm it reads
`Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5`, and that picking one actually switches the session's
model (the session's own output will say so).

- [ ] **Step 4: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/sessions/SessionChat.tsx
git commit -m "feat(web): the model menu says what the assistant calls the model"
```

---

### Task 19: discover a session's skills

**Files:**
- Create: `packages/server/server/sessions/harness-skills.ts`
- Create: `packages/server/server/sessions/harness-skills.test.ts`
- Modify: `packages/server/server/index.ts` (the new route, beside the other `/api/fleet/*` handlers)
- Modify: `packages/server/server/capability-guard.test.ts`

**Interfaces:**
- Produces: `SkillSource`, `HARNESS_SKILLS: Record<HarnessId, SkillSource | null>`, `parseSkillFrontmatter(text: string): { name?: string; description?: string }`, `readHarnessSkills(harness: string, cwd: string): Promise<HarnessSkill[]>` where `HarnessSkill = { name: string; description: string; scope: 'user' | 'plugin' | 'project' }`.

- [ ] **Step 1: Write the failing tests for the pure half**

```ts
import { describe, expect, it } from 'bun:test'
import { HARNESS_SKILLS, parseSkillFrontmatter, skillsReason } from './harness-skills'

describe('parseSkillFrontmatter', () => {
  it('reads name and description out of the frontmatter', () => {
    const out = parseSkillFrontmatter('---\nname: brainstorming\ndescription: Turn an idea into a design\n---\n# Body\n')
    expect(out.name).toBe('brainstorming')
    expect(out.description).toBe('Turn an idea into a design')
  })
  it('tolerates quotes and extra keys', () => {
    const out = parseSkillFrontmatter('---\nname: "my-skill"\nallowed-tools: Read\ndescription: \'Does a thing\'\n---\n')
    expect(out.name).toBe('my-skill')
    expect(out.description).toBe('Does a thing')
  })
  it('returns nothing for a file with no frontmatter, and never throws', () => {
    expect(parseSkillFrontmatter('# Just a heading')).toEqual({})
    expect(parseSkillFrontmatter('')).toEqual({})
    expect(parseSkillFrontmatter('---\nnot: closed')).toEqual({})
  })
})

describe('HARNESS_SKILLS', () => {
  it('names every harness, so adding one breaks the build here', () => {
    for (const h of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi']) {
      expect(h in HARNESS_SKILLS).toBe(true)
    }
  })
  it('is wired for claude only', () => {
    expect(HARNESS_SKILLS.claude).not.toBeNull()
    for (const h of ['codex', 'gemini', 'copilot', 'antigravity', 'kimi'] as const) {
      expect(HARNESS_SKILLS[h]).toBeNull()
    }
  })
  it('gives every null harness a sentence, so the menu explains itself', () => {
    expect(skillsReason('codex', 'en')).not.toBeNull()
    expect(skillsReason('claude', 'en')).toBeNull()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
bun test packages/server/server/sessions/harness-skills.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/server/server/sessions/harness-skills.ts`:

```ts
/**
 * harness-skills.ts — which skills the assistant in a session can be asked to run, and how.
 *
 * A `Record<HarnessId, SkillSource | null>`, shaped like `rename-spec.ts` and `modelSwitch.ts`:
 * adding a harness breaks the build here rather than silently shipping a control that does
 * nothing, and every `null` is a FINDING with its own sentence rather than an omission.
 *
 * ONLY CLAUDE IS WIRED. Its skills are files on disk with a documented frontmatter, and the way to
 * run one is the slash command the CLI itself resolves. For the other five there is no discovered
 * format and no verified command, and a guessed slash command does not fail loudly — it types a
 * line of nonsense into a live session.
 *
 * PATHS COME FROM `HOME_DIR`, never `CLAUDE_DIR`. The two differ exactly where it matters: a
 * container can mount somebody else's `~/.claude` read-only, and reading skills out of it would
 * offer the operator's skills to a session that cannot run them. Same distinction `cli-hooks.ts`
 * and `mcp-list.ts` make.
 *
 * The list is a CONVENIENCE for typing, never an authority: what the session accepts is whatever
 * its own CLI resolves, and this route only helps someone type it.
 */

import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { HOME_DIR } from '../config'

export interface HarnessSkill {
  name: string
  description: string
  scope: 'user' | 'plugin' | 'project'
}

export interface SkillSource {
  /** Directories to walk, relative to HOME_DIR or to the session's cwd. */
  userDirs: string[]
  projectDirs: string[]
  /** The line typed to invoke one. `{name}` is replaced. */
  line: string
}

export const HARNESS_SKILLS: Record<HarnessId, SkillSource | null> = {
  // Verified against claude 2.1.259: `~/.claude/skills/<name>/SKILL.md` and the project's own
  // `.claude/skills`, invoked as `/<name>`.
  claude: {
    userDirs: ['.claude/skills', '.claude/plugins/cache'],
    projectDirs: ['.claude/skills'],
    line: '/{name}',
  },
  // No documented skill mechanism reachable from a typed line.
  codex: null,
  gemini: null,
  copilot: null,
  antigravity: null,
  kimi: null,
}

/** Why the picker is absent, so the menu says it instead of leaving a hole. */
export function skillsReason(harness: string, lang: 'en' | 'pt'): string | null {
  if (HARNESS_SKILLS[harness as HarnessId]) return null
  return lang === 'pt'
    ? 'Invocar skills a partir daqui só está verificado no Claude Code.'
    : 'Invoking skills from here is only verified for Claude Code.'
}

/**
 * PURE: the `name` and `description` out of a SKILL.md's frontmatter.
 *
 * Deliberately a small hand parser rather than a YAML dependency: it reads two scalar keys out of
 * a leading `---` block, and it is TOTAL — a malformed, unterminated or empty document yields `{}`
 * rather than throwing. A skill file somebody is midway through editing must not take the picker
 * down with it.
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^\s*(name|description)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2]!.trim().replace(/^["']|["']$/g, '')
    if (value !== '') out[m[1] as 'name' | 'description'] = value
  }
  return out
}

/** The IO half. Unreadable directories and files are skipped, never thrown. */
export async function readHarnessSkills(harness: string, cwd: string): Promise<HarnessSkill[]> {
  const spec = HARNESS_SKILLS[harness as HarnessId]
  if (!spec) return []
  const found = new Map<string, HarnessSkill>()
  const walk = async (root: string, scope: HarnessSkill['scope']) => {
    const { readdir, readFile } = await import('node:fs/promises')
    let entries: string[]
    try { entries = await readdir(root) } catch { return }
    for (const e of entries) {
      try {
        const text = await readFile(join(root, e, 'SKILL.md'), 'utf8')
        const fm = parseSkillFrontmatter(text)
        const name = fm.name ?? e
        // First writer wins: a project skill and a user skill of the same name are one command,
        // and listing it twice would offer a choice the CLI does not have.
        if (!found.has(name)) found.set(name, { name, description: fm.description ?? '', scope })
      } catch { /* not a skill directory, or unreadable */ }
    }
  }
  for (const d of spec.userDirs) await walk(join(HOME_DIR, d), 'user')
  for (const d of spec.projectDirs) await walk(join(cwd, d), 'project')
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The line to type for a skill, or null where the harness has none. */
export function skillLine(harness: string, name: string): string | null {
  const spec = HARNESS_SKILLS[harness as HarnessId]
  if (!spec || name === '') return null
  return spec.line.replace('{name}', name)
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/server/server/sessions/harness-skills.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the route**

In `packages/server/server/index.ts`, beside the other `/api/fleet/*` handlers:

```ts
// The skills the assistant in this session can be asked to run. Guarded by the `/api/fleet`
// PREFIX already registered in `capability-guard.ts` — a new fleet route is guarded by having
// been ADDED, never by remembering a second table.
if (url.pathname === '/api/fleet/skills' && req.method === 'GET') {
  const id = url.searchParams.get('id')
  if (!id) {
    return new Response(JSON.stringify({ error: 'bad_request' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
  const { readFleetSkills, fleetLang } = await import('./sessions/fleet-web')
  const out = await readFleetSkills(fleetLang(url.searchParams.get('lang')), id)
  return new Response(JSON.stringify(out), {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}
```

and in `fleet-web.ts`:

```ts
/**
 * The skills for ONE session, resolved from the row's own harness and cwd.
 *
 * SCOPE IS CHECKED FIRST, like `GET /api/fleet/attach`: an unknown id must not be answered with a
 * plausible list assembled from this server's own home directory.
 */
export async function readFleetSkills(lang: CliLang, id: string): Promise<{
  skills: HarnessSkill[]; reason?: string
}> {
  const host = await hostFor(lang)
  const row = (await host.sessions?.())?.find(r => r.id === id || r.conversationId === id)
  if (!row) return { skills: [], reason: controlStrings(lang).sessionsUnknownRow }
  const reason = skillsReason(row.harness, lang)
  if (reason) return { skills: [], reason }
  return { skills: await readHarnessSkills(row.harness, row.cwd) }
}
```

Use whatever the host's actual fleet accessor is named — read `fleet-web.ts` before writing this.

- [ ] **Step 6: Confirm the guard covers it**

`capability-guard.test.ts` already asserts a not-yet-written `/api/fleet/*` path resolves to
`localShell`. Add the concrete path to that test's cases:

```ts
expect(capabilityFor('/api/fleet/skills')).toBe('localShell')
```

- [ ] **Step 7: Verify live**

```bash
curl -s "http://localhost:47291/api/fleet/skills?id=<a-real-session-id>&lang=en" | head -c 500
curl -s "http://localhost:47291/api/fleet/skills?id=nope&lang=en"
```

Expected: a list for a real Claude session; for an unknown id, an empty list **with a reason**,
never a list.

- [ ] **Step 8: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/server/server/sessions/harness-skills.ts packages/server/server/sessions/harness-skills.test.ts packages/server/server/sessions/fleet-web.ts packages/server/server/index.ts packages/server/server/capability-guard.test.ts
git commit -m "feat(server): a session can say which skills its assistant knows"
```

---

### Task 20: the skills picker in the composer

**Files:**
- Modify: `packages/web/src/components/sessions/SessionChat.tsx`

- [ ] **Step 1: Fetch when the menu opens, not on mount**

```tsx
/** The session's skills. Fetched when the menu is first opened: most sessions are read, not
 *  driven, and this walks directories on the host. */
const [skills, setSkills] = useState<{ name: string; description: string }[] | null>(null)
const [skillsNote, setSkillsNote] = useState<string | null>(null)
useEffect(() => {
  if (!moreOpen || skills !== null || !row?.id) return
  fetch(`/api/fleet/skills?id=${encodeURIComponent(row.id)}&lang=${pt ? 'pt' : 'en'}`)
    .then(r => (r.ok ? r.json() : null))
    .then((d: { skills?: { name: string; description: string }[]; reason?: string } | null) => {
      setSkills(d?.skills ?? [])
      setSkillsNote(d?.reason ?? null)
    })
    .catch(() => { setSkills([]) })
}, [moreOpen, skills, row?.id, pt])
```

- [ ] **Step 2: Insert into the draft — never send**

```tsx
{/* INSERTED, not sent. Most skills take an argument, and the composer's whole contract is that
    what reaches the session is what the person chose to send. */}
{skillsNote ? (
  <p style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '4px 8px' }}>{skillsNote}</p>
) : (skills ?? []).map(s => (
  <button
    key={s.name}
    title={s.description}
    onClick={() => {
      setMoreOpen(false)
      setDraft(d => (d.trim() === '' ? `/${s.name} ` : `${d.replace(/\s+$/, '')} /${s.name} `))
      textareaRef.current?.focus()
    }}
    style={{ /* same entry styling as the model list */ }}
  >
    /{s.name}
  </button>
))}
```

- [ ] **Step 3: Refuse where `prompt` is refused, in the same words**

The picker inherits the `prompt` action's refusals and must state them rather than inserting text
into a field that cannot be sent:

```tsx
// The session must be running, and a session sitting on a DIALOG is refused — a slash command
// typed into a permission prompt goes into that dialog's own filter, and the submit takes the
// highlighted option. This is the same rule `promptSession` and `rename` already enforce.
const skillsBlocked = !canPrompt || blocked
```

When `skillsBlocked`, the picker shows the same sentence the composer already shows for a blocked
prompt instead of the list.

- [ ] **Step 4: Verify by hand**

```bash
bun run dev
```

Ask the user to open a running Claude session, open the more-options menu, pick a skill, and
confirm `/<name> ` lands in the field with the cursor after it and nothing was sent. Then ask them
to try it on a session sitting on a permission prompt and confirm it refuses in words.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/sessions/SessionChat.tsx
git commit -m "feat(web): a session's skills are one pick away, typed into the draft"
```

---

### Task 21: stop attributing the harness's own text to the user

**Files:**
- Modify: `packages/server/server/sessions/chat-envelope.ts`
- Modify: `packages/server/server/sessions/chat-envelope.test.ts`
- Modify: `packages/server/server/sessions/chat-tail.ts` (the call site, ~line 160)

**Interfaces:**
- Produces: `classifyUserEntry({ text, isMeta }: { text: string; isMeta?: boolean }): UserEntry`. `classifyUserText(text)` is kept as a one-line wrapper so existing callers and tests keep compiling.

- [ ] **Step 1: Write the failing tests, from the measurement**

Add to `packages/server/server/sessions/chat-envelope.test.ts`:

```ts
import { classifyUserEntry } from './chat-envelope'

describe('classifyUserEntry — isMeta', () => {
  // Measured over the 25 most recently touched transcripts on a real machine: 553 user entries
  // carrying text, 114 of them `isMeta: true`, and 98 of those with NO envelope tag — so the tag
  // table alone drew them in the person's own bubble. All 439 real person messages had
  // `isMeta: false`.
  const meta = (text: string) => classifyUserEntry({ text, isMeta: true })

  it('treats an injected skill body as the harness, not the person', () => {
    const out = meta('Base directory for this skill: /home/u/.claude/skills/x\n\n# A skill\n…')
    expect(out.kind).toBe('system')
  })

  it('never renders the body — a SKILL.md on screen is not a conversation', () => {
    const out = meta('Base directory for this skill: /home/u/.claude/skills/x\n\n# A skill\n…')
    expect(JSON.stringify(out)).not.toContain('# A skill')
  })

  it('names each measured kind rather than saying "system"', () => {
    expect(meta('Another Claude session sent a message:\nhello').note).toContain('session')
    expect(meta('[Image: source: /tmp/x.png]').note).toContain('image')
    expect(meta('Continue from where you left off.').note).toContain('resum')
    expect(meta('## Context Usage\n…').note).toContain('context')
    expect(meta('[Cross-session idle notice] "x"').note).toContain('idle')
  })

  it('is system even for an unrecognised meta entry — the flag is the harness saying so', () => {
    const out = meta('something nobody has seen before')
    expect(out.kind).toBe('system')
    expect(out.note).not.toBe('')
  })

  it('leaves a real person message alone', () => {
    const out = classifyUserEntry({ text: 'fix the header please', isMeta: false })
    expect(out).toEqual({ kind: 'person', text: 'fix the header please' })
  })

  it('still unwraps the envelopes that ARE the person acting', () => {
    const out = classifyUserEntry({ text: '<bash-input>ls -la</bash-input>', isMeta: false })
    expect(out).toEqual({ kind: 'person', text: 'ls -la' })
  })

  it('does not hide an ordinary message that merely starts with a bracket', () => {
    const out = classifyUserEntry({ text: '<Foo /> renders twice', isMeta: false })
    expect(out.kind).toBe('person')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
bun test packages/server/server/sessions/chat-envelope.test.ts
```

- [ ] **Step 3: Implement**

In `packages/server/server/sessions/chat-envelope.ts`, extend the header with the measurement and
add:

```ts
/**
 * The kinds of injected entry seen in the wild, named by their opening line.
 *
 * The NOTE is what the pane shows; the body never is. `isMeta` alone is enough to classify — this
 * table only decides how the note reads, and an entry it does not recognise still gets a truthful
 * generic one.
 */
const META_KINDS: Array<{ test: RegExp; note: string }> = [
  { test: /^Base directory for this skill:/, note: 'a skill was loaded' },
  { test: /^Another Claude session sent a message:/, note: 'a message from another session' },
  { test: /^\[Image:/, note: 'an image was attached' },
  { test: /^Continue from where you left off\./, note: 'the session was resumed' },
  { test: /^\[Cross-session idle notice\]/, note: 'an idle notice about another session' },
  { test: /^## Context Usage/, note: 'a context-usage report' },
  { test: /^\(Re-invocation of/, note: 'a skill was re-invoked' },
]

/**
 * Classify one `user` entry.
 *
 * `isMeta` is CLAUDE CODE'S OWN FLAG, and it is checked FIRST because it is the harness declaring
 * that the entry is not a turn the person took. Measured across 25 recent transcripts: 114 of 553
 * user text entries carry it, 98 of them with no envelope tag at all — so the tag table alone drew
 * all 98 inside the person's bubble, which is how a whole SKILL.md came to appear as something the
 * user had typed. Every one of the 439 real person messages carried `isMeta: false`.
 *
 * The tag table still does the job the flag cannot: unwrapping `<command-name>` and `<bash-input>`
 * to the thing the person actually typed. Those ARE the person acting, and dropping them would
 * erase a turn that happened.
 */
export function classifyUserEntry({ text, isMeta }: { text: string; isMeta?: boolean }): UserEntry {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'system', note: '' }
  if (isMeta === true) {
    const kind = META_KINDS.find(k => k.test.test(trimmed))
    // An unrecognised meta entry is still the harness — the flag said so. It gets a truthful
    // generic note rather than being shown, because the alternative is attributing to a person
    // something they did not write.
    return { kind: 'system', note: kind?.note ?? 'injected by the assistant' }
  }
  return classifyUserText(trimmed)
}
```

Keep `classifyUserText` exactly as it is, exported, so nothing else has to change at once.

- [ ] **Step 4: Run the tests**

```bash
bun test packages/server/server/sessions/chat-envelope.test.ts
```

Expected: PASS.

- [ ] **Step 5: Thread the flag through**

At `packages/server/server/sessions/chat-tail.ts:160`, `classifyUserText(raw)` becomes
`classifyUserEntry({ text: raw, isMeta: entry.isMeta === true })`, where `entry` is the parsed
JSONL object. Read the surrounding code to find the variable holding it; if the raw object is not
in scope there, thread it from where the line is parsed — do **not** re-read the file.

- [ ] **Step 6: Add the Portuguese for the new notes**

`ChatBubble.tsx` holds "the Portuguese for each note `chat-envelope.ts` produces". Add one line per
new note, matching the English exactly.

- [ ] **Step 7: Verify against a real transcript**

```bash
curl -s "http://localhost:47291/api/fleet/chat?id=<a-session-that-loaded-a-skill>&lang=en" \
  | grep -c "Base directory for this skill"
```

Expected: `0`. Then ask the user to open that session in the browser and confirm the skill body no
longer appears as one of their messages, and that a one-line note stands in its place.

- [ ] **Step 8: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/server/server/sessions/chat-envelope.ts packages/server/server/sessions/chat-envelope.test.ts packages/server/server/sessions/chat-tail.ts packages/web/src/components/sessions/ChatBubble.tsx
git commit -m "fix(server): a message the harness injected is no longer shown as the user's own"
```

Put the measurement in the commit body.

---

## Plan 2 self-review

- **Spec coverage.** Phase 2.1 → Tasks 12–13. 2.2 → Task 14. 2.3 → Task 15. Phase 3.1 → Tasks
  16–17. 3.2 → Task 18. 3.3 → Tasks 19–20. Phase 3b → Task 21.
- **Interfaces.** `inline` (12) is consumed by 13. `dictationError` / `insecureAlternative` (16) by
  17. `models` on the harness payload (Plan 1 Task 2) by 18. `readHarnessSkills` / `skillLine` /
  `skillsReason` (19) by 20 and by Plan 4's relay. `classifyUserEntry` (21) by Plan 4's relayed
  chat.
- **Order.** 12 → 13. 14, 15 independent. 16 → 17. 18 needs Plan 1 Task 2. 19 → 20. 21
  independent.
