import { useEffect, useState } from 'react'

/**
 * Is this tab on screen right now?
 *
 * It exists for the unwatch discipline: a capture loop is two tmux reads a second, and a
 * backgrounded tab is a screen nobody can see. `shellWatching` reads this alongside the band's own
 * state, and the stream hook is handed `null` while it is false — which drops the subscription, and
 * the server's hub then stops capturing when the last reader leaves.
 *
 * Guarded for an environment with no `document` (a test DOM, SSR): assumed visible, because the
 * alternative is a surface that never opens its stream at all.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  )

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return visible
}
