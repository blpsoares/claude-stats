import { beforeEach, describe, expect, test } from 'bun:test'
import type { AppNotification } from './notifications'

/**
 * The client store is a CACHE over /api/notifications — the server owns the history. These tests
 * stub `fetch` to assert the wire contract and the optimistic updates. No localStorage is involved
 * BY DESIGN: a per-browser store shows an empty bell when the same user opens the dashboard on
 * their phone, which is the bug this store exists to avoid.
 *
 * The module is re-imported per test (cache-busting query) so its module-level cache starts clean.
 */
interface Call { url: string; method: string; body?: unknown }

let calls: Call[] = []
let respond: (c: Call) => unknown = () => []

function stubFetch() {
  calls = []
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    return { ok: true, json: async () => respond(call) } as unknown as Response
  }
}

let bust = 0
async function freshStore() {
  bust += 1
  return await import(`./notifications?t=${bust}`) as typeof import('./notifications')
}

const note = (id: string, over: Partial<AppNotification> = {}): AppNotification => ({
  id, type: 'info', code: `code-${id}`, ts: 1000, read: false, ...over,
})

beforeEach(() => { stubFetch(); respond = () => [] })

describe('loading from the server', () => {
  test('refresh pulls the history and fills the cache', async () => {
    respond = () => [note('a'), note('b')]
    const s = await freshStore()
    await s.refreshNotifications()
    expect(s.readNotifications().map(n => n.id)).toEqual(['a', 'b'])
    expect(calls[0]).toMatchObject({ url: '/api/notifications', method: 'GET' })
  })

  test('the same history reaches any device — nothing is browser-local', async () => {
    respond = () => [note('shared')]
    const desktop = await freshStore()
    const phone = await freshStore()
    await desktop.refreshNotifications()
    await phone.refreshNotifications()
    expect(desktop.readNotifications()[0]!.id).toBe('shared')
    expect(phone.readNotifications()[0]!.id).toBe('shared')
  })

  test('a malformed server payload is ignored rather than rendered', async () => {
    respond = () => ({ oops: true })
    const s = await freshStore()
    await s.refreshNotifications()
    expect(s.readNotifications()).toEqual([])
  })

  test('entries missing required fields are dropped', async () => {
    respond = () => [note('ok'), { id: 'bad' }, null]
    const s = await freshStore()
    await s.refreshNotifications()
    expect(s.readNotifications().map(n => n.id)).toEqual(['ok'])
  })

  test('a server that is down leaves the cache intact instead of throwing', async () => {
    respond = () => [note('a')]
    const s = await freshStore()
    await s.refreshNotifications()
    ;(globalThis as unknown as { fetch: unknown }).fetch = async () => { throw new Error('offline') }
    await s.refreshNotifications()
    expect(s.readNotifications().map(n => n.id)).toEqual(['a'])
  })
})

describe('writing through to the server', () => {
  test('pushing POSTs code+meta — never rendered text', async () => {
    const s = await freshStore()
    s.pushNotification({ type: 'info', code: 'app.update_available', meta: { version: '1.2.3' } })
    await Bun.sleep(1)
    expect(calls[0]).toMatchObject({
      url: '/api/notifications',
      method: 'POST',
      body: { type: 'info', code: 'app.update_available', meta: { version: '1.2.3' } },
    })
    expect(JSON.stringify(calls[0]!.body)).not.toContain('Atualização disponível')
  })

  test('the cache is replaced by the server response, so ids come from the server', async () => {
    respond = c => (c.method === 'POST' ? [note('server-minted')] : [])
    const s = await freshStore()
    s.pushNotification({ type: 'info', code: 'x' })
    await Bun.sleep(1)
    expect(s.readNotifications().map(n => n.id)).toEqual(['server-minted'])
  })

  test('dismissing one sends its id and drops it locally right away', async () => {
    respond = () => [note('a'), note('b')]
    const s = await freshStore()
    await s.refreshNotifications()

    respond = () => [note('b')]
    s.dismissNotification('a')
    // Optimistic: gone before the response lands.
    expect(s.readNotifications().map(n => n.id)).toEqual(['b'])
    await Bun.sleep(1)
    expect(calls.at(-1)).toMatchObject({ url: '/api/notifications?id=a', method: 'DELETE' })
    expect(s.readNotifications().map(n => n.id)).toEqual(['b'])
  })

  test('clear-all sends a DELETE with no id and empties the cache', async () => {
    respond = () => [note('a'), note('b')]
    const s = await freshStore()
    await s.refreshNotifications()

    respond = () => []
    s.clearNotifications()
    expect(s.readNotifications()).toEqual([])
    await Bun.sleep(1)
    expect(calls.at(-1)).toMatchObject({ url: '/api/notifications', method: 'DELETE' })
  })

  test('opening the bell PATCHes read state and clears the badge immediately', async () => {
    respond = () => [note('a'), note('b')]
    const s = await freshStore()
    await s.refreshNotifications()

    respond = () => [note('a', { read: true }), note('b', { read: true })]
    s.markAllRead()
    expect(s.readNotifications().every(n => n.read)).toBe(true)
    await Bun.sleep(1)
    expect(calls.at(-1)).toMatchObject({ url: '/api/notifications', method: 'PATCH' })
  })

  test('mark-all-read with nothing unread does not call the server', async () => {
    respond = () => [note('a', { read: true })]
    const s = await freshStore()
    await s.refreshNotifications()
    const before = calls.length
    s.markAllRead()
    await Bun.sleep(1)
    expect(calls.length).toBe(before)
  })
})

