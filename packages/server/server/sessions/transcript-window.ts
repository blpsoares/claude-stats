/**
 * transcript-window.ts — reading the END of a growing JSONL transcript, for every harness.
 *
 * A live transcript is appended to for as long as its session runs and is read on every poll of
 * every session. `chat-tail.ts` documents what reading the WHOLE file costs, measured: nine active
 * Claude transcripts totalling 31 MB, re-read and re-split every five seconds, which is what made
 * `/api/fleet` answer in 5–8 s warm and 36 s cold. Antigravity's are the same order — 5.6 MB on the
 * one live conversation measured here — so the second harness to be read must not re-learn this.
 *
 * The window GROWS rather than truncating the answer. A window that happened to cut through the
 * middle of the last few turns would silently show fewer of them, and a detail pane quietly missing
 * the newest message is worse than a slow one. Growth is bounded, and a file smaller than the
 * window is simply read whole.
 */

import { open } from 'node:fs/promises'

/** The first window tried, and the point past which the whole file is being read anyway. */
export const TAIL_BYTES = 256 * 1024
export const MAX_TAIL_BYTES = 16 * 1024 * 1024

/**
 * The last `bytes` of a file, as text, plus whether that reached the file's start.
 *
 * A window that starts mid-file almost always starts mid-LINE, and can also start mid-CHARACTER for
 * any multi-byte codepoint. Both are handled by the same rule: `windowLines` below drops everything
 * before the first newline, so the partial line — and any broken byte sequence inside it — never
 * reaches `JSON.parse`.
 */
export async function readTailBytes(
  path: string,
  bytes: number,
): Promise<{ text: string; atStart: boolean } | null> {
  let fh
  try { fh = await open(path, 'r') } catch { return null }
  try {
    const size = (await fh.stat()).size
    const start = Math.max(0, size - bytes)
    const length = size - start
    if (length === 0) return { text: '', atStart: true }
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, start)
    return { text: buf.toString('utf-8'), atStart: start === 0 }
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

/** The whole lines inside one window — the half-line the window cut through is dropped. */
export function windowLines(tail: { text: string; atStart: boolean }): string[] {
  // Everything before the first newline belongs to a line this window cut in half — it is already
  // present, whole, further up the file, and parsing the fragment would at best fail and at worst
  // succeed on a truncated object.
  const content = tail.atStart ? tail.text : tail.text.slice(tail.text.indexOf('\n') + 1)
  return content.split('\n')
}

/**
 * Read the end of `path` until `parse` has produced `want` items, widening the window as needed.
 *
 * `parse` is given the whole lines of one window and returns what it found there; it is called
 * again on a wider window whenever it came back short AND the window had not yet reached the start
 * of the file. Fewer than `want` with the window at the start means the file really is that short.
 */
export async function readTailWindow<T>(
  path: string,
  want: number,
  parse: (lines: string[], atStart: boolean) => T[],
  first: number = TAIL_BYTES,
  max: number = MAX_TAIL_BYTES,
): Promise<T[]> {
  let window = first
  let out: T[] = []
  for (;;) {
    const tail = await readTailBytes(path, window)
    if (!tail) return out
    out = parse(windowLines(tail), tail.atStart)
    if (out.length >= want || tail.atStart || window >= max) return out
    window = Math.min(window * 4, max)
  }
}
