/**
 * mongo-dates.ts — the single boundary between "date on the wire" and "date in Mongo".
 *
 * THE RULE: a timestamp is stored in Mongo as a BSON `Date`, never as a string.
 * A string date is opaque to the server — it cannot be range-queried, indexed usefully,
 * compared, or aggregated with `$dateTrunc`, and it silently sorts by lexicographic accident
 * rather than by time (which happens to work for UTC ISO 8601 and breaks the moment a value
 * carries an offset, a different precision, or an empty string).
 *
 * On the WIRE the contract stays an ISO 8601 string: JSON has no date type, every API consumer
 * (and the whole frontend, which does `parseISO(...)`) expects a string, and `SessionMeta` is a
 * shared type. So the conversion lives here and is applied ONLY where a document is written to
 * or read from Mongo — the doc types carry `Date`, the public/API types carry `string`.
 *
 * Reads tolerate BOTH shapes on purpose. `migrateStringDatesToBson()` fixes stored data at boot,
 * but a mixed-version fleet (an old central still writing strings, a doc inserted between the
 * migration and the deploy) must not blow up or render "Invalid Date" — so every reader goes
 * through `fromBsonDate`, which accepts a `Date`, a string, null or junk and always yields a
 * usable ISO string.
 *
 * Everything above `migrateStringDatesToBson` is PURE and unit-tested without a database.
 */

import type { Db } from 'mongodb'

// ---------------------------------------------------------------------------
// PURE conversion helpers
// ---------------------------------------------------------------------------

/** Anything a stored date field can legitimately hold, before or after the migration. */
export type StoredDate = Date | string | number | null | undefined

/**
 * Wire value (ISO string) → the value to STORE. Returns `null` for empty/absent/unparseable
 * input: a timestamp we cannot place on the calendar is not a date, and storing `''` as a
 * pseudo-date is exactly the disease being cured. Callers that must distinguish "no date" from
 * "bad date" should validate before calling.
 */
export function toBsonDate(value: StoredDate): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms)
}

/**
 * Stored value → the wire value (ISO string), with `''` for "no date".
 * Accepts a legacy string date unchanged in meaning (it is re-normalized to ISO so the wire
 * shape is identical whether or not the doc has been migrated yet).
 */
export function fromBsonDate(value: StoredDate): string {
  const d = toBsonDate(value)
  return d ? d.toISOString() : ''
}

/**
 * Stored value → the wire value, preserving `null` as `null` rather than collapsing to `''`.
 * Used by fields whose absence is meaningful to the UI (`lastSeenAt: null` renders "never",
 * `lastLoginAt: null` means the account has never signed in).
 */
export function fromBsonDateOrNull(value: StoredDate): string | null {
  const d = toBsonDate(value)
  return d ? d.toISOString() : null
}

/** Wire ISO strings → stored dates, dropping the ones that are not real timestamps. */
export function toBsonDates(values: readonly StoredDate[] | null | undefined): Date[] {
  if (!values) return []
  return values.map(toBsonDate).filter((d): d is Date => d !== null)
}

/** Stored dates → wire ISO strings, dropping the ones that are not real timestamps. */
export function fromBsonDates(values: readonly StoredDate[] | null | undefined): string[] {
  if (!values) return []
  return values.map(fromBsonDate).filter(s => s !== '')
}

// ---------------------------------------------------------------------------
// PURE migration spec
// ---------------------------------------------------------------------------

/** One collection's date fields. `arrays` hold ISO strings element-wise. */
export interface DateFieldSpec {
  collection: string
  /** Scalar date fields. */
  fields: readonly string[]
  /** Fields holding an ARRAY of dates. */
  arrays?: readonly string[]
}

/**
 * Every date field this server persists in Mongo, by collection.
 *
 * ADD A FIELD HERE the moment a document gains a timestamp — this list is what the boot
 * migration walks, so a field missing from it stays a string in the database forever while
 * the code that writes it looks perfectly correct.
 *
 * Deliberately NOT here:
 *   - `statsCache.dailyTokens` & friends — those are `YYYY-MM-DD` map KEYS, not values. A BSON
 *     key must be a string; they are date-shaped identifiers and stay as they are.
 *   - EVERYTHING ELSE INSIDE `memberStats.statsCache` — `lastComputedDate`, `firstSessionDate`,
 *     `longestSession.timestamp`. Three reasons, any one of which is enough. (a) The blob is a
 *     VERBATIM mirror of the member's own `~/.claude/stats-cache.json`, replaced wholesale by
 *     `replaceOne` on every push — a conversion here is overwritten with strings again within
 *     one push interval, so it would be permanent churn that never converges. (b)
 *     `lastComputedDate` is `YYYY-MM-DD`, a CALENDAR DATE, not an instant; forcing it to a BSON
 *     Date invents a timezone for something deliberately without one. (c) It is compared as a
 *     string against `format(day, 'yyyy-MM-dd')` keys by the `supplementStatsCache` guard — the
 *     one that stops revived old sessions from inflating totals. Converting it breaks that guard
 *     silently, and a wrong number is worse than an untidy type.
 *   - the local (non-Mongo) JSON stores — `tags-local-store.ts`, `preferences.ts`,
 *     `~/.agentistics/sessions/*.json`. Those ARE JSON files, where ISO strings are correct.
 */
