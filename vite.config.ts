import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'logo.svg', 'icons/*.png'],
      manifest: {
        name: 'ABCkit – Aricom Building Contractors Work Kit',
        short_name: 'ABCkit',
        description: 'Construction management platform for ARICOM BUILDING CONTRACTORS',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        categories: ['business', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'New site report', url: './#/site-reports/new', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Dashboard', url: './#/', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // the offline wake-word engine (~6 MB) is only downloaded by people who switch "Hey ABC" on
        globIgnores: ['**/vosk*.js'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        // Firestore keeps its own offline cache (IndexedDB); only cache public branding files here
        runtimeCaching: [
          {
            // wake-word engine + speech model: downloaded once, then reused offline
            urlPattern: ({ url }) => url.pathname.endsWith('.tar.gz') || /\/assets\/vosk[^/]*\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'abckit-wakeword', expiration: { maxEntries: 4 } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'firebasestorage.googleapis.com' && url.pathname.includes('branding%2F'),
            handler: 'CacheFirst',
            options: { cacheName: 'abckit-public-files', expiration: { maxEntries: 50 } },
          },
        ],
      },
    }),
  ],
  resolve: {
    // Resolve from the folder Vite was started in (not this file's URL): on Windows a server started as
    // "c:\..." vs "C:\..." would otherwise load modules twice (two React contexts → blank page).
    alias: { '@': resolve(process.cwd(), 'src') },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
  },
} as import('vite').UserConfig)
