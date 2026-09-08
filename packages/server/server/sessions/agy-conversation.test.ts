import { describe, expect, it } from 'bun:test'
import { agyLogFromFds, conversationFromAgyLog } from './agy-conversation'

/**
 * The fixtures are REAL lines, captured on 2026-09-08 from agy 1.1.27 on this machine — the log of
 * the process agentop spawned at 10:03:56, which created conversation 39783297-…. A format this
 * undocumented is worth pinning against bytes somebody actually saw.
 */
const REAL_LINE =
  'ERROR: logging before google.Init: I0908 10:03:58.569478     218 server.go:1153] '
  + 'Created conversation 39783297-b1b0-49bf-9f56-b809ee1933db'

const REAL_LOG = [
  'ERROR: logging before google.Init: I0908 10:03:50.150653      82 server.go:1530] Starting language server process with pid 613917',
  REAL_LINE,
  'ERROR: logging before google.Init: I0908 10:03:58.571000     218 server.go:1160] getConversationDetail: found conversation 39783297-b1b0-49bf-9f56-b809ee1933db (active=true)',
].join('\n')

describe('conversationFromAgyLog', () => {
  it('reads the conversation agy says it created', () => {
    expect(conversationFromAgyLog(REAL_LOG)).toBe('39783297-b1b0-49bf-9f56-b809ee1933db')
  })

  it('answers null for a log that created nothing', () => {
    const noneYet = [
      'ERROR: logging before google.Init: I0908 10:32:50.150653      82 server.go:1530] Starting language server process with pid 613917',
      'ERROR: logging before google.Init: E0908 10:32:50.415817      60 errorreport.go:224] You are not logged into Antigravity.',
    ].join('\n')
    expect(conversationFromAgyLog(noneYet)).toBeNull()
  })

  it('answers null for an empty log', () => {
    expect(conversationFromAgyLog('')).toBeNull()
  })

  /**
   * One process can create a second conversation (agy's own `/new`). The one it is WRITING is the
   * last one it made, so a reader that took the first would name a conversation the session has
   * already left — and it would look perfectly right, which is the failure mode this whole feature
   * exists to avoid.
   */
  it('takes the LAST conversation when one process created several', () => {
    const twice = [
      REAL_LINE,
      'ERROR: logging before google.Init: I0908 10:41:02.100000     218 server.go:1153] '
      + 'Created conversation aacfe2ab-ef77-470d-804b-099bfe8e40be',
    ].join('\n')
    expect(conversationFromAgyLog(twice)).toBe('aacfe2ab-ef77-470d-804b-099bfe8e40be')
  })

  /** A line that merely mentions a conversation is not a line that created one. */
  it('ignores a conversation it only looked up', () => {
    const lookupOnly =
      'ERROR: logging before google.Init: I0908 10:03:58.571000     218 server.go:1160] '
      + 'getConversationDetail: found conversation 39783297-b1b0-49bf-9f56-b809ee1933db (active=true)'
    expect(conversationFromAgyLog(lookupOnly)).toBeNull()
  })

  /** Undocumented format, read like one: anything that is not a uuid is not an answer. */
  it('refuses a created line whose id is not a uuid', () => {
    expect(conversationFromAgyLog('server.go:1153] Created conversation not-a-uuid')).toBeNull()
  })
})

describe('agyLogFromFds', () => {
  const LOG = '/home/mithrandir/.gemini/antigravity-cli/log/cli-20260908_100356.log'

  it('picks agy\'s own log out of the process\'s open files', () => {
    expect(agyLogFromFds([
      '/dev/pts/3',
      '/home/mithrandir/.gemini/antigravity-cli/conversation_summaries.db',
      '/home/mithrandir/.gemini/antigravity-cli/conversation_summaries.db-wal',
      '/home/mithrandir/.gemini/antigravity-cli/crashes/crash_613917_f08b6119.log',
      LOG,
    ])).toBe(LOG)
  })

  it('answers null when the process has no agy log open', () => {
    expect(agyLogFromFds(['/dev/pts/3', '/home/mithrandir/.bashrc'])).toBeNull()
  })

  it('answers null for a process with no open files at all', () => {
    expect(agyLogFromFds([])).toBeNull()
  })

  /**
   * A crash log sits in the same tree and ends in `.log`, and it carries a pid rather than a
   * conversation. Matching it would hand the reader a file that names nothing.
   */
  it('does not mistake a crash log for the session log', () => {
    expect(agyLogFromFds([
      '/home/mithrandir/.gemini/antigravity-cli/crashes/crash_613917_f08b6119-5e4c-48de-b201-5ccb16dee285.log',
    ])).toBeNull()
  })

  /**
   * Two session logs open at once is a shape nobody has seen and nothing here can resolve: picking
   * either would be a guess wearing a measurement's clothes. Same rule as `planFirstSightingClaims`
   * — every ambiguity errs toward refusing.
   */
  it('refuses when two session logs are open', () => {
    expect(agyLogFromFds([
      LOG,
      '/home/mithrandir/.gemini/antigravity-cli/log/cli-20260908_103250.log',
    ])).toBeNull()
  })

  /** The same file counted twice (a dup'd fd) is still one file, and must not read as ambiguity. */
  it('accepts the same log appearing on two descriptors', () => {
    expect(agyLogFromFds([LOG, LOG])).toBe(LOG)
  })
})