export const DATE_FIELDS: readonly DateFieldSpec[] = [
  { collection: 'sessions', fields: ['start_time', 'end_time'], arrays: ['user_message_timestamps'] },
  { collection: 'workflows', fields: ['startedAt'] },
  { collection: 'tokens', fields: ['createdAt', 'lastSeenAt'] },
  { collection: 'accounts', fields: ['createdAt', 'updatedAt', 'lastLoginAt'] },
  { collection: 'teams', fields: ['createdAt'] },
  { collection: 'tags', fields: ['createdAt', 'updatedAt'] },
  { collection: 'repos', fields: ['createdAt'] },
  // `updatedAt` only — see the statsCache carve-out above.
  { collection: 'memberStats', fields: ['updatedAt'] },
  // The `audit` collection is written by a deployment outside this branch (nothing here creates
  // it), but its `at` field is a timestamp and lives in the same database, so the migration owns
  // it too. Any code that grows to READ it must go through fromBsonDate like everything else.
  { collection: 'audit', fields: ['at'] },
  // The `config` collection holds the bootstrap doc (createdAt/consumedAt); the `team` doc in
  // the same collection has no dates, and a field-scoped update simply never matches it.
  { collection: 'config', fields: ['createdAt', 'consumedAt'] },
  { collection: 'machineKeys', fields: ['updatedAt'] },
  { collection: 'envelopes', fields: ['createdAt'] },
  // Per-account UI preferences (accessibility). One timestamp, same rule as everything above.
  { collection: 'userPrefs', fields: ['updatedAt'] },
]

/**
 * The update expression for one scalar field: convert the string to a Date, and when the
 * conversion cannot succeed fall back deliberately —
 *   - `''` (a "no date" placeholder, e.g. an adapter that could not read a start time) → `null`
 *   - anything else unconvertible → LEFT AS THE ORIGINAL STRING.
 *
 * The second branch matters: silently turning an unrecognized-but-real timestamp into `null`
 * would destroy data to make a schema look tidy. Such a value stays a string, is counted in the
 * migration report, and can be inspected by a human. Pure — returns a plain object.
 */
export function convertFieldStage(field: string): Record<string, unknown> {
  const ref = `$${field}`
  return {
    $set: {
      [field]: {
        $let: {
          vars: { converted: { $convert: { input: ref, to: 'date', onError: null, onNull: null } } },
          in: {
            $ifNull: [
              '$$converted',
              { $cond: [{ $eq: [ref, ''] }, null, ref] },
            ],
          },
        },
      },
    },
  }
}

