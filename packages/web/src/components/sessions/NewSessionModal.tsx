/**
 * NewSessionModal — starting a session from the dashboard, as a FOUR-STEP WIZARD.
 *
 * It was one long scrolling form. Four questions in a column is a form; a form that starts a real
 * assistant, in a real directory, spending real money, is a DECISION — and a decision is walked
 * through and then reviewed. The last step shows every answer together, because that is the only
 * moment somebody catches "wrong folder" before it costs them a session.
 *
 * What may ADVANCE is not decided here: `wizardSteps.ts` owns it, so "can I continue" and "what is
 * missing" are answerable without a DOM. A wizard whose gating lives in JSX is a wizard nothing can
 * check, and this one gates the most powerful act the server performs.
 *
 * It asks the FULL path the terminal wizard asks — assistant, where, task, model, effort, first
 * message, title — not a reduced form. What the web adds is that each answer is SHOWN rather than
 * spelled: a mark per assistant, a repository distinguished from a plain folder, and effort as a
 * coloured scale.
 *
 * TWO RULES CARRIED OVER FROM THE TERMINAL WIZARD, both load-bearing:
 *
 * - The assistants offered are the ones `availableHarnesses()` found ON PATH. Anything else would
 *   start a tmux session that dies on `command not found` behind a screen nobody is watching.
 * - `model` and `effort` are SKIPPED, not shown-and-disabled, when the spawn spec has no flag for
 *   them. `efforts` is a CLOSED set read from each CLI's own `--help` — agy prints one, codex
 *   deliberately has none — so the scale decorates a real set and may never imply a level the
 *   harness does not accept.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Check, FolderGit2, Folder, Loader, Paperclip, Search, X } from 'lucide-react'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { effortColor, effortSteps } from '../../lib/effortScale'
import { HarnessMark } from './HarnessMark'
import {
  STEP_ORDER, clearForHarness, modelDisplay, nextStep, prevStep, stepReady, unsetAnswer,
  visibleQuestions, type MissingAnswer, type StepId, type WizardDraft, type WizardHarness,
} from '../../lib/wizardSteps'

interface HarnessOption {
  id: string
  label: string
  /** The ids `--model` accepts. What is SENT. */
  modelSuggestions: string[]
  /**
   * The same ids, each with the name the harness's own CLI prints — `harnessModels.ts` on the
   * server, which carries the exact command that established every pair. Absent from an older
   * server's answer, which is why the picker falls back to the ids rather than to nothing.
   */
  models?: { id: string; label: string }[]
  supportsModel: boolean
  efforts: string[]
  /**
   * What the CLI uses when the flag is not passed, and ONLY where the CLI publishes it — see the
   * defaults block in `spawn-spec.ts`, which is the one place either value may be established.
   * Absent from an older server's answer, and absent today from every harness.
   */
  defaultModel?: string
  defaultEffort?: string
}

interface ProjectOption {
  path: string
  label: string
  repo?: string
  detail: string
  source: string
}

export interface NewSessionModalProps {
  lang: 'pt' | 'en'
  onClose: () => void
  /** Called with the new session's id when one starts, so the page can select it immediately. */
  onStarted: (id?: string) => void
}

