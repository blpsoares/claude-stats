# Metrics and Calculations

All cost and token calculations use a single source of truth: `packages/core/src/types.ts` (imported as `@agentistics/core`). No layer duplicates the pricing logic.

## What the word "tokens" means

**A token figure is always all four billed counters:** `input + output + cacheRead + cacheWrite`.
Counting lives in `packages/core/src/tokens.ts` — `sessionTokens` / `usageTokens` /
`sessionTokenTotal` / `usageTokenTotal` / `totalTokens` / `addTokens` / `sumTokens`. Never write the
sum by hand.

This is not a stylistic preference. Measured on one real machine across its 123 stored Claude
sessions:

```
input + output + cacheRead + cacheWrite   8,856,436,865
input + output                               30,247,005   ← 0.34% of it
```

A surface that summed two of the four was not slightly low, it was off by ~300×, and the cost beside
it (which had always priced the cache) disagreed by ~10×. It was found as a session-drawer bug and
turned out to be 19 call sites across the web app, the server and the exports.

Consequences that are easy to get wrong:

- **An aggregate type carries `tokens: TokenBreakdown`**, not just `inputTokens`/`outputTokens` —
  `HarnessSummary`, `RepoStat`, `TagAggregate`, `derived.tokenTotals`. The conversational pair is
  kept for surfaces that legitimately want it (an "Input" card, an "Output" card) and is **never**
  the thing labelled "tokens".
- **A rate per million is over the total**, not over the conversational pair. Computing cost/1M
  against the non-cached ~4% reports a figure tens of times higher than what is charged, and ranks
  harnesses by how much they cache.
- **`calcCost` gets the real cache counters.** For a session with no model, `blendedSessionCost`
  applies each of the four blended rates — pricing cache as fresh input is the opposite error.
- **A label may not ship without its explanation.** `TOKEN_KINDS` in `tokens.ts` carries a label
  and a one-sentence `help` per counter in EN/PT, and `totalTokensExplained()` is the sentence that
  goes under a headline figure. At these magnitudes an unexplained total reads as a fault.
- **`tokens.lint.test.ts` enforces it** — it greps core/server/web/tui for two-term sums and for
  `calcCost` arguments with the cache zeroed, and fails the build. Comments and per-field `+=` are
  exempt; a deliberate two-term reading needs `@tokens-intentional` **and a reason**.

## Date filters — what a session contributes to a day

A session is a **span** and its four counters are **lifetime** totals, so a date filter could only
ever file the whole of it somewhere. Both obvious answers are wrong, and neither is a rounding
error:

- **on the day it started** — "today" is nearly empty for anyone whose session has been open since
  Tuesday, which is the normal way this product is used;
- **on every day it touches** — measured at **86x** on a real machine: with `Today` selected, the
  repositories page reported **4.446.955.424 tokens** where Claude's own per-day accounting says
  **51.465.608**, from seven sessions that merely reached into today. That version shipped and was
  reverted.

**`SessionMeta.daily` is the third answer, and it is a measurement rather than a rule.** The parser
already walks every turn and every turn carries its own timestamp, so the split is real:
`Record<'YYYY-MM-DD', { input_tokens, output_tokens, cache_read_input_tokens,
cache_creation_input_tokens, messages }>`. `packages/web/src/lib/sessionDaySlice.ts` spends it —
`sliceSession` cuts a session down to the days in range, and every total downstream inherits the cut
instead of each of twenty call sites having to know.

Three rules hold it together:

- **A session without `daily` keeps the old rule.** The store is full of records written before the
  field existed and several adapters do not produce it. Falling back to the whole session for those
  would reintroduce the 86x on exactly the records nobody can check, so they stay filed on their
  start day. `sliceSession` returns `null` for them — never a zero, because a session that cannot be
  split is not a session that did nothing.
- **An unbounded range slices nothing.** `all` wants the lifetime totals, and cutting them against
  every day is arithmetic with no purpose.
- **A range too long to enumerate is asked from the other side.** `daysBetween` stops at
  `MAX_RANGE_DAYS` (400) rather than refusing, and `all` starts at the **epoch** — so its day set
  was `1970-01-01 … 1971-02-04`, and every session carrying `daily` was tested for membership in a
  window it could not possibly fall in and dropped: **397 of 662 sessions** on a real machine,
  silently, because the survivors were exactly the older records with no `daily`. Past the cap the
  question goes to the SESSION's own days (`activeInWindow`) — a handful of keys whatever the range.
  A set sitting exactly at the cap is treated as unusable rather than complete: nothing in it says
  which it is, and the window test is correct either way.

### `Today` is a preset of its own

The calendar's "today" means *up to and including today*; the **`Today` button beside `All`** means
**only today, in progress**. It ends at the end of the day rather than at this instant, so a session
whose only recorded activity is a few seconds ahead of the browser's clock is not excluded — every
other preset already ends there.

