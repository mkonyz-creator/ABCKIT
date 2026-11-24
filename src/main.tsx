import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App'
import './index.css'
import { initOfflineSync } from './lib/offline'
import { AuthProvider } from './providers/AuthProvider'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err: any) => count < 2 && !['42501', 'PGRST116', 'PGRST301'].includes(err?.code),
      refetchOnWindowFocus: false,
      networkMode: 'offlineFirst',
    },
    mutations: { networkMode: 'online' },
  },
})

const rootEl = document.getElementById('root')!

function boot() {
  initOfflineSync()
  render()
}

function render() {
  createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* HashRouter: works on any static host and inside an Electron file:// shell */}
      <HashRouter>
        <AuthProvider>
          <App />
          <Toaster position="top-right" richColors closeButton toastOptions={{ className: 'font-sans' }} />
        </AuthProvider>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
  )
}

boot()
