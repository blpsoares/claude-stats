import { test, expect } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { teamDocId, toTeamDoc, fromTeamDoc, parseIngestBody, stampCiSessions } from './team-store'

function session(id: string, harness: SessionMeta['harness'] = 'claude'): SessionMeta {
  return {
    session_id: id, project_path: '/p', start_time: '2026-06-01T00:00:00Z',
    duration_minutes: 0, user_message_count: 0, assistant_message_count: 0,
    tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
    git_commits: 0, git_pushes: 0, input_tokens: 0, output_tokens: 0,
    first_prompt: '', user_interruptions: 0, user_response_times: [],
    tool_errors: 0, tool_error_categories: {}, uses_task_agent: false,
    uses_mcp: false, uses_web_search: false, uses_web_fetch: false,
    lines_added: 0, lines_removed: 0, files_modified: 0, message_hours: [],
    user_message_timestamps: [], harness,
  }
}

test('teamDocId composes org:memberId:harness:sessionId', () => {
  // id is keyed by memberId (token hash), not by display name — rename-safe
  expect(teamDocId('acme', 'memberHash123', 'claude', 's1')).toBe('acme:memberHash123:claude:s1')
})

test('toTeamDoc tags user, sets org/memberId/_id, does not mutate input', () => {
  const s = session('s1')
  const doc = toTeamDoc(s, 'acme', 'memberHash123', 'devA')
  // _id is based on memberId, not on the display name
  expect(doc._id).toBe('acme:memberHash123:claude:s1')
  expect(doc.org).toBe('acme')
  expect(doc.memberId).toBe('memberHash123')
  expect(doc.user).toBe('devA')
  expect(doc.session_id).toBe('s1')
  expect(s.user).toBeUndefined() // original untouched
})

test('fromTeamDoc strips _id/org/memberId but keeps user → a plain SessionMeta', () => {
  const doc = toTeamDoc(session('s1'), 'acme', 'memberHash123', 'devA')
  const meta = fromTeamDoc(doc)
  expect((meta as unknown as Record<string, unknown>)._id).toBeUndefined()
  expect((meta as unknown as Record<string, unknown>).org).toBeUndefined()
  expect((meta as unknown as Record<string, unknown>).memberId).toBeUndefined()
  expect(meta.user).toBe('devA')
  expect(meta.session_id).toBe('s1')
})

test('round-trip toTeamDoc→fromTeamDoc preserves the session fields', () => {
  const s = session('s1')
  const meta = fromTeamDoc(toTeamDoc(s, 'acme', 'memberHash123', 'devA'))
  expect(meta.session_id).toBe(s.session_id)
  expect(meta.harness).toBe(s.harness)
  expect(meta.project_path).toBe(s.project_path)
})

test('toTeamDoc redacts a credential pasted into first_prompt (central-side defence)', () => {
  // The exact shape that leaked in production: a connection string as the opening message.
  const s = { ...session('s1'), first_prompt: 'MONGO_URL=mongodb+srv://appuser:s3cr3tP4ssw0rd@cluster.mongodb.net/db' }
  const doc = toTeamDoc(s, 'acme', 'm1', 'devA')
  expect(doc.first_prompt).not.toContain('s3cr3tP4ssw0rd')
  expect(doc.first_prompt).toContain('[REDACTED]')
  // The host survives, so the session is still recognisable in a list.
  expect(doc.first_prompt).toContain('cluster.mongodb.net')
  expect(s.first_prompt).toContain('s3cr3tP4ssw0rd') // input not mutated
})

test('toTeamDoc redacts the session title too', () => {
  // Assembled at runtime: a token-shaped literal in a committed file trips GitHub push protection.
  const tok = ['ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'].join('')
  const s = { ...session('s1'), title: `debug ${tok} failure` }
  expect(toTeamDoc(s, 'acme', 'm1', 'devA').title).not.toContain(tok)
})

test('toTeamDoc redacts the name and note the user typed themselves', () => {
  // These are free text a person typed, and they travel exactly like first_prompt. A field added to
  // SessionMeta without being added to redactSessionText is the one nobody thinks of.
  const tok = ['ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'].join('')
  const s = { ...session('s1'), user_label: `fix ${tok}`, user_note: `token is ${tok}` }
  const doc = toTeamDoc(s, 'acme', 'm1', 'devA')
  expect(doc.user_label).not.toContain(tok)
  expect(doc.user_note).not.toContain(tok)
})

test('toTeamDoc leaves an ordinary prompt exactly as it was', () => {
  const s = { ...session('s1'), first_prompt: 'reduce token usage, input_tokens=123' }
  expect(toTeamDoc(s, 'acme', 'm1', 'devA').first_prompt).toBe('reduce token usage, input_tokens=123')
})

// --- timestamps: BSON Dates in Mongo, ISO strings on the wire -------------------------------

test('toTeamDoc stores timestamps as BSON Dates, never as strings', () => {
  const s = session('s1')
  s.start_time = '2026-06-01T10:00:00.000Z'
  s.end_time = '2026-06-01T11:30:00.000Z'
  s.user_message_timestamps = ['2026-06-01T10:05:00.000Z', '2026-06-01T10:20:00.000Z']
  const doc = toTeamDoc(s, 'acme', 'm1', 'devA')
  expect(doc.start_time).toBeInstanceOf(Date)
  expect(doc.end_time).toBeInstanceOf(Date)
  expect(doc.start_time!.toISOString()).toBe('2026-06-01T10:00:00.000Z')
  expect(doc.user_message_timestamps).toHaveLength(2)
  for (const t of doc.user_message_timestamps) expect(t).toBeInstanceOf(Date)
})

