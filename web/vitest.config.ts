import { defineConfig } from 'vitest/config'

// Standalone config on purpose: it does NOT import vite.config.ts, so the
// Tailwind and PWA plugins (which only make sense for a real browser build)
// never load during tests. The default environment is node; DOM-dependent
// tests opt in with a `// @vitest-environment jsdom` docblock at the top.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
