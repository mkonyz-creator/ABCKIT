import { describe, expect, it } from 'vitest'
import type { AiAlert } from '@/shared/ai/contract'
import { alertMessage, MONITOR_EVERY_MS, monitorDue, shouldAnnounce } from './alertWatch'

const NOW = Date.parse('2026-11-16T10:00:00Z')
const alert = (over: Partial<AiAlert> = {}): AiAlert => ({
  id: 'a1',
  dedupe_key: 'project_delayed:p1',
  type: 'project_delayed' as AiAlert['type'],
  priority: 'urgent',
  title: 'Mwanza Bridge is 25% behind schedule',
  description: 'Progress 40% with 65% of the time used.',
  source: 'monitor',
  record: null,
  project: { id: 'p1', name: 'Mwanza Bridge' },
  recommended_action: 'Review the programme with the site engineer.',
  status: 'open',
  first_seen_at: new Date(NOW).toISOString(),
  last_seen_at: new Date(NOW).toISOString(),
  resolved_at: null,
  acknowledged_by: null,
  acknowledged_at: null,
  is_demo: false,
  ...over,
})

describe('the assistant is the first to know', () => {
  it('runs the monitor when it never ran or the last run is 30+ minutes old', () => {
    expect(monitorDue(null, NOW)).toBe(true)
    expect(monitorDue({ last_monitor_at: null }, NOW)).toBe(true)
    expect(monitorDue({ last_monitor_at: new Date(NOW - 5 * 60_000).toISOString() }, NOW)).toBe(false)
    expect(monitorDue({ last_monitor_at: new Date(NOW - MONITOR_EVERY_MS).toISOString() }, NOW)).toBe(true)
  })

  it('announces only NEW open high / urgent alerts, once', () => {
    const seen = new Set<string>()
    expect(shouldAnnounce(alert(), seen, NOW)).toBe(true)
    seen.add('a1')
    expect(shouldAnnounce(alert(), seen, NOW)).toBe(false)
    expect(shouldAnnounce(alert({ id: 'a2', priority: 'high' }), seen, NOW)).toBe(true)
    expect(shouldAnnounce(alert({ id: 'a3', priority: 'medium' as AiAlert['priority'] }), seen, NOW)).toBe(false)
    expect(shouldAnnounce(alert({ id: 'a4', status: 'acknowledged' }), seen, NOW)).toBe(false)
    // an old alert re-delivered when the listener starts is not "new"
    expect(shouldAnnounce(alert({ id: 'a5', first_seen_at: new Date(NOW - 3600_000).toISOString() }), seen, NOW)).toBe(false)
    expect(shouldAnnounce(null, seen, NOW)).toBe(false)
  })

  it('says what happened, where, and what to do — in Kiswahili or English', () => {
    const sw = alertMessage(alert(), 'sw')
    expect(sw.text).toContain('Tahadhari ya dharura')
    expect(sw.text).toContain('(Mwanza Bridge)')
    expect(sw.text).toContain('Hatua inayopendekezwa: Review the programme')
    expect(sw.speech.startsWith('Tahadhari ya dharura. Mwanza Bridge is 25% behind schedule')).toBe(true)
    expect(alertMessage(alert({ priority: 'high' }), 'en').text).toContain('High-priority alert')
  })
})
