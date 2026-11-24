/**
 * Operational monitoring rules — pure functions shared by the scheduled Cloud Function (aiMonitor) and
 * Demo Mode. Input rows are ABCkit documents exactly as stored (see src/backend/schema.generated.ts).
 *
 * IMPLEMENTATION OWNED BY THE FUNCTIONS WORK (see functions/src/ai/monitor*.ts); keep this file pure:
 * no Node/browser APIs, no clock (the date comes from `input.today`), deterministic output order.
 */
import type { AiSettings, AlertType, Priority, RecordRef } from './contract.js'

type Row = Record<string, any>

export interface MonitorInput {
  /** YYYY-MM-DD (company local date) */
  today: string
  settings: Pick<AiSettings, 'schedule_slip_threshold_pct' | 'approval_stale_days' | 'low_stock_alerts'>
  projects: Row[]
  tasks: Row[]
  boqs: Row[]
  site_reports: Row[]
  safety_incidents: Row[]
  purchase_requests: Row[]
  purchase_orders: Row[]
  financial_transactions: Row[]
  client_invoices: Row[]
  supplier_invoices: Row[]
  leave_requests: Row[]
  materials: Row[]
  /** analysed emails of the last 14 days (AiEmail rows) */
  emails: Row[]
  /** suppliers / clients for matching email senders to records */
  suppliers: Row[]
  clients: Row[]
}

export interface AlertCandidate {
  dedupe_key: string
  type: AlertType
  priority: Priority
  title: string
  description: string
  source: 'monitor' | 'email'
  record: RecordRef | null
  project: { id: string; name: string } | null
  recommended_action: string
}

// ----------------------------------------------------------------------------- helpers

const RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2, urgent: 3 }
const BY_RANK: Priority[] = ['low', 'medium', 'high', 'urgent']

export function maxPriority(a: Priority, b: Priority): Priority {
  return RANK[a] >= RANK[b] ? a : b
}
export function raisePriority(p: Priority, steps = 1): Priority {
  return BY_RANK[Math.min(3, RANK[p] + steps)]
}
function asPriority(v: unknown, d: Priority = 'medium'): Priority {
  return typeof v === 'string' && v in RANK ? (v as Priority) : d
}

