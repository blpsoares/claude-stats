import { describe, expect, it, test } from 'bun:test'
import { redactSecrets, containsSecret, redactSessionText, redactSharedTask, REDACTION } from './redact'
import type { SharedTask } from './sharedTask'

const R = '[REDACTED]'

describe('URI credentials', () => {
  test('redacts the password of a mongodb+srv URI but keeps user and host', () => {
    const out = redactSecrets('MONGO_URL=mongodb+srv://appuser:s3cr3tP4ssw0rd@cluster.mongodb.net/db')
    expect(out).toContain('mongodb+srv://appuser:')
    expect(out).toContain('@cluster.mongodb.net/db')
    expect(out).not.toContain('s3cr3tP4ssw0rd')
  })

  test.each([
    ['postgres', 'postgres://u:hunter2hunter2@db:5432/x'],
    ['mysql', 'mysql://root:tOpS3cretValue@127.0.0.1/app'],
    ['redis', 'redis://default:abcdefgh12345678@redis:6379'],
    ['amqp', 'amqp://guest:guestpassword1@rabbit:5672'],
    ['https basic', 'https://admin:MyPassw0rd123@internal.example.com/api'],
  ])('redacts a %s URI password', (_label, uri) => {
    const out = redactSecrets(uri)
    expect(out).toContain(R)
    expect(containsSecret(uri)).toBe(true)
  })

  test('leaves a URI with NO credentials untouched', () => {
    const clean = 'mongodb://localhost:27017/agentistics'
    expect(redactSecrets(clean)).toBe(clean)
    expect(containsSecret(clean)).toBe(false)
  })

  test('keeps the host so the prompt still says WHICH system it was about', () => {
    // The point of first_prompt is to label the session. Nuking the whole line would be safe
    // and useless; the host is the part that makes it readable.
    expect(redactSecrets('mongodb+srv://u1:pw12345678@elmd-geral-01.mongodb.net'))
      .toBe(`mongodb+srv://u1:${R}@elmd-geral-01.mongodb.net`)
  })
})

describe('provider tokens', () => {
  // Fixtures are ASSEMBLED AT RUNTIME on purpose. A literal token-shaped string in a committed
  // file trips GitHub's own push protection (it blocked this very branch on the Slack sample) —
  // and a test suite for a secret scrubber is the last place that should ship look-alike secrets.
  const j = (...parts: string[]) => parts.join('')
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const a = 'abcdefghijklmnopqrstuvwxyz'
  const n = '0123456789'

  const CASES: [string, string][] = [
    ['GitHub PAT (classic)', j('ghp', '_', A, n, 'EXAMPLE')],
    ['GitHub fine-grained', j('github', '_pat_', '11', A, '_', a, n)],
    ['Anthropic', j('sk', '-ant-', 'api03-', A, n, a)],
    ['OpenAI', j('sk', '-proj-', A, n, a, A)],
    ['Slack', j('xox', 'b-', n, n, '-', A, a)],
    ['Google API key', j('AIza', 'Sy', A, a, n, 'ABCDEFGHI')],
    ['AWS access key id', j('AKIA', 'IOSFODNN7', 'EXAMPLE')],
  ]

  test.each(CASES)('redacts a %s', (_label, token) => {
    const out = redactSecrets(`here is the key ${token} use it`)
    expect(out).not.toContain(token)
    expect(out).toContain(R)
    expect(containsSecret(token)).toBe(true)
  })

  test('redacts a JWT', () => {
    const jwt = j('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.', A, n, a)
    expect(redactSecrets(jwt)).not.toContain(jwt)
  })

  test('redacts a private key block', () => {
    const body = j('MIIEowIBAAKCAQEA', A, n)
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    const out = redactSecrets(key)
    expect(out).not.toContain(body)
    expect(out).toContain(R)
  })

  test('redacts a Bearer token', () => {
    const tok = j(a, n, A)
    const out = redactSecrets(`curl -H "Authorization: Bearer ${tok}" api`)
    expect(out).not.toContain(tok)
  })
})

