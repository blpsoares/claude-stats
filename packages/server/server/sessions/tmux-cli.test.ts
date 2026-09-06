import { describe, expect, it } from 'bun:test'
import {
  LIST_FORMAT, PANE_INFO_FORMAT, attachArgs, capturePaneArgs, capturePaneAnsiArgs, idFromTmuxName,
  isSessionGoneError, killSessionArgs, newSessionArgs, paneInfoArgs, parsePaneInfo, parsePrefix,
  parseTmuxList, sendKeysEnterArgs, sendKeysLiteralArgs,
  sendKeysNamedArgs, trimCapture,
  tmuxName,
  serverOptionsArgs, HISTORY_LIMIT,
  resolveDefaultTerminal, resolveTruecolorTerm, spawnArgs,
  type TerminalProfile, tmuxListIsEmptyState,
} from './tmux-cli'

/** A colour-neutral profile: neither a 256-colour terminfo entry nor a truecolor invoker. */
const NO_COLOR: TerminalProfile = { defaultTerminal: null, truecolorTerm: null }
/** The common case on this host: tmux-256color present, invoker not (yet) truecolor. */
const C256: TerminalProfile = { defaultTerminal: 'tmux-256color', truecolorTerm: null }
/** A truecolor invoker on xterm-256color. */
const TRUECOLOR: TerminalProfile = { defaultTerminal: 'tmux-256color', truecolorTerm: 'xterm-256color' }

describe('names', () => {
  it('namespaces our sessions', () => {
    expect(tmuxName('a1b2')).toBe('agentop-a1b2')
    expect(idFromTmuxName('agentop-a1b2')).toBe('a1b2')
  })

  it("ignores a session that is not ours", () => {
    expect(idFromTmuxName('my-own-work')).toBeNull()
  })
})

describe('newSessionArgs', () => {
  it('uses our socket, detaches, sets the cwd, and separates the command with --', () => {
    expect(newSessionArgs({ id: 'a1', cwd: '/home/u/p', argv: ['claude', '--model', 'opus', 'fix it'] }))
      .toEqual([
        '-L', 'agentop', 'new-session', '-d', '-s', 'agentop-a1', '-c', '/home/u/p',
        '--', 'claude', '--model', 'opus', 'fix it',
      ])
  })

  it('propagates COLORTERM into the pane when the invoker is truecolor, before the -- guard', () => {
    // tmux does NOT set COLORTERM itself (measured on 3.2a): a detached CLI only emits 24-bit colour
    // when it inherits COLORTERM=truecolor, and the pane inherits it from -e. It must land before
    // `--`, or tmux reads it as one of the harness's own arguments.
    const args = newSessionArgs({ id: 'a1', cwd: '/home/u/p', argv: ['claude'], truecolor: true })
    expect(args).toEqual([
      '-L', 'agentop', 'new-session', '-d', '-s', 'agentop-a1', '-c', '/home/u/p',
      '-e', 'COLORTERM=truecolor', '--', 'claude',
    ])
    expect(args.indexOf('-e')).toBeLessThan(args.indexOf('--'))
  })

  it('adds nothing when the invoker is not truecolor', () => {
    const args = newSessionArgs({ id: 'a1', cwd: '/home/u/p', argv: ['claude'], truecolor: false })
    expect(args).not.toContain('-e')
    expect(args).not.toContain('COLORTERM=truecolor')
  })
})

describe('resolveDefaultTerminal', () => {
  it('prefers tmux-256color when its terminfo entry is present', () => {
    expect(resolveDefaultTerminal({ tmux256color: true, screen256color: true })).toBe('tmux-256color')
    expect(resolveDefaultTerminal({ tmux256color: true, screen256color: false })).toBe('tmux-256color')
  })

  it('falls back to screen-256color when tmux-256color is absent', () => {
    expect(resolveDefaultTerminal({ tmux256color: false, screen256color: true })).toBe('screen-256color')
  })

  it('leaves tmux to its own default rather than naming a terminfo entry that does not exist', () => {
    // A default-terminal pointing at a missing entry is worse than none — it downgrades every pane.
    expect(resolveDefaultTerminal({ tmux256color: false, screen256color: false })).toBeNull()
  })
})

