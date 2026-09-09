import { describe, expect, it } from 'bun:test'
import { cachedBaseline, resetBaselineCache, BASELINE_TTL_MS } from './fleet-baseline'
import type { SessionMeta } from '@agentistics/core'

const NOW = Date.parse('2026-09-08T12:00:00Z')

const one = (): SessionMeta[] => ([{
  session_id: 's1', project_path: '/p', start_time: '2026-09-07T00:00:00Z',
  duration_minutes: 0, user_message_count: 7, assistant_message_count: 0,
  tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
  git_commits: 0, git_pushes: 0, input_tokens: 0, output_tokens: 0, first_prompt: '',
  user_interruptions: 0, user_response_times: [], tool_errors: 0, tool_error_categories: {},
  uses_task_agent: false, uses_mcp: false, uses_web_search: false, uses_web_fetch: false,
  lines_added: 0, lines_removed: 0, files_modified: 0, message_hours: [],
  user_message_timestamps: [], harness: 'claude',
}])

describe('cachedBaseline', () => {
  it('loads once and serves the cached answer inside the TTL', async () => {
    resetBaselineCache()
    let loads = 0
    const load = async () => { loads++; return one() }
    const a = await cachedBaseline(load, NOW)
    const b = await cachedBaseline(load, NOW + BASELINE_TTL_MS - 1)
    expect(loads).toBe(1)
    expect(a.metrics.messages.median).toBe(7)
    expect(b).toEqual(a)
  })

  it('reloads once the TTL has passed', async () => {
    resetBaselineCache()
    let loads = 0
    const load = async () => { loads++; return one() }
    await cachedBaseline(load, NOW)
    await cachedBaseline(load, NOW + BASELINE_TTL_MS + 1)
    expect(loads).toBe(2)
  })

  it('shares one in-flight load across overlapping calls', async () => {
    // `/api/fleet` is polled every five seconds by the dashboard, the cockpit and the VS Code
    // extension — two callers landing on the same expired TTL must share the one scan already
    // running rather than each starting their own directory walk.
    resetBaselineCache()
    let loads = 0
    let resolveLoad!: (sessions: SessionMeta[]) => void
    const load = () => {
      loads++
      return new Promise<SessionMeta[]>(resolve => { resolveLoad = resolve })
    }

    const first = cachedBaseline(load, NOW)
    const second = cachedBaseline(load, NOW)
    resolveLoad(one())
    const [a, b] = await Promise.all([first, second])

    expect(loads).toBe(1)
    expect(b).toEqual(a)
  })

  it('keeps the previous answer when a reload throws', async () => {
    // A failed store read must not blank a profile that was correct a minute ago — the same rule
    // `sessions-host.ts` applies to a failed poll.
    resetBaselineCache()
    let loads = 0
    const load = async () => {
      loads++
      if (loads === 2) throw new Error('store unreadable')
      return one()
    }
    const first = await cachedBaseline(load, NOW)
    const second = await cachedBaseline(load, NOW + BASELINE_TTL_MS + 1)
    expect(second).toEqual(first)
  })
})
