/**
 * SessionWizard.tsx — starting a session, one question at a time.
 *
 * Every question the CLI's flags express, asked in the order a person decides them: which assistant,
 * where, which model, how hard to think, what to say first, and whether to take the terminal now.
 * Nothing here knows which CLI takes which flag — the host answers `startableHarnesses()` from the
 * spawn specs, so a harness with no spec is ABSENT rather than offered and failing, and a harness
 * with no model flag is never asked about a model.
 *
 * The `where` step is the one that earns the wizard its place: a search field over the projects and
 * repositories this machine has actually worked in, opening on the directory you are standing in.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type {
  ControlHost, ProjectOption, SessionHarnessOption, SpawnSessionRequest, SpawnSessionResult,
} from '../types'
import type { ControlStrings } from '../i18n'
import { resolveListKey, windowOffset, type NavKey } from '../nav'
import {
  PROJECT_LEAD, padCell, planSubmit, projectColumns, projectPickRows, type ProjectRow,
} from '../sessions'

/**
 * What KIND of place each candidate is, at a glance.
 *
 * Single-width geometric glyphs on purpose: an emoji folder is two columns wide in most terminals
 * and one in some, and every column of this table is arithmetic. A filled mark is somewhere you
 * have been, a hollow one is somewhere merely found on disk.
 */
const KIND_GLYPH: Record<ProjectOption['source'], string> = {
  cwd: '◈',
  history: '◆',
  repo: '◇',
  folder: '○',
  typed: '▸',
}

const KIND_COLOR: Record<ProjectOption['source'], string> = {
  cwd: COLORS.accent,
  history: COLORS.success,
  repo: COLORS.secondary,
  folder: COLORS.muted,
  typed: COLORS.secondary,
}
import { TextPrompt } from '../Prompt'
import { TaskChoice } from '../TaskChoice'
import { truncate } from '../../components/Primitives'
import { COLORS } from '../../theme'

/**
 * Where the wizard is.
 *
 * `model` and `effort` are SKIPPED rather than shown-and-disabled when the chosen harness has no
 * such flag: a question whose only answer is "not applicable" is a question that should not have
 * been asked, and `advance` is the single place that decides which ones a harness earns.
 */
type Step = 'harness' | 'where' | 'task' | 'model' | 'effort' | 'prompt' | 'name' | 'how'

interface Draft {
  harness?: SessionHarnessOption
  cwd?: string
  task?: string
  label?: string
  model?: string
  effort?: string
  prompt?: string
}