describe('resolveTruecolorTerm', () => {
  it('trusts COLORTERM=truecolor and keys the capability to the invoker own $TERM', () => {
    expect(resolveTruecolorTerm({ TERM: 'xterm-256color', COLORTERM: 'truecolor' })).toBe('xterm-256color')
    expect(resolveTruecolorTerm({ TERM: 'alacritty', COLORTERM: '24bit' })).toBe('alacritty')
  })

  it('is case- and whitespace-tolerant on COLORTERM', () => {
    expect(resolveTruecolorTerm({ TERM: 'xterm-256color', COLORTERM: ' TrueColor ' })).toBe('xterm-256color')
  })

  it('declares no truecolor when the invoker did not (compatibility: never force RGB)', () => {
    // The exact state of this host at authoring time: TERM=screen, COLORTERM unset -> no truecolor.
    expect(resolveTruecolorTerm({ TERM: 'screen', COLORTERM: '' })).toBeNull()
    expect(resolveTruecolorTerm({ TERM: 'xterm-256color', COLORTERM: undefined })).toBeNull()
    expect(resolveTruecolorTerm({ TERM: 'xterm-256color', COLORTERM: '256' })).toBeNull()
  })

  it('cannot key a capability with no $TERM to key it to', () => {
    expect(resolveTruecolorTerm({ TERM: '', COLORTERM: 'truecolor' })).toBeNull()
    expect(resolveTruecolorTerm({ TERM: undefined, COLORTERM: 'truecolor' })).toBeNull()
  })
})

describe('spawnArgs', () => {
  it('is ONE invocation: the socket once, options then new-session, chained by bare ";"', () => {
    // `set-option` does not start a tmux server (measured on 3.2a), so options applied as separate
    // calls before the first `new-session` are lost on a cold socket and the first session keeps
    // tmux's 8-colour `screen` default. Chaining runs them against the single server tmux starts for
    // the batch, in order, so `default-terminal` precedes the pane it configures.
    const args = spawnArgs(C256, { id: 'a1', cwd: '/home/u/p', argv: ['claude', 'fix it'] })
    expect(args.slice(0, 2)).toEqual(['-L', 'agentop'])
    // -L appears exactly once, at the front; subcommands carry no socket flag of their own.
    expect(args.filter(a => a === '-L')).toHaveLength(1)
    // default-terminal is set BEFORE new-session in the sequence.
    expect(args.indexOf('default-terminal')).toBeLessThan(args.indexOf('new-session'))
    // The command list is exactly serverOptionsArgs + newSessionArgs, de-prefixed and ;-joined.
    const cmds = [...serverOptionsArgs(C256), newSessionArgs({ id: 'a1', cwd: '/home/u/p', argv: ['claude', 'fix it'] })]
    const expected: string[] = ['-L', 'agentop']
    cmds.forEach((c, i) => { if (i) expected.push(';'); expected.push(...c.slice(2)) })
    expect(args).toEqual(expected)
  })

  it('carries the truecolor pane env through to new-session', () => {
    const args = spawnArgs(TRUECOLOR, { id: 'a1', cwd: '/p', argv: ['claude'] })
    expect(args).toContain('COLORTERM=truecolor')
    // terminal-features (client side) and COLORTERM (pane side) both present for a truecolor invoker.
    expect(args.join(' ')).toContain('terminal-features ,xterm-256color:RGB')
  })

  it('still ends with the harness command after --, untouched', () => {
    const args = spawnArgs(NO_COLOR, { id: 'a1', cwd: '/p', argv: ['claude', '--model', 'opus', 'go'] })
    const dashdash = args.lastIndexOf('--')
    expect(args.slice(dashdash + 1)).toEqual(['claude', '--model', 'opus', 'go'])
  })
})

