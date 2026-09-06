/**
 * subagent-join.ts — PURE: which transcript belongs to which invocation.
 *
 * The parent transcript and the `subagents/` directory answer two different questions, and until
 * now only the first was asked. The parent says how an agent was LAUNCHED and what it was asked to
 * do; the directory is the authoritative record of which agents actually EXISTED. An agent the
 * parent never names in the one shape the reader recognised — an `Agent` tool_use paired with the
 * `tool_result` that answers it — therefore became no row at all.
 *
 * Measured on one machine, 2026-09-06: 541 subagent transcripts, of which four top-level ones
 * (1,6 MB) were invisible or permanently unmeasured. Three shapes did it:
 *
 * - **The parent got a result with no `agentId`.** The user interrupted the call, so `toolUseResult`
 *   is the STRING `"Error: [Request interrupted by user for tool use]"`. The agent had already run
 *   and left a full transcript; the enrichment keyed only on `agentId` and skipped it. The link it
 *   needed is `agent-<id>.meta.json`'s own `toolUseId`.
 * - **The parent never got a result at all** — the plain background agent, launched and never
 *   resolved in the transcript.
 * - **The launch was not an `Agent` call.** A skill run in the background (`/code-review`) is a
 *   `Skill` tool_use whose result carries `{ status: 'forked', background: true, agentId }`. The
 *   parent names the agent; only the tool it came from is different.
 *
 * Two rules this module exists to keep:
 *
 * - **A NESTED transcript never becomes its own row.** It is already counted inside the invocation
 *   that spawned it (`descendantsOf` in `subagent-metrics.ts`), so pairing it again would report
 *   the same tokens twice. It is excluded from the candidate pool outright rather than by relying
 *   on no invocation happening to match it.
 * - **A top-level transcript nobody claims is REPORTED, never silently dropped.** Today those are
 *   conversation forks (5 transcripts, 11,4 MB on the same machine), which have no `tool_use`
 *   anywhere to key on and whose place in this product is a separate question — see issue #384. An
 *   absence a caller can see is a fact; one this module swallowed would be a fact nobody could find.
 */

import type { AgentInvocation } from '@agentistics/core'

/**
 * What `agent-<id>.meta.json` carries beside a subagent's transcript.
 *
 * Every field is optional: the file's shape has already changed once (`model` and `name` appear
 * only on the newer records) and a reader that requires a field is a reader that breaks on the next
 * change. `toolUseId` is the one that matters — it is the link back to the parent's own tool call
 * when the parent's result could not provide one.
 */
export interface AgentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
  parentAgentId?: string
  spawnDepth?: number
  isFork?: boolean
  name?: string
  model?: string
}

/** One transcript found in a `subagents/` directory. */
export interface AgentEntry {
  agentId: string
  meta: AgentMeta | null
}

export interface AgentJoinPlan {
  /** Every invocation in the parent's own order, with the transcript that measures it — or `null`. */
  reads: { invocation: AgentInvocation; agentId: string | null }[]
  /** Top-level transcripts no invocation claims. Reported so a caller can say so; see issue #384. */
  unclaimed: AgentEntry[]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * Read one `agent-<id>.meta.json`. Total: junk, a non-object and an empty file all yield `null`,
 * and a field of the wrong type is dropped rather than carried into the rest of the pipeline.
 */
export function parseAgentMeta(text: string): AgentMeta | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const meta: AgentMeta = {}
  const agentType = str(o.agentType); if (agentType) meta.agentType = agentType
  const description = str(o.description); if (description) meta.description = description
  const toolUseId = str(o.toolUseId); if (toolUseId) meta.toolUseId = toolUseId
  const parentAgentId = str(o.parentAgentId); if (parentAgentId) meta.parentAgentId = parentAgentId
  if (typeof o.spawnDepth === 'number' && Number.isFinite(o.spawnDepth)) meta.spawnDepth = o.spawnDepth
  if (typeof o.isFork === 'boolean') meta.isFork = o.isFork
  const name = str(o.name); if (name) meta.name = name
  const model = str(o.model); if (model) meta.model = model
  return meta
}