describe('key=value assignments', () => {
  test.each([
    'PASSWORD=sup3rS3cretValue',
    'api_key: AbCdEf1234567890xyz',
    'SECRET="hunter2hunter2hunter"',
    "token = 'abcdef1234567890abcd'",
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  ])('redacts %s', (line) => {
    expect(redactSecrets(line)).toContain(R)
  })

  test('keeps the KEY NAME so the text still reads sensibly', () => {
    expect(redactSecrets('PASSWORD=sup3rS3cretValue')).toBe(`PASSWORD=${R}`)
  })

  test('does not swallow the character before the key name', () => {
    // Regression: the delimiter was consumed but not captured, so the preceding word was glued
    // onto the key — "run with PASSWORD=x" came out as "run withPASSWORD=[REDACTED]".
    expect(redactSecrets('run with PASSWORD=sup3rS3cretValue and go'))
      .toBe(`run with PASSWORD=${R} and go`)
  })
})

describe('false positives — these must survive untouched', () => {
  // A redactor that eats ordinary prose is worse than none: it destroys every session label
  // and people turn it off. These are all real phrasings from this project's own prompts.
  test.each([
    'input_tokens=123 output_tokens=456',
    'the token count was 1500',
    'tokens: 42',
    'reduce token usage by 90%',
    'my password is wrong, can you help debug the login?',
    'set the secret in GitHub Actions, not in code',
    'MONGO_URL=mongodb://localhost:27017',
    'api_key: <your-key-here>',
    'password: ****',
    'the API key is stored in 1Password',
    'fix(auth): rotate the token on logout',
    'PORT=47291',
    'timeout=30',
  ])('leaves %j alone', (text) => {
    expect(redactSecrets(text)).toBe(text)
    expect(containsSecret(text)).toBe(false)
  })
})

