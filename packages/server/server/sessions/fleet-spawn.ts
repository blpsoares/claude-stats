/**
 * fleet-spawn.ts — PURE. What a START request arriving over HTTP is allowed to ask for.
 *
 * The cockpit's wizard cannot produce an invalid request: it only ever offers the harnesses
 * `startableHarnesses()` returned and the efforts that harness printed in its own `--help`. A
 * request off the wire has no such shape, so the checks the wizard performs by CONSTRUCTION have to
 * be performed here explicitly — and refused in a sentence, never repaired. A spawn is the most
 * powerful thing this server does: it starts a billable coding assistant, with a prompt, in a
 * directory, on this machine.
 *
 * Three rules, each of which exists because the alternative fails silently:
 *
 * - **The directory must be ABSOLUTE.** A relative path resolves against the SERVER's own working
 *   directory, which is wherever `agentop server` happened to be started — not anywhere the caller
 *   named. The session would start somewhere nobody chose and appear, correctly filed, under that
 *   project. Absolute is the only path a caller and this process provably read the same way.
 * - **The harness must be one this machine can START.** The caller passes the list
 *   `startableHarnesses()` produced, so a harness with no spawn spec is refused here for exactly
 *   the reason it is absent from the wizard: it would be offered and then fail.
 * - **An `effort` must be one the CLI itself prints.** `SpawnSpec.efforts` is a genuine closed enum
 *   read off the tool's `--help`; anything else is a usage error the assistant dies on, in a pane
 *   nobody is looking at. A `model`, by contrast, is NEVER validated — `claude --help` documents
 *   `--model` as an alias "or a model's full name", so a fixed list would reject valid input the day
 *   a model ships. It is only refused when the harness has no model flag AT ALL, which is a
 *   different fact: silently dropping it would start a session that is not the one asked for.
 *
 * `attach` is not a field of the request and never can be: attaching needs a real tty, and an HTTP
 * caller has none. A client that wants to enter the session asks for the attach ticket afterwards.
 */

/**
 * What this module needs to know about a harness — a structural subset of
 * `SessionHarnessOption`.
 *
 * Declared locally rather than imported so this leaf names nothing under `@agentistics/tui`, whose
 * entry point pulls in Ink and React. `index.ts` names these types to parse a request body, and the
 * fleet routes load their implementation by dynamic import precisely so a machine that never opens
 * the Sessions page never pays for that graph.
 */
export interface SpawnHarness {
  id: string
  /** False when the CLI has no model flag at all — a different fact from an empty suggestion list. */
  supportsModel: boolean
  /** The closed enum the CLI prints. Empty means the tool has no effort flag. */
  efforts: string[]
}

/** The request body, as it arrives: every field unknown until it has been read. */
export interface FleetSpawnBody {
  harness?: unknown
  cwd?: unknown
  task?: unknown
  prompt?: unknown
  model?: unknown
  effort?: unknown
  label?: unknown
}

/** An accepted request, in the shape `ControlHost.spawnSession` takes. */
export interface FleetSpawnPlan {
  harness: string
  cwd: string
  task?: string
  prompt?: string
  model?: string
  effort?: string
  label?: string
  /** Always false — see the header. */
  attach: false
}

/** Why a request was refused. The caller turns it into the user's own language. */
export type FleetSpawnRefusal =
  | 'unknown_harness'
  | 'cwd_missing'
  | 'cwd_relative'
  | 'unknown_effort'
  | 'model_unsupported'

export type FleetSpawnDecision =
  | { ok: true; plan: FleetSpawnPlan }
  /** `detail` is the offending value, so the sentence can name it. */
  | { ok: false; reason: FleetSpawnRefusal; detail?: string }

/**
 * A string field, read the way every other text field in this product is read: trimmed, and an
 * empty one treated as absent rather than as an empty value. A `label` of `''` would name a row
 * with nothing.
 */
function text(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  return t.length > 0 ? t : undefined
}

/**
 * POSIX-absolute, and deliberately not `path.isAbsolute`.
 *
 * The session backend is tmux and there is no Windows one (`sessions/index.ts` records why), so a
 * drive-letter path is not a path this machine can start a session in — accepting one because the
 * host process happens to run on Windows would accept a request nothing downstream can honour. A
 * NUL byte is refused outright: it truncates the path in every syscall that eventually receives it.
 */
function absolutePath(raw: string): boolean {
  return raw.startsWith('/') && !raw.includes('\0')
}

/**
 * Read one start request, or say why it cannot be honoured.
 *
 * Total: it never throws, whatever arrives, and it performs no I/O — whether the directory EXISTS
 * is not asked here, because that is a fact about the moment and belongs to the spawn itself (the
 * same distinction `repo-facts.ts` draws between a missing directory and a non-repository one).
 */
export function planFleetSpawn(
  body: FleetSpawnBody,
  harnesses: readonly SpawnHarness[],
): FleetSpawnDecision {
  const harness = text(body.harness)
  const spec = harnesses.find(h => h.id === harness)
  if (!harness || !spec) return { ok: false, reason: 'unknown_harness', ...(harness ? { detail: harness } : {}) }

  const cwd = text(body.cwd)
  if (!cwd) return { ok: false, reason: 'cwd_missing' }
  if (!absolutePath(cwd)) return { ok: false, reason: 'cwd_relative', detail: cwd }

  const effort = text(body.effort)
  if (effort && !spec.efforts.includes(effort)) {
    return { ok: false, reason: 'unknown_effort', detail: effort }
  }

  const model = text(body.model)
  if (model && !spec.supportsModel) {
    return { ok: false, reason: 'model_unsupported', detail: harness }
  }

  const task = text(body.task)
  const prompt = text(body.prompt)
  const label = text(body.label)

  return {
    ok: true,
    plan: {
      harness,
      cwd,
      ...(task ? { task } : {}),
      ...(prompt ? { prompt } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(label ? { label } : {}),
      attach: false,
    },
  }
}
