import { describe, test, expect } from 'bun:test'
import { gh, parseRepoUrl, repoUrlHost, type FetchLike } from './github-api'

describe('parseRepoUrl — the four accepted forms', () => {
  test('https://github.com/o/r', () => {
    expect(parseRepoUrl('https://github.com/someone/agentistics-backups'))
      .toEqual({ owner: 'someone', repo: 'agentistics-backups' })
  })

  test('https://github.com/o/r.git, and a trailing slash', () => {
    expect(parseRepoUrl('https://github.com/someone/repo.git')).toEqual({ owner: 'someone', repo: 'repo' })
    expect(parseRepoUrl('https://github.com/someone/repo/')).toEqual({ owner: 'someone', repo: 'repo' })
  })

  test('github.com/o/r — no protocol', () => {
    expect(parseRepoUrl('github.com/someone/repo')).toEqual({ owner: 'someone', repo: 'repo' })
  })

  test('git@github.com:o/r.git — the SSH form', () => {
    expect(parseRepoUrl('git@github.com:someone/repo.git')).toEqual({ owner: 'someone', repo: 'repo' })
  })

  test('o/r — the bare shorthand', () => {
    expect(parseRepoUrl('someone/repo')).toEqual({ owner: 'someone', repo: 'repo' })
  })

  test('whitespace around the input is trimmed', () => {
    expect(parseRepoUrl('  someone/repo  ')).toEqual({ owner: 'someone', repo: 'repo' })
  })

  test('www. is stripped from an https host', () => {
    expect(parseRepoUrl('https://www.github.com/someone/repo')).toEqual({ owner: 'someone', repo: 'repo' })
  })
})

describe('parseRepoUrl — garbage and unknown hosts, refused', () => {
  test('an unrecognized host over https is refused, not guessed at', () => {
    expect(parseRepoUrl('https://gitlab.com/someone/repo')).toBeNull()
  })

  test('an unrecognized bare host is refused', () => {
    expect(parseRepoUrl('gitlab.com/someone/repo')).toBeNull()
  })

  test('an unrecognized SSH host is refused', () => {
    expect(parseRepoUrl('git@gitlab.com:someone/repo.git')).toBeNull()
  })

  test('empty input is refused', () => {
    expect(parseRepoUrl('')).toBeNull()
    expect(parseRepoUrl('   ')).toBeNull()
  })

  test('a bare URL with no owner/repo path is refused', () => {
    expect(parseRepoUrl('https://github.com/')).toBeNull()
    expect(parseRepoUrl('https://github.com/onlyowner')).toBeNull()
  })

  test('too many path segments is refused rather than guessing which two are meant', () => {
    expect(parseRepoUrl('https://github.com/someone/repo/extra')).toBeNull()
  })

  test('an owner with an invalid character is refused', () => {
    expect(parseRepoUrl('some one/repo')).toBeNull()
    expect(parseRepoUrl('some.one/repo')).toBeNull()
  })

  test('completely unrelated garbage is refused', () => {
    expect(parseRepoUrl('not a url at all')).toBeNull()
    expect(parseRepoUrl('ftp://github.com/o/r')).toBeNull()
  })
})

describe('repoUrlHost — naming the host for the refusal sentence', () => {
  test('names the host from an https URL', () => {
    expect(repoUrlHost('https://gitlab.com/someone/repo')).toBe('gitlab.com')
  })

  test('names the host from a bare host form', () => {
    expect(repoUrlHost('gitlab.com/someone/repo')).toBe('gitlab.com')
  })

  test('names the host from an SSH form', () => {
    expect(repoUrlHost('git@gitlab.com:someone/repo.git')).toBe('gitlab.com')
  })

  test('a shorthand with no dot has no host to report', () => {
    expect(repoUrlHost('someone/repo')).toBeNull()
  })

  test('garbage with no discernible host has none to report', () => {
    expect(repoUrlHost('not a url at all')).toBeNull()
  })
})

// A fake `fetch` — no network in tests, matching the plan's testability requirement.
function fakeFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchLike {
  return async (url, init) => responder(url, init)
}

const TOKEN = 'ghp_superSecretTokenValue1234567890'