describe('the other argv builders', () => {
  it('builds them all against our socket and our session name', () => {
    expect(killSessionArgs('a1')).toEqual(['-L', 'agentop', 'kill-session', '-t', 'agentop-a1'])
    expect(capturePaneArgs('a1', 40)).toEqual(['-L', 'agentop', 'capture-pane', '-p', '-t', 'agentop-a1', '-S', '-40'])
    // The ANSI variant is the plain one with `-e` added — colours survive to the browser. Getting
    // this wrong is silent: without `-e` the terminal renders monochrome and looks fine.
    expect(capturePaneAnsiArgs('a1', 40)).toEqual(['-L', 'agentop', 'capture-pane', '-p', '-e', '-t', 'agentop-a1', '-S', '-40'])
    expect(paneInfoArgs('a1')).toEqual(['-L', 'agentop', 'display-message', '-p', '-t', 'agentop-a1', '-F', PANE_INFO_FORMAT])
    expect(sendKeysLiteralArgs('a1', 'hello there')).toEqual(['-L', 'agentop', 'send-keys', '-t', 'agentop-a1', '-l', 'hello there'])
    expect(sendKeysEnterArgs('a1')).toEqual(['-L', 'agentop', 'send-keys', '-t', 'agentop-a1', 'Enter'])
    expect(attachArgs('a1')).toEqual(['tmux', '-L', 'agentop', 'attach-session', '-t', 'agentop-a1'])
  })

  it('sends a NAMED key without -l, which is the opposite of sending text', () => {
    // Getting these two the wrong way round fails silently: `send-keys -l Enter` types the five
    // characters `E n t e r` into the assistant's prompt and reports success.
    expect(sendKeysNamedArgs('a1', 'Enter')).toEqual(['-L', 'agentop', 'send-keys', '-t', 'agentop-a1', 'Enter'])
    expect(sendKeysNamedArgs('a1', 'Escape')).toEqual(['-L', 'agentop', 'send-keys', '-t', 'agentop-a1', 'Escape'])
    expect(sendKeysNamedArgs('a1', 'Enter')).not.toContain('-l')
    expect(sendKeysLiteralArgs('a1', 'Enter')).toContain('-l')
  })

  it('builds the Enter argv through the named one, so there is a single answer', () => {
    expect(sendKeysEnterArgs('a1')).toEqual(sendKeysNamedArgs('a1', 'Enter'))
  })
})

describe('parseTmuxList', () => {
  const line = (n: string, created: string, attached: string, dead: string, activity: string) =>
    [n, created, attached, dead, activity].join('\t')

  it('reads the fields our LIST_FORMAT asks for, converting seconds to ms', () => {
    expect(parseTmuxList(line('agentop-a1', '1786562971', '0', '0', '1786563000'))).toEqual([
      { id: 'a1', createdMs: 1_786_562_971_000, attached: false, alive: true, lastActivityMs: 1_786_563_000_000 },
    ])
  })

  it('reads a dead pane as not alive, without dropping the session', () => {
    const [s] = parseTmuxList(line('agentop-a1', '1786562971', '0', '1', '1786563000'))
    expect(s!.alive).toBe(false)
  })

  it('reads an attached session as attached', () => {
    const [s] = parseTmuxList(line('agentop-a1', '1786562971', '1', '0', '1786563000'))
    expect(s!.attached).toBe(true)
  })

  it("ignores the user's own tmux sessions", () => {
    expect(parseTmuxList(line('my-own-work', '1786562971', '0', '0', '1786563000'))).toEqual([])
  })

  it('ignores blank lines and malformed rows rather than throwing', () => {
    expect(parseTmuxList('\n\nagentop-a1\nagentop-b2\t1786562971\t0\t0\t1786563000\n')).toHaveLength(1)
  })

  it('is empty for the empty output of a server with no sessions', () => {
    expect(parseTmuxList('')).toEqual([])
  })

  it('asks for exactly the fields it parses', () => {
    expect(LIST_FORMAT).toBe('#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_dead}\t#{session_activity}')
  })
})

