/**
 * spawn-spec.ts — PURE. What argv each harness needs to start an interactive session.
 *
 * A `Record<HarnessId, …>`, never an array: TypeScript accepts an array literal with a member
 * missing, and CLAUDE.md records five surfaces that silently lost a harness exactly that way. A
 * harness whose entry is `null` is not spawnable by us yet, and every caller must therefore refuse
 * it by name rather than offering a verb that fails.
 *
 * EVERY flag below was read from that tool's own `--help` — claude, codex and kimi on 2026-08-12,
 * gemini, copilot and antigravity on 2026-08-13. A flag that could not be verified is absent, not
 * guessed.
 *
 * MODELS follow the same rule, and it took a second pass to get right. The suggestions used to be
 * "the ids this machine has actually run", read from the local session store — which is not the
 * same question. What a harness REPORTS a conversation ran under and what its `--model` flag
 * ACCEPTS are different strings, and shipping the first as the second is how the picker came to
 * offer values the CLI refuses. Measured 2026-09-02, on the versions named below: of copilot's
 * three shipped ids only `auto` was accepted (`claude-sonnet-4.6` and `gpt-5.3-codex` both came
 * back `Model "…" from --model flag is not available.`, and so did `gpt-5.4`, copilot's OWN help
 * example); of gemini's three, `gemini-2.5-pro` is refused by the API outright; and agy's single
 * `gemini-3.6-flash` — the technical id `antigravity-protobuf.ts` decodes out of the conversation
 * DB — is not a value `--model` takes at all, its own `agy models` listing only ever naming the
 * effort-suffixed `gemini-3.6-flash-high|medium|low`.
 *
 * So: A VALUE APPEARS HERE ONLY IF THE CLI ITSELF NAMES IT — in `--help`, in a listing subcommand,
 * or by answering with it when driven. A harness whose CLI publishes no list gets an EMPTY list and
 * a sentence saying why, which makes the picker ABSENT rather than wrong; a plausible id sourced
 * from anywhere else is a guess, and a guess here fails after the session has already started.
 * The lists stay a convenience and never a validation set (`planSpawn` does not check membership):
 * every one of these CLIs also accepts a full model name, and several of them scope what is
 * available to the signed-in account, so refusing an unlisted value would reject valid input.
 *
 * DEFAULTS (`defaultModel` / `defaultEffort`) FOLLOW THE SAME RULE AND ARE, TODAY, ALL ABSENT.
 *
 * A wizard that says "the assistant's default" names a thing without saying what it is, so the
 * fields exist to say "Default (sonnet)" wherever the CLI publishes the answer. Measured
 * 2026-09-04 on the versions below, NONE of the six does — and in four of the six the absence is
 * EVIDENCE rather than an omission, because those help formatters print a default wherever one
 * exists and print none here:
 *
 * - claude 2.1.261 — `claude --help`. `--model` documents the aliases and a full name; `--effort`
 *   documents `(low, medium, high, xhigh, max)`. Commander prints `(default: …)` on eight other
 *   options in the same output and on neither of these two.
 * - codex-cli 0.113.0 — `codex --help`, `codex exec --help`. `-m, --model <MODEL>` names no value.
 *   This help prints no `[default …]` anywhere, so its silence proves nothing either way; it
 *   simply does not publish one.
 * - gemini 0.55.1 — `gemini --help`. yargs prints `[default: false]` on six other options;
 *   `-m, --model  Model  [string]` carries none.
 * - copilot 1.0.82 — `copilot --help`, `copilot help config`. That config page writes "defaults
 *   to …" 37 times; the `model` key is not one of them. `--help` names `auto` as something you MAY
 *   pass, which is not the same as what happens when you pass nothing.
 * - antigravity 1.1.25 — `agy --help`, `agy models`. The help prints `(default …)` on three other
 *   flags and none on `--model` or `--effort`; `agy models` marks no row as current.
 * - kimi 0.38.0 — `kimi --help`. `--model` says "Defaults to default_model in config.toml", which
 *   names a KEY, not a value. `kimi provider list` does print a resolved default, but it is THIS
 *   MACHINE's configuration rather than the CLI's — a per-machine answer cannot live in a pure
 *   static table, and it is the user's own setting, not something the tool publishes.
 *
 * So every entry below omits both fields, and the wizard keeps its honest wording. The day one of
 * these CLIs prints its default, add it HERE with the command in a comment — never anywhere else.
 */

import type { HarnessId } from '@agentistics/core'
import { HARNESS_SESSION_SOURCES } from './harness-session-file'
import type { InitialPrompt, SpawnRequest, SpawnPlanResult, SpawnSpec } from './types'

