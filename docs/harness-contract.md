# Harness contract

Every harness Agentistics tracks must satisfy this contract. It is the **project-wide definition of
each metric** — not a per-adapter choice. Two adapters computing "duration" differently is not a
difference in the harnesses, it is a bug in one of them.

`CLAUDE.md` ("Adding a harness — the complete checklist") lists the *mechanical* steps: the
`HarnessId`, the capability record, the sort record, the adapter pair, live sessions, the frontend
labels, the docs. **This file defines what the numbers must MEAN.** Do both.

The governing principle, stated once:

> **Report what the harness recorded. When it recorded nothing, report nothing.**
>
> A confident wrong number is worse than a visible gap. `N/A` and `—` are correct answers. A
> plausible-looking default, an inferred threshold, or a fallback rate applied silently is not.

---

## 1. Time — `duration_minutes` vs `active_minutes`

Two fields, and they answer different questions. Both are required.

| Field | Meaning | Rule |
|---|---|---|
| `duration_minutes` | **Wall clock.** Last event − first event. | Always populated. |
| `active_minutes` | **Time actually worked.** Σ per-turn duration. | Populated whenever the transcript carries usable timing; `undefined` otherwise. |

### Why both

A session reopened across three weeks has a wall clock of ~500h. That is a true statement about
when the session was open and a useless statement about how long it was worked on. Ranking
"longest session" by it crowns whichever session merely stayed open the longest.

Active time alone would be equally misleading in the other direction — it hides that the work was
spread across weeks. **Every surface shows both**, active as the headline and elapsed as its
qualifier: `3h 12m ativo · 958h decorrido`.

### The rule — one implementation, `computeActiveTime()`

`packages/core/src/activeTime.ts`. **Adapters must not compute time themselves**; they emit
`TurnEvent[]` and call `activeMinutesOf()`. A turn runs from a human prompt until the harness stops
working on it.

1. **If the harness measured the turn itself, that number wins.** Set `measuredMs`.
2. **Otherwise reconstruct from event timestamps.** This is the same quantity, not an approximation
   of a different one — validated against Claude Code's own `turn_duration` over 1326 real turns:
   median difference **0.0s**, within 5s on 63%.
3. **If the harness writes an explicit end-of-turn** (abort, shutdown), set `turnEnd`. Without it an
   aborted turn stays open to the last line of the file — a real Copilot session aborted at 20:13
   whose file ends at 23:34 reported 3.4h of "active" work.
4. **If there is no usable timing at all, the result is `undefined`.** The UI shows `—`.

### What this deliberately does NOT do

It does not subtract "the user walked away mid-turn." A turn blocked on a permission prompt
overnight is measured as ~8h **by the harness itself**. Cutting it would need an arbitrary idle
cutoff — a made-up number inside the metric that exists to stop reporting made-up numbers.

The gap that IS excluded — harness finishes → human's next prompt — is excluded because it is a
real, observable boundary, not a threshold.

**Do not add an idle-gap heuristic.** If a future harness genuinely records user presence (an
explicit AFK / idle event), that is a measurement and may close a turn via `turnEnd`. An inferred
one may not.

### Where each harness's turn time comes from

| Harness | Source | Measured? |
|---|---|---|
| claude | `{"type":"system","subtype":"turn_duration","durationMs":N}` | yes, when present; timestamps otherwise |
| codex | `task_complete.duration_ms` | yes |
| copilot | `assistant.turn_start` → `assistant.turn_end`; `abort` / `session.shutdown` close an open turn | yes (bracket) |
| gemini | message timestamps | reconstructed |
| antigravity | step `created_at` timestamps | reconstructed |
| kimi | wire `time` field; subagent wires merged and **sorted** before use | reconstructed |

**Sub-agents never add time.** A subagent runs *inside* the parent turn that dispatched it — its
span is already inside the parent's. Antigravity's `mergeAntigravityChild` keeps the parent's
`active_minutes`; Kimi sorts every agent's events into one chronological stream. Summing them
double-counts the same wall clock.

---

## 2. Cost and pricing

Covered in depth in `CLAUDE.md` (§ "Pricing — three layered sources"). The contract:

- **Report the bare model id.** Strip any `provider/` prefix (`kimi-parse.ts` does this). The
  shared table prices it; you almost never add pricing code.