export function NewSessionModal({ lang, onClose, onStarted }: NewSessionModalProps) {
  const pt = lang === 'pt'
  const [harnesses, setHarnesses] = useState<HarnessOption[] | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [tasks, setTasks] = useState<string[]>([])
  const [query, setQuery] = useState('')

  const [harness, setHarness] = useState<HarnessOption | null>(null)
  const [cwd, setCwd] = useState('')
  const [task, setTask] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [prompt, setPrompt] = useState('')
  const [label, setLabel] = useState('')

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  /** Which question is on screen. The ORDER and the gating are `wizardSteps.ts`'s, not this file's. */
  const [step, setStep] = useState<StepId>('assistant')
  /**
   * The model picker's own open state, held HERE rather than inside it, because the modal owns the
   * keyboard: `esc` has to close the picker before it closes the wizard, and two listeners racing
   * for one key is how a dropdown takes the whole dialog down with it.
   */
  const [modelOpen, setModelOpen] = useState(false)
  /**
   * Files already uploaded to this machine, as `{name, path}`.
   *
   * Same shape and same reason as the composer's: the first message is TYPED into a tmux pane, so
   * there is no channel a byte array could travel down — but every one of these CLIs reads a file
   * it is pointed at. The chip says the name; the message carries the path.
   */
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`/api/fleet/new?lang=${lang}&q=${encodeURIComponent(query)}`)
        if (!res.ok || !alive) return
        const json = await res.json() as {
          harnesses: HarnessOption[]; projects: ProjectOption[]; tasks: string[]
        }
        setHarnesses(json.harnesses)
        setProjects(json.projects)
        setTasks(json.tasks)
        // Pre-select the only assistant there is. A one-item picker is a question with one answer.
        setHarness(h => h ?? (json.harnesses.length === 1 ? json.harnesses[0]! : null))
      } catch { /* transient — the picker keeps what it had */ }
    }
    void load()
    return () => { alive = false }
  }, [lang, query])

  // Reset the answers a DIFFERENT assistant does not accept. Carrying `effort: 'high'` across to a
  // harness whose set does not contain it would send a flag the CLI rejects at spawn.
  const efforts = useMemo(() => effortSteps(harness?.efforts ?? []), [harness])

  /** The selected assistant in the pure module's shape. One mapping, read by everything below. */
  const wizardHarness: WizardHarness | null = useMemo(() => harness ? {
    id: harness.id,
    label: harness.label,
    // The server's labelled list when it sent one; the bare ids otherwise. A missing label is
    // rendered AS THE ID — never as an invented name, which is `modelLabel`'s own rule.
    models: harness.models ?? harness.modelSuggestions.map(m => ({ id: m, label: m })),
    supportsModel: harness.supportsModel,
    efforts: harness.efforts,
    ...(harness.defaultModel ? { defaultModel: harness.defaultModel } : {}),
    ...(harness.defaultEffort ? { defaultEffort: harness.defaultEffort } : {}),
  } : null, [harness])

  /**
   * The answers so far. Rebuilt each render rather than held as state: one source for each answer,
   * and therefore no chance of the form and the gate disagreeing about what was chosen.
   */
  const draft: WizardDraft = useMemo(
    () => ({ harness: harness?.id ?? '', cwd, task, model, effort, prompt, label, attachments }),
    [harness, cwd, task, model, effort, prompt, label, attachments],
  )

  // `clearForHarness` decides what survives a change of assistant, so the rule lives in one tested
  // place: a model or an effort the NEW assistant also names is KEPT, and anything it cannot accept
  // is dropped rather than sent as a flag the CLI rejects at spawn.
  useEffect(() => {
    setModel(m => (wizardHarness && wizardHarness.models.some(x => x.id === m)) ? m : '')
    setEffort(e => (wizardHarness && wizardHarness.efforts.includes(e)) ? e : '')
  }, [wizardHarness])

  const ready = stepReady(step, draft, wizardHarness)
  const canStart = stepReady('review', draft, wizardHarness).ok && !busy
  const stepIndex = STEP_ORDER.indexOf(step)

  /**
   * What a blocked step is waiting for, IN WORDS. A disabled button that says nothing is a bug.
   *
   * One sentence per `MissingAnswer`, and the mapping is exhaustive on purpose: the pure module
   * decides WHAT is missing, this file only says it, so a new gate over there cannot land here as
   * a silent fallback to the wrong sentence.
   */
  const BLOCKED_BECAUSE: Record<MissingAnswer, string> = {
    assistant: pt ? 'Escolha um assistente para continuar.' : 'Pick an assistant to continue.',
    title: pt ? 'Dê um título à sessão para continuar.' : 'Give the session a title to continue.',
    cwd: pt ? 'Escolha uma pasta para continuar.' : 'Pick a folder to continue.',
  }
  const blockedBecause = ready.ok || !ready.missing ? null : BLOCKED_BECAUSE[ready.missing]

  /**
   * WHAT HAPPENS IF YOU LEAVE IT ALONE — named where the CLI publishes it, vague where it does not.
   *
   * `unsetAnswer` is the rule; this is only the wording. "Default (sonnet)" tells a reader whether
   * skipping the question was the right call, which "the assistant's default" never could — and
   * where no default could be read out of the CLI's own output the vague sentence is the only
   * honest one, because a named default we cannot verify is read at a glance and believed.
   */
  const unsetText = (published: string | undefined): string => {
    const answer = unsetAnswer(published)
    return answer.known
      ? (pt ? `Padrão (${answer.value})` : `Default (${answer.value})`)
      : (pt ? 'Padrão do assistente' : "The assistant's default")
  }
  const modelUnset = unsetText(harness?.defaultModel)
  const effortUnset = unsetText(harness?.defaultEffort)

  const STEP_TITLE: Record<StepId, string> = {
    assistant: pt ? 'Assistente' : 'Assistant',
    where: pt ? 'Onde' : 'Where',
    message: pt ? 'Mensagem' : 'Message',
    review: pt ? 'Revisão' : 'Review',
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Innermost first. Closing the whole wizard because a dropdown was open loses every answer
      // already given, over a keypress the user meant for the dropdown.
      if (modelOpen) setModelOpen(false)
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, modelOpen])

  /**
   * Wait for the row to exist before handing the caller its id.
   *
   * The spawn returns as soon as tmux has the session; the workspace learns about it from a poll
   * that runs every five seconds. Navigating to `/sessions/<id>` in between lands on a row the page
   * does not have, and it renders "this session is no longer in this machine's list" — a sentence
   * about a session created one second earlier, which is exactly the "criou como inativa" report.
   *
   * Bounded, and it never blocks the outcome: the session IS started either way, so when the budget
   * runs out we navigate anyway and let the next poll settle it. Failing to confirm is not a reason
   * to withhold a session that exists.
   */
  async function waitForRow(id: string, budgetMs = 6000): Promise<void> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`/api/fleet?lang=${lang}`)
        if (r.ok) {
          const f = await r.json() as { rows?: { id?: string }[] }
          if (f.rows?.some(x => x.id === id)) return
        }
      } catch { /* the poll that matters is the workspace's; this one is a courtesy */ }
      await new Promise(res => setTimeout(res, 400))
    }
  }

  /**
   * Upload the picked files, one request each, and keep only what actually landed.
   *
   * A chip is added ONLY for a file the server confirmed and named a path for. Adding it
   * optimistically would put a path into the first message that resolves to nothing, and the
   * assistant would be told to read a file that is not there — a failure the person cannot see and
   * the session cannot explain.
   */
  async function pick(list: FileList | null): Promise<void> {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    setUploading(true)
    for (const file of files) {
      const body = new FormData()
      body.append('file', file)
      try {
        const res = await fetch(`/api/fleet/attach?lang=${lang}`, { method: 'POST', body })
        const json = await res.json() as { ok: boolean; path?: string; name?: string; message?: string }
        if (json.ok && json.path && json.name) {
          setAttachments(a => [...a, { name: json.name!, path: json.path! }])
        } else {
          setNotice(json.message ?? (pt ? 'O anexo falhou.' : 'The attachment failed.'))
        }
      } catch {
        setNotice(pt ? 'Erro de rede ao enviar o anexo.' : 'Network error uploading the attachment.')
      }
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  /**
   * THE REVIEW — every answer in one place, and the honest word for each one left unset.
   *
   * "Padrão do assistente" is not the same as blank: one says a decision was deferred to the CLI,
   * the other reads as a field somebody forgot. A question the harness never asked (a model on a
   * harness that names none) is ABSENT here rather than shown as unset, for the same reason it was
   * skipped in step 1 — reporting "Model: default" for a harness with no model flag describes a
   * choice nobody was offered.
   */
  const reviewPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <ReviewRow label={pt ? 'Assistente' : 'Assistant'} value={
        harness ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <HarnessMark harness={harness.id} size={16} />
            {(HARNESS_LABELS as Record<string, string>)[harness.id] ?? harness.label}
          </span>
        ) : null
      } />
      {visibleQuestions(wizardHarness).model && (() => {
        // The SAME pure rule the picker renders, so the review cannot name the choice differently
        // one step after it was made.
        const shown = modelDisplay(wizardHarness!.models, model)
        return (
          <ReviewRow label={pt ? 'Modelo' : 'Model'}
            value={shown ? (
              // Wraps: at 390px the review's value column is ~165px, and a name plus its id is
              // wider than that on several of agy's models. Wrapping keeps the page from scrolling
              // sideways, which is the one thing no screen here may do.
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 7 }}>
                {shown.label}
                {shown.id && <ModelId id={shown.id} />}
              </span>
            ) : null}
            muted={modelUnset} />
        )
      })()}
      {visibleQuestions(wizardHarness).effort && (
        <ReviewRow label={pt ? 'Esforço' : 'Effort'} value={effort || null} muted={effortUnset} />
      )}
      {/* No `muted` fallback: the title is required, so the review can never reach this row with
          nothing in it — and offering a sentence for a state the gate forbids would describe a
          choice nobody was allowed to make. */}
      <ReviewRow label={pt ? 'Título' : 'Title'} value={label || null} />
      <ReviewRow label={pt ? 'Onde' : 'Where'} value={cwd || null} mono />
      <ReviewRow label={pt ? 'Tarefa' : 'Task'} value={task || null}
        muted={task === '' ? (pt ? 'Nenhuma' : 'None') : undefined} />
      <ReviewRow label={pt ? 'Primeira mensagem' : 'First message'} value={prompt || null}
        muted={prompt === '' ? (pt ? 'Nenhuma — a sessão abre esperando você' : 'None — the session opens waiting for you') : undefined} />
      {attachments.length > 0 && (
        <ReviewRow label={pt ? 'Anexos' : 'Attachments'} value={
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {attachments.map(a => (
              <span key={a.path} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px',
                borderRadius: 6, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                fontSize: 11.5,
              }}>
                <Paperclip size={11} /> {a.name}
              </span>
            ))}
          </span>
        } />
      )}
    </div>
  )

  /** The first message as it will be TYPED: the attachment paths, then the words. */
  const promptWithAttachments = [...attachments.map(a => a.path), prompt].filter(x => x !== '').join('\n')

  async function start() {
    if (!canStart) return
    setBusy(true)
    setNotice(null)
    try {
      // `/api/fleet/new`, never `/api/fleet/spawn`: the same body, but read by the pure
      // `fleet-spawn.ts`, which REFUSES rather than repairs — a relative cwd, an effort outside the
      // CLI's own enum, a model asked of a harness with no model flag. A spawn is the most powerful
      // thing this server does, and there is no reason for the browser to reach the unvalidated
      // twin of a validated route.
      const res = await fetch(`/api/fleet/new?lang=${lang}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          harness: harness!.id,
          cwd,
          ...(task ? { task } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          // The paths go FIRST, each on its own line, then what was typed — the same order the
          // composer uses. An assistant reads the files it is pointed at, and a path buried inside
          // a sentence is one it can miss.
          ...(promptWithAttachments ? { prompt: promptWithAttachments } : {}),
          ...(label ? { label } : {}),
        }),
      })
      const json = await res.json() as { ok: boolean; message: string; id?: string }
      if (json.ok) {
        // Still `busy` — the button keeps saying it is working, because it is.
        if (json.id) await waitForRow(json.id)
        setBusy(false)
        onStarted(json.id)
        return
      }
      setBusy(false)
      setNotice(json.message)
    } catch {
      setBusy(false)
      setNotice(pt ? 'Erro de rede ao falar com esta máquina.' : 'Network error talking to this machine.')
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={pt ? 'Nova sessão' : 'New session'}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'var(--ag-scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: '86vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
            {pt ? 'Nova sessão' : 'New session'}
          </h2>
          <button
            onClick={onClose}
            aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </header>

        {/* WHERE YOU ARE, in a band of its own.
            It was a row of pills crammed beside the title, which is why it read as clutter: four
            labelled controls competing with the heading for one line. A wizard's progress is not a
            control group — it is a TRACK you move along, so it is drawn as one, full width, with
            the line between two steps carrying the state of the passage between them.
            A step already PASSED is clickable: going back to change one answer is ordinary, and
            making it cost three presses of Back is the wizard being pleased with itself. A step
            AHEAD is not — it may be gated by an answer this one has not given, which `stepReady`
            decides. */}
        <nav aria-label={pt ? 'Etapas' : 'Steps'} style={{
          display: 'flex', alignItems: 'flex-start',
          padding: '16px 24px 14px', borderBottom: '1px solid var(--border)',
        }}>
          {STEP_ORDER.map((id, i) => {
            const done = i < stepIndex
            const here = id === step
            const reachable = done
            return (
              <div key={id} style={{ display: 'flex', alignItems: 'flex-start', flex: i === STEP_ORDER.length - 1 ? '0 0 auto' : 1, minWidth: 0 }}>
                <button
                  onClick={() => { if (reachable) setStep(id) }}
                  disabled={!reachable && !here}
                  aria-current={here ? 'step' : undefined}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    border: 'none', background: 'transparent', padding: 0, flexShrink: 0,
                    cursor: reachable ? 'pointer' : 'default', fontFamily: 'inherit',
                  }}
                >
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 26, height: 26, borderRadius: 999, fontSize: 12, fontWeight: 700,
                    boxSizing: 'border-box',
                    background: done ? 'var(--anthropic-orange)'
                      : here ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                    border: here ? '1.5px solid var(--anthropic-orange)' : '1.5px solid transparent',
                    color: done ? '#fff' : here ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                    transition: 'background 0.18s, color 0.18s, border-color 0.18s',
                  }}>
                    {done ? <Check size={13} strokeWidth={3} /> : i + 1}
                  </span>
                  <span style={{
                    fontSize: 11, whiteSpace: 'nowrap',
                    fontWeight: here ? 700 : 500,
                    color: here ? 'var(--text-primary)' : done ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                  }}>
                    {STEP_TITLE[id]}
                  </span>
                </button>
                {/* The line BETWEEN two steps carries the state of the passage between them: filled
                    once you have crossed it. It sits on the dot's centre line, not the label's. */}
                {i < STEP_ORDER.length - 1 && (
                  <span aria-hidden style={{
                    flex: 1, height: 2, margin: '12px 8px 0', borderRadius: 2, minWidth: 12,
                    background: done ? 'var(--anthropic-orange)' : 'var(--border)',
                    opacity: done ? 0.55 : 1,
                    transition: 'background 0.18s',
                  }} />
                )}
              </div>
            )
          })}
        </nav>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* STEP 1 — WHO. The assistant, and the two answers that only exist once one is
              chosen: a model and an effort. The TITLE is here too — it is what you will look
              for in the list later, so it is asked while you are deciding what this IS, and it
              is the one answer on this step that is REQUIRED. */}
          {step === 'assistant' && (<>
          <Field label={pt ? 'Assistente' : 'Assistant'}>
            {harnesses === null ? (
              <Muted text={pt ? 'Vendo o que está instalado…' : 'Checking what is installed…'} />
            ) : harnesses.length === 0 ? (
              // Not an empty picker: the machine looked and found nothing it knows how to start.
              <Muted text={pt
                ? 'Nenhum assistente que o agentop saiba iniciar foi encontrado nesta máquina.'
                : 'No assistant agentop knows how to start was found on this machine.'} />
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {harnesses.map(h => {
                  const on = harness?.id === h.id
                  const color = (HARNESS_COLORS as Record<string, string>)[h.id] ?? 'var(--text-secondary)'
                  const name = (HARNESS_LABELS as Record<string, string>)[h.id] ?? h.label
                  return (
                    <button
                      key={h.id}
                      onClick={() => { setHarness(h) }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '9px 13px', borderRadius: 10, cursor: 'pointer',
                        border: `1px solid ${on ? color : 'var(--border-subtle)'}`,
                        background: on ? `color-mix(in srgb, ${color} 14%, transparent)` : 'var(--bg-elevated)',
                        color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 650 : 500,
                      }}
                    >
                      <HarnessMark harness={h.id} size={18} />
                      {name}
                    </button>
                  )
                })}
              </div>
            )}
          </Field>

          {/* SKIPPED, not disabled, when the CLI has no such flag — see the header. Skipped for the
              same reason when the harness offers NO names: `modelSuggestions` is empty exactly
              where that CLI publishes no list of its own (see `spawn-spec.ts`), and a closed
              dropdown whose only entry is "the assistant's default" is a control that cannot be
              used. An absent picker says "we cannot name these for you"; a one-option one says
              nothing at all. */}
          {visibleQuestions(wizardHarness).model && (
            <Field label={pt ? 'Modelo (opcional)' : 'Model (optional)'}>
              {/* A CLOSED picker, never free text: the list is the actual set this harness offers,
                  and a typed id it does not recognise fails at spawn with no explanation on
                  screen. The wizard's job is to offer only what will work.

                  It was a bare `<select>`, which on every platform draws the OS's own menu — a
                  control that ignores this application's palette and its 44px mobile target, and
                  the only one in the wizard that did. `ModelSelect` is the same shape as the value
                  pickers in `FiltersBar`: a trigger, a popover, one checked row per value. */}
              <ModelSelect
                lang={lang}
                open={modelOpen}
                onOpenChange={setModelOpen}
                value={model}
                onChange={setModel}
                options={wizardHarness!.models}
                unsetLabel={modelUnset}
              />
            </Field>
          )}

          {efforts.length > 0 && (
            <Field label={pt ? 'Esforço (opcional)' : 'Effort (optional)'} hint={pt
              ? `Mais esforço pensa por mais tempo e custa mais. Sem escolha: ${effortUnset}.`
              : `More effort thinks for longer and costs more. Left unset: ${effortUnset}.`}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {efforts.map(step => {
                  const on = effort === step.value
                  const color = effortColor(step.intensity)
                  return (
                    <button
                      key={step.value}
                      onClick={() => setEffort(on ? '' : step.value)}
                      className={on && step.peak ? 'ag-effort-peak' : undefined}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 7,
                        padding: '8px 13px', borderRadius: 9, cursor: 'pointer',
                        border: `1px solid ${on ? color : 'var(--border-subtle)'}`,
                        background: on ? `color-mix(in srgb, ${color} 16%, transparent)` : 'var(--bg-elevated)',
                        color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontFamily: 'inherit', fontSize: 12.5, fontWeight: on ? 650 : 500,
                        transition: 'background 0.15s, border-color 0.15s',
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
                      {step.value}
                    </button>
                  )
                })}
              </div>
            </Field>
          )}

          {/* REQUIRED, and the gate is `stepReady('assistant')`'s — see `wizardSteps.ts`. It is
              asked here rather than at the end because a title is what this session IS, and that
              is the thing you know while you are deciding to start it. */}
          <Field label={pt ? 'Título' : 'Title'} hint={pt
            ? 'É por ele que você acha esta sessão na lista depois.'
            : 'It is how you find this session in the list later.'}>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={pt ? 'O que esta sessão é…' : 'What this session is…'}
              aria-label={pt ? 'Título' : 'Title'}
              aria-required
              style={{ ...inputStyle, paddingLeft: 12 }}
            />
          </Field>
          </>)}

          {/* STEP 2 — WHERE. The directory, and the task that files this session with its
              siblings. Both are about the WORK rather than about the assistant. */}
          {step === 'where' && (<>
          <Field label={pt ? 'Onde' : 'Where'}>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <Search size={13} style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--text-tertiary)', pointerEvents: 'none',
              }} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={pt ? 'Buscar projeto ou pasta…' : 'Search project or folder…'}
                style={inputStyle}
              />
            </div>
            <div style={{
              maxHeight: 190, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4,
              border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 6,
            }}>
              {projects.length === 0 ? (
                <Muted text={pt ? 'Nenhuma pasta encontrada.' : 'No folder found.'} />
              ) : projects.map(p => {
                const on = cwd === p.path
                return (
                  <button
                    key={p.path}
                    onClick={() => setCwd(p.path)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                      padding: '8px 10px', borderRadius: 8, border: 'none', minWidth: 0,
                      background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                      color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    {/* A repository and a plain directory are different things, and the mark says
                        which. Read from the store's own answer, never guessed from the path. */}
                    {p.repo
                      ? <FolderGit2 size={15} style={{ color: 'var(--accent-purple)', flexShrink: 0 }} />
                      : <Folder size={15} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />}
                    <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 12.5, fontWeight: on ? 650 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.label}
                      </span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.repo ? `${p.repo} · ${p.detail}` : p.detail}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label={pt ? 'Tarefa (opcional)' : 'Task (optional)'} hint={pt
            ? 'Agrupa várias sessões como um trabalho só, e é o que permite reabrir todas de uma vez.'
            : 'Groups several sessions as one piece of work, and is what lets you reopen them all at once.'}>
            <input
              value={task}
              onChange={e => setTask(e.target.value)}
              list="agentistics-tasks"
              placeholder={pt ? 'Nova ou existente…' : 'New or existing…'}
              style={{ ...inputStyle, paddingLeft: 12 }}
            />
            <datalist id="agentistics-tasks">
              {tasks.map(t => <option key={t} value={t} />)}
            </datalist>
          </Field>
          </>)}

          {/* STEP 3 — WHAT. The first message, and the files it points at. */}
          {step === 'message' && (<>
          <Field label={pt ? 'Primeira mensagem (opcional)' : 'First message (optional)'}>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              placeholder={pt ? 'O que a sessão deve fazer…' : 'What the session should do…'}
              style={{ ...inputStyle, paddingLeft: 12, resize: 'vertical', minHeight: 68 }}
            />
          </Field>

          <Field label={pt ? 'Anexos (opcional)' : 'Attachments (optional)'} hint={pt
            ? 'Os arquivos ficam nesta máquina; a primeira mensagem carrega o caminho de cada um.'
            : 'The files stay on this machine; the first message carries the path of each one.'}>
            <input
              ref={fileRef}
              type="file"
              multiple
              onChange={e => void pick(e.target.files)}
              style={{ display: 'none' }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {attachments.map(a => (
                <span key={a.path} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 9px',
                  borderRadius: 8, background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)', fontSize: 12,
                }}>
                  <Paperclip size={11} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
                  <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <button
                    onClick={() => setAttachments(list => list.filter(x => x.path !== a.path))}
                    aria-label={pt ? `Remover ${a.name}` : `Remove ${a.name}`}
                    style={{
                      display: 'flex', border: 'none', background: 'transparent', cursor: 'pointer',
                      color: 'var(--text-tertiary)', padding: 2,
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px',
                  borderRadius: 8, cursor: uploading ? 'default' : 'pointer',
                  border: '1px dashed var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12,
                }}
              >
                {uploading ? <Loader size={12} /> : <Paperclip size={12} />}
                {uploading ? (pt ? 'Enviando…' : 'Uploading…') : (pt ? 'Anexar arquivo' : 'Attach file')}
              </button>
            </div>
          </Field>
          </>)}

          {/* STEP 4 — the REVIEW, rendered by `reviewRows` below. */}
          {step === 'review' && reviewPane}

          {notice && (
            <p role="status" style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--anthropic-orange)' }}>
              {notice}
            </p>
          )}
        </div>

        <footer style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
          padding: '14px 20px', borderTop: '1px solid var(--border)',
        }}>
          {/* WHY THE STEP IS BLOCKED, beside the button that will not move. A disabled control
              with no sentence next to it is indistinguishable from a broken one — the rule this
              product applies to every refusal, applied to a wizard. */}
          {blockedBecause && (
            <span role="status" style={{ marginRight: 'auto', fontSize: 12, color: 'var(--text-tertiary)' }}>
              {blockedBecause}
            </span>
          )}
          <button
            onClick={() => (stepIndex === 0 ? onClose() : setStep(prevStep(step)))}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '9px 14px', borderRadius: 9, cursor: 'pointer',
              border: '1px solid var(--border-subtle)', background: 'transparent',
              color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 13,
            }}
          >
            {stepIndex > 0 && <ChevronLeft size={14} />}
            {stepIndex === 0 ? (pt ? 'Cancelar' : 'Cancel') : (pt ? 'Voltar' : 'Back')}
          </button>
          {step !== 'review' ? (
            <button
              onClick={() => { if (ready.ok) setStep(nextStep(step)) }}
              disabled={!ready.ok}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '9px 16px', borderRadius: 9, border: 'none',
                background: ready.ok ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
                color: ready.ok ? '#fff' : 'var(--text-tertiary)',
                cursor: ready.ok ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 13, fontWeight: 650,
              }}
            >
              {pt ? 'Continuar' : 'Continue'}
              <ChevronRight size={14} />
            </button>
          ) : (
            <button
              onClick={() => void start()}
              disabled={!canStart}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '9px 16px', borderRadius: 9, border: 'none',
                background: canStart ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
                color: canStart ? '#fff' : 'var(--text-tertiary)',
                cursor: canStart ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 13, fontWeight: 650,
              }}
            >
              {busy && <Loader size={14} />}
              {busy
                ? (pt ? 'Iniciando…' : 'Starting…')
                : (pt ? 'Iniciar sessão' : 'Start session')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

/**
 * One line of the review: what was asked, and what will be used.
 *
 * `muted` is the answer for a question left unset, and it is a SENTENCE rather than a blank — "the
 * assistant's default" and "none" are decisions, while an empty cell reads as a field somebody
 * forgot to fill in and sends the reader back through the steps looking for it.
 */
function ReviewRow({ label, value, muted, mono }: {
  label: string
  value: React.ReactNode | null
  muted?: string
  mono?: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '9px 0', borderBottom: '1px solid var(--border-subtle)',
    }}>
      <span style={{
        minWidth: 132, flexShrink: 0, fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
        textTransform: 'uppercase', color: 'var(--text-tertiary)', paddingTop: 1,
      }}>{label}</span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5,
        color: value ? 'var(--text-primary)' : 'var(--text-tertiary)',
        fontStyle: value ? 'normal' : 'italic',
        fontFamily: mono && value ? 'var(--font-mono, ui-monospace, monospace)' : 'inherit',
        wordBreak: 'break-word', whiteSpace: 'pre-wrap',
      }}>{value ?? muted ?? '—'}</span>
    </div>
  )
}

/**
 * The model picker — this application's own control, not the browser's.
 *
 * A bare `<select>` renders the platform's menu: it ignores the dashboard's palette in both
 * themes, it cannot show a value's id beside its name, and on a phone it is the one control in the
 * wizard that does not meet the 44px target every other row here does. So it is built the way
 * `FiltersBar`'s value pickers are built — a trigger, a popover, one checked row per value.
 *
 * WHAT A ROW SAYS: the name the harness's own CLI prints, and — only when the two differ — the id
 * that will actually be sent, in the trailing tag. `opus`/`Opus 5` are the same model under two
 * names, and a picker that shows only one of them leaves the reader unable to match what they
 * chose against what the CLI reports back. Where the harness publishes no name, `label === id` and
 * the tag is ABSENT rather than a repetition.
 *
 * The popover is constrained to the trigger's own width (`left: 0; right: 0`), so it cannot give
 * the page a horizontal scrollbar at any viewport — the clamping arithmetic `FiltersBar` needs
 * exists because its trigger is a small button in a bar, which is not the case here.
 *
 * `open` is the CALLER's state: the wizard owns the keyboard, and `esc` must close this before it
 * closes the dialog.
 */
function ModelSelect({ lang, open, onOpenChange, value, onChange, options, unsetLabel }: {
  lang: 'pt' | 'en'
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The id, or `''` for "leave it to the assistant". */
  value: string
  onChange: (id: string) => void
  options: { id: string; label: string }[]
  /** The sentence for the unset row — what happens when nothing is picked, in words. */
  unsetLabel: string
}) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onOpenChange])

  const chosen = modelDisplay(options, value)
  const rowHeight = isMobile ? 44 : undefined

  const row = (key: string, selected: boolean, label: string, tag: string | null, pick: () => void) => (
    <button
      key={key}
      role="option"
      aria-selected={selected}
      onClick={() => { pick(); onOpenChange(false) }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: isMobile ? '0 10px' : '7px 10px', minHeight: rowHeight, boxSizing: 'border-box',
        borderRadius: 6, border: 'none', cursor: 'pointer',
        background: selected ? 'var(--anthropic-orange-dim)' : 'transparent',
        color: selected ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
        fontSize: 12.5, fontFamily: 'inherit', textAlign: 'left',
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-card-hover)' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
    >
      <span style={{ width: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {selected && <Check size={12} strokeWidth={3} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {/* The id, and only when it is not already the label — `modelDisplay`'s rule. */}
      {tag && <ModelId id={tag} />}
    </button>
  )

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        style={{
          ...inputStyle,
          display: 'flex', alignItems: 'center', gap: 8,
          paddingLeft: 12, paddingRight: 10, minHeight: isMobile ? 44 : undefined,
          cursor: 'pointer', textAlign: 'left',
          borderColor: open ? 'var(--anthropic-orange)' : 'var(--border-subtle)',
        }}
      >
        <span style={{
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: chosen ? 'var(--text-primary)' : 'var(--text-tertiary)',
        }}>
          {chosen ? chosen.label : unsetLabel}
        </span>
        {chosen?.id && <ModelId id={chosen.id} />}
        <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={pt ? 'Modelo' : 'Model'}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 10,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            maxHeight: 260, overflowY: 'auto', overflowX: 'hidden',
            boxSizing: 'border-box', padding: 6,
          }}
        >
          {/* The unset row FIRST, and named — "no model" is a decision the CLI acts on, not a
              blank. It is also the row the wizard opens on, so it may never be hard to find. */}
          {row('', value === '', unsetLabel, null, () => onChange(''))}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          {options.map(o => {
            const shown = modelDisplay(options, o.id)!
            return row(o.id, o.id === value, shown.label, shown.id, () => onChange(o.id))
          })}
        </div>
      )}
    </div>
  )
}

/** The id beside a model's name. Monospace and quiet: it is what is SENT, not what is read. */
function ModelId({ id }: { id: string }) {
  return (
    <span style={{
      flexShrink: 0, fontSize: 10.5, color: 'var(--text-tertiary)',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    }}>{id}</span>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '9px 12px 9px 30px', borderRadius: 9,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, outline: 'none',
}

function Field({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <span style={{
        fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
        color: 'var(--text-tertiary)',
      }}>
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{hint}</span>
      )}
    </div>
  )
}

function Muted({ text }: { text: string }) {
  return <p style={{ margin: 0, padding: '6px 4px', fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{text}</p>
}
