import { describe, it, expect } from 'bun:test'
import { buildMachineFleetReply, performMachineAction, type MachineFleetDeps } from './machine-fleet'

function row(id: string, cwd: string, extra: Record<string, unknown> = {}) {
  return {
    id, title: `session ${id}`, harness: 'claude', state: 'working', stateLabel: 'working',
    project: cwd.split('/').pop() ?? '', cwd,
    lastLines: ['$ secret command'], chatTurns: [{ role: 'user', text: 'sk-live-abc' }],
    ...extra,
  }
}

function deps_(rows: Record<string, unknown>[], attention = 0, unavailable?: string): MachineFleetDeps {
  return {
    readFleet: async () => ({ rows, attention, ...(unavailable ? { unavailable } : {}) }),
    readIndexSources: async () => ({
      sessions: [
        { session_id: 'a', project_path: '/home/me/alpha', git_remote: 'github.com/o/alpha' },
        { session_id: 'b', project_path: '/home/me/beta', git_remote: 'github.com/o/beta' },
      ],
      projects: [
        { path: '/home/me/alpha', gitRemote: 'github.com/o/alpha' },
        { path: '/home/me/beta', gitRemote: 'github.com/o/beta' },
      ],
    }),
  }
}

const ALL = [row('1', '/home/me/alpha'), row('2', '/home/me/beta')]

const WITH_VERBS = [row('1', '/home/me/alpha', {
  verbs: [
    { action: 'rename', label: 'Rename', enabled: true },
    { action: 'kill', label: 'Kill', enabled: true },
    { action: 'approve', label: 'Approve', enabled: true },
    { action: 'prompt', label: 'Send', enabled: true },
  ],
})]