- **Cost is `calcCost()`, never an inline calculation.** One implementation, `@agentistics/core`.
- **Never guess a rate.** A wrong price is invisible; a missing one is visible — Settings → Pricing
  lists any model this machine used that no source can price. Add a rate only with a **verified,
  dated source comment**.
- A harness that routes to other vendors (Kimi, Antigravity) reports **that vendor's** model.
  A provider is a billing entity; a harness is not.

## 3. Tokens

- Find the **one** place the harness records usage and count only that. Both Kimi and Codex
  publish the same usage twice in different envelopes — summing both doubles every figure.
- Know whether records are **cumulative** (Codex: last one wins) or **per-turn increments**
  (Kimi: sum). Getting this backwards is silent.
- Split cached from fresh input. Codex's `input_tokens` **includes** the cached portion; store
  `total − cached` in `input_tokens` and the cached part in `cache_read_input_tokens`.
- No cache-write counter → leave `cache_creation_input_tokens` at 0, and say so in the capability
  comment.

### 3a. Context size is a GAUGE, and it is not the token total

`SessionMeta.context_tokens` answers "how full was the window on the last turn", which is a
**level**, not a quantity — it is reassigned per turn, never accumulated. The distinction is the
whole reason it is a separate field: on a real session measured here the cumulative input was
44.3M against a context of 455k, so a gauge derived from the totals would have reported ~4400% of
the window. Rules:

- **A cumulative counter can never answer this.** Codex's `total_token_usage` and Kimi's summed
  `usage.record`s are session totals; the per-turn `last_token_usage` / individual `usage.record`
  are what qualify. If the harness reports only running totals, `contextWindow: false` — even
  though `tokens: true`.
- **Count the INPUT side only.** The prompt that was sent is fresh input + cache read + cache
  write; output is what came back and is not in the window when the turn is issued.
- **A subagent's window is not the session's.** Where a harness folds child agents into one
  session (Kimi), the gauge comes from the main agent only, chosen by timestamp so it does not
  depend on the order the files were read.
- **A harness that states its own window wins.** Codex writes `model_context_window` per session
  and Antigravity states it too (protobuf field `1.9.10.4`); store it in
  `SessionMeta.context_window` and it outranks any table lookup, because it knows the deployment
  and any per-session cap that a model id cannot express. Measured on one machine, agy ran
  `gemini-3.6-flash` under a 128.000 window on some conversations and 256.000 on others — one model
  id, two windows, which no table could have told apart. It is also the escape hatch for a vendor
  that publishes no citable limit: agy draws a bar with no `CONTEXT_WINDOWS` row at all.
- **Otherwise the window comes from `resolveContextWindow`** (`packages/core/src/contextWindows.ts`),
  which holds only models with a dated source — the `MODEL_PRICING` provenance rule applied to a
  different number. A model that is not in it draws no bar at all: an absent gauge is visible, a
  wrong percentage is not.

## 4. Capabilities — `N/A` vs a real `0`

`HARNESS_CAPABILITIES` (`packages/core/src/types.ts`) is a `Record<HarnessId, …>`, so the build
fails until a new harness declares every flag. **Be honest.** A flag set `true` for something the
harness cannot produce renders a confident `0`, which is exactly the failure this mechanism exists
to prevent. `activeTime: false` means the UI shows only wall-clock elapsed.

Three flags are narrower than their neighbours and are worth reading before you fill them in:

- **`compaction`** — the harness records when it compacted the conversation, so
  `SessionMeta.compact_count` (and `compact_ms` / `compact_dropped_tokens`) can be filled. Claude
  Code writes a `compact_boundary` system line carrying a `compactMetadata` block. If your harness
  has no equivalent marker the figures are **absent**, never zero: a session that compacted and one
  whose harness cannot say are different facts.
- **`skills`** — the harness records SKILL invocations BY NAME, so `SessionMeta.skill_uses` can be
  filled. Claude's is a `Skill` tool_use whose `input.skill` names it. An empty map is a real answer
  ("this session invoked none") only where the concept exists at all.
