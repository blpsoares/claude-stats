import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, utimes, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { openParseCache } from './parse-cache'
import { cachedParseSession, cachedEnrich } from './parse-cache-jsonl'
import {
  parseSessionJsonl, activeMinutesFromClaudeJsonl, contextTokensFromClaudeJsonl,
  compactsFromClaudeJsonl, skillUsesFromClaudeJsonl,
} from './jsonl'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-parse-jsonl-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

/** A minimal but REAL Claude transcript: a user turn, an assistant turn with usage,
 *  and a tool call — enough that the parser produces non-trivial counters to compare. */
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', cwd: '/home/u/app', timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: 'hello there' } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T10:00:05.000Z', message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/home/u/app/a.ts' } }] } }),
  JSON.stringify({ type: 'user', cwd: '/home/u/app', timestamp: '2026-08-01T10:00:09.000Z', message: { role: 'user', content: 'thanks' } }),
].join('\n')

async function fixture(): Promise<{ dir: string; file: string }> {
  const dir = await tempDir()
  const file = join(dir, 'sess-1.jsonl')
  await writeFile(file, TRANSCRIPT)
  return { dir, file }
}

describe('cachedParseSession', () => {
  test('a hit reproduces the uncached parse exactly', async () => {
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))

    const direct = await parseSessionJsonl(file, 'sess-1', '/fallback', 'jsonl')
    const cold = await cachedParseSession(cache, file, 'sess-1', '/fallback', 'jsonl')
    const warm = await cachedParseSession(cache, file, 'sess-1', '/fallback', 'jsonl')

    expect(cold).toEqual(direct)
    expect(warm).toEqual(direct)
    // The whole point: byte-identical, not merely "close enough".
    expect(JSON.stringify(warm)).toBe(JSON.stringify(direct))
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, writes: 1 })
    cache.close()
  })

  test('a hit does not read the file', async () => {
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    await cachedParseSession(cache, file, 'sess-1', '/fallback', 'jsonl')

    // Overwrite the CONTENT with garbage of the same byte length, then restore the
    // original mtime exactly. The version key is (truncated mtimeMs, size), so the
    // stored row still matches this "new" version — a genuine hit answers from the
    // database alone and returns the real counters; a re-read would return garbage
    // (or crash the parser) instead.
    const before = await stat(file)
    await writeFile(file, 'x'.repeat(TRANSCRIPT.length))
    await utimes(file, before.atime, before.mtime)

    const warm = await cachedParseSession(cache, file, 'sess-1', '/fallback', 'jsonl')
    expect(warm.user_message_count).toBe(2)
    expect(warm.input_tokens).toBe(10)
    expect(cache.stats().hits).toBe(1)
    cache.close()
  })

  test('an appended transcript is reparsed, not served stale', async () => {
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const before = await cachedParseSession(cache, file, 'sess-1', '/fallback', 'jsonl')

    await writeFile(file, TRANSCRIPT + '\n' + JSON.stringify({
      type: 'user', cwd: '/home/u/app', timestamp: '2026-08-01T10:01:00.000Z',
      message: { role: 'user', content: 'one more' },
    }))
    const after = await cachedParseSession(cache, file, 'sess-1', '/fallback', 'jsonl')

    expect(after.user_message_count).toBe(before.user_message_count + 1)
    cache.close()
  })

  test('the caller returns to the live parser when the file cannot be stat-ed', async () => {
    // A vanished file has no version, so there is nothing to key on. The wrapper must
    // fall through to the parser (which answers with an empty session) rather than throw.
    const dir = await tempDir()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const s = await cachedParseSession(cache, join(dir, 'missing.jsonl'), 'nope', '/fallback', 'jsonl')
    expect(s.session_id).toBe('nope')
    expect(s.project_path).toBe('/fallback')
    expect(cache.rowCount()).toBe(0)
    cache.close()
  })

  test('two sources of one path do not share a row', async () => {
    // `source` changes the SessionMeta the parser produces, and Format A and Format B
    // can name the same transcript. It has to be part of the identity.
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const a = await cachedParseSession(cache, file, 'sess-1', '/fallback', 'jsonl')
    const b = await cachedParseSession(cache, file, 'sess-1', '/fallback', 'subdir')
    expect(a._source).toBe('jsonl')
    expect(b._source).toBe('subdir')
    cache.close()
  })

  test('a row written under an older session shape is never served', async () => {
    // This is the exact defect the SESSION_SHAPE bump exists to prevent: `compact_count` and
    // `skill_uses` were added to `parseSessionJsonl`'s output (and `compact_count`/`compact_ms`
    // moved from written-only-above-zero to written whenever the transcript was read) without a
    // stamp bump. A row cached under the OLD shape then went on being served forever — a closed
    // conversation's transcript never changes, so the entry never invalidates on its own — with
    // both fields silently absent, which `session-profile.ts` reads as "no transcript was read"
    // rather than "read, and it compacted/invoked nothing".
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const st = await stat(file)
    const stamp = { path: file, mtimeMs: st.mtimeMs, size: st.size }

    // Exactly what the shape before this fix produced: a valid SessionMeta (both fields are
    // optional) that simply never carries `compact_count`/`compact_ms`/`skill_uses`.
    const stale = await parseSessionJsonl(file, 'sess-1', '/fallback', 'jsonl')
    delete (stale as { compact_count?: number }).compact_count
    delete (stale as { compact_ms?: number }).compact_ms
    delete (stale as { skill_uses?: Record<string, number> }).skill_uses
    cache.set('session', stamp, stale, 'v4:jsonl')

    const fresh = await cachedParseSession(cache, file, 'sess-1', '/fallback', 'jsonl')
    // A hit under the retired 'v4:jsonl' variant would have returned `stale`, whose fields are
    // absent — proving the bump is what forces a recompute rather than the shape being irrelevant
    // to begin with (TRANSCRIPT carries neither a compaction nor a skill invocation, so a fresh
    // parse answers with real zeros, not with nothing).
    expect(fresh.compact_count).toBe(0)
    expect(fresh.compact_ms).toBe(0)
    expect(fresh.skill_uses).toEqual({})
    cache.close()
  })
})

