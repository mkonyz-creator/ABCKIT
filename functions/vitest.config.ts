// Unit tests for the Cloud Functions. Run from the repo root:
//   node node_modules/vitest/vitest.mjs run --config functions/vitest.config.ts
// No network, credentials or emulators are needed: Firestore, fetch and the Anthropic client are faked.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')

export default defineConfig({
  root: repoRoot,
  resolve: {
    // functions/src/shared/ai is a build-time copy of src/shared/ai: test against the source of truth
    alias: [{ find: /^(?:\.\.?\/)+shared\/ai\/(.*)\.js$/, replacement: `${repoRoot}/src/shared/ai/$1.ts` }],
  },
  test: {
    environment: 'node',
    include: ['functions/src/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