export function SessionWizard({ host, strings: s, width, height, isActive, onCancel, onDone }: {
  host: ControlHost
  strings: ControlStrings
  width: number
  height: number
  isActive: boolean
  onCancel: () => void
  onDone: (result: SpawnSessionResult) => void
}) {
  const [step, setStep] = useState<Step>('harness')
  const [draft, setDraft] = useState<Draft>({})
  const [harnesses, setHarnesses] = useState<SessionHarnessOption[] | null>(null)
  /** Why the last attempt did not start. Shown in the wizard, which stays put so nothing is lost. */
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const read = host.startableHarnesses
    if (!read) return
    let alive = true
    void read.call(host).then(list => { if (alive) setHarnesses(list) })
    return () => { alive = false }
  }, [host])

  /** The next step this harness actually earns, skipping the questions it has no flag for. */
  const nextAfter = useCallback((from: Step, h: SessionHarnessOption | undefined): Step => {
    const order: Step[] = ['harness', 'where', 'task', 'model', 'effort', 'prompt', 'name', 'how']
    let i = order.indexOf(from) + 1
    while (i < order.length) {
      const candidate = order[i]!
      if (candidate === 'model' && !h?.supportsModel) { i++; continue }
      if (candidate === 'effort' && (h?.efforts.length ?? 0) === 0) { i++; continue }
      return candidate
    }
    return 'how'
  }, [])

  /**
   * Start it — and on ANY failure, keep the wizard and everything typed into it.
   *
   * Two ways this used to lose someone's work. It returned SILENTLY when it had nothing to spawn
   * with, so the last `enter` of a six-step wizard did nothing at all and there was no way to tell
   * a dead key from a slow one. And a spawn that came back `ok: false` closed the wizard anyway and
   * put the reason on the status line — one transient row — taking the prompt with it. A prompt is
   * the most expensive thing on this screen; it is the one thing a failure must not consume.
   *
   * So: a missing answer sends you BACK to the step that takes it, a refusal is shown HERE and the
   * draft stands, and only success unmounts.
   */
  const submit = useCallback((attach: boolean) => {
    const spawn = host.spawnSession
    const plan = planSubmit({ draft, hasSpawn: Boolean(spawn), attach })
    if (!plan.ok) {
      setError(plan.reason === 'no-host' ? s.wizNoSpawn
        : plan.reason === 'no-harness' ? s.wizNeedHarness
        : s.wizNeedCwd)
      if (plan.step) setStep(plan.step)
      return
    }
    const req = plan.req as unknown as SpawnSessionRequest
    setError('')
    setBusy(true)
    void spawn!.call(host, req)
      .then(r => {
        setBusy(false)
        if (r.ok) return onDone(r)
        setError(r.message)
      })
      // A REJECTED promise used to leave the screen exactly as it was, forever: no session, no
      // message, and an `enter` that had visibly done something and then nothing.
      .catch((e: unknown) => {
        setBusy(false)
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [host, draft, onDone, s])

  // `esc` steps BACK rather than out, until there is nowhere back to go. A wizard that abandons six
  // answers because the sixth was a typo is a wizard people stop using.
  useInput((_input, key) => {
    if (!key.escape) return
    const order: Step[] = ['harness', 'where', 'task', 'model', 'effort', 'prompt', 'name', 'how']
    const i = order.indexOf(step)
    for (let j = i - 1; j >= 0; j--) {
      const prev = order[j]!
      if (prev === 'model' && !draft.harness?.supportsModel) continue
      if (prev === 'effort' && (draft.harness?.efforts.length ?? 0) === 0) continue
      setError('')
      return setStep(prev)
    }
    onCancel()
  }, { isActive })

  if (step === 'harness') {
    return (
      <Picker
        label={s.wizHarness}
        options={(harnesses ?? []).map(h => ({ key: h.id, label: h.label }))}
        empty={s.sessionsLoading}
        width={width}
        height={height}
        isActive={isActive}
        onPick={key => {
          const h = (harnesses ?? []).find(x => x.id === key)
          setDraft(d => ({ ...d, harness: h }))
          setStep(nextAfter('harness', h))
        }}
      />
    )
  }

  if (step === 'where') {
    return (
      <ProjectSearch
        host={host}
        strings={s}
        width={width}
        height={height}
        isActive={isActive}
        onPick={path => {
          setDraft(d => ({ ...d, cwd: path }))
          setStep(nextAfter('where', draft.harness))
        }}
      />
    )
  }

  // Filed at BIRTH rather than afterwards. A task is how several sessions become one piece of work,
  // and the moment you know which piece a session belongs to is the moment you are starting it —
  // filing it later means remembering to, which nobody does.
  if (step === 'task') {
    return (
      <TaskChoice
        host={host}
        strings={s}
        current=""
        width={width}
        onCancel={() => setStep('where')}
        onPick={(task: string) => {
          setDraft(d => ({ ...d, ...(task ? { task } : {}) }))
          setStep(nextAfter('task', draft.harness))
        }}
      />
    )
  }

  if (step === 'model') {
    return (
      <FreeChoice
        label={s.wizModel}
        hint={s.wizModelHint}
        skipLabel={s.wizSkip}
        options={draft.harness?.modelSuggestions ?? []}
        width={width}
        height={height}
        isActive={isActive}
        onPick={value => {
          setDraft(d => ({ ...d, ...(value ? { model: value } : {}) }))
          setStep(nextAfter('model', draft.harness))
        }}
      />
    )
  }

  if (step === 'effort') {
    return (
      <Picker
        label={s.wizEffort}
        // A genuine closed enum printed by the CLI itself, so it is a pick and not a free field.
        options={[
          { key: '', label: s.wizSkip },
          ...(draft.harness?.efforts ?? []).map(e => ({ key: e, label: e })),
        ]}
        empty=""
        width={width}
        height={height}
        isActive={isActive}
        onPick={key => {
          setDraft(d => ({ ...d, ...(key ? { effort: key } : {}) }))
          setStep(nextAfter('effort', draft.harness))
        }}
      />
    )
  }

  if (step === 'prompt') {
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>{truncate(s.wizPromptHint, width)}</Text>
        <TextPrompt
          // KEYED per step. `prompt` and `name` render a `TextPrompt` at the SAME position in this
          // component's tree, so React reconciled them as one element and carried its `value` state
          // across — the name field arrived holding the whole first prompt, and a long one had to be
          // deleted by hand before the session could be named. The key is what makes them two
          // fields. Reported as "o prompt vira o titulo da sessao".
          key="wiz-prompt"
          label={s.wizPrompt}
          width={width}
          isActive={isActive}
          onSubmit={value => {
            const text = value.trim()
            setDraft(d => ({ ...d, ...(text ? { prompt: text } : {}) }))
            setStep(nextAfter('prompt', draft.harness))
          }}
          onCancel={() => setStep('where')}
        />
      </Box>
    )
  }

  if (step === 'name') {
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>{truncate(s.wizNameHint, width)}</Text>
        <TextPrompt
          key="wiz-name"
          label={s.wizName}
          // A PLACEHOLDER, never a `defaultValue`: `TextPrompt` treats a default as the answer to an
          // empty submit, which is right for renaming and wrong here — enter on an untouched field
          // means "no name of my own", and the row falls back to the derived one.
          placeholder={draft.task ?? ''}
          width={width}
          isActive={isActive}
          onSubmit={value => {
            const label = value.trim()
            setDraft(d => ({ ...d, ...(label ? { label } : {}) }))
            setStep(nextAfter('name', draft.harness))
          }}
          onCancel={() => setStep('prompt')}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      <Picker
        label={s.wizHow}
        options={[
          { key: 'bg', label: s.wizBackground },
          { key: 'fg', label: s.wizAttached },
        ]}
        empty=""
        width={width}
        // Two rows are spent below on the outcome, and a screen that draws more rows than it was
        // given is composited over the ones under it by Ink rather than clipped.
        height={Math.max(1, height - 2)}
        isActive={isActive && !busy}
        onPick={key => submit(key === 'fg')}
      />
      {/* The outcome, HERE. It used to go to the status line — one transient row — while this
          screen unmounted and took the prompt with it. */}
      {busy ? <Text dimColor>{truncate(s.wizStarting, width)}</Text> : null}
      {error && !busy ? (
        <>
          <Text color={COLORS.danger} wrap="truncate">{truncate(error, width)}</Text>
          <Text dimColor wrap="truncate">{truncate(s.wizKeptDraft, width)}</Text>
        </>
      ) : null}
    </Box>
  )
}

// ---------------------------------------------------------------------------

/** A plain vertical pick. The wizard's default question shape. */
function Picker({ label, options, empty, width, height, isActive, onPick }: {
  label: string
  options: ReadonlyArray<{ key: string; label: string }>
  empty: string
  width: number
  height: number
  isActive: boolean
  onPick: (key: string) => void
}) {
  const [index, setIndex] = useState(0)
  const at = options.length === 0 ? 0 : Math.min(index, options.length - 1)

  useInput((input, key) => {
    if (options.length === 0) return
    if (key.return) return onPick(options[at]!.key)
    const nav: NavKey = { input, upArrow: key.upArrow, downArrow: key.downArrow }
    const next = resolveListKey(nav, at, options.length)
    if (next !== at) setIndex(next)
  }, { isActive })

  // One row for the label, one for the blank under it.
  const page = Math.max(1, height - 2)
  const offset = windowOffset(at, options.length, page)

  return (
    <Box flexDirection="column" width={width}>
      <Text bold>{truncate(label, width)}</Text>
      <Box height={1} />
      {options.length === 0 ? (
        <Text dimColor>{truncate(empty, width)}</Text>
      ) : (
        options.slice(offset, offset + page).map((o, i) => {
          const active = offset + i === at
          return (
            <Text key={o.key || `_${i}`} color={active ? COLORS.accent : undefined} wrap="truncate">
              {active ? '❯ ' : '  '}
              {truncate(o.label, Math.max(1, width - 2))}
            </Text>
          )
        })
      )}
    </Box>
  )
}

/**
 * A pick that also accepts anything typed.
 *
 * The model list is explicitly NOT a validation list — `claude --help` documents `--model` as an
 * alias "or a model's full name", so refusing an unlisted value would reject valid input the day a
 * model ships. Typing therefore beats the list: the moment a character is entered, `enter` submits
 * what was typed rather than what the cursor is on.
 */
function FreeChoice({ label, hint, skipLabel, options, width, height, isActive, onPick }: {
  label: string
  hint: string
  skipLabel: string
  options: readonly string[]
  width: number
  height: number
  isActive: boolean
  onPick: (value: string) => void
}) {
  const [typed, setTyped] = useState('')
  const [index, setIndex] = useState(0)

  const rows = useMemo(() => ['', ...options], [options])
  const at = Math.min(index, Math.max(0, rows.length - 1))

  useInput((input, key) => {
    if (key.return) return onPick(typed.trim() || rows[at]! )
    if (key.backspace || key.delete) { setTyped(v => v.slice(0, -1)); return }
    if (key.upArrow || key.downArrow) {
      const nav: NavKey = { input, upArrow: key.upArrow, downArrow: key.downArrow }
      const next = resolveListKey(nav, at, rows.length)
      if (next !== at) setIndex(next)
      return
    }
    if (key.ctrl || key.meta || key.tab) return
    const printable = [...input].filter(ch => ch >= ' ' && ch !== '\x7f').join('')
    if (printable) setTyped(v => v + printable)
  }, { isActive })

  const page = Math.max(1, height - 3)

  return (
    <Box flexDirection="column" width={width}>
      <Text bold>{truncate(label, width)}</Text>
      <Text dimColor>{truncate(hint, width)}</Text>
      <Text>
        <Text dimColor>{'› '}</Text>
        {typed ? <Text>{truncate(typed, Math.max(1, width - 2))}</Text> : <Text dimColor>…</Text>}
      </Text>
      {rows.slice(0, page).map((o, i) => {
        // While something is typed the list is only a reference — what `enter` submits is the field.
        const active = !typed && i === at
        return (
          <Text key={o || '_skip'} color={active ? COLORS.accent : undefined} dimColor={Boolean(typed)} wrap="truncate">
            {active ? '❯ ' : '  '}
            {truncate(o || skipLabel, Math.max(1, width - 2))}
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * The search field, and the one control that decides where work happens.
 *
 * It opens on results rather than on an empty list: with nothing typed the host returns the places
 * ranked by recency, with the directory you are standing in first. That is the answer most of the
 * time, and it costs one keypress.
 */
function ProjectSearch({ host, strings: s, width, height, isActive, onPick }: {
  host: ControlHost
  strings: ControlStrings
  width: number
  height: number
  isActive: boolean
  onPick: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<ProjectOption[] | null>(null)
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const search = host.searchProjects
    if (!search) return
    let alive = true
    void search.call(host, query).then(list => {
      if (!alive) return
      setOptions(list)
      // A new result set means the old position points at something else entirely.
      setIndex(0)
    })
    return () => { alive = false }
  }, [host, query])

  const list = options ?? []
  const at = list.length === 0 ? 0 : Math.min(index, list.length - 1)

  useInput((input, key) => {
    if (key.return) {
      if (list.length > 0) return onPick(list[at]!.path)
      // Nothing matched, but a typed absolute path is still a legitimate answer — the host already
      // checked it exists, so an empty list here means it does not.
      return
    }
    if (key.backspace || key.delete) { setQuery(v => v.slice(0, -1)); return }
    if (key.upArrow || key.downArrow) {
      const nav: NavKey = { input, upArrow: key.upArrow, downArrow: key.downArrow }
      const next = resolveListKey(nav, at, Math.max(1, list.length))
      if (next !== at) setIndex(next)
      return
    }
    if (key.ctrl && input === 'u') { setQuery(''); return }
    if (key.ctrl || key.meta || key.tab) return
    const printable = [...input].filter(ch => ch >= ' ' && ch !== '\x7f').join('')
    if (printable) setQuery(v => v + printable)
  }, { isActive })

  // Label, hint, the field itself — and the table's header row.
  const page = Math.max(1, height - 4)

  // A folder that was merely FOUND on disk must not read like one you have worked in — the words
  // are the only thing distinguishing them, since both are just a directory name on a row.
  const sourceWord = (o: ProjectOption): string =>
    o.source === 'cwd' ? s.wizSourceCwd
      : o.source === 'typed' ? s.wizSourceTyped
      : o.source === 'history' ? s.wizSourceHistory
      : o.source === 'repo' ? s.wizSourceRepo
      : ''

  const table: ProjectRow[] = list.map(o => ({
    name: o.label, repo: o.repo ?? '', path: o.detail, why: sourceWord(o),
  }))
  // Grouped by REPOSITORY, which is the shape of the question: three worktrees of one repo are
  // three answers to "which checkout", and a flat list mixed them in among unrelated folders that
  // merely sorted nearby. The repo COLUMN then goes — the heading over the row already says it,
  // the same rule the sessions list follows for its task cell — and the path gets the width back.
  const picks = projectPickRows(table, s.wizNoRepo)
  const flat = picks.rows
  // Windowed over the DRAWN rows, not the projects: headings take rows too, and paging by project
  // count scrolls the selection off a list whose real length is larger than the number it counted.
  const cursorAt = Math.max(0, flat.findIndex(r => r.kind === 'project' && r.index === at))
  const offset = windowOffset(cursorAt, flat.length, page)
  const shown = flat.slice(offset, offset + page)
  const visible = shown.flatMap(r => (r.kind === 'project' ? [r.row] : []))
  // Measured across the page, not per row: sizing each row against its own content started every
  // name at a different column, and the eye had to re-find the path on every line.
  const cols = projectColumns(
    picks.grouped ? visible.map(r => ({ ...r, repo: '' })) : visible,
    width,
  )

  return (
    <Box flexDirection="column" width={width}>
      <Text bold>{truncate(s.wizWhere, width)}</Text>
      <Text dimColor>{truncate(s.wizWhereHint, width)}</Text>
      <Text>
        <Text dimColor>{'› '}</Text>
        {query ? <Text>{truncate(query, Math.max(1, width - 2))}</Text> : <Text dimColor>…</Text>}
      </Text>
      {options === null ? (
        <Text dimColor>{s.sessionsLoading}</Text>
      ) : list.length === 0 ? (
        <Text dimColor wrap="truncate">{truncate(s.wizNoMatch, width)}</Text>
      ) : (
        <>
          {/* A header row, because a table of unlabelled columns is that many columns of guesswork —
              and `caminho` versus `repositório` is exactly the distinction a person is scanning for. */}
          <Text dimColor wrap="truncate">
            {' '.repeat(PROJECT_LEAD) + padCell(s.wizColName, cols.name)}
            {cols.repo > 0 ? '  ' + padCell(s.wizColRepo, cols.repo) : ''}
            {cols.path > 0 ? '  ' + padCell(s.wizColPath, cols.path) : ''}
            {cols.why > 0 ? '  ' + padCell(s.wizColWhy, cols.why) : ''}
          </Text>
          {shown.map((entry, i) => {
            if (entry.kind === 'heading') {
              // A heading is drawn as a heading: the repo name, with a rule running out to the edge.
              const rule = Math.max(0, width - entry.label.length - 4)
              return (
                <Text key={`h${offset + i}`} wrap="truncate">
                  <Text color={COLORS.secondary} bold>{truncate(entry.label, width - 2)}</Text>
                  <Text dimColor>{rule > 0 ? `  ${'─'.repeat(rule)}` : ''}</Text>
                </Text>
              )
            }
            const { row, index } = entry
            const active = index === at
            const accent = active ? COLORS.accent : undefined
            return (
              <Text key={row.path} wrap="truncate">
                <Text color={accent}>{active ? '❯ ' : '  '}</Text>
                {/* What KIND of place this is, at a glance. Never the only signal: the `why` column
                    still says it in words, because a distinction announced in a glyph alone is one
                    a person has to be taught before the screen is usable. */}
                <Text color={KIND_COLOR[list[index]!.source]}>{KIND_GLYPH[list[index]!.source] + ' '}</Text>
                <Text color={accent} bold={active}>{padCell(row.name, cols.name)}</Text>
                {cols.repo > 0 ? (
                  <Text color={COLORS.secondary}>{'  ' + padCell(row.repo, cols.repo)}</Text>
                ) : null}
                {/* The PATH is what makes two directories of the same name distinguishable, so it is
                    on every row and it is the cell that survives. */}
                {cols.path > 0 ? <Text dimColor>{'  ' + padCell(row.path, cols.path)}</Text> : null}
                {cols.why > 0 ? <Text dimColor>{'  ' + padCell(row.why, cols.why)}</Text> : null}
              </Text>
            )
          })}
        </>
      )}
    </Box>
  )
}