test('an unknown start_time is stored as null, not as an empty string posing as a date', () => {
  const s = session('s1')
  s.start_time = '' // adapters report '' when the harness gave them no start time
  expect(toTeamDoc(s, 'acme', 'm1', 'devA').start_time).toBeNull()
})

test('a session with no end_time leaves the field ABSENT rather than writing null on every doc', () => {
  const doc = toTeamDoc(session('s1'), 'acme', 'm1', 'devA')
  expect('end_time' in doc).toBe(false)
})

test('round-trip preserves every timestamp exactly, back as ISO strings', () => {
  const s = session('s1')
  s.start_time = '2026-06-01T10:00:00.000Z'
  s.end_time = '2026-06-01T11:30:00.000Z'
  s.user_message_timestamps = ['2026-06-01T10:05:00.000Z']
  const meta = fromTeamDoc(toTeamDoc(s, 'acme', 'm1', 'devA'))
  expect(meta.start_time).toBe(s.start_time)
  expect(meta.end_time).toBe(s.end_time)
  expect(meta.user_message_timestamps).toEqual(s.user_message_timestamps)
})

test('fromTeamDoc reads a LEGACY doc whose dates are still strings', () => {
  // A doc written before the migration, or by an older central in a mixed-version fleet, must
  // read identically — otherwise the dashboard renders "Invalid Date" for that member.
  const legacy = { ...toTeamDoc(session('s1'), 'acme', 'm1', 'devA'), start_time: '2026-06-01T10:00:00.000Z' }
  expect(fromTeamDoc(legacy).start_time).toBe('2026-06-01T10:00:00.000Z')
})

test('fromTeamDoc survives a PROJECTED doc that omits the date fields', () => {
  // loadTagSessionsFromMongo projects a narrow field set; the omitted timestamps must not throw.
  const { start_time, end_time, user_message_timestamps, ...projected } =
    toTeamDoc(session('s1'), 'acme', 'm1', 'devA')
  void start_time; void end_time; void user_message_timestamps
  const meta = fromTeamDoc(projected)
  expect(meta.start_time).toBe('')
  expect(meta.user_message_timestamps).toEqual([])
})

test('parseIngestBody accepts a valid body', () => {
  const raw = { org: 'acme', user: 'devA', sessions: [session('s1')] }
  const r = parseIngestBody(raw)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.body.user).toBe('devA')
    expect(r.body.sessions).toHaveLength(1)
  }
})

test('parseIngestBody rejects a real push missing user', () => {
  const r = parseIngestBody({ org: 'acme', sessions: [session('s1')] })
  expect(r.ok).toBe(false)
})

test('parseIngestBody rejects a real push missing org', () => {
  const r = parseIngestBody({ user: 'devA', sessions: [session('s1')] })
  expect(r.ok).toBe(false)
})

test('parseIngestBody accepts an empty connectivity ping without identity', () => {
  // A body with no sessions stores nothing, so org/user are not required — this is the
  // connectivity check the member uses before saving.
  const r = parseIngestBody({ org: '', user: '', sessions: [] })
  expect(r.ok).toBe(true)
})

test('parseIngestBody rejects a non-array sessions field', () => {
  const r = parseIngestBody({ org: 'acme', user: 'devA', sessions: 'nope' })
  expect(r.ok).toBe(false)
})

test('parseIngestBody rejects a session without a session_id', () => {
  const r = parseIngestBody({ org: 'acme', user: 'devA', sessions: [{ harness: 'claude' }] })
  expect(r.ok).toBe(false)
})

test('stampCiSessions sets git_remote + ci without mutating input', () => {
  const s = session('s1')
  const [out] = stampCiSessions([s], 'github.com/org/repo', true)
  expect(out!.git_remote).toBe('github.com/org/repo')
  expect(out!.ci).toBe(true)
  // original untouched
  expect(s.git_remote).toBeUndefined()
  expect(s.ci).toBeUndefined()
})

test('stampCiSessions overrides whatever the runner reported', () => {
  const s = { ...session('s1'), git_remote: 'github.com/attacker/evil', ci: false }
  const [out] = stampCiSessions([s], 'github.com/org/repo', true)
  expect(out!.git_remote).toBe('github.com/org/repo')
  expect(out!.ci).toBe(true)
})

test('stampCiSessions with no repo and no ci is a passthrough (same ref)', () => {
  const arr = [session('s1')]
  expect(stampCiSessions(arr, undefined, false)).toBe(arr)
})

test('parseIngestBody carries the shared deliveries through', () => {
  // The bug this pins: the field type-checked on both sides while the parser never copied it, so
  // a shared board reached a live central as nothing at all. Caught by pushing to a real one.
  const r = parseIngestBody({
    org: 'acme', user: 'laptop', sessions: [{ session_id: 's1' }],
    tasks: [{
      task: { id: 't1', title: 'ship it', status: 'todo', createdAt: 'x', updatedAt: 'x' },
      comments: [], subtasks: [], files: [], sessionIds: ['s1'], sessionsWithheld: 0,
    }],
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.body.tasks).toHaveLength(1)
  expect(r.body.tasks![0]!.task.id).toBe('t1')
})

test('parseIngestBody refuses a delivery with no task id rather than storing a nameless one', () => {
  const r = parseIngestBody({
    org: 'acme', user: 'laptop', sessions: [{ session_id: 's1' }],
    tasks: [{ comments: [], subtasks: [], files: [], sessionIds: [], sessionsWithheld: 0 }],
  })
  expect(r.ok).toBe(false)
})

test('parseIngestBody leaves tasks absent when the body carries none', () => {
  const r = parseIngestBody({ org: 'acme', user: 'laptop', sessions: [{ session_id: 's1' }] })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.body.tasks).toBeUndefined()
})