describe('trimCapture', () => {
  it('drops the blank padding capture-pane appends, keeping interior blanks', () => {
    expect(trimCapture(['a', '', 'b', '', '', ''])).toEqual(['a', '', 'b'])
  })

  it('survives an all-blank frame', () => {
    expect(trimCapture(['', '', ''])).toEqual([])
  })
})

describe('parsePaneInfo', () => {
  it('reads the six numbers our PANE_INFO_FORMAT asks for', () => {
    expect(parsePaneInfo('12\t3\t80\t40\t0\t500')).toEqual({
      cols: 80, rows: 40, cursorX: 12, cursorY: 3, alive: true, historySize: 500,
    })
  })

  it('reads pane_dead=1 as not alive', () => {
    expect(parsePaneInfo('0\t0\t80\t40\t1\t0')!.alive).toBe(false)
  })

  it('returns null on a short or non-numeric line rather than a half-built PaneInfo', () => {
    // A confident-wrong cursor or "alive" is worse than none: the channel refuses the frame's
    // metadata instead of shipping a guess.
    expect(parsePaneInfo('12\t3\t80')).toBeNull()
    expect(parsePaneInfo('a\tb\tc\td\te\tf')).toBeNull()
    expect(parsePaneInfo('')).toBeNull()
  })

  it('asks for exactly the fields it parses', () => {
    expect(PANE_INFO_FORMAT).toBe('#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{pane_height}\t#{pane_dead}\t#{history_size}')
  })
})

describe('parsePrefix', () => {
  it('turns tmux notation into the keystroke a person reads', () => {
    expect(parsePrefix('prefix C-b')).toBe('Ctrl-b then d')
    expect(parsePrefix('prefix C-a')).toBe('Ctrl-a then d')
  })

  it('falls back to the raw value rather than claiming Ctrl-b', () => {
    expect(parsePrefix('prefix M-x')).toBe('M-x then d')
    expect(parsePrefix('')).toBe('the tmux prefix then d')
  })
})

describe('isSessionGoneError', () => {
  it('recognizes every wording tmux 3.2a uses for "already gone"', () => {
    expect(isSessionGoneError("can't find session: agentop-a1")).toBe(true)
    expect(isSessionGoneError('no server running on /tmp/tmux-1000/agentop')).toBe(true)
    expect(isSessionGoneError('error connecting to /tmp/tmux-1000/agentop (No such file or directory)')).toBe(true)
  })

  it('treats any other stderr as a real failure, never a guessed "gone"', () => {
    expect(isSessionGoneError('permission denied')).toBe(false)
    expect(isSessionGoneError('')).toBe(false)
  })
})

describe('serverOptionsArgs', () => {
  const all = serverOptionsArgs(C256)

  it('touches only agentop own socket', () => {
    // The whole reason setting global options is safe: none of this reaches the user's tmux, their
    // config, or the sessions they started themselves.
    for (const args of all) expect(args.slice(0, 2)).toEqual(['-L', 'agentop'])
  })

  it('turns the mouse on, because a pane you cannot scroll is a pane you cannot read', () => {
    const mouse = all.find(a => a.includes('mouse'))
    expect(mouse).toEqual(['-L', 'agentop', 'set-option', '-g', 'mouse', 'on'])
  })

  it('raises the scrollback well past tmux own 2000', () => {
    // Two thousand lines of an assistant transcript is a few minutes of work: attaching to a
    // session that has run for an hour and scrolling up finds the middle of a sentence.
    const history = all.find(a => a.includes('history-limit'))
    expect(history?.at(-1)).toBe(String(HISTORY_LIMIT))
    expect(HISTORY_LIMIT).toBeGreaterThan(2000)
  })

  it('still holds a finished session listable', () => {
    expect(all.some(a => a.includes('remain-on-exit') && a.at(-1) === 'on')).toBe(true)
  })
})