describe('cachedEnrich', () => {
  test('derives the model from the transcript when the caller has none', async () => {
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const r = await cachedEnrich(cache, file, '')
    expect(r?.model).toBe('claude-opus-4-6')
    cache.close()
  })

  test('active minutes match the live computation', async () => {
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const r = await cachedEnrich(cache, file, '')
    expect(r?.activeMinutes).toBe(activeMinutesFromClaudeJsonl(TRANSCRIPT.split('\n')) ?? null)
    cache.close()
  })

  test('a hit reproduces the cold result exactly and reads no file', async () => {
    // A cache lookup still needs to `stat()` the file to build the FileStamp (exactly
    // like cachedParseSession) — a deleted file has no version to check freshness
    // against and correctly falls into the "missing" path tested below. What this test
    // proves is the "does not read no file CONTENT" half: overwrite the bytes with
    // garbage of the same length, then restore the original mtime exactly, so the
    // stored row still matches this "new" version. A genuine hit answers from the
    // database alone; a re-read would derive from the garbage content instead.
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const cold = await cachedEnrich(cache, file, '')

    const before = await stat(file)
    await writeFile(file, 'x'.repeat(TRANSCRIPT.length))
    await utimes(file, before.atime, before.mtime)

    const warm = await cachedEnrich(cache, file, '')
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold))
    cache.close()
  })

  test('the caller-supplied model is part of the identity', async () => {
    // extractAgentMetrics PRICES against the model id the caller passes. Two callers
    // with different ids must not read each other's row, or a session is costed with
    // another session's rate.
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    await cachedEnrich(cache, file, 'claude-opus-4-6')
    await cachedEnrich(cache, file, 'claude-haiku-4-5-20251001')
    expect(cache.rowCount()).toBe(2)
    cache.close()
  })

  test('a missing file yields null rather than an invented result', async () => {
    const dir = await tempDir()
    const cache = await openParseCache(join(dir, 'cache.db'))
    expect(await cachedEnrich(cache, join(dir, 'missing.jsonl'), '')).toBeNull()
    cache.close()
  })

  test('an empty file yields null', async () => {
    const dir = await tempDir()
    const file = join(dir, 'empty.jsonl')
    await writeFile(file, '')
    const cache = await openParseCache(join(dir, 'cache.db'))
    expect(await cachedEnrich(cache, file, '')).toBeNull()
    cache.close()
  })

  test('the context gauge matches the live computation', async () => {
    // context_tokens arrived on dev while this cache was being built, into the very
    // block cachedEnrich replaced. If it were not carried here it would read as blank
    // on every meta-backed session — which is most of them.
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const r = await cachedEnrich(cache, file, '')
    expect(r?.contextTokens).toBe(contextTokensFromClaudeJsonl(TRANSCRIPT.split('\n')) ?? null)
    expect(r?.contextTokens).toBeGreaterThan(0)
    cache.close()
  })

  test('fills compaction and skill fields for a meta-sourced session', async () => {
    // The bug this closes: `cachedEnrich` served `_source: 'meta'` sessions — MOST Claude
    // sessions — and never computed `compact`/`skillUses` at all, so the two metrics could only
    // ever be filled by `parseSessionJsonl` reading a session's own raw transcript directly. A
    // session that had already aged into `session-meta` was permanently blank on both.
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const r = await cachedEnrich(cache, file, '')
    // TRANSCRIPT has neither a compact_boundary nor a Skill tool_use — the real answer is zero,
    // not absence, matching `parseSessionJsonl`'s own rule that a read transcript answers `0`/`{}`.
    expect(r?.compact).toEqual(compactsFromClaudeJsonl(TRANSCRIPT.split('\n')))
    expect(r?.compact).toEqual({ count: 0, ms: 0 })
    expect(r?.skillUses).toEqual(skillUsesFromClaudeJsonl(TRANSCRIPT.split('\n')))
    expect(r?.skillUses).toEqual({})
    cache.close()
  })

  test('a row written under an older result shape is never served', async () => {
    // A stored row is a JSON blob of whatever EnrichResult looked like when it was
    // written. Without a shape marker in the variant, adding a field leaves every
    // existing row missing it while STILL HITTING — and a finished session's transcript
    // never changes again, so the new metric would read blank on it forever.
    const { dir, file } = await fixture()
    const cache = await openParseCache(join(dir, 'cache.db'))
    const st = await stat(file)
    const stamp = { path: file, mtimeMs: st.mtimeMs, size: st.size }

    // Exactly what an older build wrote: the variant was the bare model id, no shape.
    cache.set('enrich', stamp, { model: 'stale-model', activeMinutes: 999, agentMetrics: null }, '')

    const fresh = await cachedEnrich(cache, file, '')
    expect(fresh?.model).toBe('claude-opus-4-6')
    expect(fresh?.model).not.toBe('stale-model')
    expect(fresh?.contextTokens).toBeGreaterThan(0)
    cache.close()
  })
})
