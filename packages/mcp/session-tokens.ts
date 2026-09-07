import { calcCost, sessionCostUSD } from "@agentistics/core";

export type AnySession = Record<string, any>;

export function sessionHarness(s: AnySession): string {
  return (s.harness as string) ?? "claude";
}

/** Filter sessions to a single harness, or return all for undefined/'all'. */
export function filterSessions(sessions: AnySession[], harness?: string): AnySession[] {
  if (!harness || harness === "all") return sessions;
  return sessions.filter((s) => sessionHarness(s) === harness);
}

/**
 * Token + cost breakdown of one session.
 *
 * Cost is priced per model via `sessionCostUSD` (from `@agentistics/core`) — a session that used
 * more than one model (an Antigravity parent with its subagent children folded in carries a
 * `model_usage` breakdown) is charged each model at its own rate, never the whole session at the
 * dominant model's rate. A session with no model at all (`sessionCostUSD` returns null) falls
 * back to the blended default rate `calcCost` applies when given an empty model id.
 */
export function sessionTokens(s: AnySession) {
  const input = s.input_tokens ?? 0;
  const output = s.output_tokens ?? 0;
  const cacheRead = s.cache_read_input_tokens ?? 0;
  const cacheWrite = s.cache_creation_input_tokens ?? 0;
  const cost = sessionCostUSD({
    model: s.model,
    model_usage: s.model_usage,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  }) ?? calcCost({
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    webSearchRequests: 0,
    costUSD: 0,
  }, "");
  return { input, output, cacheRead, cacheWrite, cost };
}

export function sessionMessages(s: AnySession): number {
  return (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0);
}
