import { test, expect } from 'bun:test'
import type { SessionMeta, StatsCache } from '@agentistics/core'
import { supplementStatsCache } from './data'

const empty = (): StatsCache => ({
  lastComputedDate: '2026-07-19',
  dailyActivity: [], dailyModelTokens: [], modelUsage: {},
} as unknown as StatsCache)

const sess = (o: Partial<SessionMeta>): SessionMeta => ({
  session_id: 's', project_path: '/p', start_time: '2026-09-05T10:00:00Z',
  model: 'claude-opus-5', harness: 'claude',
  user_message_count: 0, assistant_message_count: 0,
  input_tokens: 0, output_tokens: 0,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  ...o,
} as unknown as SessionMeta)

const tokensOn = (sc: StatsCache, day: string): number =>
  Object.values((sc.dailyModelTokens ?? []).find(d => d.date === day)?.tokensByModel ?? {})
    .reduce((a, b) => a + b, 0)

/**
 * THE BUG, in one session. A conversation opened on the 5th and still running on the 7th put every
 * token it ever spent on the 5th and nothing on the two days after it — so the day series was wrong
 * in both directions at once. Measured on a real machine: 2026-09-06 read 64 M against an actual
 * 1,83 B, and 2026-09-03 read 3,89 B against an actual 1,26 B.
 */
test('a session that ran for three days is counted on each of them, for what it spent there', () => {
  const sc = empty()
  supplementStatsCache(sc, [sess({
    start_time: '2026-09-05T10:00:00Z',
    user_message_count: 6, assistant_message_count: 6,
    // The lifetime counters, which is what the old rule filed on the start day.
    input_tokens: 60, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    daily: {
      '2026-09-05': { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 2 },
      '2026-09-06': { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 4 },
      '2026-09-07': { input_tokens: 30, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 6 },
    },
  } as Partial<SessionMeta>)])

  expect(tokensOn(sc, '2026-09-05')).toBe(10)
  expect(tokensOn(sc, '2026-09-06')).toBe(20)
  expect(tokensOn(sc, '2026-09-07')).toBe(30)
  // And the days still add up to the lifetime — nothing is lost or invented by spreading it.
  expect(tokensOn(sc, '2026-09-05') + tokensOn(sc, '2026-09-06') + tokensOn(sc, '2026-09-07')).toBe(60)
})

test('it is counted as ALIVE on every day it worked, not only on its first', () => {
  const sc = empty()
  supplementStatsCache(sc, [sess({
    user_message_count: 2, assistant_message_count: 2,
    daily: {
      '2026-09-05': { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 2 },
      '2026-09-06': { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 2 },
    },
  } as Partial<SessionMeta>)])
  const days = sc.dailyActivity ?? []
  expect(days.find(d => d.date === '2026-09-05')?.sessionCount).toBe(1)
  expect(days.find(d => d.date === '2026-09-06')?.sessionCount).toBe(1)
  expect(days.find(d => d.date === '2026-09-05')?.messageCount).toBe(2)
  expect(days.find(d => d.date === '2026-09-06')?.messageCount).toBe(2)
})

/** A day it merely existed through, with no turn on it, is not activity. */
test('a day with nothing on it draws no entry', () => {
  const sc = empty()
  supplementStatsCache(sc, [sess({
    user_message_count: 2, assistant_message_count: 0,
    daily: {
      '2026-09-05': { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 2 },
      '2026-09-06': { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 0 },
    },
  } as Partial<SessionMeta>)])
  expect((sc.dailyActivity ?? []).map(d => d.date)).toEqual(['2026-09-05'])
})

/**
 * A session with no per-day record cannot be split, and inventing a spread for it would be worse
 * than filing it where it began — the same fallback the date filter and the calendar keep.
 */
test('with no `daily` it keeps the start-day rule and its lifetime totals', () => {
  const sc = empty()
  supplementStatsCache(sc, [sess({
    start_time: '2026-09-05T10:00:00Z',
    user_message_count: 3, assistant_message_count: 4,
    input_tokens: 99,
  } as Partial<SessionMeta>)])
  expect(tokensOn(sc, '2026-09-05')).toBe(99)
  expect((sc.dailyActivity ?? []).find(d => d.date === '2026-09-05')?.messageCount).toBe(7)
})

/**
 * The watermark is per DAY and always was: Claude's own updater has rolled up everything up to
 * `lastComputedDate`, so counting those days again would double them. A session that STARTED
 * before it and worked after contributes only the days after.
 */
test('days at or before lastComputedDate are left to Claude Code, whatever day the session began', () => {
  const sc = empty()
  supplementStatsCache(sc, [sess({
    start_time: '2026-07-01T10:00:00Z',
    user_message_count: 4, assistant_message_count: 0,
    daily: {
      '2026-07-18': { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 2 },
      '2026-07-19': { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 2 },
      '2026-07-20': { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 2 },
    },
  } as Partial<SessionMeta>)])
  expect((sc.dailyActivity ?? []).map(d => d.date)).toEqual(['2026-07-20'])
  expect(tokensOn(sc, '2026-07-20')).toBe(5)
})

test('every one of the four counters is attributed per day, not just input', () => {
  const sc = empty()
  supplementStatsCache(sc, [sess({
    user_message_count: 2, assistant_message_count: 0,
    daily: {
      '2026-09-06': { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 400, cache_creation_input_tokens: 8, messages: 2 },
    },
  } as Partial<SessionMeta>)])
  // Cache read is 98% of the volume on real data — a sum that dropped it would be off by ~50x.
  expect(tokensOn(sc, '2026-09-06')).toBe(411)
})
