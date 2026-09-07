/**
 * effortScale.ts — PURE. How an effort level is coloured and how far along the scale it sits.
 *
 * The set of levels is NOT open. `SpawnSpec.efforts` is read from each CLI's own `--help` — agy
 * prints a closed enum, codex deliberately has none — so this module never invents a level and
 * never orders one it does not recognise ahead of one it does. The visual scale decorates a real
 * closed set; if it implied a level the harness does not accept, the wizard would offer something
 * that fails at spawn.
 *
 * Only the arithmetic lives here so the component stays a renderer and the ordering is testable.
 */

/** The levels seen across the CLIs, weakest first. Anything else keeps the order it arrived in. */
const KNOWN = ['minimal', 'low', 'medium', 'standard', 'high', 'max', 'maximum', 'ultra'] as const

/** Weakest → strongest, then anything unrecognised in the order the harness gave it. */
export function orderEfforts(efforts: readonly string[]): string[] {
  const rank = (e: string): number => {
    const i = KNOWN.indexOf(e.toLowerCase() as typeof KNOWN[number])
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...efforts].sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    // Unrecognised levels keep the harness's own order rather than being alphabetised: its `--help`
    // lists them in the order it considers meaningful, and re-sorting would assert an order nobody
    // established.
    return efforts.indexOf(a) - efforts.indexOf(b)
  })
}

export interface EffortStep {
  value: string
  /** 0 at the weakest, 1 at the strongest. A single-level scale is 1 — it IS the maximum. */
  intensity: number
  /** True for the strongest level offered. The one that plays the emphatic effect. */
  peak: boolean
}

export function effortSteps(efforts: readonly string[]): EffortStep[] {
  const ordered = orderEfforts(efforts)
  const last = ordered.length - 1
  return ordered.map((value, i) => ({
    value,
    intensity: last === 0 ? 1 : i / last,
    peak: i === last,
  }))
}

/**
 * Green through amber to red as the effort rises.
 *
 * Red is deliberate and is not an alarm: the strongest level is the slowest and the most expensive,
 * which is worth showing before the session starts rather than after the bill. `hsl` so the ramp is
 * continuous for any number of levels — a harness with two and one with five both read correctly.
 */
export function effortColor(intensity: number): string {
  const hue = Math.round(142 - 142 * Math.min(1, Math.max(0, intensity)))
  return `hsl(${hue}, 72%, 48%)`
}