/** 'YYYY-MM-DD' (or the date part of an ISO timestamp) → whole days since epoch, or null. */
function dayNum(v: unknown): number | null {
  if (typeof v !== 'string' || v.length < 10) return null
  const t = Date.parse(`${v.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(t) ? Math.floor(t / 86400000) : null
}
function daysBetween(from: unknown, to: unknown): number | null {
  const a = dayNum(from)
  const b = dayNum(to)
  return a === null || b === null ? null : b - a
}
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
function money(v: number, currency?: unknown) {
  const c = str(currency) || 'TZS'
  return `${c} ${Math.round(v).toLocaleString('en-US')}`
}
function lower(v: unknown) {
  return str(v).trim().toLowerCase()
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com', 'zoho.com',
])
function domainOf(address: unknown): string {
  const a = lower(address)
  const at = a.lastIndexOf('@')
  return at > 0 ? a.slice(at + 1) : ''
}

const OPEN_PO = new Set(['pending_approval', 'approved', 'sent', 'partially_received'])
const DELIVERY_PENDING_PO = new Set(['approved', 'sent', 'partially_received'])
const OPEN_TASK = new Set(['todo', 'in_progress', 'review', 'blocked'])

// ----------------------------------------------------------------------------- rules

/** Every condition that currently needs management attention. Deterministic for a given input. */
export function computeAlerts(input: MonitorInput): AlertCandidate[] {
  const { today, settings } = input
  const out = new Map<string, AlertCandidate>()
  const add = (a: AlertCandidate) => {
    const prev = out.get(a.dedupe_key)
    if (!prev || RANK[a.priority] > RANK[prev.priority]) out.set(a.dedupe_key, a)
  }

  const projects = new Map<string, Row>()
  for (const p of input.projects ?? []) if (p?.id) projects.set(str(p.id), p)
  const projectRef = (id: unknown): { id: string; name: string } | null => {
    const p = projects.get(str(id))
    return p ? { id: str(p.id), name: str(p.name) || str(p.code) || 'Project' } : null
  }
  const projectLabel = (id: unknown) => {
    const p = projects.get(str(id))
    return p ? ` (${str(p.code) ? `${str(p.code)} ` : ''}${str(p.name)})`.replace(' ()', '') : ''
  }
  const isActiveProject = (id: unknown) => projects.get(str(id))?.status === 'active'
  const suppliers = new Map<string, Row>()
  for (const s of input.suppliers ?? []) if (s?.id) suppliers.set(str(s.id), s)
  const clients = new Map<string, Row>()
  for (const c of input.clients ?? []) if (c?.id) clients.set(str(c.id), c)

  // approved money movements
  const approvedTx = (input.financial_transactions ?? []).filter((t) => t?.status === 'approved')
  const txAmount = (t: Row) => num(t.amount_base ?? t.amount)

  // ---- 1. projects behind schedule / past end date
  const thr = Math.max(0, num(settings.schedule_slip_threshold_pct))
  for (const p of projects.values()) {
    if (p.is_archived === true) continue
    const status = str(p.status)
    const name = str(p.name) || str(p.code) || 'Project'
    const record: RecordRef = { table: 'projects', id: str(p.id), label: name, link: `/projects/${str(p.id)}` }
    const progress = Math.max(0, Math.min(100, num(p.progress)))
    const pastEnd = daysBetween(p.end_date, today)
    if ((status === 'active' || status === 'on_hold') && pastEnd !== null && pastEnd > 0 && progress < 100) {
      add({
        dedupe_key: `project_past_end:${record.id}`,
        type: 'project_behind_schedule',
        priority: pastEnd > 30 ? 'urgent' : 'high',
        title: `${name} is past its end date`,
        description: `The planned end date was ${str(p.end_date).slice(0, 10)} (${plural(pastEnd, 'day')} ago) and the project is ${progress}% complete (status: ${status}).`,
        source: 'monitor',
        record,
        project: { id: record.id, name },
        recommended_action: 'Review the programme with the project manager, agree a recovery plan or a revised completion date, and inform the client if needed.',
      })
      continue
    }
    if (status !== 'active') continue
    const total = daysBetween(p.start_date, p.end_date)
    const elapsed = daysBetween(p.start_date, today)
    if (total === null || elapsed === null || total <= 0 || elapsed <= 0) continue
    const elapsedPct = Math.min(100, (elapsed / total) * 100)
    const slip = elapsedPct - progress
    if (slip > thr) {
      add({
        dedupe_key: `project_behind_schedule:${record.id}`,
        type: 'project_behind_schedule',
        priority: slip >= Math.max(25, thr * 2.5) ? 'high' : 'medium',
        title: `${name} is behind schedule`,
        description: `${Math.round(elapsedPct)}% of the planned time has passed (${str(p.start_date).slice(0, 10)} to ${str(p.end_date).slice(0, 10)}) but progress is ${progress}% — ${Math.round(slip)} points behind (threshold ${thr}).`,
        source: 'monitor',
        record,
        project: { id: record.id, name },
        recommended_action: 'Check the latest site reports and tasks for delays, and ask the project manager for a recovery plan.',
      })
    }
  }

  // ---- 2. budget overrun (approved expenses vs project budget)
  const spentByProject = new Map<string, number>()
  for (const t of approvedTx) {
    if (t.direction !== 'expense' || !t.project_id) continue
    spentByProject.set(str(t.project_id), (spentByProject.get(str(t.project_id)) ?? 0) + txAmount(t))
  }
  for (const p of projects.values()) {
    if (p.is_archived === true || p.status === 'cancelled') continue
    const budget = num(p.budget)
    const spent = spentByProject.get(str(p.id)) ?? 0
    if (budget <= 0 || spent <= 0) continue
    const name = str(p.name) || 'Project'
    const pct = (spent / budget) * 100
    const progress = num(p.progress)
    const record: RecordRef = { table: 'projects', id: str(p.id), label: name, link: `/projects/${str(p.id)}` }
    if (pct > 100) {
      add({
        dedupe_key: `budget_overrun:${record.id}`,
        type: 'budget_overrun',
        priority: pct >= 115 ? 'urgent' : 'high',
        title: `${name} is over budget`,
        description: `Approved expenses are ${money(spent, p.currency)} against a budget of ${money(budget, p.currency)} (${Math.round(pct)}%), with progress at ${progress}%.`,
        source: 'monitor',
        record,
        project: { id: record.id, name },
        recommended_action: 'Review project costs with finance and the project manager; check for unapproved variations and update the cost forecast.',
      })
    } else if (pct >= 90 && progress < 80 && p.status !== 'completed') {
      add({
        dedupe_key: `budget_risk:${record.id}`,
        type: 'budget_overrun',
        priority: 'medium',
        title: `${name} has used ${Math.round(pct)}% of its budget`,
        description: `Approved expenses are ${money(spent, p.currency)} of ${money(budget, p.currency)} while progress is only ${progress}%.`,
        source: 'monitor',
        record,
        project: { id: record.id, name },
        recommended_action: 'Prepare a cost-to-complete forecast and confirm whether a budget revision or variation claim is needed.',
      })
    }
  }

  // ---- 3. overdue tasks
  for (const t of input.tasks ?? []) {
    if (!OPEN_TASK.has(str(t.status))) continue
    const late = daysBetween(t.due_date, today)
    if (late === null || late <= 0) continue
    const tp = str(t.priority)
    let pr: Priority = tp === 'critical' ? 'urgent' : tp === 'high' ? 'high' : tp === 'low' ? 'low' : 'medium'
    if (late > 14) pr = raisePriority(pr)
    add({
      dedupe_key: `task_overdue:${str(t.id)}`,
      type: 'task_overdue',
      priority: pr,
      title: `Task overdue: ${str(t.title) || 'Untitled task'}`,
      description: `Due ${str(t.due_date).slice(0, 10)} (${plural(late, 'day')} ago), status ${str(t.status)}${projectLabel(t.project_id)}.`,
      source: 'monitor',
      record: { table: 'tasks', id: str(t.id), label: str(t.title) || 'Task', link: '/tasks' },
      project: projectRef(t.project_id),
      recommended_action: 'Follow up with the assignee, update the due date or reassign the task.',
    })
  }

  // ---- 4. stale approvals
  const stale = Math.max(0, num(settings.approval_stale_days))
  const approval = (table: string, row: Row, since: unknown, what: string, link: string, label: string, approver: string, base: Priority = 'medium') => {
    const age = daysBetween(since, today)
    if (age === null || age <= stale) return
    add({
      dedupe_key: `approval_pending:${table}:${str(row.id)}`,
      type: 'approval_pending',
      priority: age > Math.max(stale * 3, stale + 5) ? raisePriority(base) : base,
      title: `${what} awaiting approval for ${plural(age, 'day')}`,
      description: `${label}${projectLabel(row.project_id)} has been waiting for approval since ${str(since).slice(0, 10)}.`,
      source: 'monitor',
      record: { table, id: str(row.id), label, link },
      project: projectRef(row.project_id),
      recommended_action: `${approver} should review and approve or reject it.`,
    })
  }
  for (const b of input.boqs ?? [])
    if (b.status === 'submitted') approval('boqs', b, b.updated_at ?? b.created_at, 'BOQ', `/boq/${str(b.id)}`, `BOQ ${str(b.number) || str(b.title)}`.trim(), 'The commercial manager')
  for (const r of input.site_reports ?? [])
    if (r.status === 'submitted')
      approval('site_reports', r, r.submitted_at ?? r.updated_at ?? r.created_at, 'Site report', `/site-reports/${str(r.id)}`, `Site report ${str(r.number) || str(r.report_date)}`.trim(), 'The project manager')
  for (const r of input.purchase_requests ?? [])
    if (r.status === 'submitted')
      approval('purchase_requests', r, r.updated_at ?? r.created_at, 'Purchase request', '/procurement', `Purchase request ${str(r.number)}`.trim(), 'The procurement approver', r.priority === 'urgent' || r.priority === 'high' ? 'high' : 'medium')
  for (const o of input.purchase_orders ?? [])
    if (o.status === 'pending_approval') approval('purchase_orders', o, o.updated_at ?? o.created_at, 'Purchase order', '/procurement', `Purchase order ${str(o.number)}`.trim(), 'The procurement approver')
  for (const t of input.financial_transactions ?? [])
    if (t.status === 'pending')
      approval('financial_transactions', t, t.created_at ?? t.transaction_date, 'Payment / transaction', '/finance', `${t.direction === 'income' ? 'Receipt' : 'Payment'} ${str(t.number)} of ${money(txAmount(t), t.currency)}`.trim(), 'Finance')
  for (const l of input.leave_requests ?? [])
    if (l.status === 'pending') approval('leave_requests', l, l.created_at, 'Leave request', '/workforce', `Leave request (${str(l.leave_type) || 'leave'}, from ${str(l.start_date).slice(0, 10)})`, 'HR / the line manager', 'low')

  // ---- 5. overdue invoices
  const paidClient = new Map<string, number>()
  const paidSupplier = new Map<string, number>()
  for (const t of approvedTx) {
    if (t.client_invoice_id) paidClient.set(str(t.client_invoice_id), (paidClient.get(str(t.client_invoice_id)) ?? 0) + txAmount(t))
    if (t.supplier_invoice_id) paidSupplier.set(str(t.supplier_invoice_id), (paidSupplier.get(str(t.supplier_invoice_id)) ?? 0) + txAmount(t))
  }
  for (const inv of input.client_invoices ?? []) {
    if (inv.status !== 'issued' && inv.status !== 'partially_paid') continue
    const late = daysBetween(inv.due_date, today)
    if (late === null || late <= 0) continue
    const balance = num(inv.total) - (paidClient.get(str(inv.id)) ?? 0)
    if (balance <= 0.005) continue
    const client = clients.get(str(inv.client_id))
    add({
      dedupe_key: `client_invoice_overdue:${str(inv.id)}`,
      type: 'payment_overdue',
      priority: late > 60 ? 'urgent' : late > 30 ? 'high' : 'medium',
      title: `Client invoice ${str(inv.number)} overdue by ${plural(late, 'day')}`.replace('  ', ' '),
      description: `${client ? `${str(client.name)} owes` : 'Outstanding balance'} ${money(balance, inv.currency)} on invoice ${str(inv.number)} (due ${str(inv.due_date).slice(0, 10)})${projectLabel(inv.project_id)}.`,
      source: 'monitor',
      record: { table: 'client_invoices', id: str(inv.id), label: `Invoice ${str(inv.number)}`.trim(), link: '/finance' },
      project: projectRef(inv.project_id),
      recommended_action: 'Contact the client for payment and confirm whether any certificate or document is holding the payment back.',
    })
  }
  for (const inv of input.supplier_invoices ?? []) {
    if (inv.status !== 'unpaid' && inv.status !== 'partially_paid') continue
    const late = daysBetween(inv.due_date, today)
    if (late === null || late <= 0) continue
    const balance = num(inv.total) - (paidSupplier.get(str(inv.id)) ?? 0)
    if (balance <= 0.005) continue
    const sup = suppliers.get(str(inv.supplier_id))
    add({
      dedupe_key: `supplier_invoice_overdue:${str(inv.id)}`,
      type: 'payment_overdue',
      priority: late > 30 ? 'high' : 'medium',
      title: `Supplier invoice ${str(inv.invoice_no)} overdue by ${plural(late, 'day')}`.replace('  ', ' '),
      description: `${money(balance, inv.currency)} is unpaid${sup ? ` to ${str(sup.name)}` : ''} on invoice ${str(inv.invoice_no)} (due ${str(inv.due_date).slice(0, 10)})${projectLabel(inv.project_id)}.`,
      source: 'monitor',
      record: { table: 'supplier_invoices', id: str(inv.id), label: `Supplier invoice ${str(inv.invoice_no)}`.trim(), link: '/finance' },
      project: projectRef(inv.project_id),
      recommended_action: 'Schedule the payment or agree new terms with the supplier to protect deliveries.',
    })
  }

  // ---- 6. purchase orders past expected delivery
  const openPosBySupplier = new Map<string, Row[]>()
  for (const o of input.purchase_orders ?? []) {
    if (OPEN_PO.has(str(o.status)) && o.supplier_id) {
      const list = openPosBySupplier.get(str(o.supplier_id)) ?? []
      list.push(o)
      openPosBySupplier.set(str(o.supplier_id), list)
    }
    if (!DELIVERY_PENDING_PO.has(str(o.status))) continue
    const late = daysBetween(o.expected_date, today)
    if (late === null || late <= 0) continue
    const sup = suppliers.get(str(o.supplier_id))
    let pr: Priority = late > 7 ? 'high' : 'medium'
    if (isActiveProject(o.project_id) && late > 3) pr = maxPriority(pr, 'high')
    add({
      dedupe_key: `po_delivery_overdue:${str(o.id)}`,
      type: 'delivery_overdue',
      priority: pr,
      title: `Delivery overdue: PO ${str(o.number)}`.trim(),
      description: `Expected on ${str(o.expected_date).slice(0, 10)} (${plural(late, 'day')} ago)${sup ? ` from ${str(sup.name)}` : ''}; status ${str(o.status).replace('_', ' ')}${projectLabel(o.project_id)}.`,
      source: 'monitor',
      record: { table: 'purchase_orders', id: str(o.id), label: `PO ${str(o.number)}`.trim(), link: '/procurement' },
      project: projectRef(o.project_id),
      recommended_action: 'Call the supplier for a firm delivery date and check whether site work is affected.',
    })
  }

  // ---- 7. open safety incidents
  for (const s of input.safety_incidents ?? []) {
    if (s.status !== 'open' && s.status !== 'investigating') continue
    const sev = str(s.severity)
    const pr: Priority = sev === 'fatal' ? 'urgent' : sev === 'major' ? 'high' : sev === 'moderate' ? 'medium' : 'low'
    add({
      dedupe_key: `safety_incident:${str(s.id)}`,
      type: 'site_issue',
      priority: pr,
      title: `Open safety incident (${sev || 'unknown severity'})${projectLabel(s.project_id)}`,
      description: `${str(s.category) ? `${str(s.category)}: ` : ''}${str(s.description).slice(0, 300)} — reported ${str(s.incident_date).slice(0, 10)}, status ${str(s.status)}.`,
      source: 'monitor',
      record: { table: 'safety_incidents', id: str(s.id), label: 'Safety incident', link: s.report_id ? `/site-reports/${str(s.report_id)}` : s.project_id ? `/projects/${str(s.project_id)}` : null },
      project: projectRef(s.project_id),
      recommended_action: 'Make sure the investigation is completed, corrective actions are taken and the incident is closed.',
    })
  }

  // ---- 8. low stock
  if (settings.low_stock_alerts) {
    for (const m of input.materials ?? []) {
      if (m.is_active === false) continue
      const min = num(m.min_stock)
      const cur = num(m.current_stock)
      if (min <= 0 || cur > min) continue
      add({
        dedupe_key: `low_stock:${str(m.id)}`,
        type: 'low_stock',
        priority: cur <= 0 ? 'high' : 'medium',
        title: `Low stock: ${str(m.name)}`,
        description: `Current stock ${cur} ${str(m.unit)} is at or below the minimum of ${min} ${str(m.unit)}.`.replace(/\s+\./, '.'),
        source: 'monitor',
        record: { table: 'materials', id: str(m.id), label: str(m.name) || 'Material', link: '/inventory' },
        project: null,
        recommended_action: 'Raise a purchase request or move stock from another store.',
      })
    }
  }

  // ---- 9. alerts from analysed emails
  const supplierByEmail = new Map<string, Row>()
  const supplierByDomain = new Map<string, Row>()
  for (const s of [...suppliers.values()].sort((a, b) => str(a.id).localeCompare(str(b.id)))) {
    const e = lower(s.email)
    if (!e) continue
    if (!supplierByEmail.has(e)) supplierByEmail.set(e, s)
    const d = domainOf(e)
    if (d && !FREE_MAIL.has(d) && !supplierByDomain.has(d)) supplierByDomain.set(d, s)
  }
  const matchSupplier = (email: Row): Row | null => {
    const party = email.ai?.related_party
    if (party?.type === 'supplier' && party.id && suppliers.has(str(party.id))) return suppliers.get(str(party.id))!
    const from = lower(email.from?.address)
    if (from && supplierByEmail.has(from)) return supplierByEmail.get(from)!
    const d = domainOf(from)
    if (d && !FREE_MAIL.has(d) && supplierByDomain.has(d)) return supplierByDomain.get(d)!
    return null
  }

  for (const e of input.emails ?? []) {
    const ai = e?.ai
    if (!ai || e.status !== 'analyzed' || e.folder === 'sent') continue
    const id = str(e.id)
    const subject = str(e.subject) || '(no subject)'
    const sender = str(e.from?.name) || str(e.from?.address) || 'unknown sender'
    const record: RecordRef = { table: 'ai_emails', id, label: subject, link: `/ai?tab=email&email=${encodeURIComponent(id)}` }
    const aiPr = asPriority(ai.priority)
    const flags = ai.flags ?? {}
    const caution = flags.suspicious_instructions ? ' Caution: this email contains instructions aimed at automated systems — verify it independently.' : ''
    const relProject = ai.related_project_id && projects.has(str(ai.related_project_id)) ? str(ai.related_project_id) : null
    const summary = str(ai.summary).slice(0, 400)

    if (flags.delivery_issue) {
      const sup = matchSupplier(e)
      const pos = sup ? [...(openPosBySupplier.get(str(sup.id)) ?? [])].sort((a, b) => str(a.number).localeCompare(str(b.number)) || str(a.id).localeCompare(str(b.id))) : []
      let pr = maxPriority(aiPr, 'medium')
      const activePo = pos.find((o) => isActiveProject(o.project_id))
      if (activePo) pr = raisePriority(pr)
      if (pos.some((o) => DELIVERY_PENDING_PO.has(str(o.status)) && (daysBetween(o.expected_date, today) ?? 0) > 0)) pr = maxPriority(pr, 'high')
      const projId = relProject ?? (activePo ? str(activePo.project_id) : pos.find((o) => o.project_id) ? str(pos.find((o) => o.project_id)!.project_id) : null)
      const poText = pos.length
        ? ` Open purchase orders with this supplier: ${pos
            .slice(0, 5)
            .map((o) => `PO ${str(o.number)}${o.expected_date ? ` (expected ${str(o.expected_date).slice(0, 10)})` : ''}${projectLabel(o.project_id)}`)
            .join('; ')}${pos.length > 5 ? `; and ${pos.length - 5} more` : ''}.`
        : sup
          ? ' No open purchase orders were found for this supplier.'
          : ' The sender could not be matched to a supplier in ABCkit.'
      add({
        dedupe_key: `supplier_delivery_issue:${id}`,
        type: 'supplier_delivery_issue',
        priority: pr,
        title: `Delivery issue reported by ${sup ? str(sup.name) : sender}`,
        description: `${summary}${poText}${caution}`,
        source: 'email',
        record,
        project: projectRef(projId),
        recommended_action: str(ai.required_action) || 'Confirm the new delivery date with the supplier and check the impact on the site programme; arrange an alternative supplier if needed.',
      })
      continue
    }
    if (flags.complaint || ai.category === 'complaint') {
      let pr = maxPriority(aiPr, 'high')
      if (relProject && isActiveProject(relProject) && aiPr === 'high') pr = 'urgent'
      add({
        dedupe_key: `client_complaint:${id}`,
        type: 'client_complaint',
        priority: pr,
        title: `Complaint from ${str(ai.related_party?.name) || sender}`,
        description: `${summary}${caution}`,
        source: 'email',
        record,
        project: projectRef(relProject),
        recommended_action: str(ai.required_action) || 'Acknowledge the complaint quickly, investigate with the project team and reply with a clear plan.',
      })
      continue
    }
    if (aiPr === 'urgent' || (aiPr === 'high' && ai.is_important === true)) {
      add({
        dedupe_key: `urgent_email:${id}`,
        type: 'urgent_email',
        priority: aiPr,
        title: `${aiPr === 'urgent' ? 'Urgent' : 'Important'} email: ${subject}`,
        description: `From ${sender}. ${summary}${ai.deadline ? ` Deadline: ${str(ai.deadline)}.` : ''}${caution}`,
        source: 'email',
        record,
        project: projectRef(relProject),
        recommended_action: str(ai.required_action) || 'Read the email and assign someone to respond.',
      })
    }
  }

  return [...out.values()].sort((a, b) => RANK[b.priority] - RANK[a.priority] || a.dedupe_key.localeCompare(b.dedupe_key))
}
