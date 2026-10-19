// Isolated visual fixture: no real Supabase client, credentials or network writes.
// Run: npm run dev -- --config qa/vite.config.ts --host 127.0.0.1 --port 5174
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  plugins: [{ name: 'isolated-visual-data', enforce: 'pre', resolveId(id, importer) {
    if (id.endsWith('/lib/supabase') || (id === './supabase' && importer?.replaceAll('\\','/').includes('/src/lib/'))) return fileURLToPath(new URL('./supabase.ts', import.meta.url))
  } }, react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5174 },
})