describe('localization', () => {
  test('a stored code+meta still resolves in the current language', async () => {
    const s = await freshStore()
    const n = note('a', { code: 'member.reconnected' })
    expect(s.resolveNotification(n, 'pt').title).toBe('Conectado à central')
    expect(s.resolveNotification(n, 'en').title).toBe('Connected to the central')
  })
})

describe('I3 — a per-connection notification names WHICH central it is about', () => {
  const PER_CONNECTION = [
    'member.unreachable',
    'member.auth_rejected',
    'member.reconnected',
    'member.removed',
    'member.disconnected',
  ] as const

  test('every member.* code carries a {central} placeholder in BOTH languages', async () => {
    const s = await freshStore()
    for (const code of PER_CONNECTION) {
      for (const lang of ['pt', 'en'] as const) {
        expect(s.NOTIFICATION_TEXT[code]![lang].message).toContain('{central}')
      }
    }
  })

  test('two centrals produce two DISTINCT rows instead of two identical ones', async () => {
    const s = await freshStore()
    // The dedupe key already includes meta.connectionId, so both rows survive; before this fix the
    // bell showed two byte-identical messages and the user could not tell which central was down.
    const a = note('a', { code: 'member.unreachable', meta: { connectionId: 'c_a', central: 'central-a.example.com' } })
    const b = note('b', { code: 'member.unreachable', meta: { connectionId: 'c_b', central: 'work-central' } })
    for (const lang of ['pt', 'en'] as const) {
      const ma = s.resolveNotification(a, lang).message!
      const mb = s.resolveNotification(b, lang).message!
      expect(ma).toContain('central-a.example.com')
      expect(mb).toContain('work-central')
      expect(ma).not.toBe(mb)
      expect(ma).not.toContain('{central}')
    }
  })

  test('a label is used verbatim when the connection has one (the server sends label ?? host)', async () => {
    const s = await freshStore()
    const n = note('a', { code: 'member.removed', meta: { connectionId: 'c_a', central: 'Acme HQ' } })
    expect(s.resolveNotification(n, 'en').message).toContain('Acme HQ')
    expect(s.resolveNotification(n, 'pt').message).toContain('Acme HQ')
  })

  test('a row persisted before meta.central existed degrades to a generic noun, never a literal {central}', async () => {
    const s = await freshStore()
    for (const code of PER_CONNECTION) {
      const legacy = note('a', { code, meta: { connectionId: 'c_a' } })
      expect(s.resolveNotification(legacy, 'en').message).toContain('the central')
      expect(s.resolveNotification(legacy, 'pt').message).toContain('a central')
      expect(s.resolveNotification(legacy, 'en').message).not.toContain('{central}')
      expect(s.resolveNotification(legacy, 'pt').message).not.toContain('{central}')
      // An empty string is treated the same as missing.
      const blank = note('a', { code, meta: { connectionId: 'c_a', central: '  ' } })
      expect(s.resolveNotification(blank, 'en').message).not.toContain('{central}')
    }
  })

  test('the auth-rejected HTTP status still appends, on top of the interpolated central', async () => {
    const s = await freshStore()
    const n = note('a', { code: 'member.auth_rejected', meta: { connectionId: 'c_a', central: 'hq', status: 401 } })
    const msg = s.resolveNotification(n, 'en').message!
    expect(msg).toContain('hq')
    expect(msg).toContain('(HTTP 401)')
  })
})