describe('gh() — never throws, never leaks the token', () => {
  test('a successful call returns the parsed body', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ private: true }), { status: 200 }))
    const res = await gh<{ private: boolean }>('/repos/o/r', TOKEN, {}, fetchImpl)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.private).toBe(true)
  })

  test('sends the required headers, including the bearer token', async () => {
    let seenHeaders: Headers = new Headers()
    const fetchImpl = fakeFetch((_url, init) => {
      seenHeaders = new Headers(init?.headers)
      return new Response('{}', { status: 200 })
    })
    await gh('/repos/o/r', TOKEN, {}, fetchImpl)
    expect(seenHeaders.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(seenHeaders.get('accept')).toBe('application/vnd.github+json')
    expect(seenHeaders.get('x-github-api-version')).toBe('2022-11-28')
  })

  test('a non-2xx status is reported as ok:false with the status and a message', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }))
    const res = await gh('/repos/o/r', TOKEN, {}, fetchImpl)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(404)
      expect(res.message).toContain('404')
      expect(res.message).toContain('Not Found')
    }
  })

  test('a thrown network error never propagates — it comes back as ok:false', async () => {
    const fetchImpl: FetchLike = async () => { throw new Error('getaddrinfo ENOTFOUND') }
    const res = await gh('/repos/o/r', TOKEN, {}, fetchImpl)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(0)
      expect(res.message).toContain('ENOTFOUND')
    }
  })

  test('an unparsable success body never throws — reported as ok:false', async () => {
    const fetchImpl = fakeFetch(() => new Response('not json', { status: 200 }))
    const res = await gh('/repos/o/r', TOKEN, {}, fetchImpl)
    expect(res.ok).toBe(false)
  })

  // The enforcement the plan asks for: drive gh() through every failure path with a token that
  // could plausibly leak, and assert none of the resulting messages contain it — even when the
  // underlying error or response body is adversarially built to include it.
  test('the token never appears in any error message gh() produces', async () => {
    const messages: string[] = []

    const networkErr = await gh('/x', TOKEN, {}, async () => {
      throw new Error(`connection failed while sending Authorization: Bearer ${TOKEN}`)
    })
    if (!networkErr.ok) messages.push(networkErr.message)

    const badStatus = await gh('/x', TOKEN, {}, fakeFetch(() =>
      new Response(JSON.stringify({ message: `token ${TOKEN} is invalid` }), { status: 401 })))
    if (!badStatus.ok) messages.push(badStatus.message)

    const notFound = await gh('/x', TOKEN, {}, fakeFetch(() => new Response('', { status: 404 })))
    if (!notFound.ok) messages.push(notFound.message)

    const badBody = await gh('/x', TOKEN, {}, fakeFetch(() => new Response(`token=${TOKEN}`, { status: 200 })))
    if (!badBody.ok) messages.push(badBody.message)

    expect(messages.length).toBeGreaterThan(0)
    for (const m of messages) expect(m).not.toContain(TOKEN)
  })

  test('a caller can override Accept for a binary download', async () => {
    let seenAccept = ''
    const fetchImpl = fakeFetch((_url, init) => {
      seenAccept = new Headers(init?.headers).get('accept') ?? ''
      return new Response('binary', { status: 200 })
    })
    await gh('/repos/o/r/releases/assets/1', TOKEN, { headers: { Accept: 'application/octet-stream' } }, fetchImpl)
    expect(seenAccept).toBe('application/octet-stream')
  })

  test('a relative path resolves against the GitHub API host', async () => {
    let seenUrl = ''
    const fetchImpl = fakeFetch((url) => { seenUrl = url; return new Response('{}', { status: 200 }) })
    await gh('/repos/o/r', TOKEN, {}, fetchImpl)
    expect(seenUrl).toBe('https://api.github.com/repos/o/r')
  })

  test('responseType "arrayBuffer" returns the raw bytes, never attempting JSON', async () => {
    const fetchImpl = fakeFetch(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }))
    const res = await gh<ArrayBuffer>('/repos/o/r/releases/assets/1', TOKEN, {}, fetchImpl, 'arrayBuffer')
    expect(res.ok).toBe(true)
    if (res.ok) expect(new Uint8Array(res.data)).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  test('responseType "none" never parses the body — a 204 with no content is still ok:true', async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 204 }))
    const res = await gh('/repos/o/r/releases/1', TOKEN, { method: 'DELETE' }, fetchImpl, 'none')
    expect(res.ok).toBe(true)
  })
})
