// Security-rules tests: run against the Firestore emulator with `npm run test:rules` (needs Java 21+).
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  // never load the real project's .env.local here: these tests talk to the emulators only
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    env: {
      VITE_USE_EMULATORS: 'true',
      VITE_FIREBASE_PROJECT_ID: 'demo-abckit',
      VITE_FIREBASE_API_KEY: 'fake-api-key',
      VITE_FIREBASE_APP_ID: 'fake-app-id',
      VITE_FIREBASE_AUTH_DOMAIN: 'demo-abckit.firebaseapp.com',
    },
    environment: 'node',
    include: ['tests/rules/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