export const SPAWN_SPECS: Record<HarnessId, SpawnSpec | null> = {
  // `Usage: claude [options] [command] [prompt]` / `Arguments: prompt  Your prompt`
  claude: {
    bin: 'claude',
    prompt: { kind: 'positional' },
    modelFlag: '--model',
    // `--help`: "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a
    // model's full name (e.g. 'claude-fable-5')" — an "e.g.", so the three it prints are examples
    // and NOT the set. VERIFIED 2026-09-02 against claude 2.1.259 by driving the CLI: `claude
    // --model <alias> -p ok` is accepted for fable / opus / sonnet / HAIKU, and `claude -p "/model
    // <alias>"` answers `Set model to \`Fable 5.1\` | \`Opus 5\` | \`Sonnet 5\` | \`Haiku 4.5\``
    // for the same four. `haiku` was missing here purely because `--help` did not happen to name
    // it in its example.
    //
    // `mythos` is deliberately ABSENT although the binary's own ANTHROPIC_TIER_NAMES lists it:
    // both front doors reject it on this version (`[claude-code:unrecognized_model] {"model":
    // "mythos"}` / `Model 'mythos' not found`). That regex is a "does this look Anthropic" test,
    // not the catalog — the catalog is what answers, so the catalog is what was asked.
    modelSuggestions: ['fable', 'opus', 'sonnet', 'haiku'],
    effortFlag: '--effort',
    // "Effort level for the current session (low, medium, high, xhigh, max)"
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // `-r, --resume [value]  Resume a conversation by session ID`
    resume: id => ['--resume', id],
    // `--session-id <uuid>  Use a specific session ID for the conversation (must be a valid UUID)`.
    // VERIFIED 2026-08-14 against claude 2.1.x: `claude --session-id <uuid> -p …` in `/tmp/sid-probe`
    // wrote `~/.claude/projects/-tmp-sid-probe/<uuid>.jsonl` — the same id the adapter reads back as
    // `SessionMeta.session_id`, which is the only thing that makes the record worth keeping.
    assignId: id => ['--session-id', id],
  },

  // `Usage: codex [OPTIONS] [PROMPT]` / `[PROMPT]  Optional user prompt to start the session`
  // No `--effort`: the reasoning effort is a `-c key=value` override whose key is not verifiable
  // from the CLI (`-c` accepts unknown keys silently), so it is absent rather than guessed.
  codex: {
    bin: 'codex',
    prompt: { kind: 'positional' },
    modelFlag: '--model', // `-m, --model <MODEL>`
    // EMPTY, checked 2026-09-02 against codex-cli 0.113.0: `--help` prints "Model the agent should
    // use" and no values, and no subcommand lists any (`codex --help` has no `models`; `debug` only
    // has `app-server`). The binary does carry a bundled catalog, and it is exactly the wrong thing
    // to copy: each row is gated by an `available_in_plans` array, and the account here answers
    // `{"detail":"The '…' model is not supported when using Codex with a ChatGPT account."}` — so a
    // list lifted from it would offer models this user cannot run. Nothing to name honestly.
    modelSuggestions: [],
    // A SUBCOMMAND, not a flag: `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`, whose argument is
    // documented as "Conversation/session id (UUID) or thread name".
    resume: id => ['resume', id],
  },

  // Kimi's only prompt flag is `-p, --prompt <prompt>  Run one prompt non-interactively and print
  // the response.` — that exits, leaving nothing to attach to. So the prompt is TYPED IN instead.
  kimi: {
    bin: 'kimi',
    prompt: { kind: 'send-keys' },
    modelFlag: '--model', // `-m, --model <model>`
    // EMPTY, and this one could not be otherwise. kimi 0.38.0's `--help` says "LLM model ALIAS to
    // use for this invocation. Defaults to default_model in config.toml" — the accepted values are
    // aliases the USER defined, in their own provider registry, so they are a property of the
    // machine and not of the CLI. `kimi provider list` prints them for whoever is asking (here:
    // one provider, `Default model: ollama-local/qwen2.5-3b-instruct`); there is no list to ship.
    modelSuggestions: [],
    // `-S, --session [id]  Resume a session. With ID: resume that session.`
    resume: id => ['-S', id],
  },

  // `-i, --prompt-interactive  Execute the provided prompt and continue in interactive mode`.
  // Preferred over the positional `query` (which also stays interactive) because it says so in its
  // own name — a positional that silently becomes headless on a future release is a trap, and this
  // flag cannot.
  gemini: {
    bin: 'gemini',
    prompt: { kind: 'flag', flag: '--prompt-interactive' },
    modelFlag: '--model', // `-m, --model  Model  [string]`
    // EMPTY as of 2026-09-02, checked against gemini 0.55.1. `--help` prints "Model  [string]" and
    // no values; the CLI has `--list-extensions` and `--list-sessions` but nothing that lists
    // models, and no `models` subcommand. The string is forwarded VERBATIM to the Google API, which
    // is the only thing that validates it — `gemini -m zzz-nope -p ok` fails with a 404
    // `ModelNotFoundError: models/zzz-nope is not found`, from the API and not from gemini.
    //
    // The three ids that used to sit here came from this machine's session store, and one of them
    // had already died: `gemini -m gemini-2.5-pro -p ok` answers "This model models/gemini-2.5-pro
    // is no longer available to new users." A list nothing local can check goes stale silently, so
    // there is none — the picker is absent instead of confidently wrong.
    modelSuggestions: [],
    // No effort flag exists, and no `resume`: gemini's `-r, --resume` takes "latest" or an index
    // number, never a session id. Offering it would be a verb that reopens the wrong conversation.
    //
    // And deliberately NO `assignId`, although `--session-id  Start a new session with a manually
    // provided UUID` exists: the id agentistics knows a gemini conversation by is SYNTHETIC —
    // `gemini.ts` builds `${dirName}/${fileBase}` from the chat file's path, because the files
    // carry no id of their own. A recorded UUID would therefore match no session in the store, and
    // an id that resolves to nothing is worse than no id at all: it looks like an exact link.
  },

  // `-p, --prompt <text>  Execute a prompt in non-interactive mode (exits after completion)` — the
  // same trap kimi has, so the prompt is TYPED IN instead of passed. There is no interactive prompt
  // flag to use in its place.
  copilot: {
    bin: 'copilot',
    prompt: { kind: 'send-keys' },
    modelFlag: '--model', // `--model <model>  Set the AI model to use (use 'auto' to let Copilot pick)`
    // `auto` and nothing else, and copilot 1.0.80 is the case that proves the rule. It is the one
    // value its own `--model` help NAMES, and running it works: `copilot --model auto -p … ` ran
    // the turn. Every other id was REFUSED on this account, instantly and locally, by the CLI's own
    // check — `claude-sonnet-4.6` and `gpt-5.3-codex` (both previously shipped here) and, tellingly,
    // `gpt-5.4`, the model copilot's OWN `--help` examples tell you to start with:
    //   Error: Model "gpt-5.4" from --model flag is not available.
    // So the real list is served by GitHub per ACCOUNT and is printed by no command (`copilot
    // --help` has no `models`; the completion script enumerates flags, not values; nothing under
    // ~/.copilot caches it). Its own documentation is not a safe source for it — only `auto` is.
    modelSuggestions: ['auto'],
    // `--session-id <id>  Resume an existing session or task by id` — used in preference to
    // `-r, --resume[=value]`, whose `[=value]` form requires the `=` and silently degrades to
    // "resume the most recent" when the id is passed as a separate argument.
    resume: id => ['--session-id', id],
    // The SAME flag: `--session-id <id>  Resume an existing session or task by ID, **or set the
    // UUID for a new session**`. VERIFIED 2026-08-14: `copilot --session-id <uuid> -p …` printed
    // back `Resume  copilot --resume=<that uuid>` and created
    // `~/.copilot/session-state/<uuid>/events.jsonl` — and that directory name IS the id the
    // adapter keys sessions by.
    assignId: id => ['--session-id', id],
  },

  // `--prompt-interactive  Run an initial prompt interactively and continue the session`, plus a
  // real closed effort enum — the only harness besides claude that documents one.
  antigravity: {
    bin: 'agy',
    prompt: { kind: 'flag', flag: '--prompt-interactive' },
    modelFlag: '--model', // `--model  Model for the current CLI session`
    // The only harness here with a real listing command: `agy models` ("List available models",
    // its own `--help`). Printed verbatim by agy 1.1.22 on 2026-09-02, in the order it gave them.
    //
    // The single `gemini-3.6-flash` that used to sit here was never a `--model` value at all — it
    // is the technical model id `antigravity-protobuf.ts` decodes out of field `1.19` of the
    // conversation DB, i.e. what agy REPORTS having run, which is the exact confusion the header
    // describes. agy names the effort in the model id (`-high|-medium|-low`) and ALSO takes the
    // `--effort` flag below; both are the CLI's own, so both stay. Measured: `agy --model
    // gemini-3.6-flash-high -p "say ok"` answers `ok`, while the bare `gemini-3.6-flash` never
    // reaches a turn.
    //
    // Caveat kept honest: `agy models` FETCHES ("Fetching available models…"), so this is a
    // snapshot of what one account was offered, not a constant. It is still the CLI's own answer,
    // which is the bar; the day it drifts, re-run the command rather than editing from memory.
    modelSuggestions: [
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
      'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
      'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
      'gemini-3.5-flash-high', 'gemini-3.5-flash-medium', 'gemini-3.5-flash-low',
      'gemini-3.1-pro-low', 'gemini-3.1-pro-high',
    ],
    effortFlag: '--effort',
    // `--effort  Reasoning effort for the current CLI session (low|medium|high)` — printed by the
    // CLI itself, so unlike codex's `-c` override this one IS verifiable and IS validated.
    efforts: ['low', 'medium', 'high'],
    resume: id => ['--conversation', id], // `--conversation  Resume a previous conversation by ID`
  },
}

