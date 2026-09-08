/**
 * mode-spec.ts — PURE: the MODE a harness is in, and the key that changes it.
 *
 * Asked for: "nao consigo alternar entre os modos que os harnesses possuem (auto mode, plan mode
 * etc)". The terminal has always been able to — it is one keystroke — and the web had no way to
 * see the mode, let alone change it.
 *
 * THE MODE IS ON THE SCREEN, in the same footer `attention-rules.ts` reads for `working`, and it is
 * read the same way: the LAST FEW LINES ONLY (`FOOTER_LINES`), because a session whose transcript
 * quotes "plan mode on" would otherwise report itself as being in it. This module is developed with
 * this product, so that is a certainty rather than a risk.
 *
 * MEASURED, BY DRIVING A LIVE SESSION — claude 2.1.263, 2026-09-06. Sending `BTab` (tmux's name for
 * shift+tab) four times walked the whole cycle and came back to where it started:
 *
 *   ⏸ manual mode on · ? for shortcuts
 *   ⏵⏵ accept edits on (shift+tab to cycle)
 *   ⏸ plan mode on (shift+tab to cycle)
 *   ⏵⏵ auto mode on (shift+tab to cycle)
 *
 * Note that `manual` is the one whose footer does NOT say how to cycle — it advertises `? for
 * shortcuts` instead. Matching on "(shift+tab to cycle)" would therefore have found three of the
 * four and reported the fourth as unknown, which is why each mode is matched on its own NAME.
 *
 * IT CYCLES, IT DOES NOT PICK. There is no keystroke that jumps to a named mode, so offering a
 * menu of four would be a control that reaches three of them by luck. The verb is "next mode", the
 * row says which one it is now, and both are true.
 *
 * EVERY OTHER HARNESS IS `null`, and that is a finding rather than a gap: nobody has driven one to
 * see whether it has modes at all, what its footer says, or which key moves it. A guessed key sent
 * into a live assistant is a keystroke nobody asked for — the same reason `approval-spec.ts` refuses
 * a numbered dialog it has not probed.
 */

import type { HarnessId } from '@agentistics/core'

/** How many lines from the bottom count as the footer. Mirrors `attention.ts` for the same reason. */
export const MODE_FOOTER_LINES = 4

export interface HarnessMode {
  /** Stable id, for a UI that wants to style one. */
  id: string
  /**
   * What to SHOW — the harness's own words, verbatim.
   *
   * Not translated and not renamed: this is what the person sees in the terminal one window over,
   * and inventing a second vocabulary for it would make the two disagree about what the session is
   * doing. The same call `stateLabel` makes for a machine's refusals.
   */
  label: string
  /** Matched against the FOOTER only. */
  match: RegExp
}

export interface ModeSpec {
  /** The key that advances to the next mode, in the backend's own naming. */
  cycleKey: string
  /** In cycle order, starting anywhere — the order is documentation, not behaviour. */
  modes: HarnessMode[]
  /** Provenance: the exact CLI version this was driven against, and the date. */
  probed: string
}

export const MODE_SPECS: Record<HarnessId, ModeSpec | null> = {
  claude: {
    // tmux's name for shift+tab. Verified by sending it and watching the footer change.
    cycleKey: 'BTab',
    modes: [
      { id: 'manual', label: 'manual mode', match: /manual mode on/ },
      { id: 'accept-edits', label: 'accept edits', match: /accept edits on/ },
      { id: 'plan', label: 'plan mode', match: /plan mode on/ },
      { id: 'auto', label: 'auto mode', match: /auto mode on/ },
    ],
    probed: 'claude 2.1.263, 2026-09-06',
  },
  // Unprobed. See the header: a guessed key is a keystroke nobody asked for.
  codex: null,
  gemini: null,
  copilot: null,
  kimi: null,
  antigravity: null,
}

/** The spec for a harness, or `undefined` when nobody has driven its modes. */
export function modeSpecFor(harness: HarnessId | undefined): ModeSpec | undefined {
  return harness ? (MODE_SPECS[harness] ?? undefined) : undefined
}

/**
 * Which mode this frame is in — PURE. `null` when the footer names none.
 *
 * `null` is an ordinary answer: a session that has not drawn its footer yet, one sitting on a
 * dialog that replaces it, or a harness nobody has probed. The caller shows nothing rather than
 * guessing, because a mode chip naming the wrong mode is worse than no chip — it is read at a
 * glance and believed.
 */
export function modeOf(frame: readonly string[], spec: ModeSpec | undefined): HarnessMode | null {
  if (!spec) return null
  const footer = frame.slice(Math.max(0, frame.length - MODE_FOOTER_LINES)).join('\n')
  // First match wins, and the patterns are disjoint by construction — each names its own mode.
  for (const m of spec.modes) if (m.match.test(footer)) return m
  return null
}
