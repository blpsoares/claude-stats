import { describe, expect, test } from 'bun:test'
import {
  toBsonDate,
  fromBsonDate,
  fromBsonDateOrNull,
  toBsonDates,
  fromBsonDates,
  convertFieldStage,
  convertArrayFieldStage,
  DATE_FIELDS,
} from './mongo-dates'

describe('toBsonDate', () => {
  test('parses an ISO string into a Date', () => {
    const d = toBsonDate('2026-07-28T12:34:56.000Z')
    expect(d).toBeInstanceOf(Date)
    expect(d!.toISOString()).toBe('2026-07-28T12:34:56.000Z')
  })

  test('preserves the instant of an offset-bearing ISO string', () => {
    expect(toBsonDate('2026-07-28T09:34:56-03:00')!.toISOString()).toBe('2026-07-28T12:34:56.000Z')
  })

  test('passes a Date through', () => {
    const src = new Date('2026-01-02T03:04:05.000Z')
    expect(toBsonDate(src)!.getTime()).toBe(src.getTime())
  })

  test('accepts epoch milliseconds', () => {
    expect(toBsonDate(1_700_000_000_000)!.getTime()).toBe(1_700_000_000_000)
  })

  test.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['junk', 'not a date'],
  ])('returns null for %s', (_label, input) => {
    expect(toBsonDate(input as string | null | undefined)).toBeNull()
  })

  test('returns null for an Invalid Date object', () => {
    expect(toBsonDate(new Date('nope'))).toBeNull()
  })
})

describe('fromBsonDate', () => {
  test('renders a stored Date as ISO', () => {
    expect(fromBsonDate(new Date('2026-07-28T12:00:00.000Z'))).toBe('2026-07-28T12:00:00.000Z')
  })

  test('normalizes a legacy string date (unmigrated doc) to the same ISO wire shape', () => {
    expect(fromBsonDate('2026-07-28T09:00:00-03:00')).toBe('2026-07-28T12:00:00.000Z')
  })

  test('collapses absent/invalid to an empty string', () => {
    expect(fromBsonDate(null)).toBe('')
    expect(fromBsonDate(undefined)).toBe('')
    expect(fromBsonDate('')).toBe('')
    expect(fromBsonDate('garbage')).toBe('')
  })

  test('round-trips a wire value unchanged', () => {
    const iso = '2026-03-04T05:06:07.008Z'
    expect(fromBsonDate(toBsonDate(iso))).toBe(iso)
  })
})

describe('fromBsonDateOrNull', () => {
  test('keeps null null — "never seen" is not "the epoch"', () => {
    expect(fromBsonDateOrNull(null)).toBeNull()
    expect(fromBsonDateOrNull(undefined)).toBeNull()
    expect(fromBsonDateOrNull('')).toBeNull()
  })

  test('renders a real date as ISO', () => {
    expect(fromBsonDateOrNull(new Date('2026-07-28T00:00:00.000Z'))).toBe('2026-07-28T00:00:00.000Z')
  })
})

describe('array helpers', () => {
  test('toBsonDates drops the values that are not timestamps', () => {
    const out = toBsonDates(['2026-01-01T00:00:00.000Z', '', 'junk', '2026-01-02T00:00:00.000Z'])
    expect(out).toHaveLength(2)
    expect(out[0]!.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  test('fromBsonDates renders stored dates back to ISO', () => {
    expect(fromBsonDates([new Date('2026-01-01T00:00:00.000Z'), null])).toEqual(['2026-01-01T00:00:00.000Z'])
  })

  test('both tolerate null/undefined', () => {
    expect(toBsonDates(null)).toEqual([])
    expect(fromBsonDates(undefined)).toEqual([])
  })

  test('round-trips a timestamp list', () => {
    const isos = ['2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z']
    expect(fromBsonDates(toBsonDates(isos))).toEqual(isos)
  })
})

describe('DATE_FIELDS', () => {
  test('covers every collection that stores a timestamp', () => {
    const names = DATE_FIELDS.map(s => s.collection)
    for (const c of ['sessions', 'workflows', 'tokens', 'accounts', 'teams', 'tags', 'repos', 'memberStats', 'config', 'audit', 'machineKeys', 'envelopes', 'tasks']) {
      expect(names).toContain(c)
    }
  })

  test('lists each collection exactly once', () => {
    const names = DATE_FIELDS.map(s => s.collection)
    expect(new Set(names).size).toBe(names.length)
  })

  test('memberStats declares ONLY updatedAt — the statsCache blob is deliberately excluded', () => {
    // Converting inside the blob would be undone by the next verbatim push, and would break the
    // string comparison `supplementStatsCache` does on lastComputedDate.
    const ms = DATE_FIELDS.find(s => s.collection === 'memberStats')!
    expect(ms.fields).toEqual(['updatedAt'])
    expect(ms.arrays ?? []).toEqual([])
  })

  test('the delivery board declares its three instants and not its scheduled DAYS', () => {
    // `dueDate`/`startDate` are `yyyy-MM-dd` — a day somebody scheduled, not an instant. Same
    // treatment `TagDoc.window` gets; converting them would turn a date into a midnight in some
    // timezone nobody chose.
    const tasks = DATE_FIELDS.find(s => s.collection === 'tasks')!
    expect(tasks.fields).toEqual(['createdAt', 'updatedAt', 'deliveredAt'])
    expect(tasks.fields).not.toContain('dueDate')
    expect(tasks.fields).not.toContain('startDate')
  })

  test('session timestamps are all declared', () => {
    const sessions = DATE_FIELDS.find(s => s.collection === 'sessions')!
    expect(sessions.fields).toContain('start_time')
    expect(sessions.fields).toContain('end_time')
    expect(sessions.arrays).toContain('user_message_timestamps')
  })
})

describe('convertFieldStage', () => {
  test('targets the named field only', () => {
    const stage = convertFieldStage('createdAt') as { $set: Record<string, unknown> }
    expect(Object.keys(stage.$set)).toEqual(['createdAt'])
  })

  test('preserves an unconvertible non-empty value instead of nulling it', () => {
    // The fallback branch must return the original field reference, never null: turning a real
    // but unrecognized timestamp into null would delete data to make the schema look tidy.
    expect(JSON.stringify(convertFieldStage('start_time'))).toContain('"$start_time"')
  })

  test('maps the empty-string placeholder to null', () => {
    const json = JSON.stringify(convertFieldStage('start_time'))
    expect(json).toContain('"$eq":["$start_time",""]')
  })

  test('converts to a date, tolerating errors and nulls', () => {
    const json = JSON.stringify(convertFieldStage('updatedAt'))
    expect(json).toContain('"to":"date"')
    expect(json).toContain('"onError":null')
    expect(json).toContain('"onNull":null')
  })
})

describe('convertArrayFieldStage', () => {
  test('maps element-wise and drops the failures', () => {
    const json = JSON.stringify(convertArrayFieldStage('user_message_timestamps'))
    expect(json).toContain('"$map"')
    expect(json).toContain('"$filter"')
    expect(json).toContain('"to":"date"')
  })

  test('leaves a non-array value untouched', () => {
    const json = JSON.stringify(convertArrayFieldStage('user_message_timestamps'))
    expect(json).toContain('"$isArray"')
  })
})
