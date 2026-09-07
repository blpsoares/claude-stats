import React from 'react'
import ReactDOM from 'react-dom/client'
import AppRouter from './AppRouter'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import './index.css'

/**
 * IN DEV, EVICT ANY SERVICE WORKER THAT IS STILL CONTROLLING THIS PAGE.
 *
 * `vite.config.ts` stopped REGISTERING one in dev, and that was not enough: a worker installed
 * before that change keeps serving its cached bundle until something unregisters it. The symptom is
 * the worst kind — code that is provably correct on disk, tested green, and visibly absent in the
 * browser. It cost three rounds of "this did not change" on work that had shipped, so the app
 * cleans up after itself rather than asking somebody to remember DevTools.
 *
 * Dev only, and it also drops the caches the worker left behind: unregistering alone leaves the
 * Cache Storage entries it was serving from. Production is untouched — there the worker is the
 * feature.
 */
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations()
    .then(regs => Promise.all(regs.map(r => r.unregister())))
    .then(async done => {
      if (!done.some(Boolean)) return
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
      }
      // One reload, and only after a worker was actually removed — otherwise this is a loop.
      location.reload()
    })
    .catch(() => { /* nothing to clean up, or the browser refused; the page still works */ })
}

/**
 * A CHUNK FROM A BUILD THAT NO LONGER EXISTS RELOADS ONCE, INSTEAD OF SHOWING A STACK TRACE.
 *
 * Reported as an error screen appearing "em diversas telas diferentes", with
 * `ReferenceError: Cannot access 'W' before initialization` inside a lazily-loaded chunk. Nothing
 * in the source explains it — the import graph has no cycle that reaches it, and the same screen is
 * clean under Chromium AND under WebKit. What does explain it is the situation this app is in all
 * day: the server is rebuilt while a phone has the page open. The document holds `index-<old>.js`,
 * asks for a route's chunk minutes later, and the shared chunk that chunk expects has been replaced
 * by a build with different hashes. The pieces load and disagree.
 *
 * `vite:preloadError` fires exactly there, and a reload fixes it because `index.html` is served
 * `no-store` — the next load is a coherent set. Once, guarded by a flag, because a reload loop is
 * strictly worse than the error it replaces: the flag is cleared on any successful navigation, so a
 * genuinely broken deploy still lands on the error screen with its details rather than spinning.
 */
const RELOADED = 'ag-chunk-reloaded'
window.addEventListener('vite:preloadError', event => {
  let already = false
  try { already = sessionStorage.getItem(RELOADED) === '1' } catch { /* private mode */ }
  if (already) return
  try { sessionStorage.setItem(RELOADED, '1') } catch { /* nothing to remember it with */ }
  event.preventDefault()
  location.reload()
})
window.addEventListener('load', () => {
  // Cleared once a load completes, so the guard only ever suppresses a SECOND reload inside one
  // broken sequence rather than the next legitimate one.
  window.setTimeout(() => { try { sessionStorage.removeItem(RELOADED) } catch { /* ignore */ } }, 5_000)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <AppRouter />
    </RootErrorBoundary>
  </React.StrictMode>
)
