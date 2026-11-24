import { useRegisterSW } from 'virtual:pwa-register/react'
import { RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Shows a banner when a new version of the app has been downloaded. */
export function PwaPrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true })

  if (!needRefresh && !offlineReady) return null
  return (
    <div role="status" className="fixed bottom-20 left-1/2 z-[60] flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-black p-3 text-sm text-white shadow-2xl lg:bottom-6">
      <span className="h-8 w-1 shrink-0 rounded-full bg-accent" />
      <p className="flex-1">{needRefresh ? 'A new version of ABCkit is available.' : 'ABCkit is ready to work offline.'}</p>
      {needRefresh && (
        <Button size="sm" variant="primary" onClick={() => updateServiceWorker(true)}>
          <RefreshCw /> Update
        </Button>
      )}
      <button
        className="rounded p-1 text-white/70 hover:text-white"
        aria-label="Dismiss"
        onClick={() => {
          setNeedRefresh(false)
          setOfflineReady(false)
        }}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