describe('behavior', () => {
  test('is a no-op on text with nothing to hide (returns the same string)', () => {
    const s = 'refactor the session parser to handle empty transcripts'
    expect(redactSecrets(s)).toBe(s)
  })

  test('tolerates empty and non-string-ish input', () => {
    expect(redactSecrets('')).toBe('')
    expect(redactSecrets(undefined as unknown as string)).toBe('')
    expect(redactSecrets(null as unknown as string)).toBe('')
  })

  test('redacts every occurrence, not just the first', () => {
    const t1 = ['ghp', '_', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA1'].join('')
    const t2 = ['ghp', '_', 'BBBBBBBBBBBBBBBBBBBBBBBBBBB2'].join('')
    const out = redactSecrets(`a=${t1} b=${t2}`)
    expect(out).not.toContain(t1)
    expect(out).not.toContain(t2)
  })

  test('is idempotent — redacting twice changes nothing further', () => {
    const once = redactSecrets('MONGO_URL=mongodb+srv://u:pw12345678@h/db')
    expect(redactSecrets(once)).toBe(once)
  })

  test('containsSecret agrees with redactSecrets', () => {
    const dirty = 'mongodb+srv://u:pw12345678@h/db'
    expect(containsSecret(dirty)).toBe(true)
    expect(containsSecret(redactSecrets(dirty))).toBe(false)
  })
})

describe("agentistics' own connect token", () => {
  /**
   * The composite form `packConnectToken` produces and the UI tells people to paste: `act1_` +
   * base64url of the central URL + `.` + the hex secret. Shaped like the real one that was found in
   * a session's `first_prompt`; the secret here is random hex typed for this test.
   */
  const TOKEN = 'act1_aHR0cHM6Ly9jZW50cmFsLmV4YW1wbGUuY29t'
    + '.1f3c9a7e5b2d4068af91c3e7d5b8402619ac7f3e0d2b5849c6ef1a3b7d90c254'

  test('redacts the token this product mints, which is the one it kept missing', () => {
    // Every other vendor's format was on the STRONG list and ours was not. It was found in
    // plaintext in `first_prompt` — the field this module exists to protect.
    expect(redactSecrets(TOKEN)).toBe(REDACTION)
    expect(containsSecret(TOKEN)).toBe(true)
  })

  test('redacts it inside the prose somebody actually pastes', () => {
    const out = redactSecrets(`agentop member connect --token ${TOKEN} nao funciona`)
    expect(out).not.toContain(TOKEN)
    // The sentence still says what the session was ABOUT, which is the whole value of a label.
    expect(out).toContain('agentop member connect')
    expect(out).toContain('nao funciona')
  })

  test('scrubs it out of a session the way the push boundary does', () => {
    const session = { first_prompt: `here is my token: ${TOKEN}`, title: 'connect fails' }
    const out = redactSessionText(session)
    expect(out.first_prompt).not.toContain(TOKEN)
    expect(out.title).toBe('connect fails')
  })

  test('leaves a bare SHA-256 alone — 64 hex is a hash, not a namespace', () => {
    // The deliberate limit. `hashToken` output, git objects and content hashes are all this shape,
    // and a rule for it would redact labels that merely quote one. A noisy redactor gets switched
    // off, which costs more than it saves.
    const sha = 'a'.repeat(64)
    expect(redactSecrets(`the id is ${sha}`)).toContain(sha)
  })

  test('still catches a bare secret when it is pasted WITH context', () => {
    const secret = '1f3c9a7e5b2d4068af91c3e7d5b8402619ac7f3e0d2b5849c6ef1a3b7d90c254'
    expect(redactSecrets(`--token=${secret}`)).not.toContain(secret)
    expect(redactSecrets(`Authorization: Bearer ${secret}`)).not.toContain(secret)
  })

  test('does not fire on the prefix alone, or on prose that merely mentions it', () => {
    expect(redactSecrets('paste your act1_ token here')).toBe('paste your act1_ token here')
    expect(redactSecrets('the act1_ format embeds the endpoint')).toBe('the act1_ format embeds the endpoint')
  })
})

describe('redactSharedTask', () => {
  const base = (): SharedTask => ({
    task: {
      id: 't1', title: 'ship it', status: 'todo',
      createdAt: '2026-09-05T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
    },
    comments: [], subtasks: [], files: [], sessionIds: [], sessionsWithheld: 0,
  })

  it('scrubs the title, the description and the reason a card is blocked', () => {
    const out = redactSharedTask({
      ...base(),
      task: {
        ...base().task,
        title: 'deploy with ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        detail: 'run it as MONGO_URL=mongodb+srv://user:s3cretPassw0rd@host',
        blockedReason: 'waiting on sk-ant-aaaaaaaaaaaaaaaaaaaa to be rotated',
      },
    })
    expect(out.task.title).toContain(REDACTION)
    expect(out.task.title).not.toContain('ghp_')
    expect(out.task.detail).toContain(REDACTION)
    expect(out.task.blockedReason).toContain(REDACTION)
    expect(out.task.blockedReason).not.toContain('sk-ant-')
  })

  it('scrubs every comment body and subtask, not only the first', () => {
    const out = redactSharedTask({
      ...base(),
      comments: [
        { id: 'c1', author: 'scion', body: 'ok', createdAt: '2026-09-05T10:00:00.000Z' },
        { id: 'c2', author: 'scion', body: 'token ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', createdAt: '2026-09-05T10:00:00.000Z' },
      ],
      subtasks: [{
        id: 's1', title: 'rotate ghp_cccccccccccccccccccccccccccccccccccc', done: false,
        status: 'todo', createdAt: '2026-09-05T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
        notes: 'see AKIAIOSFODNN7EXAMPLE',
      }],
    })
    expect(out.comments[1]!.body).toContain(REDACTION)
    expect(out.comments[0]!.body).toBe('ok')
    expect(out.subtasks[0]!.title).toContain(REDACTION)
  })

  it('scrubs a file NAME — a pasted screenshot can be called anything', () => {
    const out = redactSharedTask({
      ...base(),
      files: [{
        id: 'f1', name: 'ghp_dddddddddddddddddddddddddddddddddddd.png', size: 10,
        createdAt: '2026-09-05T10:00:00.000Z',
      }],
    })
    expect(out.files[0]!.name).toContain(REDACTION)
  })

  it('leaves an ordinary board completely alone', () => {
    const doc = {
      ...base(),
      comments: [{ id: 'c1', author: 'scion', body: 'merged in dev', createdAt: '2026-09-05T10:00:00.000Z' }],
    }
    const out = redactSharedTask(doc)
    expect(out.task.title).toBe('ship it')
    expect(out.comments[0]!.body).toBe('merged in dev')
  })
})
