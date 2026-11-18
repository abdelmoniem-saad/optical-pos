import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Refuse to build a mis-flagged app: a typo must never produce a read-write
 * "phone view" or a shop PC that writes straight to the cloud (web/OFFLINE.md).
 */
function checkDeploymentFlags(command: string, mode: string) {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')
  const dataMode = (env.VITE_DATA_MODE ?? '').trim().toLowerCase()
  const readOnly = (env.VITE_READ_ONLY ?? '').trim().toLowerCase()
  const problems: string[] = []
  if (dataMode && dataMode !== 'supabase' && dataMode !== 'local') {
    problems.push(`VITE_DATA_MODE must be "supabase" or "local" (got "${env.VITE_DATA_MODE}")`)
  }
  if (readOnly && readOnly !== 'true' && readOnly !== 'false') {
    problems.push(`VITE_READ_ONLY must be "true" or "false" (got "${env.VITE_READ_ONLY}")`)
  }
  if (dataMode === 'local' && readOnly === 'true') {
    problems.push('VITE_READ_ONLY=true cannot be combined with VITE_DATA_MODE=local')
  }
  // Phones can't open the register's address: QR codes need the cloud app's URL.
  if (command === 'build' && dataMode === 'local' && !(env.VITE_CLOUD_URL ?? '').trim()) {
    problems.push('VITE_CLOUD_URL is required for the shop PC build (VITE_DATA_MODE=local)')
  }
  if (problems.length) throw new Error(`LensyPOS build settings: ${problems.join('; ')}`)
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  checkDeploymentFlags(command, mode)
  return config
})

const config = {
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'LensyPOS',
        short_name: 'LensyPOS',
        description: 'Optical retail point of sale',
        theme_color: '#1976d2',
        background_color: '#f5f5f7',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the app shell + assets only; Supabase API calls fall through
        // to the network (cached reads come from the TanStack Query persister).
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    // Honor a port assigned by the launch/preview tooling (PORT env), else 5173.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    host: true, // expose on LAN so shop tablets can hit the dev server
  },
}
