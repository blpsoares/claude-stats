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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <AppRouter />
    </RootErrorBoundary>
  </React.StrictMode>
)
