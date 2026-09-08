/**
 * Prompt — the text / confirm primitives, replacing `server/cli-ui.ts` on the TTY path (that
 * module stays as the non-TTY fallback).
 *
 * The editing is written out by hand rather than pulled from `ink-text-input`: the compiled binary
 * resolves node_modules statically, so every added dependency is a build that can only fail at
 * `bun run build:binary` — the same class of problem the `react-devtools-core` stub exists for. A
 * single-line field is a few lines of `useInput`; a dependency is not worth it.
 *
 * Both are drawn into a pane the cockpit hands them, beside the panes that say what is being acted
 * on, so they carry no framing and no title of their own. Every label arrives already localized;
 * nothing here knows a language.
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { COLORS } from '../theme'
import { truncate } from '../components/Primitives'
import { Menu } from './Menu'
import { Question, questionRows } from './Surface'
import { promptLayout } from './surface.ts'

/** Block cursor. A trailing space would be invisible, and the field would look unfocused. */
const CURSOR = '▏'

export interface TextPromptProps {
  /** Already-localized question. */
  label: string
  /** Dim text shown in place of an empty value. */
  placeholder?: string
  /** Offered in parentheses and submitted when the field is left empty. */
  defaultValue?: string
  /** Mask the value — the member token is pasted in front of other people. */
  secret?: boolean
  onSubmit: (value: string) => void
  /**
   * Called on EVERY keystroke, when the caller wants the answer as it is typed.
   *
   * Optional because most of these prompts must not act early: a member token is meaningless until
   * it is whole, and a rename applied per character would write six labels while somebody types
   * one. A SEARCH is the opposite — the whole value of it is watching the list narrow — so it is
   * the caller that decides, not this component.
   */
  onChange?: (value: string) => void
  onCancel?: () => void
  width: number
  isActive?: boolean
}

/** One control chord, however this terminal chose to deliver it — the letter, or the raw byte. */
function isCtrl(input: string, ctrl: boolean, letter: string, byte: string): boolean {
  return (ctrl && input === letter) || input === byte
}

/**
 * Delete the word before the cursor, the way a shell's `ctrl+w` does: the run of spaces first, then
 * the run of non-spaces. Deleting only the word leaves the trailing space behind, so pressing it
 * twice in a row appears to do nothing the second time.
 */
export function deleteWord(v: string): string {
  const trimmed = v.replace(/\s+$/, '')
  const cut = trimmed.lastIndexOf(' ')
  return cut === -1 ? '' : trimmed.slice(0, cut + 1)
}