### The day rule is UTC

`start_time.slice(0, 10)`, matching `tagSessionDay`, `stats-cache.json`'s own day series and the
parser that wrote `daily`. **Two day rules exist in this repo** — the other is the local-clock
`format(parseISO(...))` used for the session-gap count — and mixing them drifts a session across a
boundary. At UTC-3 the two disagree for roughly 15% of sessions.

## Pricing table

All prices are in USD per **1 million tokens**:

| Model | Input | Output | Cache Read | Cache Write |
|-------|-------|--------|------------|-------------|
| Claude Opus 4.6 / 4.5 | $5.00 | $25.00 | $0.50 | $6.25 |
| Claude Opus 4.1 / 4.0 | $15.00 | $75.00 | $1.50 | $18.75 |
| Claude Sonnet 4.6 / 4.5 / 4.0 | $3.00 | $15.00 | $0.30 | $3.75 |
| Claude Haiku 4.5 | $1.00 | $5.00 | $0.10 | $1.25 |
| Claude Haiku 3.5 | $0.80 | $4.00 | $0.08 | $1.00 |
| Claude Haiku 3.0 | $0.25 | $1.25 | $0.03 | $0.30 |

> Prices are updated in `packages/core/src/types.ts → MODEL_PRICING`. If Anthropic changes pricing, update only that table — all layers pick it up automatically.

The `/api/rates` endpoint also fetches the current Anthropic pricing page and caches it. The dashboard shows a "pricing source" indicator when live prices differ from the local table.

## Cost formula

```
Total Cost = Σ per model [
  (inputTokens     / 1,000,000 × input_price)       +
  (outputTokens    / 1,000,000 × output_price)      +
  (cacheReadTokens / 1,000,000 × cache_read_price)  +
  (cacheWriteTokens/ 1,000,000 × cache_write_price)
]
```

Implemented in `calcCost(usage, modelId)` at `packages/core/src/types.ts`.

## Blended rate (per-session cost estimate)

Individual sessions may not store which model was used — that data is only available in aggregate via `stats-cache.json → modelUsage`. When a per-session cost estimate is needed (project filter active, or per-session cost column in PDF export), a weighted average rate is computed:

```
avg_input_rate  = Σ(model_input_tokens  × model_input_price)  / Σ input_tokens
avg_output_rate = Σ(model_output_tokens × model_output_price) / Σ output_tokens
(same for cache read and write)

Estimated Session Cost = session_input_tokens      × avg_input_rate
                       + session_output_tokens     × avg_output_rate
                       + session_cache_read_tokens  × avg_cache_read_rate
                       + session_cache_write_tokens × avg_cache_write_rate
```

Implemented **once**, in `blendedSessionCost` (`packages/web/src/hooks/useData.ts`). Two call sites
— the session drawer and the PDF's per-session column — each wrote their own version over `input`
and `output` only, which priced a session on the ~4% of its volume that is not cache.

## Token types

| Type | Description | Relative cost |
|------|-------------|---------------|
| **Input** | Context + prompt sent to the model | Base |
| **Output** | Tokens generated by the model | ~5× more expensive than input |
| **Cache Read** | Served from prompt cache | ~10× cheaper than input |
| **Cache Write** | Creating/updating the prompt cache | ~1.25× more expensive than input |

### Cache efficiency

Cache hit rate = `cacheRead / (input + cacheRead + cacheWrite)`

The denominator is everything the model READ, however it was served — cache writes included, since
a write is input that had to be read to be written. Output is not in it: output is produced, not
read, so including it would dilute the rate on an output-heavy session. See `readTokens()` in
`packages/core/src/tokens.ts`, which is the same function the panel uses.

Color coding: red < 30% · yellow 30–60% · green ≥ 60%

Net savings = gross saved − write overhead:
```
gross_saved   = cacheReadTokens × (input_price − cache_read_price)
write_overhead = cacheWriteTokens × (cache_write_price − input_price)
net_saved     = gross_saved − write_overhead
```

## Streak (consecutive active days)

The streak is calculated globally — date and project filters do not affect it.

```
streak = 0
for i = 0, 1, 2, ..., 365:
    date = today − i days
    if date has activity:
        streak++
    else if i > 0:   # today with no activity yet does NOT break the streak
        break
```

This means: if you haven't worked yet today, the streak still counts from yesterday. You are not penalized for opening the dashboard before your first commit of the day.

## Session duration

```
duration_minutes = (last_message_timestamp − first_message_timestamp) / 60
```

Minimum duration is 0 (single-turn sessions).

## Git commits and pushes

Detected by analyzing `Bash` tool inputs at JSONL parse time. Each command is split on `&&`, `||`, `;`, and newlines before matching:

```
/^(cd\s+\S+\s+&&\s+)?git\s+commit\b/  → gitCommits++
/^(cd\s+\S+\s+&&\s+)?git\s+push\b/    → gitPushes++
```

Lines changed and files modified are retrieved from git:

```bash
git -C <project_path> log --numstat --after="<start>" --before="<end>"
```

`files_modified` is the higher of git-tracked files and files Claude directly edited (Edit/Write/MultiEdit tool calls). See [data-sources.md](./data-sources.md#files_modified-counting) for details.

## Tool token attribution

Output tokens are attributed to tools using a fair-split algorithm:

```
For each assistant message with N tool_use blocks:
  tokens_per_tool = output_tokens ÷ N
  tool_output_tokens[tool_name] += tokens_per_tool
```

Tools consuming more than 40% of total output tokens are flagged as token "villains" in the Tool Metrics panel.

## BRL conversion

The Brazilian Real exchange rate is fetched from a public API by `/api/rates` and cached for 1 hour. If the fetch fails, a hardcoded fallback rate is used. The dashboard always shows the source and timestamp of the rate in the currency toggle tooltip.

## Cost basis — API estimate vs your plan

Every cost above is an **API-equivalent estimate**: tokens × the model's published rate. If you pay
a flat subscription, that figure is not your invoice. Register your billing timeline in
**Settings → Billing** and the dashboard can express the same metrics against what you actually
pay.

### The arithmetic

For a filter window and one harness:

```
C = Σ over the harness's registered periods:
      monthlyUSD(period) × overlapDays(period, window) / 30.44

A = the API-equivalent cost of the filtered sessions, restricted to the SAME days

V = A / C                              the value multiple
effective $/1M tokens = C / (tokens / 1e6)
```

`V = 8.5` means you extracted 8.5× the plan's price in API-equivalent value over that window.
`V = 1` is break-even.

### Why proration, and why by days

The plan price is monthly; a filter window is arbitrary. Counting whole calendar months is the
*invoice* reading — you did pay the full amount even if you used three days — but applied to a
7-day filter it reports a whole month's price against a fifth of a month's usage and calls the
plan a bad deal. Prorating by days (`30.44` = the average month) gives a *rate*, and a rate is
what makes one window comparable to another.

A period change inside the window is priced exactly: each period contributes its own price for
its own overlap. That is why the model is a timeline rather than a single "current plan".

### Days with no registered plan

A day no period covers has an A and no C. Including it inflates V; removing it from C alone
inflates V harder. So such days are removed from **both** sides, and the card states the coverage:
how many days were excluded and how much API value went with them.

Two related facts appear in the same place:

- **The measured window.** It can be narrower than your filter. Claude's daily token series does
  not reach the whole history, so an "all time" filter may resolve to the last N days. The number
  is correct for those days — the window is stated so the heading is not read as covering more.
- **Undated history.** Claude's cumulative totals include usage the daily series cannot attribute
  to a day. It is neither included nor excluded silently; it is reported as its own figure.

### Modes other than a subscription

- **API / pay-as-you-go** — those days' C *is* their A, so they contribute a multiple of exactly 1.
  Nothing is gained or lost, which is the truth.
- **Third party** (Bedrock, Vertex, a gateway) — the cost is off-machine and unknowable here, so
  those days count as uncovered.

### The monthly commitment

The budget panel does **not** convert. It forecasts variable spend from the pace so far, and a
subscription has no pace — it is a fixed number known on day one, so a converted forecast would
only ever predict itself.

Instead it gains a third figure beside the two variable ones: **Month commitment**, what your
registered plans owe for the current calendar month. That is a different question from the plan
cost of a filter window, and it is the one a monthly budget is actually set against. Days billed
per token commit nothing to it — their cost is usage — so they are reported as variable spend on
top rather than folded in. A plan that started or ended mid-month is prorated and labelled as
such, so an unexpected figure explains itself.

### What does not convert

- **Cache savings** stay in API pricing, always. Cache does not reduce a subscription bill — the
  plan costs the same either way. What it buys you is more work inside the same rate limit.
- **The Settings → Pricing table** stays in API pricing. It is a *rate* table, and a flat monthly
  fee has no per-token rate.
- **Per-model, per-repo and per-agent costs** in plan basis are **allocations**: the plan cost
  split in proportion to each row's API-equivalent share. Nobody is billed per model on a
  subscription. Within one harness the split is a linear rescale, so every ranking and proportion
  is preserved exactly; the labels say "allocated" so the figures are not read as observed.

### What the app cannot know

Prices in the plan catalog are a **prefill** carrying the date they were checked and the page they
came from; several plans ship with no amount because no vendor page states one. Whatever you type
wins. The app also cannot see your real API console spend, your overage, or which plan you were on
historically — that last one is why the timeline asks for dates.
