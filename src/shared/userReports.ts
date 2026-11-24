/**
 * Reports to the admin ("Ripoti kwa Admin"): any active user sends a problem, request, complaint, safety issue or
 * idea; administrators (users.manage) see every report, reply and set its status. The reporter sees only their own.
 * Mirrors firebase/rules/10_core.rules (match /user_reports) and src/backend/domains/core.ts.
 */
export const USER_REPORTS = 'user_reports'
export const USER_REPORT_ADMIN_PERM = 'users.manage'

export const REPORT_CATEGORIES = ['problem', 'request', 'complaint', 'safety', 'idea', 'other'] as const
export const REPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export const REPORT_STATUSES = ['open', 'in_review', 'resolved', 'closed'] as const
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]
export type ReportPriority = (typeof REPORT_PRIORITIES)[number]
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export const REPORT_LIMITS = { subject: 200, body: 5000, reply: 5000, page: 300 } as const

export const CATEGORY_LABEL: Record<ReportCategory, { en: string; sw: string }> = {
  problem: { en: 'Problem / bug', sw: 'Tatizo / hitilafu' },
  request: { en: 'Request', sw: 'Ombi' },
  complaint: { en: 'Complaint', sw: 'Lalamiko' },
  safety: { en: 'Safety / incident', sw: 'Usalama / ajali' },
  idea: { en: 'Idea / suggestion', sw: 'Wazo / pendekezo' },
  other: { en: 'Other', sw: 'Nyingine' },
}
export const PRIORITY_LABEL: Record<ReportPriority, { en: string; sw: string }> = {
  low: { en: 'Low', sw: 'Chini' },
  normal: { en: 'Normal', sw: 'Kawaida' },
  high: { en: 'High', sw: 'Juu' },
  urgent: { en: 'Urgent', sw: 'Dharura' },
}
export const STATUS_LABEL: Record<ReportStatus, { en: string; sw: string }> = {
  open: { en: 'New', sw: 'Mpya' },
  in_review: { en: 'In review', sw: 'Inashughulikiwa' },
  resolved: { en: 'Resolved', sw: 'Imetatuliwa' },
  closed: { en: 'Closed', sw: 'Imefungwa' },
}

export interface UserReport {
  id: string
  reporter_id: string
  category: ReportCategory
  priority: ReportPriority
  subject: string
  body: string
  page: string | null
  status: ReportStatus
  admin_reply: string | null
  handled_by: string | null
  handled_at: string | null
  created_at: string
  updated_at: string
}