export function TextPrompt({
  label,
  placeholder,
  defaultValue,
  secret,
  onSubmit,
  onChange,
  onCancel,
  width,
  isActive = true,
}: TextPromptProps) {
  const [value, setValue] = useState('')
  // One place that changes the value, so `onChange` cannot be forgotten on a path — and it fires
  // with the NEW value rather than reading state that has not re-rendered yet.
  const edit = (next: (v: string) => string): void => {
    setValue(v => { const n = next(v); onChange?.(n); return n })
  }

  useInput((input, key) => {
    if (key.escape) { onCancel?.(); return }
    if (key.return) { onSubmit(value.trim() || defaultValue || ''); return }
    // The line editor, such as it is: clear-line and delete-word, the two a long paste needs.
    // Matched on BOTH the letter and the raw control byte — Ink translates `ctrl+u` to `'u'` with
    // `key.ctrl` set, but a paste or a terminal that sends the byte straight through arrives as
    // `\x15` with `key.ctrl` unset, and the printable filter below would then silently drop it. A
    // clear-line that works only sometimes is worse than none: you press it, nothing happens, and
    // you go back to holding backspace.
    if (isCtrl(input, key.ctrl, 'u', '\x15')) { edit(() => ''); return }
    if (isCtrl(input, key.ctrl, 'w', '\x17')) { edit(deleteWord); return }
    if (key.backspace || key.delete) { edit(v => v.slice(0, -1)); return }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return

    // A paste arrives as one multi-character chunk; control bytes inside it would corrupt the
    // rendered row, so only printable characters are kept.
    const printable = [...input].filter(ch => ch >= ' ' && ch !== '\x7f').join('')
    if (printable) edit(v => v + printable)
  }, { isActive })

  const suffix = defaultValue ? ` (${defaultValue})` : ''
  const shown = secret ? '•'.repeat(value.length) : value
  // Whether the field shares the question's row is a measurement, not a preference: inside the
  // cockpit's right column "Member token (from the central's Team Manager)" leaves a field five
  // columns wide, and a field that narrow cannot show that a paste arrived.
  const layout = promptLayout(label, suffix, width)
  // Keep the TAIL of a long value: what was just typed matters more than what scrolled off the left.
  const tail = shown.length > layout.room ? shown.slice(shown.length - layout.room) : shown

  const field = (
    <>
      {tail
        ? <Text color={COLORS.text}>{tail}</Text>
        : placeholder ? <Text dimColor>{truncate(placeholder, layout.room)}</Text> : null}
      <Text color={COLORS.accent}>{CURSOR}</Text>
    </>
  )

  if (layout.inline) {
    return (
      <Box flexDirection="row">
        <Text bold>{truncate(label, width)}</Text>
        {suffix ? <Text dimColor>{suffix}</Text> : null}
        <Text dimColor> › </Text>
        {field}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {layout.head.map((line, i) => <Text key={i} bold>{line}</Text>)}
      <Box flexDirection="row">
        <Text dimColor>{'› '}</Text>
        {field}
      </Box>
    </Box>
  )
}

export interface ConfirmPromptProps {
  label: string
  yesLabel: string
  noLabel: string
  /** Which answer the cursor starts on. */
  initial?: boolean
  onAnswer: (yes: boolean) => void
  onCancel?: () => void
  width: number
  /** Rows available. Given, the question is capped so the two answers can never be pushed off. */
  height?: number
  isActive?: boolean
  /** Where this prompt's first row sits in the frame the shell is emitting. See `Menu.origin`. */
  origin?: { x: number; y: number }
}

/**
 * A yes/no question rendered as a two-item `Menu` — the same shape `cli-ui.ts` uses today, so a
 * confirmation and a selection are the same interaction and nothing has to be re-learned.
 *
 * The question is WRAPPED rather than truncated. Every one of them is a sentence with the stakes at
 * the end — "A server is already running here — stop it and start a new one?" — and the cockpit
 * asks them in a column narrow enough that the old single truncated row cut the question off at
 * "already running here…", which asks the user to answer something they cannot read.
 */
export function ConfirmPrompt({
  label,
  yesLabel,
  noLabel,
  initial = false,
  onAnswer,
  onCancel,
  width,
  height,
  isActive = true,
  origin,
}: ConfirmPromptProps) {
  // Two answers plus a blank row between them and the question; anything above that the question
  // may have, and the cap is what stops a long sentence from compositing over the answers.
  const ANSWERS = 3
  const maxQuestion = height === undefined ? 3 : Math.max(1, height - ANSWERS)
  // The question is WRAPPED, so how many rows stand between this prompt's origin and its two
  // answers is a measurement rather than a constant — `questionRows` is the same call the height
  // budget below makes, so the pointer and the layout cannot disagree about it.
  const asked = questionRows(label, width, maxQuestion)

  return (
    <Box flexDirection="column">
      <Question text={label} width={width} maxRows={maxQuestion} />
      <Text> </Text>
      <Menu
        items={[
          { label: yesLabel, value: 'yes' },
          { label: noLabel, value: 'no' },
        ]}
        initialIndex={initial ? 0 : 1}
        onSelect={v => onAnswer(v === 'yes')}
        onCancel={onCancel}
        width={width}
        isActive={isActive}
        height={height === undefined ? undefined : Math.max(1, height - asked - 1)}
        origin={origin && { x: origin.x, y: origin.y + asked + 1 }}
      />
    </Box>
  )
}