/**
 * Is this transcript an agent spawned by another agent?
 *
 * Such a transcript is counted INSIDE the invocation at the root of its subtree, per the rule
 * `agentNumbers` documents, so it must never also become a row of its own. A meta that could not be
 * read is NOT treated as nested: excluding a transcript on a guess loses a real agent, while a
 * missing exclusion is caught by the claim rules below.
 */
export function isNestedAgent(meta: AgentMeta | null): boolean {
  if (!meta) return false
  return meta.parentAgentId !== undefined || (meta.spawnDepth !== undefined && meta.spawnDepth > 1)
}

/**
 * Fill in what the parent could not say, from the transcript's own meta.
 *
 * Only ever fills a BLANK: what the parent recorded is what the assistant actually asked for, and
 * the meta is the harness's own restatement of it. A background forked skill is the case this
 * exists for — its launch is a `Skill` call, so the parent names no agent type and no description,
 * while the meta carries both.
 */
export function describedFrom(invocation: AgentInvocation, meta: AgentMeta | null): AgentInvocation {
  if (!meta) return invocation
  const needsType = !invocation.agentType || invocation.agentType === 'unknown'
  const needsDescription = !invocation.description
  const agentType = needsType ? meta.agentType : undefined
  const description = needsDescription ? meta.description : undefined
  if (!agentType && !description) return invocation
  return {
    ...invocation,
    ...(agentType ? { agentType } : {}),
    ...(description ? { description } : {}),
  }
}

/**
 * Pair each invocation with the transcript that measures it.
 *
 * Two passes, in this order and not the other: the `agentId` the parent recorded is an EXACT link,
 * while the meta's `toolUseId` is a link back that only exists because the exact one is missing. A
 * single pass would let a `toolUseId` match consume a transcript some other invocation names
 * outright. One transcript serves at most one invocation, and one invocation reads at most one
 * transcript — a second claim on either side reads `null` and stays unmeasured, which is the right
 * answer to "these two rows describe the same agent" and is not a shape this module may invent
 * around.
 */
export function planAgentJoin(
  invocations: readonly AgentInvocation[],
  entries: readonly AgentEntry[],
): AgentJoinPlan {
  const candidates = entries.filter(e => !isNestedAgent(e.meta))
  const byAgentId = new Map(candidates.map(e => [e.agentId, e]))
  // A `toolUseId` naming MORE THAN ONE transcript is ambiguous, and an ambiguous link pairs
  // nothing: half-read options get published as a measurement, which is worse than an absence the
  // surface renders as N/A. The exact `agentId` link above is unaffected.
  const byToolUseId = new Map<string, AgentEntry | null>()
  for (const e of candidates) {
    const t = e.meta?.toolUseId
    if (!t) continue
    byToolUseId.set(t, byToolUseId.has(t) ? null : e)
  }

  const claimed = new Set<string>()
  const paired = new Map<AgentInvocation, string>()

  for (const invocation of invocations) {
    const id = invocation.agentId
    if (!id) continue
    const entry = byAgentId.get(id)
    if (!entry || claimed.has(entry.agentId)) continue
    claimed.add(entry.agentId)
    paired.set(invocation, entry.agentId)
  }

  for (const invocation of invocations) {
    if (paired.has(invocation)) continue
    const entry = byToolUseId.get(invocation.toolUseId) ?? null
    if (!entry || claimed.has(entry.agentId)) continue
    claimed.add(entry.agentId)
    paired.set(invocation, entry.agentId)
  }

  return {
    reads: invocations.map(invocation => ({ invocation, agentId: paired.get(invocation) ?? null })),
    unclaimed: candidates.filter(e => !claimed.has(e.agentId)),
  }
}
