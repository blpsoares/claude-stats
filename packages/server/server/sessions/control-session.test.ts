import { emptySearchFields } from '@agentistics/tui/control/search-scope'
import { describe, expect, it } from 'bun:test'
import { cliStrings } from '../cli-i18n'
import { toControlSession } from './control-session'
import type { ResolvedRepoFacts } from './repo-facts'
import type { SessionView } from './session-view'

const S = cliStrings('en')

/** The narrowest row this mapper accepts — a session agentop hosts and is running. */
function view(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 'a1',
    harness: 'claude',
    cwd: '/home/d/agentistics/.claude/worktrees/member-connect-rotate',
    status: 'lost',
    attached: false,
    approvalDetection: true,
    searchFields: emptySearchFields(),
    ...over,
  }
}

const GONE: ResolvedRepoFacts = { worktree: false, missing: true, source: 'none' }
const RECOVERED: ResolvedRepoFacts = {
  repo: 'blpsoares/agentistics', root: 'agentistics', worktree: true, missing: true, source: 'recorded',
}
const LIVE: ResolvedRepoFacts = {
  repo: 'blpsoares/agentistics', root: 'agentistics', worktree: true, missing: false, source: 'live',
}

describe('a directory that no longer exists', () => {
  it('is NOT filed under the last segment of a path that names nothing', () => {
    // The reported bug: the removed worktree `member-connect-rotate` became a project group of its
    // own, standing beside `Agentistics` — the project it was a worktree of. The folder cell still
    // says where the session was, because that is a fact; the GROUP must not claim it is a project.
    const c = toControlSession(view(), S, GONE)
    expect(c.project).toBe('member-connect-rotate')
    // No group is claimed here: `groupSessions` keys the bucket on `dirGone` instead.
    expect(c.projectGroup).toBeUndefined()
    expect(c.dirGone).toBe(S.sessDirGone)
    expect(c.repo).toBeUndefined()
  })

  it('groups under the project it belonged to once the repository was recorded at spawn', () => {
    const c = toControlSession(view(), S, RECOVERED)
    expect(c.projectGroup).toBe('agentistics')
    expect(c.repo).toBe('blpsoares/agentistics')
    // Still said: the row names a path that is not there, which is also why reopening will fail.
    expect(c.dirGone).toBe(S.sessDirGone)
  })

  it('says nothing about a directory that is simply there', () => {
    const c = toControlSession(view(), S, LIVE)
    expect(c.dirGone).toBeUndefined()
    expect(c.projectGroup).toBe('agentistics')
  })
})

describe('where the session sits INSIDE its project', () => {
  it('carries the main checkout path, so the cascade measures branches against a fact', () => {
    const c = toControlSession(view(), S, {
      ...LIVE, rootPath: '/home/d/agentistics',
    })
    expect(c.projectRoot).toBe('/home/d/agentistics')
  })

  it('carries none when nothing names a repository, so the row hangs at its project root', () => {
    // The honesty rule: outside a repository, and for a directory that is gone with nothing
    // recorded, there is no path to measure against. A branch synthesised from the cwd alone would
    // be a guess drawn as a fact.
    expect(toControlSession(view(), S, GONE).projectRoot).toBeUndefined()
    expect(toControlSession(view(), S, RECOVERED).projectRoot).toBeUndefined()
  })
})

describe('which conversation a row continues from', () => {
  it('carries a RECORDED id, and only a recorded one', () => {
    const c = toControlSession(view({ conversationId: 'c-1' }), S, LIVE)
    expect(c.conversationId).toBe('c-1')
    expect(c.conversationBlind).toBeUndefined()
  })

  it('says so where the harness can never report one', () => {
    // codex invents its own id and never hands it back, so everything downstream falls to the
    // harness-and-directory guess. That is fine to OFFER and not fine to state as fact.
    const c = toControlSession(view({ harness: 'codex' }), S, LIVE)
    expect(c.conversationId).toBeUndefined()
    expect(c.conversationBlind).toBe(S.sessConversationBlind('codex'))
  })

  it('stays quiet on a claude row that has not been recorded YET', () => {
    // claude CAN be linked — the id is assigned at spawn, and the harness's own record names it
    // besides. An absent id here is "not yet", not "never", and the two must not read alike.
    const c = toControlSession(view({ harness: 'claude' }), S, LIVE)
    expect(c.conversationBlind).toBeUndefined()
  })

  it('claims nothing about a row agentop never started', () => {
    // An external process and a closed conversation were never ours to record, so the sentence
    // would be answering a question this screen is not letting anyone ask.
    for (const status of ['external', 'closed'] as const) {
      const c = toControlSession(view({ harness: 'codex', status }), S, LIVE)
      expect(c.conversationBlind).toBeUndefined()
    }
  })
})

describe('a dialog agentop can SEE and cannot READ', () => {
  /*
   * THE REPORTED BUG, 2026-09-07.
   *
   * A claude `AskUserQuestion` with four described options was drawn into an 80x24 pane (the tmux
   * default the spawner used to accept), so its question and option `1.` were redrawn off the top
   * and never reached `capture-pane`. `readDialog` correctly refused — and the refusal, being an
   * empty option list, read downstream as "there is nothing to choose between". The card offered a
   * bare confirm button, which takes whichever row is HIGHLIGHTED, on a six-option question.
   *
   * The user could not answer from the browser and opened the terminal instead. They were right not
   * to press it.
   */
  const asking = (over: Partial<SessionView> = {}) => view({
    status: 'running',
    activity: 'waiting-approval',
    approvalLines: ['  4. [ ] Erros repetidos', '  5. [ ] Type something', 'Esc to cancel'],
    ...over,
  })

  it('offers NO confirm button — the empty list was a refusal, not an absence', () => {
    const c = toControlSession(asking({ dialogUnreadable: 'no-anchor' }), S, LIVE)
    expect(c.canApprove).toBeUndefined()
  })

  it('says why, naming what does work, instead of leaving a control silently inert', () => {
    const c = toControlSession(asking({ dialogUnreadable: 'no-anchor' }), S, LIVE)
    expect(c.dialogBlind).toBe(S.sessDialogBlind('claude'))
    expect(c.dialogBlind).toContain('attach')
  })

  it('still offers the confirm where there is genuinely nothing to choose between', () => {
    // The codex-shaped `Press enter to continue`: no options AND no refusal. Unchanged.
    const c = toControlSession(asking(), S, LIVE)
    expect(c.canApprove).toBe(true)
    expect(c.dialogBlind).toBeUndefined()
  })

  it('is silent on a session that is not asking anything', () => {
    const c = toControlSession(view({ status: 'running', activity: 'working' }), S, LIVE)
    expect(c.dialogBlind).toBeUndefined()
    expect(c.canApprove).toBeUndefined()
  })
})