describe('buildMachineFleetReply', () => {
  it('answers NOTHING when the machine has not agreed — silence is not an empty fleet', () => {
    // An empty list is a statement about the fleet; null is a statement about consent, and the
    // central keeps them as different sentences.
    return Promise.all([
      buildMachineFleetReply({}, 'en', deps_(ALL)),
      buildMachineFleetReply({ allowRemoteSessions: false }, 'en', deps_(ALL)),
      // A screen grant with no fleet grant agrees to nothing — resolveRemoteConsent's rule.
      buildMachineFleetReply({ allowRemoteScreens: true }, 'en', deps_(ALL)),
    ]).then(rs => rs.forEach(r => expect(r).toBeNull()))
  })

  it('relays every row under an unrestricted denylist, and nothing is withheld', async () => {
    const r = (await buildMachineFleetReply({ allowRemoteSessions: true }, 'en', deps_(ALL)))!
    expect(r.rows.map(x => x.id)).toEqual(['1', '2'])
    expect(r.withheld).toBe(0)
  })

  it('never relays the screen or the conversation, whatever the rules say', async () => {
    const r = (await buildMachineFleetReply({ allowRemoteSessions: true }, 'en', deps_(ALL)))!
    for (const relayed of r.rows as unknown as Record<string, unknown>[]) {
      expect(relayed.lastLines).toBeUndefined()
      expect(relayed.chatTurns).toBeUndefined()
    }
  })

  it('a denied repository never becomes a row, and is COUNTED', async () => {
    const r = (await buildMachineFleetReply({
      allowRemoteSessions: true, shareMode: 'denylist',
      sources: [{ type: 'repo', value: 'github.com/o/beta' }],
    }, 'en', deps_(ALL)))!
    expect(r.rows.map(x => x.id)).toEqual(['1'])
    // Reported rather than silently subtracted: "some sessions are not shared with this central"
    // is a sentence, not an absence.
    expect(r.withheld).toBe(1)
  })

  it('an allowlist relays only what it names', async () => {
    const r = (await buildMachineFleetReply({
      allowRemoteSessions: true, shareMode: 'allowlist',
      sources: [{ type: 'repo', value: 'github.com/o/beta' }],
    }, 'en', deps_(ALL)))!
    expect(r.rows.map(x => x.id)).toEqual(['2'])
    expect(r.withheld).toBe(1)
  })

  it('an EMPTY allowlist relays nothing — it is the strictest rule, not the absence of one', async () => {
    const r = (await buildMachineFleetReply({
      allowRemoteSessions: true, shareMode: 'allowlist', sources: [],
    }, 'en', deps_(ALL)))!
    expect(r.rows).toEqual([])
    expect(r.withheld).toBe(2)
  })

  it('a directory the index cannot resolve is WITHHELD under any rule in force', async () => {
    // Positive resolution only — cwdShared's rule. Under a denylist an unknown path would
    // otherwise read as shared, and cwd is the sensitive field here.
    const rows = [...ALL, row('3', '/somewhere/unknown')]
    const r = (await buildMachineFleetReply({
      allowRemoteSessions: true, shareMode: 'denylist',
      sources: [{ type: 'repo', value: 'github.com/o/beta' }],
    }, 'en', deps_(rows)))!
    expect(r.rows.map(x => x.id)).toEqual(['1'])
    expect(r.withheld).toBe(2)
  })

  it('a row with NO directory is withheld once any rule is in force, and kept when none is', async () => {
    const rows = [row('1', '/home/me/alpha'), row('9', '')]
    const restricted = (await buildMachineFleetReply({
      allowRemoteSessions: true, shareMode: 'denylist',
      sources: [{ type: 'repo', value: 'github.com/o/beta' }],
    }, 'en', deps_(rows)))!
    expect(restricted.rows.map(x => x.id)).toEqual(['1'])
    const open = (await buildMachineFleetReply({ allowRemoteSessions: true }, 'en', deps_(rows)))!
    expect(open.rows.map(x => x.id)).toEqual(['1', '9'])
  })

  it('attention is the MACHINE\'s own count over its unfiltered fleet', async () => {
    // Recomputing it from the relayed rows would answer "how many of the ones you may see" under
    // the same name.
    const r = (await buildMachineFleetReply({
      allowRemoteSessions: true, shareMode: 'allowlist', sources: [],
    }, 'en', deps_(ALL, 3)))!
    expect(r.rows).toEqual([])
    expect(r.attention).toBe(3)
  })

  it('relays only the verbs a central may drive — approve and prompt never appear', async () => {
    // Narrowed BEFORE the reduction, so a verb this machine would refuse never reaches the button.
    // Offering one and refusing it on the click is the control that reads as broken.
    const r = (await buildMachineFleetReply({ allowRemoteSessions: true }, 'en', deps_(WITH_VERBS)))!
    expect(r.rows[0]!.verbs!.map(v => v.action)).toEqual(['rename', 'kill'])
  })

  it('the SCREEN consent unlocks approve and prompt, and carries the screen with them', async () => {
    // The two halves are one decision: a verb that answers a dialog is only offered where the
    // dialog can be READ, so the row that carries the verb carries the dialog too.
    const r = (await buildMachineFleetReply({ allowRemoteSessions: true, allowRemoteScreens: true }, 'en', deps_(WITH_VERBS)))!
    expect(r.rows[0]!.verbs!.map(v => v.action)).toEqual(['rename', 'kill', 'approve', 'prompt'])
  })

  it("carries the machine's own sentence about an incomplete list", async () => {
    const r = (await buildMachineFleetReply({ allowRemoteSessions: true }, 'en', deps_(ALL, 0, 'tmux is not installed')))!
    expect(r.unavailable).toBe('tmux is not installed')
  })

  it('drops the TASK verbs from a row when the connection is restricted', async () => {
    // A verb this machine will refuse must never appear on the row — the same rule the screen
    // verbs already follow. Offering it and refusing on the click is the control that reads as
    // broken.
    const rows = [row('1', '/home/me/alpha', {
      verbs: [
        { action: 'rename', label: 'Rename', enabled: true },
        { action: 'openTask', label: 'Open task', enabled: true },
        { action: 'finishTask', label: 'Finish task', enabled: true },
      ],
    })]
    const restricted = (await buildMachineFleetReply({
      allowRemoteSessions: true,
      shareMode: 'denylist',
      sources: [{ type: 'repo', value: 'github.com/o/beta' }],
    }, 'en', deps_(rows)))!
    expect(restricted.rows[0]!.verbs?.map(v => v.action)).toEqual(['rename'])
    // ...and keeps them when nothing is withheld.
    const open = (await buildMachineFleetReply({ allowRemoteSessions: true }, 'en', deps_(rows)))!
    expect(open.rows[0]!.verbs?.map(v => v.action)).toEqual(['rename', 'openTask', 'finishTask'])
  })
})

