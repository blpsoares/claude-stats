/**
 * creationProgress.ts — PURE. What the "starting your session" loader says and how full its bar is.
 *
 * ## The rule the whole thing is judged on: NOTHING WAITS FOR THIS
 *
 * The loader exists so the seconds between pressing Start and reading the session feel like
 * somewhere rather than nowhere. It is decoration with a job, and the job is NOT to be watched to
 * the end — the caller unmounts it the instant the session can be drawn, mid-step and mid-sweep if
 * that is where it happens to be. Showing the session fast is the feature; this is the manners.
 *
 * That is also why the bar NEVER reaches 100 on its own. `CREATION_CEILING` is an asymptote it
 * approaches and does not cross while the work is still going, because a bar sitting at full while
 * a session is still starting is the kind of lie people remember — the same instinct behind
 * `contextFraction` rounding DOWN so a gauge cannot read full with room left. 100% and the orange
 * are what `ready` buys, and `ready` is a fact, not a timer.
 *
 * ## Why the steps are named after real work
 *
 * Each one is something that actually happens, in the order it happens: the request is validated by
 * `fleet-spawn.ts`, a tmux session is created, the harness is launched, its first prompt is
 * delivered once its screen is ready (`initial-prompt.ts`), and the row has to appear in a fleet
 * poll before the workspace can draw it. Inventing a fifth thing that does not happen would make
 * the loader a small work of fiction, and the one place a person looks when a start goes wrong is
 * the last line it managed to show.
 *
 * The durations are a SHAPE, not a measurement — nobody can promise how long `agy` takes to wake on
 * a given machine. So the last step holds rather than running out, which is honest: still waiting is
 * exactly what is happening.
 */

/** How full the bar may get while the work is still going. Never 100 — see the header. */
export const CREATION_CEILING = 94

export interface CreationStep {
  /** Stable id, so a step can be referred to without its wording. */
  id: string
  /** Roughly how long this step tends to take. A shape for the animation, never a promise. */
  ms: number
  /** `{harness}` is substituted where the step is about the assistant itself. */
  en: string
  pt: string
}

export const CREATION_STEPS: readonly CreationStep[] = [
  { id: 'check', ms: 500, en: 'Reading what you asked for', pt: 'Lendo o que você pediu' },
  { id: 'room', ms: 900, en: 'Clearing a desk for it', pt: 'Arrumando uma mesa para ela' },
  { id: 'wake', ms: 1600, en: 'Waking {harness} up', pt: 'Acordando o {harness}' },
  { id: 'brief', ms: 1400, en: 'Handing over your first message', pt: 'Entregando sua primeira mensagem' },
  { id: 'fleet', ms: 1600, en: 'Introducing it to the fleet', pt: 'Apresentando ela para a frota' },
  // The one that holds. It has to read as fine to sit on, because on a slow machine it will.
  { id: 'settle', ms: 4000, en: 'Letting it get its bearings', pt: 'Deixando ela se situar' },
]

export interface CreationView {
  /** Which step to say. Never out of range. */
  index: number
  /** 0–100. Only ever 100 when `complete`. */
  percent: number
  complete: boolean
}

const TOTAL_MS = CREATION_STEPS.reduce((n, s) => n + s.ms, 0)

/**
 * Where the loader is right now.
 *
 * `ready` is the caller's own fact — the session can be drawn — and it wins over every timer here.
 * A hostile `elapsedMs` (negative, NaN, Infinity) is read as the first frame rather than throwing:
 * this runs inside a render, and a loader that crashes the screen it is decorating is worse than no
 * loader at all.
 */
export function creationView(elapsedMs: number, ready: boolean): CreationView {
  const last = CREATION_STEPS.length - 1
  if (ready) return { index: last, percent: 100, complete: true }

  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0

  // The step is whichever window `t` has reached; past the end it HOLDS on the last one.
  let index = last
  let acc = 0
  for (let i = 0; i < CREATION_STEPS.length; i++) {
    acc += CREATION_STEPS[i]!.ms
    if (t < acc) { index = i; break }
  }

  // An exponential approach to the ceiling: quick at first, never arriving. `TOTAL_MS` sets the
  // pace, so the bar is most of the way along about when the steps run out — which is where the
  // common case ends, and where the uncommon one starts waiting visibly.
  const percent = CREATION_CEILING * (1 - Math.exp(-3 * (t / TOTAL_MS)))

  // Floored at a visible sliver: a bar that renders empty on its first frame reads as a bar that
  // never started. Rounded DOWN so it cannot round its way to the ceiling early.
  return { index, percent: Math.max(2, Math.floor(percent)), complete: false }
}

/**
 * The line under the bar, in the reader's language.
 *
 * An index outside the list answers with the last step rather than `undefined` — the caller is a
 * render, and a missing string there is a blank line where the only explanation was.
 */
export function creationStepText(
  index: number,
  lang: 'pt' | 'en',
  harness: string | undefined,
): string {
  const i = Number.isFinite(index)
    ? Math.min(Math.max(Math.trunc(index), 0), CREATION_STEPS.length - 1)
    : 0
  const step = CREATION_STEPS[i]!
  const text = lang === 'pt' ? step.pt : step.en
  // No harness named: the sentence still has to read, so the placeholder goes with its own article
  // rather than leaving `{harness}` or a dangling "o " on screen.
  if (!harness) {
    return text
      .replace(/ o \{harness\}/g, lang === 'pt' ? ' o assistente' : ' the assistant')
      .replace(/\{harness\}/g, lang === 'pt' ? 'o assistente' : 'the assistant')
  }
  return text.replace(/\{harness\}/g, harness)
}