/**
 * Can agentop ever know EXACTLY which conversation a fresh session of this harness is writing?
 *
 * Two ways exist and this is both of them: we told the CLI which id to use (`assignId`), or the
 * harness keeps a record of its own live sessions that can be matched back to our row
 * (`HARNESS_SESSION_SOURCES` — Claude's `~/.claude/sessions/<pid>.json`, which carries the tmux
 * session name we started it under).
 *
 * `false` is the answer for codex, kimi, gemini and antigravity, and it must be SAID rather than
 * papered over: everything downstream then falls back to `conversationForProcess`, which matches by
 * harness and directory and therefore gives every session of one repository the same conversation.
 * That guess is good enough to OFFER a reopen a person confirms by title, and not good enough to be
 * presented as the conversation this row is in. The same rule `HARNESS_CAPABILITIES` applies to a
 * metric, applied to a link.
 */
export function conversationLinkable(harness: HarnessId): boolean {
  return SPAWN_SPECS[harness]?.assignId !== undefined
    || HARNESS_SESSION_SOURCES[harness] !== null
}

/** Decide the exact argv (and any text to type in) for a requested session. */
export function planSpawn(req: SpawnRequest): SpawnPlanResult {
  const spec = SPAWN_SPECS[req.harness]
  if (!spec) return { ok: false, error: { code: 'unsupported-harness', harness: req.harness } }

  if (req.model && !spec.modelFlag) {
    return { ok: false, error: { code: 'model-unsupported', harness: req.harness } }
  }
  if (req.effort && (!spec.effortFlag || !spec.efforts)) {
    return { ok: false, error: { code: 'effort-unsupported', harness: req.harness } }
  }
  if (req.effort && spec.efforts && !spec.efforts.includes(req.effort)) {
    return {
      ok: false,
      error: { code: 'unknown-effort', harness: req.harness, value: req.effort, accepted: spec.efforts },
    }
  }

  if (req.resumeId && !spec.resume) {
    return { ok: false, error: { code: 'resume-unsupported', harness: req.harness } }
  }

  const argv: string[] = [spec.bin]
  // The resume argv goes FIRST because one of these is a subcommand (`codex resume <id>`), and a
  // subcommand that follows a flag is not a subcommand any more.
  if (req.resumeId && spec.resume) argv.push(...spec.resume(req.resumeId))
  // A FRESH session may be told which conversation id to write under, where the CLI accepts one.
  // Never alongside a resume: the conversation already exists and already has an id.
  const assigned = !req.resumeId && req.conversationId && spec.assignId ? req.conversationId : undefined
  if (assigned && spec.assignId) argv.push(...spec.assignId(assigned))
  if (req.model && spec.modelFlag) argv.push(spec.modelFlag, req.model)
  if (req.effort && spec.effortFlag) argv.push(spec.effortFlag, req.effort)

  // How the initial prompt will be DELIVERED once the session is up — see `initial-prompt.ts`. A
  // `positional` prompt is in argv but may not have been auto-submitted (`submit`); a `send-keys`
  // harness needs it typed (`type`); a `flag` harness runs it itself and needs no delivery.
  let initialPrompt: InitialPrompt | undefined
  if (req.prompt) {
    if (spec.prompt.kind === 'positional') {
      argv.push(req.prompt)
      initialPrompt = { mode: 'submit' }
    } else if (spec.prompt.kind === 'flag') {
      argv.push(spec.prompt.flag, req.prompt)
    } else {
      initialPrompt = { mode: 'type', text: req.prompt }
    }
  }

  // The conversation this spawn is KNOWN to drive: the one we asked to reopen, or the one we just
  // named. Absent for a fresh session on a CLI that will invent its own id and never report it —
  // and absent is what makes the UI say so instead of showing a guess.
  const conversationId = req.resumeId ?? assigned

  return {
    ok: true,
    plan: {
      argv,
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(conversationId ? { conversationId } : {}),
    },
  }
}