describe('performMachineAction', () => {
  const ran: { id: string; action: string; text?: string }[] = []
  // `s1` sits in alpha, `s2` in beta, and they share the task "refactor" — the shape the leak
  // needed: one row a restricted central may see, one it may not, filed under one piece of work.
  const ACT_ROWS = [
    row('s1', '/home/me/alpha', { task: 'refactor' }),
    row('s2', '/home/me/beta', { task: 'refactor' }),
  ]
  const runAction = async (_l: never, r: { id: string; action: string; text?: string }) => {
    ran.push(r)
    return { ok: true, message: 'done' }
  }
  const deps = { ...deps_(ACT_ROWS), runAction } as never

  it('performs a screenless verb once the machine has agreed', async () => {
    for (const action of ['rename', 'note', 'task', 'interrupt', 'kill', 'resume', 'openTask', 'finishTask']) {
      const r = await performMachineAction({ allowRemoteSessions: true }, 'en', { action, id: 's1' }, deps)
      expect(r.ok).toBe(true)
    }
  })

  it('refuses everything without the consent, and never runs the verb', async () => {
    // The machine is the authority; a check that runs only on the central is not a check.
    const before = ran.length
    const r = await performMachineAction({}, 'en', { action: 'kill', id: 's1' }, deps)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/does not allow/)
    expect(ran.length).toBe(before)
  })

  it('refuses approve and prompt by NAMING the screen when only the FLEET switch is on', async () => {
    // "Not allowed" would read the same for a verb that needs the screen and one that does not
    // exist. They are different problems and get different sentences.
    for (const action of ['approve', 'prompt']) {
      const r = await performMachineAction({ allowRemoteSessions: true }, 'en', { action, id: 's1' }, deps)
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/screen does not leave this machine/)
    }
  })

  it('refuses an unknown verb with its own sentence', async () => {
    const r = await performMachineAction({ allowRemoteSessions: true }, 'en', { action: 'wipe', id: 's1' }, deps)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/cannot be performed from a central/)
  })

  it('refuses a request that names no session', async () => {
    const r = await performMachineAction({ allowRemoteSessions: true }, 'en', { action: 'kill', id: '' }, deps)
    expect(r.ok).toBe(false)
  })

  it('carries the text through for the verbs that take one', async () => {
    ran.length = 0
    await performMachineAction({ allowRemoteSessions: true }, 'en', { action: 'rename', id: 's1', text: 'new name' }, deps)
    expect(ran[0]).toEqual({ id: 's1', action: 'rename', text: 'new name' })
  })

  // ---- the sharing rules, on the ACT half ----------------------------------------------------
  //
  // The read half filtered rows through `cwdShared` from the day it shipped; this half checked
  // consent and the verb and then resolved the id against the machine's RAW fleet. Every test
  // below fails if that check is removed.

  const DENY_BETA = {
    allowRemoteSessions: true,
    shareMode: 'denylist' as const,
    sources: [{ type: 'repo' as const, value: 'github.com/o/beta' }],
  }

  it('refuses a verb aimed at a session this connection cannot see, and never runs it', async () => {
    // `s2` lives in the withheld repo. Before the fix this reached `runFleetAction`, which resolves
    // the id against the unfiltered registry — a bare tmux kill, a rename, a resume in that cwd.
    for (const action of ['kill', 'rename', 'note', 'task', 'interrupt', 'resume']) {
      ran.length = 0
      const r = await performMachineAction(DENY_BETA, 'en', { action, id: 's2', text: 'x' }, deps)
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/not shared with this central/)
      expect(ran).toEqual([])
    }
  })

  it('still performs the same verbs on a session it DOES share', async () => {
    // The rule narrows; it must not break the feature for the rows the central was shown.
    ran.length = 0
    const r = await performMachineAction(DENY_BETA, 'en', { action: 'kill', id: 's1' }, deps)
    expect(r.ok).toBe(true)
    expect(ran).toEqual([{ id: 's1', action: 'kill', text: undefined }])
  })

  it('fails CLOSED on an id the machine cannot find', async () => {
    // An id with no row is an id with no directory, and the rule names directories. Passing it
    // through would leave every verb reachable by naming an id the fleet does not list.
    ran.length = 0
    const r = await performMachineAction(DENY_BETA, 'en', { action: 'kill', id: 'ghost' }, deps)
    expect(r.ok).toBe(false)
    expect(ran).toEqual([])
  })

  it('refuses the TASK verbs on a restricted connection, without saying whether this task spans one', async () => {
    // `openTask` expands over the whole registry, so pressing it on the VISIBLE `s1` reopened `s2`
    // in the withheld repo. Refused for every restricted connection rather than only when it
    // provably spans: the narrower check is an oracle for which visible rows share work with the
    // hidden half.
    for (const action of ['openTask', 'finishTask']) {
      ran.length = 0
      const r = await performMachineAction(DENY_BETA, 'en', { action, id: 's1' }, deps)
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/task on the machine itself/)
      expect(ran).toEqual([])
      // The refusal may not name the hidden row, its repo, or a count of them.
      expect(r.message).not.toMatch(/beta|s2/)
    }
  })

  it('leaves an UNRESTRICTED connection paying nothing — task verbs included', async () => {
    // The common case: a denylist that names nothing reads the fleet not at all.
    let read = 0
    const counting = {
      ...deps_(ACT_ROWS),
      readFleet: async (l: never) => { read++; return await deps_(ACT_ROWS).readFleet(l) },
      runAction,
    } as never
    for (const action of ['kill', 'openTask']) {
      const r = await performMachineAction({ allowRemoteSessions: true }, 'en', { action, id: 's1' }, counting)
      expect(r.ok).toBe(true)
    }
    expect(read).toBe(0)
  })

  it('an ALLOWLIST restricts even when it names nothing', async () => {
    // The strictest rule there is — it must never take the unrestricted shortcut.
    const r = await performMachineAction(
      { allowRemoteSessions: true, shareMode: 'allowlist', sources: [] },
      'en', { action: 'kill', id: 's1' }, deps,
    )
    expect(r.ok).toBe(false)
  })

  it('refuses in the asked-for language on both new refusals', async () => {
    for (const req of [{ action: 'kill', id: 's2' }, { action: 'openTask', id: 's1' }]) {
      const en = await performMachineAction(DENY_BETA, 'en', req, deps)
      const pt = await performMachineAction(DENY_BETA, 'pt', req, deps)
      expect(en.message).not.toBe(pt.message)
      expect(pt.message.length).toBeGreaterThan(10)
    }
  })

  it('every refusal is worded, in the asked-for language', async () => {
    for (const lang of ['en', 'pt'] as const) {
      const r = await performMachineAction({}, lang, { action: 'kill', id: 's1' }, deps)
      expect(r.message.length).toBeGreaterThan(10)
    }
    const en = await performMachineAction({}, 'en', { action: 'kill', id: 's1' }, deps)
    const pt = await performMachineAction({}, 'pt', { action: 'kill', id: 's1' }, deps)
    expect(en.message).not.toBe(pt.message)
  })
})