describe('Task 13 — the two resync notification codes (member.resync_started / _done)', () => {
  const RESYNC = ['member.resync_started', 'member.resync_done'] as const

  test('both codes resolve to non-empty EN and PT titles', async () => {
    const s = await freshStore()
    for (const code of RESYNC) {
      for (const lang of ['pt', 'en'] as const) {
        const { title } = s.resolveNotification(note('a', { code }), lang)
        expect(title.length).toBeGreaterThan(0)
      }
    }
  })

  test('both codes interpolate {central} and {count} from meta, in both languages', async () => {
    const s = await freshStore()
    for (const code of RESYNC) {
      for (const lang of ['pt', 'en'] as const) {
        const n = note('a', { code, meta: { connectionId: 'c_a', central: 'Acme HQ', count: 7 } })
        const msg = s.resolveNotification(n, lang).message!
        expect(msg).toContain('Acme HQ')
        expect(msg).toContain('7')
        expect(msg).not.toContain('{central}')
        expect(msg).not.toContain('{count}')
      }
    }
  })

  // The dedupe key that decides whether two rows collapse into one lives server-side
  // (`notifications-store.ts`'s `keyOf`, `c:${code}:${JSON.stringify(meta)}`) — the web bundle may
  // never import `packages/server/*`, so this cannot cross-check that function directly the way
  // `shareRepos.test.ts` cross-checks `canonicalRepoKey`. `meta` there already carries
  // `connectionId` for EVERY per-connection notification (`notifyMeta` in `team-uploader.ts` always
  // sets it), so two different connections' resync events already produce two different JSON blobs
  // and therefore two different keys — this was already true before this task (Plan 2 fixed the
  // dedupe key itself for the member.* family), so nothing changes here; this test only asserts,
  // at the one boundary the web side can observe, that the two rows carry enough distinguishing
  // information to never be mistaken for the same central.
  test('two resync notifications with the same code and different connectionId do not collapse', async () => {
    const s = await freshStore()
    for (const code of RESYNC) {
      const a = note('a', { code, meta: { connectionId: 'c_a', central: 'central-a.example.com', count: 3 } })
      const b = note('b', { code, meta: { connectionId: 'c_b', central: 'work-central', count: 5 } })
      for (const lang of ['pt', 'en'] as const) {
        const ma = s.resolveNotification(a, lang).message!
        const mb = s.resolveNotification(b, lang).message!
        expect(ma).not.toBe(mb)
        expect(ma).toContain('central-a.example.com')
        expect(mb).toContain('work-central')
      }
    }
  })
})

describe('every {placeholder} is interpolated, not only the hand-listed ones', () => {
  test('a placeholder with no hand-written case still resolves from meta', async () => {
    // Seen on screen: a toast reading "Salvando {layers}." and another "Motivo: {reason}".
    // Interpolation was a hand-written list — `user`, `version`, `central` — so every new
    // notification with a new placeholder shipped showing its own braces. The list is the bug,
    // not the missing entries: the next person adding a code would have hit it again.
    const s = await freshStore()
    const out = s.resolveNotification(
      note('a', { code: 'backup.started', meta: { layers: 'metrics + repos' } }), 'pt',
    )
    expect(out.message).toContain('metrics + repos')
    expect(out.message).not.toContain('{layers}')
  })

  test('a placeholder with NO value in meta is left alone, never replaced with "undefined"', async () => {
    // An empty slot is a missing fact. Printing the word `undefined` in a sentence a person reads
    // is worse than leaving the brace, because it looks like the value.
    const s = await freshStore()
    const out = s.resolveNotification(note('a', { code: 'backup.failed', meta: {} }), 'en')
    expect(out.message).not.toContain('undefined')
  })

  test('the same placeholder appearing twice is replaced everywhere', async () => {
    const s = await freshStore()
    const out = s.resolveNotification(
      note('a', { code: 'backup.done', meta: { layers: 'metrics', size: '4 MB' } }), 'en',
    )
    expect(out.message).toContain('metrics')
    expect(out.message).toContain('4 MB')
  })

  test('a numeric value interpolates — `skipped` is a count, not a string', async () => {
    const s = await freshStore()
    const out = s.resolveNotification(
      note('a', { code: 'backup.done.skipped', meta: { layers: 'metrics', size: '4 MB', skipped: 3 } }), 'pt',
    )
    expect(out.message).toContain('3')
    expect(out.message).not.toContain('{skipped}')
  })
})
