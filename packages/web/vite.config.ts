import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const apiPort = process.env.PORT ?? '47291'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Service worker disabled in dev: it cached stale bundles during iteration,
      // making code changes appear not to take effect. Still enabled for prod builds.
      devOptions: { enabled: false, suppressWarnings: true, type: 'module' },
      // `icons/*.png` covers the central variants too; the central favicon needs naming.
      includeAssets: ['favicon.ico', 'favicon-central.ico', 'minimalistLogo.png', 'icons/*.png'],
      manifest: {
        name: 'Agentistics',
        short_name: 'Agentistics',
        description: 'Local analytics dashboard for AI coding assistants',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f0f12',
        theme_color: '#D97706',
        icons: [
          // Transparent mark, no backdrop — what desktop taskbars/docks draw verbatim.
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Opaque plate, glyph confined to the safe-zone circle — for OSes (Android/ChromeOS)
          // that crop icons to their own adaptive shape. A maskable icon must stay opaque
          // edge-to-edge, or the crop reveals holes; it must never double as the 'any' icon,
          // or the same edge-to-edge plate is what painted the black square being fixed here.
          { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache only static assets; API calls always go to network
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: null,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    allowedHosts: true,
    host: true,
    // Dev UI port. Defaults to 47292; the central dev flow sets WEB_PORT=48080 so you open the
    // same URL as the Docker container (which publishes 48080). API stays proxied below.
    port: Number(process.env.WEB_PORT ?? 47292),
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        // WEBSOCKETS TOO, and without this line the write channels are dead in dev while
        // everything else works. Both of them ride an upgrade (`/api/fleet/input`,
        // `/api/shell/input`); a proxy entry without `ws` forwards ordinary requests and silently
        // DROPS the handshake, so the socket times out with no status to look up — the live screen
        // keeps drawing over SSE (a plain GET) and typing into it just does nothing.
        ws: true,
      },
    },
  },
})
