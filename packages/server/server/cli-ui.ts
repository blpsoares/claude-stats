/**
 * cli-ui.ts — tiny, dependency-free interactive prompts for the agentop CLI.
 *
 * Provides an arrow-key `select` (↑/↓/j/k + Enter), a boolean `confirm` (rendered as a
 * Yes/No select), and a typed `input`. Dependency-free on purpose: it bundles cleanly into the
 * compiled binary with no transitive node_modules to resolve at runtime. Falls back to the
 * initial/entered value when stdin isn't a raw-capable TTY.
 *
 * Rendering re-draws in place (moves the cursor up and clears each line) so navigation is smooth.
 * Ctrl-C exits the process with code 130 (standard SIGINT) without leaving raw mode on.
 */

import { createInterface } from 'readline'

const ESC = '\x1b'
const R = `${ESC}[0m`
const B = `${ESC}[1m`
const D = `${ESC}[2m`
const O = `${ESC}[38;5;208m`
const CY = `${ESC}[96m`

export interface Choice<T> {
  name: string
  value: T
  /** Optional dim hint shown after the name. */
  hint?: string
  /** Optional disabled marker — shown dim and skipped by navigation. */
  disabled?: boolean
}

/**
 * Arrow-key single-select. Returns the chosen value. On a non-TTY it resolves to the initial
 * choice without prompting (so scripts don't hang).
 */
export function select<T>(opts: { message: string; choices: Choice<T>[]; initial?: number }): Promise<T> {
  const { message, choices } = opts
  const enabled = choices.map((c, i) => (c.disabled ? -1 : i)).filter((i) => i >= 0)
  let idx = opts.initial != null && !choices[opts.initial]?.disabled ? opts.initial : (enabled[0] ?? 0)

  const stdin = process.stdin
  const stdout = process.stdout

  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.resolve(choices[idx]!.value)
  }

  return new Promise<T>((resolve) => {
    let lines = 0

    const draw = (first: boolean) => {
      if (!first) stdout.write(`${ESC}[${lines}A`)
      let out = `\r  ${B}${message}${R}${ESC}[K\n`
      choices.forEach((c, i) => {
        const selected = i === idx
        const pointer = selected ? `${O}❯${R}` : ' '
        const label = c.disabled
          ? `${D}${c.name}${R}`
          : selected ? `${O}${B}${c.name}${R}` : c.name
        const hint = c.hint ? `  ${D}${c.hint}${R}` : ''
        out += `\r  ${pointer} ${label}${hint}${ESC}[K\n`
      })
      stdout.write(out)
      lines = choices.length + 1
    }

    const move = (dir: 1 | -1) => {
      const pos = enabled.indexOf(idx)
      const next = enabled[(pos + dir + enabled.length) % enabled.length]
      if (next != null) { idx = next; draw(false) }
    }

    const cleanup = () => {
      stdin.setRawMode!(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }

    const commit = () => {
      cleanup()
      // Collapse the menu to a single confirmation line.
      stdout.write(`${ESC}[${lines}A`)
      stdout.write(`\r  ${O}❯${R} ${B}${message}${R} ${D}·${R} ${CY}${choices[idx]!.name}${R}${ESC}[K\n`)
      for (let i = 1; i < lines; i++) stdout.write(`${ESC}[K\n`)
      stdout.write(`${ESC}[${lines - 1}A`)
      resolve(choices[idx]!.value)
    }

    // Process the chunk sequence-by-sequence: a real keypress arrives alone, but batched or
    // pasted input can pack several keys (and Enter) into one data event — matching the whole
    // chunk would then miss everything and hang.
    const onData = (buf: Buffer) => {
      let s = buf.toString('utf8')
      while (s.length) {
        if (s.startsWith('\x03')) { cleanup(); stdout.write('\n'); process.exit(130) } // Ctrl-C
        else if (s.startsWith('\x1b[A')) { move(-1); s = s.slice(3) }                  // up
        else if (s.startsWith('\x1b[B')) { move(1); s = s.slice(3) }                   // down
        else if (s[0] === '\r' || s[0] === '\n') { commit(); return }                  // enter
        else if (s[0] === 'k') { move(-1); s = s.slice(1) }
        else if (s[0] === 'j') { move(1); s = s.slice(1) }
        else s = s.slice(1)                                                            // ignore
      }
    }

    stdin.setRawMode!(true)
    stdin.resume()
    stdin.on('data', onData)
    draw(true)
  })
}

/** Boolean prompt rendered as a Yes/No select (arrow-navigable). */
export async function confirm(message: string, initial = false): Promise<boolean> {
  return select<boolean>({
    message,
    initial: initial ? 0 : 1,
    choices: [
      { name: 'Yes', value: true },
      { name: 'No', value: false },
    ],
  })
}

/** Wait for the user to press Enter (used to let action output be read before the panel redraws). */
export function pause(message = 'Press Enter to go back'): Promise<void> {
  const stdout = process.stdout
  if (!process.stdin.isTTY) return Promise.resolve()
  const rl = createInterface({ input: process.stdin, output: stdout })
  rl.on('SIGINT', () => { stdout.write('\n'); rl.close(); process.exit(130) })
  return new Promise((resolve) => {
    rl.question(`\n  ${D}${message} ↵${R}`, () => { rl.close(); resolve() })
  })
}

/**
 * Typed text input with the terminal echo suppressed — for secrets (a GitHub PAT, a password).
 * Falls back to the ordinary (echoed) `input()` when stdin is not a raw-capable TTY, since there
 * is no way to suppress echo without one and a piped/non-interactive invocation must not hang.
 */
export function maskedInput(message: string): Promise<string> {
  const stdout = process.stdout
  const stdin = process.stdin

  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return input(message)
  }

  return new Promise<string>((resolve) => {
    let value = ''
    stdout.write(`  ${B}${message}${R}${D} ›${R} `)

    const cleanup = () => {
      stdin.setRawMode!(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }

    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8')
      for (const ch of s) {
        if (ch === '\x03') { cleanup(); stdout.write('\n'); process.exit(130) } // Ctrl-C
        else if (ch === '\r' || ch === '\n') { cleanup(); stdout.write('\n'); resolve(value.trim()); return }
        else if (ch === '\x7f' || ch === '\b') { value = value.slice(0, -1) } // backspace, no echo either
        else if (ch >= ' ') { value += ch } // no echo — the whole point of this function
      }
    }

    stdin.setRawMode!(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

/** Clear the visible screen and home the cursor (keeps scrollback so history isn't lost). */
export function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H')
}

/** Typed text input via readline. `secret` masks nothing (readline can't) but trims the value. */
export function input(message: string, opts: { default?: string } = {}): Promise<string> {
  const stdout = process.stdout
  const suffix = opts.default ? ` ${D}(${opts.default})${R}` : ''
  const rl = createInterface({ input: process.stdin, output: stdout })
  rl.on('SIGINT', () => { stdout.write('\n'); rl.close(); process.exit(130) })
  return new Promise((resolve) => {
    rl.question(`  ${B}${message}${R}${suffix}${D} ›${R} `, (a) => {
      rl.close()
      resolve(a.trim() || opts.default || '')
    })
  })
}
