/**
 * modelSwitch.ts — PURE: can this session's model be changed mid-conversation, and how?
 *
 * A `Record` per harness with an explicit `null`, deliberately shaped like the server's
 * `rename-spec.ts`: adding a harness breaks the build here rather than silently shipping a control
 * that does nothing, and every `null` is a FINDING with its own sentence rather than an omission.
 *
 * There is no fleet VERB for this and there should not be: changing the model is not something
 * agentop does to a session, it is something the assistant's own command does from inside it. So
 * the mechanism is a typed line — the same `prompt` action the composer already uses — and it
 * therefore inherits every rule that action has: the session must be running, and it is refused
 * while a dialog is open, because a slash command typed into a permission prompt goes into that
 * dialog's filter and the submit takes the highlighted option.
 *
 * ONLY CLAUDE IS WIRED, and it is wired because it was verified: `/model` was read back from the
 * running CLI (claude 2.1.x, `claude -p` asked for the command's exact name) rather than assumed.
 * The others are null until somebody checks the same way — a guessed slash command does not fail
 * loudly, it types a line of nonsense into a live session.
 *
 * THE MODEL NAME IS PASSED VERBATIM, and the values come from the server's `modelSuggestions` for
 * this harness (`GET /api/fleet/new`) — which is the list `--model` accepts. That those two are
 * the same set is a FINDING, not an assumption: driven against claude 2.1.259 on 2026-09-02,
 * `claude -p "/model <alias>"` answered `Set model to \`Fable 5.1\` | \`Opus 5\` | \`Sonnet 5\` |
 * \`Haiku 4.5\`` for exactly the four aliases `--model` accepts, and answered `Model '<x>' not
 * found` for `mythos` and for a nonsense id — the same two rejections `--model` gives. The CLI
 * says so itself: its model-selection schema reads "an alias ("opus"), an Anthropic model ID, or a
 * provider-format ID … Same values --model accepts." So one list can feed both surfaces.
 *
 * The corollary is the rule the list is held to: NEVER prettify a name on the way in. `/model`
 * matches the id, so a display label ("Opus 5", "Sonnet") typed here is `Model 'Opus 5' not found`
 * in a live session, which is a silent no-op the user reads as the switch having worked.
 */

export interface ModelSwitchSpec {
  /** The line to type. `{model}` is replaced with the chosen id. */
  line: string
}

/** Keyed by the harness ids the fleet reports. */
export const MODEL_SWITCH: Record<string, ModelSwitchSpec | null> = {
  // Verified against the running CLI, not the docs.
  claude: { line: '/model {model}' },
  // Codex takes `--model` at spawn; nothing in its help offers a mid-session switch.
  codex: null,
  // Gemini's model is chosen at spawn.
  gemini: null,
  // Copilot exposes model selection through its own UI, not a line that can be typed.
  copilot: null,
  // Antigravity has no documented slash command for it.
  antigravity: null,
  // Kimi routes per request; there is no session-level switch to type.
  kimi: null,
}

export function modelSwitchLine(harness: string, model: string): string | null {
  const spec = MODEL_SWITCH[harness]
  if (!spec || !model) return null
  return spec.line.replace('{model}', model)
}

/** Why the control is absent, so the panel can say it instead of leaving a hole. */
export function modelSwitchReason(harness: string, lang: 'en' | 'pt'): string | null {
  if (MODEL_SWITCH[harness]) return null
  const pt = lang === 'pt'
  return pt
    ? 'Trocar de modelo no meio da conversa só está verificado no Claude Code.'
    : 'Switching model mid-conversation is only verified for Claude Code.'
}