describe('serverOptionsArgs — colour', () => {
  it('sets default-terminal to the resolved 256-colour entry so panes are not capped at 8', () => {
    // Measured on tmux 3.2a: tmux's default-terminal is `screen`, which advertises 8 colours, so a
    // CLI inside the pane self-downgrades. tmux-256color takes tput colors from 8 to 256.
    const term = serverOptionsArgs(C256).find(a => a.includes('default-terminal'))
    expect(term).toEqual(['-L', 'agentop', 'set-option', '-g', 'default-terminal', 'tmux-256color'])
  })

  it('names no default-terminal when no 256-colour terminfo entry exists here', () => {
    expect(serverOptionsArgs(NO_COLOR).some(a => a.includes('default-terminal'))).toBe(false)
  })

  it('appends a truecolor capability keyed to the invoker $TERM, preserving tmux built-ins', () => {
    // `-ga` APPENDS so tmux's own terminal-features (clipboard, titles, …) survive; keying to the
    // invoker's own $TERM is the compatibility guarantee — a differently-typed client attaching
    // later never matches and renders at 256 rather than being fed RGB it cannot show.
    const rgb = serverOptionsArgs(TRUECOLOR).find(a => a.includes('terminal-features'))
    expect(rgb).toEqual(['-L', 'agentop', 'set-option', '-ga', 'terminal-features', ',xterm-256color:RGB'])
  })

  it('adds no truecolor capability when the invoker did not declare truecolor', () => {
    expect(serverOptionsArgs(C256).some(a => a.includes('terminal-features'))).toBe(false)
    expect(serverOptionsArgs(NO_COLOR).some(a => a.includes('terminal-features'))).toBe(false)
  })
})

describe('the status bar', () => {
  it('is off — it costs a row to say nothing here', () => {
    // tmux's band lists windows, the session name and a clock. An agentop session is one window
    // with one pane, its name is `agentop-<id>` rather than anything a person chose, and the
    // cockpit already shows all of it.
    const status = serverOptionsArgs(C256).find(a => a.includes('status'))
    expect(status).toEqual(['-L', 'agentop', 'set-option', '-g', 'status', 'off'])
  })
})

describe('tmuxListIsEmptyState — an unreachable tmux is not an empty fleet', () => {
  it('a clean exit is always the answer, whatever it says', () => {
    expect(tmuxListIsEmptyState(0, '')).toBe(true)
    expect(tmuxListIsEmptyState(0, 'agentop-x\t1\t0\t0\t1')).toBe(true)
  })

  it('NO SERVER is the ordinary empty state, in both wordings tmux uses', () => {
    // Measured on this machine (tmux 3.2a): a socket that does not exist exits 1 with
    // `error connecting to /tmp/tmux-1000/<name> (No such file or directory)`. Older builds print
    // `no server running on <socket>`; both mean the same thing and both are legitimate.
    expect(tmuxListIsEmptyState(1, 'error connecting to /tmp/tmux-1000/agentop (No such file or directory)')).toBe(true)
    expect(tmuxListIsEmptyState(1, 'no server running on /tmp/tmux-1000/agentop')).toBe(true)
  })

  it('EVERY OTHER failure is a failure — the bug this exists to fix', () => {
    // `PATH=/nonexistent tmux list-sessions` exits 127 printing `command not found`, which the old
    // reader parsed as zero sessions: the cockpit said "nothing running · 326 sessions withheld"
    // while four assistants were live, and the whole fleet reconciled to `lost`.
    expect(tmuxListIsEmptyState(127, 'bash: line 1: tmux: command not found')).toBe(false)
    expect(tmuxListIsEmptyState(1, 'lost server')).toBe(false)
    expect(tmuxListIsEmptyState(1, '')).toBe(false)
    expect(tmuxListIsEmptyState(2, 'usage: tmux ...')).toBe(false)
    expect(tmuxListIsEmptyState(1, 'server exited unexpectedly')).toBe(false)
  })

  it('is case-insensitive — the message is the only signal there is', () => {
    expect(tmuxListIsEmptyState(1, 'No server running on /tmp/x')).toBe(true)
  })
})
