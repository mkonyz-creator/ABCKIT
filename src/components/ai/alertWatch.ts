/**
 * "ABC AI is the first to know": while someone with ai.view has ABCkit open,
 *  - the monitor (rule-based checks over projects, tasks, budgets, stock, safety, payments, emails…) is kept
 *    running: if the last run is older than MONITOR_EVERY_MS the app asks the server for a run (the server lock
 *    prevents double runs; the scheduled job does the same every 30 minutes when deployed);
 *  - every NEW high / urgent alert arrives through the realtime listener and is announced by the assistant
 *    (a message in the panel, a toast and — if voice is on — spoken aloud).
 */
import { useEffect, useRef } from 'react'
import { db } from '@/lib/backend'
import { callAi } from '@/lib/ai/api'
import { AI_COLLECTIONS, type AiAlert, type AiStatus } from '@/shared/ai/contract'

export const MONITOR_EVERY_MS = 30 * 60 * 1000
export const CHECK_EVERY_MS = 5 * 60 * 1000
const FIRST_CHECK_MS = 8000

/** the monitor has not run recently (or never) */
export function monitorDue(status: Pick<AiStatus, 'last_monitor_at'> | null | undefined, now = Date.now()): boolean {
  const last = status?.last_monitor_at ? Date.parse(status.last_monitor_at) : NaN
  return !Number.isFinite(last) || now - last >= MONITOR_EVERY_MS
}

/** a new alert worth interrupting the user for */
export function shouldAnnounce(a: Partial<AiAlert> | null | undefined, seen: Set<string>, since: number): a is AiAlert {
  if (!a?.id || seen.has(a.id)) return false
  if (a.status !== 'open' || (a.priority !== 'urgent' && a.priority !== 'high')) return false
  const first = a.first_seen_at ? Date.parse(a.first_seen_at) : NaN
  // only alerts that appeared while the app is open (not old ones re-delivered at subscription)
  return !Number.isFinite(first) || first >= since - 60_000
}

/** short sentence for the panel / speech */
export function alertMessage(a: AiAlert, lang: 'sw' | 'en'): { text: string; speech: string } {
  const urgent = a.priority === 'urgent'
  const head = lang === 'sw' ? (urgent ? 'Tahadhari ya dharura' : 'Tahadhari muhimu') : urgent ? 'Urgent alert' : 'High-priority alert'
  const project = a.project?.name ? ` (${a.project.name})` : ''
  const action = a.recommended_action ? `\n\n${lang === 'sw' ? 'Hatua inayopendekezwa' : 'Recommended action'}: ${a.recommended_action}` : ''
  const ask = lang === 'sw' ? 'Niulize "nieleze tahadhari hii" kwa maelezo zaidi.' : 'Ask me "explain this alert" for details.'
  return {
    text: `⚠️ **${head}:** ${a.title}${project}\n\n${a.description}${action}\n\n_${ask}_`,
    speech: `${head}. ${a.title}${project}. ${a.description}`.slice(0, 400),
  }
}

export interface AlertWatchOptions {
  enabled: boolean
  status: Pick<AiStatus, 'last_monitor_at'> | null | undefined
  onAlert: (a: AiAlert) => void
  /** after a monitor run (refresh the status / alert queries) */
  onMonitorRun?: () => void
}

export function useAlertWatch({ enabled, status, onAlert, onMonitorRun }: AlertWatchOptions) {
  const onAlertRef = useRef(onAlert)
  const onRunRef = useRef(onMonitorRun)
  const statusRef = useRef(status)
  useEffect(() => {
    onAlertRef.current = onAlert
    onRunRef.current = onMonitorRun
    statusRef.current = status
  })

  // new alerts → announce
  useEffect(() => {
    if (!enabled) return
    const since = Date.now()
    const seen = new Set<string>()
    const ch = db
      .channel('ai-first-to-know')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: AI_COLLECTIONS.alerts, filter: 'status=eq.open' }, (payload: { new?: Partial<AiAlert> }) => {
        const a = payload?.new
        if (!shouldAnnounce(a, seen, since)) return
        seen.add(a.id)
        onAlertRef.current(a)
      })
      .subscribe()
    return () => void db.removeChannel(ch)
  }, [enabled])

  // keep the monitor running
  useEffect(() => {
    if (!enabled) return
    let busy = false
    let retryAt = 0
    const check = async () => {
      if (busy || Date.now() < retryAt || (typeof document !== 'undefined' && document.hidden) || !monitorDue(statusRef.current)) return
      busy = true
      try {
        await callAi(db.functions, 'aiRunMonitor', {})
      } catch {
        // no permission / AI off / server not deployed: the alerts page shows those errors; try again later
        retryAt = Date.now() + MONITOR_EVERY_MS
      } finally {
        busy = false
        onRunRef.current?.()
      }
    }
    const first = setTimeout(() => void check(), FIRST_CHECK_MS)
    const every = setInterval(() => void check(), CHECK_EVERY_MS)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [enabled])
}