describe('the screen, end to end', () => {
  const WITH_SCREEN = [{
    id: 's1', title: 'x', harness: 'claude', state: 'waiting-approval', stateLabel: 'needs you',
    project: 'p', cwd: '/repo',
    lastLines: ['$ rm -rf /tmp/x', 'Do you want to proceed?'],
    approvalLines: ['1. Yes', '2. Yes, always', '3. No'],
    dialogOptions: [{ number: 1, label: 'Yes', selected: true }, { number: 3, label: 'No', selected: false }],
    chatTurns: [{ role: 'user', text: 'the API key is sk-live-abc123' }],
    verbs: [{ action: 'approve', label: 'Approve', enabled: true }],
  }]

  it('the FLEET consent alone relays no screen at all', async () => {
    const r = (await buildMachineFleetReply({ allowRemoteSessions: true }, 'en', deps_(WITH_SCREEN)))!
    expect(r.rows[0]!.lastLines).toBeUndefined()
    expect(r.rows[0]!.approvalLines).toBeUndefined()
    expect(r.rows[0]!.dialogOptions).toBeUndefined()
  })

  it('the SCREEN consent relays the terminal and the options, never the transcript', async () => {
    const r = (await buildMachineFleetReply({ allowRemoteSessions: true, allowRemoteScreens: true }, 'en', deps_(WITH_SCREEN)))!
    const row = r.rows[0]! as unknown as Record<string, unknown>
    expect(row.lastLines).toEqual(['$ rm -rf /tmp/x', 'Do you want to proceed?'])
    expect(row.dialogOptions).toHaveLength(2)
    // The one field NEITHER switch grants. Its route answers 410 and a screen consent must not
    // quietly reopen it.
    expect(Object.keys(row)).not.toContain('chatTurns')
  })

  it('the CHOICE reaches the machine — an approve is never a blind confirm', async () => {
    // Most dialogs are not yes/no. A key that "approves" takes whichever row is HIGHLIGHTED, so
    // the number the person picked has to travel or the central is choosing for them.
    const seen: Record<string, unknown>[] = []
    const d = {
      ...deps_(WITH_SCREEN),
      runAction: async (_l: unknown, req: Record<string, unknown>) => {
        seen.push(req)
        return { ok: true, message: 'sent' }
      },
    }
    await performMachineAction(
      { allowRemoteSessions: true, allowRemoteScreens: true }, 'en',
      { action: 'approve', id: 's1', choice: 3 }, d as never,
    )
    expect(seen[0]!.choice).toBe(3)
  })

  it('NO choice stays absent rather than becoming zero', async () => {
    // `runFleetAction` reads an absent choice as "use the dialog's confirm key", which is right
    // where there is nothing to choose between. `undefined` and "option zero" are different asks.
    const seen: Record<string, unknown>[] = []
    const d = {
      ...deps_(WITH_SCREEN),
      runAction: async (_l: unknown, req: Record<string, unknown>) => {
        seen.push(req)
        return { ok: true, message: 'sent' }
      },
    }
    await performMachineAction(
      { allowRemoteSessions: true, allowRemoteScreens: true }, 'en',
      { action: 'prompt', id: 's1', text: 'go on' }, d as never,
    )
    expect(Object.keys(seen[0]!)).not.toContain('choice')
    expect(seen[0]!.text).toBe('go on')
  })
})
