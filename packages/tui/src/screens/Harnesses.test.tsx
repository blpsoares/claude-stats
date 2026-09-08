import React from 'react'
import { describe, test, expect } from 'bun:test'
import { render } from 'ink-testing-library'
import type { AppData, SessionMeta } from '@agentistics/core'
import { emptyStatsCache } from '@agentistics/core'
import { Harnesses } from './Harnesses'
import { strings } from '../i18n'

const s = strings('en')

function session(over: Partial<SessionMeta> & { session_id: string }): SessionMeta {
  return {
    project_path: '/p', start_time: '2026-07-20T10:00:00Z', duration_minutes: 1,
    user_message_count: 1, assistant_message_count: 1, tool_counts: {}, tool_output_tokens: {},
    agent_file_reads: {}, languages: [], git_commits: 0, git_pushes: 0,
    input_tokens: 0, output_tokens: 0, first_prompt: '', user_interruptions: 0,
    user_response_times: [], tool_errors: 0, tool_error_categories: {}, uses_task_agent: false,
    uses_mcp: false, uses_web_search: false, uses_web_fetch: false, lines_added: 0,
    lines_removed: 0, files_modified: 0, message_hours: [], user_message_timestamps: [],
    ...over,
  } as SessionMeta
}

function data(over: Partial<AppData> = {}): AppData {
  return {
    statsCache: emptyStatsCache(), sessions: [], projects: [], allSessions: [],
    harnesses: ['claude'], ...over,
  } as AppData
}

/** Strip ANSI so assertions read against the visible text. */
function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\[[0-9;]*m/g, '')
}

describe('Harnesses screen', () => {
  test('renders N/A for the agent count of a harness that cannot report agents', () => {
    const { lastFrame } = render(
      <Harnesses
        data={data({
          sessions: [session({ session_id: 'c', harness: 'codex', model: 'gpt-5', input_tokens: 10 })],
          harnesses: ['codex'],
        })}
        s={s}
        width={100}
        height={20}
      />,
    )

    const out = plain(lastFrame())
    expect(out).toContain('Codex')
    expect(out).toContain('N/A')
  })

  test('renders a real agent count for Claude instead of N/A', () => {
    const { lastFrame } = render(
      <Harnesses
        data={data({
          statsCache: { ...emptyStatsCache(), totalSessions: 3, totalMessages: 10 },
          sessions: [session({
            session_id: 'a', harness: 'claude',
            agentMetrics: { invocations: [], totalInvocations: 7, totalTokens: 0, totalDurationMs: 0, totalCostUSD: 0 , unmeasuredInvocations: 0},
          })],
          harnesses: ['claude'],
        })}
        s={s}
        width={100}
        height={20}
      />,
    )

    const out = plain(lastFrame())
    expect(out).toContain('Claude')
    expect(out).toContain('7')
    expect(out).not.toContain('N/A')
  })

  test('shows an empty state rather than a bare table when nothing is tracked', () => {
    const { lastFrame } = render(<Harnesses data={data({ harnesses: [] })} s={s} width={100} height={20} />)
    expect(plain(lastFrame())).toContain(s.empty)
  })
})