- **`mcpServers`** — the harness names an MCP tool `mcp__<server>__<tool>`, so the SERVER can be
  read back off `tool_counts`. **This is narrower than `tools`**, which is `true` for every harness:
  recording the tool is not the same as recording whose server it was. Antigravity records `mcp_`
  with one underscore and `call_mcp_tool`, Copilot keeps MCP names in its own `mcp_tool_names` and
  never a server, codex and gemini record no MCP tool at all. Only claude and kimi qualify.

**A capability gates a DENOMINATOR as well as a rendering.** `packages/core/src/session-profile.ts`
computes the machine's 30-day baseline and its per-metric `n` counts the sessions that COULD have
answered — so a metric whose reader returns a number regardless (a `.length` over a filtered map,
say) drags every incapable harness into the sample and reports `0 (n=479)` for a question most of
that population was never asked. Where the metric is only fillable from a transcript, the second
half of the same rule applies: write the real `0`, so "answered none" stays distinguishable from
"was never read".

## 5. Filters and aggregation

- **`stats-cache.json` is Claude-only.** Never aggregate another harness from it. Non-Claude
  totals come from per-session sums, everywhere — dashboard, Compare page, team central.
- **Never hardcode a harness list.** `HARNESS_ORDER` derives from a `Record`, because TypeScript
  accepts an array literal with a member missing — that silently dropped a harness from the Compare
  page, the filter bar, the data-source list and the consolidate store while the build stayed green.
- **A filter must not silently fall back to a fraction of its own scope.** A member's deep history
  exists only in the stats caches; `resolveMachineCacheScope()` returns `null` — "fall back to the
  per-session sum" — only when the caches cannot serve the scope *exactly*.
- Every session-level field you add must survive the whole pipeline: parser → consolidate store →
  team uploader → Mongo → `loadSessionMetas`. `loadSessionMetas` builds `SessionMeta` **field by
  field**; a field not listed there is dropped on the way back in, silently.

## 6. Timestamps

Bucket activity hours on the **local** clock (`getHours()`), like every existing adapter. Reading a
UTC timestamp as local put the peak-usage chart off by hours for four harnesses at once.

## 7. Purity and failure

- Split each adapter in two: `<id>.ts` does I/O, `<id>-parse.ts` is **pure** and takes strings.
  Only the pure half is unit-testable, and only it is easy to reason about.
- **A malformed, locked or missing input yields empty data, never a throw.** One corrupt file must
  not take down the whole scan. Antigravity's protobuf reader returns `null` on junk; a locked
  SQLite DB degrades to zero tokens.
- Drop bootstrap/stub sessions with no genuine content (Gemini writes many). A harness appears in
  the selector only when it contributes a real session.

## 8. Verification before claiming it works

Run the parser over **real files on disk** and eyeball the output — every rule above was written
after real data disproved something that looked right in code:

```bash
bun test                    # pure-function unit tests
bun tsc --noEmit
```

Then compare against the harness's own numbers where it publishes any. For active time, the check
that matters is: *does the reconstruction agree with the harness's own measurement where both
exist?* If a future harness publishes durations, run that comparison before trusting the
reconstruction for the turns where it doesn't.

### Reading an undocumented binary format

Antigravity's token counts live in a protobuf blob with no schema published anywhere, and the first
reader of it got **every counter but output pointing at the wrong field**. It reported 52,6 mi
tokens where the provider billed ~250 mi, and R$111 against R$703 — 4,8x and 6,3x low. Nothing
inside the product looked wrong: the numbers were the right order of magnitude, they moved with
usage, and the per-model split was self-consistent. Two checks would have caught it, and both are
now required before a decoded field is trusted:

- **Check that the value VARIES the way the thing it claims to count varies.** The field being read
  as `input_tokens` was the constant 1072 on all 2.966 rows (`min === max`). A per-call counter
  cannot be constant — that alone disqualified it, with no external source needed.
- **Reconcile the total against a bill.** Where the vendor exposes a usage console, sum the whole
  local store and compare — per model and per day, not just the headline. The correct mapping came
  out within a few percent on input, cache, output *and* the 78,5 % cache share simultaneously;
  every wrong candidate broke at least one of those. A single aggregate can be matched by luck, a
  four-way agreement cannot.

Record the reconciliation in the reader's own header, with the figures and the date. The next
person to touch those field numbers needs to see what pinned them, not just what they are.
