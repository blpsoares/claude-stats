/**
 * useAttachmentSizes — how big each sent file is, asked of the server and never guessed.
 *
 * A `HEAD` on `/api/fleet/attachment/by-name`, which answers the size WITHOUT the bytes — that is
 * the whole reason the route accepts the method. Downloading a file to learn its length is not a
 * measurement, it is a download, and this panel routinely holds sixty screenshots.
 *
 * A name that could not be measured stays ABSENT from the map, and `formatBytes(undefined)` is `''`
 * — so the row shows a name and a format and no size, rather than a `0 B` that is a confident wrong
 * answer. Two things land there legitimately: a file the route refuses (it serves images only) and
 * one that is no longer on disk.
 *
 * Each name is asked at most once per mount. The set only grows while a conversation is open, so a
 * poll that adds a message costs one request for its files and nothing for the ones already known.
 */

import { useEffect, useRef, useState } from 'react'
import { attachmentNameUrl } from '../lib/attachmentUrl'

export function useAttachmentSizes(names: readonly string[]): Record<string, number> {
  const [sizes, setSizes] = useState<Record<string, number>>({})
  /** Every name already asked about — answered or not. A failed HEAD is not retried on each poll. */
  const asked = useRef(new Set<string>())

  useEffect(() => {
    const pending = names.filter(n => !asked.current.has(n))
    if (pending.length === 0) return
    for (const n of pending) asked.current.add(n)

    const ctrl = new AbortController()
    void (async () => {
      const found: Record<string, number> = {}
      await Promise.all(pending.map(async name => {
        try {
          const res = await fetch(attachmentNameUrl(name), { method: 'HEAD', signal: ctrl.signal })
          if (!res.ok) return
          const len = Number(res.headers.get('content-length'))
          if (Number.isFinite(len) && len >= 0) found[name] = len
        } catch {
          // Refused, gone, or the request was abandoned. All three mean the same thing to the row:
          // there is no size to show. Nothing is invented and nothing is logged — a panel that
          // fills the console on every unmount is a panel nobody can debug in.
        }
      }))
      if (!ctrl.signal.aborted && Object.keys(found).length > 0) {
        setSizes(prev => ({ ...prev, ...found }))
      }
    })()

    return () => ctrl.abort()
  }, [names])

  return sizes
}
