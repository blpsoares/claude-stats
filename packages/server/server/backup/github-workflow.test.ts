/**
 * github-workflow.test.ts — wave G4, against a fully injected `fetch`. No network call ever
 * reaches github.com.
 *
 * `buildBackupDocWorkflow()` is asserted on directly (it is pure text); `installGithubBackupWorkflow`
 * is asserted against a fake Contents API covering both the "already there" and "nothing there yet"
 * cases, plus the failure paths.
 */
import { describe, test, expect } from 'bun:test'
import type { FetchLike } from './github-api'
import { BACKUP_DOC_WORKFLOW_PATH, buildBackupDocWorkflow, installGithubBackupWorkflow } from './github-workflow'

const OWNER = 'someone'
const REPO = 'agentistics-backups'
const TOKEN = 'ghp_workflowTestToken1234567890'
const CONTENTS_PATH = `/repos/${OWNER}/${REPO}/contents/${BACKUP_DOC_WORKFLOW_PATH}`

describe('buildBackupDocWorkflow — the workflow text itself', () => {
  const yaml = buildBackupDocWorkflow()

  test('triggers only on a published release', () => {
    expect(yaml).toContain('release:')
    expect(yaml).toContain('types: [published]')
  })

  test('asks for contents: write and nothing more — no other permission line', () => {
    expect(yaml).toContain('permissions:')
    expect(yaml).toContain('contents: write')
    // The only permission-looking line beyond the block header itself.
    const permissionLines = yaml.split('\n').filter(l => /^\s*[a-z-]+: (write|read|none)\s*$/.test(l))
    expect(permissionLines).toEqual(['  contents: write'])
  })

  test('ignores any release whose tag is not one agentop minted', () => {
    expect(yaml).toContain("startsWith(github.event.release.tag_name, 'backup-')")
  })

  test('reads the release body and writes BACKUPS.md, never the archive itself', () => {
    expect(yaml).toContain('RELEASE_BODY')
    expect(yaml).toContain('BACKUPS.md')
    expect(yaml).not.toMatch(/\.tar\.|\.tgz|\.zst/)
  })

  test('parses every field buildReleaseBody (backup-github.ts) writes', () => {
    for (const label of ['created', 'host', 'layers', 'harnesses', 'sessions', 'size', 'sha256']) {
      expect(yaml).toContain(`get_field ${label}`)
    }
  })

  test('names its own status as a third reader of the release-body format, for the drift warning', () => {
    expect(yaml.toLowerCase()).toContain('third reader')
    expect(yaml).toContain('buildReleaseBody')
    expect(yaml).toContain('parseReleaseBody')
  })

  test('a failure must never fail the release — every run step tolerates its own errors', () => {
    expect(yaml).toContain('set +e')
    expect(yaml).toContain('continue-on-error: true')
  })

  test('handles the first release, when BACKUPS.md does not exist yet', () => {
    expect(yaml).toContain('if [ ! -f BACKUPS.md ]')
  })

  test('is valid, parseable YAML', () => {
    expect(() => Bun.YAML.parse(yaml)).not.toThrow()
  })
})

describe('installGithubBackupWorkflow', () => {
  test('a repository that already has the workflow is left untouched, and reports so', async () => {
    let putCalled = false
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url.endsWith(CONTENTS_PATH) && method === 'GET') {
        return new Response(JSON.stringify({ sha: 'existing-sha' }), { status: 200 })
      }
      if (method === 'PUT') { putCalled = true; return new Response('{}', { status: 201 }) }
      throw new Error(`unexpected request: ${method} ${url}`)
    }
    const result = await installGithubBackupWorkflow(OWNER, REPO, TOKEN, fetchImpl)
    expect(result).toEqual({ ok: true, status: 'already-exists' })
    expect(putCalled).toBe(false)
  })

  test('a repository with nothing there yet gets the workflow committed', async () => {
    let putBody: unknown = null
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url.endsWith(CONTENTS_PATH) && method === 'GET') {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      }
      if (url.endsWith(CONTENTS_PATH) && method === 'PUT') {
        putBody = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ content: { sha: 'new-sha' } }), { status: 201 })
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }
    const result = await installGithubBackupWorkflow(OWNER, REPO, TOKEN, fetchImpl)
    expect(result).toEqual({ ok: true, status: 'installed' })
    expect(putBody).not.toBeNull()
    const body = putBody as { message: string; content: string }
    expect(body.message.length).toBeGreaterThan(0)
    const decoded = Buffer.from(body.content, 'base64').toString('utf-8')
    expect(decoded).toBe(buildBackupDocWorkflow())
  })

  test('a failure checking for the existing file is reported, never attempted anyway', async () => {
    let putCalled = false
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url.endsWith(CONTENTS_PATH) && method === 'GET') {
        return new Response(JSON.stringify({ message: 'Internal Server Error' }), { status: 500 })
      }
      if (method === 'PUT') { putCalled = true; return new Response('{}', { status: 201 }) }
      throw new Error(`unexpected request: ${method} ${url}`)
    }
    const result = await installGithubBackupWorkflow(OWNER, REPO, TOKEN, fetchImpl)
    expect(result.ok).toBe(false)
    expect(putCalled).toBe(false)
  })

  test('a failed commit is reported by name', async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url.endsWith(CONTENTS_PATH) && method === 'GET') {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      }
      if (url.endsWith(CONTENTS_PATH) && method === 'PUT') {
        return new Response(JSON.stringify({ message: 'no write access' }), { status: 403 })
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }
    const result = await installGithubBackupWorkflow(OWNER, REPO, TOKEN, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.toLowerCase()).toContain('commit')
  })

  test('the token never appears in any message this function produces', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error(`network error carrying Bearer ${TOKEN}`)
    }
    const result = await installGithubBackupWorkflow(OWNER, REPO, TOKEN, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).not.toContain(TOKEN)
  })
})