/** Same, element-wise over an array of ISO strings. Unconvertible elements are dropped. */
export function convertArrayFieldStage(field: string): Record<string, unknown> {
  const ref = `$${field}`
  return {
    $set: {
      [field]: {
        $cond: [
          { $isArray: ref },
          {
            $filter: {
              input: {
                $map: {
                  input: ref,
                  as: 'v',
                  in: { $convert: { input: '$$v', to: 'date', onError: null, onNull: null } },
                },
              },
              as: 'd',
              cond: { $ne: ['$$d', null] },
            },
          },
          ref,
        ],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// The migration (IO)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Completion marker
// ---------------------------------------------------------------------------

/** Bump when DATE_FIELDS gains a field, so an already-migrated deployment re-runs for the new one. */
export const DATE_MIGRATION_VERSION = 3

const MIGRATION_COLLECTION = 'config'
const MIGRATION_DOC_ID = 'migrations'

/**
 * Why a marker at all: the scan matches on `$type: 'string'`, which no index can serve — on a
 * central with a large `sessions` collection that is a full collection scan per field, on every
 * single boot, forever, to discover there is nothing to do. The marker makes the steady state one
 * tiny `findOne`. It records the VERSION, so adding a field to DATE_FIELDS re-arms the migration
 * instead of being silently skipped.
 */
async function migrationDone(db: Db): Promise<boolean> {
  try {
    const doc = await db.collection<{ _id: string; dateFieldsVersion?: number }>(MIGRATION_COLLECTION)
      .findOne({ _id: MIGRATION_DOC_ID })
    return (doc?.dateFieldsVersion ?? 0) >= DATE_MIGRATION_VERSION
  } catch {
    return false // can't tell → do the work; the pass is idempotent either way
  }
}

async function markMigrationDone(db: Db): Promise<void> {
  await db.collection(MIGRATION_COLLECTION).updateOne(
    { _id: MIGRATION_DOC_ID as never },
    { $set: { dateFieldsVersion: DATE_MIGRATION_VERSION, dateFieldsAt: new Date() } },
    { upsert: true },
  ).catch(() => { /* marker is an optimization; failing to write it only costs a re-scan */ })
}

export interface FieldMigrationResult {
  collection: string
  field: string
  /** Documents holding a string in this field before the run. */
  stringsBefore: number
  /** Documents modified by the run. */
  converted: number
  /** Still a string afterwards — an unconvertible value that was deliberately preserved. */
  unconvertible: number
}

/**
 * Convert every string date in Mongo to a BSON `Date`, in place.
 *
 * Idempotent and safe to run on every boot: the match stage only ever selects documents whose
 * field is still `$type: 'string'`, so a migrated database matches nothing and the whole pass
 * costs one indexed-free count per field. Never throws — a central must boot even when this
 * cannot run (unreachable DB, MongoDB < 4.2 with no pipeline-update support, read-only user).
 *
 * @param dryRun report what WOULD change without writing.
 * @param force  ignore the completion marker and scan anyway (the CLI's default — someone running
 *               the script by hand wants it to actually look, not trust a flag in the database).
 */
export async function migrateStringDatesToBson(
  db: Db,
  opts: { dryRun?: boolean; force?: boolean; log?: (msg: string) => void } = {},
): Promise<FieldMigrationResult[]> {
  const { dryRun = false, force = false, log } = opts
  const results: FieldMigrationResult[] = []

  if (!force && await migrationDone(db)) return results

  for (const spec of DATE_FIELDS) {
    const col = db.collection(spec.collection)

    for (const field of spec.fields) {
      const filter = { [field]: { $type: 'string' as const } }
      const stringsBefore = await col.countDocuments(filter).catch(() => 0)
      if (stringsBefore === 0) continue

      let converted = 0
      if (!dryRun) {
        const res = await col.updateMany(filter, [convertFieldStage(field)]).catch((e: unknown) => {
          log?.(`[mongo-dates] ${spec.collection}.${field} failed: ${e instanceof Error ? e.message : String(e)}`)
          return null
        })
        converted = res?.modifiedCount ?? 0
      }
      const unconvertible = dryRun ? 0 : await col.countDocuments(filter).catch(() => 0)
      results.push({ collection: spec.collection, field, stringsBefore, converted, unconvertible })
      log?.(`[mongo-dates] ${spec.collection}.${field}: ${stringsBefore} string(s)` +
        (dryRun ? ' (dry run)' : ` → ${converted} converted, ${unconvertible} left as string`))
    }

    for (const field of spec.arrays ?? []) {
      // An array of strings is matched by `$type: 'string'` on the field path (Mongo applies the
      // predicate element-wise), which is exactly what we want: any element still a string.
      const filter = { [field]: { $type: 'string' as const } }
      const stringsBefore = await col.countDocuments(filter).catch(() => 0)
      if (stringsBefore === 0) continue

      let converted = 0
      if (!dryRun) {
        const res = await col.updateMany(filter, [convertArrayFieldStage(field)]).catch((e: unknown) => {
          log?.(`[mongo-dates] ${spec.collection}.${field}[] failed: ${e instanceof Error ? e.message : String(e)}`)
          return null
        })
        converted = res?.modifiedCount ?? 0
      }
      const unconvertible = dryRun ? 0 : await col.countDocuments(filter).catch(() => 0)
      results.push({ collection: spec.collection, field, stringsBefore, converted, unconvertible })
      log?.(`[mongo-dates] ${spec.collection}.${field}[]: ${stringsBefore} doc(s) with string element(s)` +
        (dryRun ? ' (dry run)' : ` → ${converted} converted, ${unconvertible} left`))
    }
  }

  // Only a real (non-dry) pass may claim the database is clean.
  if (!dryRun) await markMigrationDone(db)

  return results
}
