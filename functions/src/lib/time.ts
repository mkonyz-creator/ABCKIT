/** Company-local dates (East Africa Time, UTC+3, no daylight saving). */
const EAT_OFFSET_MS = 3 * 3600 * 1000

export function companyToday(now = new Date()): string {
  return new Date(now.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10)
}

/** ISO timestamp of 00:00 EAT of the company day containing `now`. */
export function startOfCompanyDayIso(now = new Date()): string {
  return new Date(Date.parse(`${companyToday(now)}T00:00:00Z`) - EAT_OFFSET_MS).toISOString()
}

export function daysAgoIso(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86400_000).toISOString()
}
