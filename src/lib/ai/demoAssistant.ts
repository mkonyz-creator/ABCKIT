/**
 * [DEMO] rule-based assistant — stands in for the `aiComplete` callable in Demo Mode. NO AI MODEL IS CALLED.
 *
 * It speaks the same protocol as the real server, so the chat/report UI and its tool loop are exercised
 * unchanged: on a new question it maps English/Kiswahili keywords to data tools and returns tool_use blocks;
 * the app runs those tools locally (under the demo user's permissions) and sends the results back; this module
 * then composes a Markdown answer from those results with fixed rules.
 */
import type { CallableContracts } from '@/shared/ai/contract'
import { addDays } from './tools'

type Req = CallableContracts['aiComplete']['req']
type Res = CallableContracts['aiComplete']['res']
type Block = { type: string; [k: string]: any }
type Msg = { role: 'user' | 'assistant'; content: string | Block[] }
type Call = { name: string; input: Record<string, unknown> }
type Done = { call: Call; ok: boolean; data: any }

export const DEMO_MODEL = 'demo-rule-based (no AI model)'
export const DEMO_BANNER = '> **[DEMO] rule-based assistant (no AI model is called).** This answer was assembled by fixed rules from the ABCkit records your role can see.'

// ----------------------------------------------------------------------------- language & intents

const SW_WORDS = /\b(niambie|kila|kinachoendelea|kampuni|leo|nini|miradi|mradi|barua|pepe|wasambazaji|msambazaji|malipo|je|gani|habari|ripoti|hali|wiki|idhini|haraka|muhimu|andaa|jibu|zipi|ipi|zilizo|kazi|tafadhali|mteja|wateja|matatizo|changamoto|ushauri|nishauri|nipe|ukurasa|huu|hapa|eleza|nieleze|naomba|kuhusu|hiki|hili|nifanye|vipi|sasa)\b/i

export function detectLanguage(q: string): 'en' | 'sw' {
  const hits = (q.match(new RegExp(SW_WORDS.source, 'gi')) ?? []).length
  return hits >= 2 || /\b(niambie|kinachoendelea|andaa|wasambazaji)\b/i.test(q) ? 'sw' : 'en'
}

type Intent =
  | 'overview'
  | 'behind'
  | 'emails_today'
  | 'urgent_emails'
  | 'communications'
  | 'deliveries'
  | 'approvals'
  | 'reply'
  | 'full_report'
  | 'attention'
  | 'finance'
  | 'tasks'
  | 'site'
  | 'inventory'
  | 'workforce'
  | 'alerts'
  | 'project'
  | 'knowledge'
  | 'progress'
  | 'summarize_email'

const has = (q: string, re: RegExp) => re.test(q)
/** "how far is project X", "mradi umefika wapi", "progress ya projects" */
const PROGRESS_WORDS = /\bprogress\b|how far|umefika wapi|imefika wapi|maendeleo ya mradi|asilimia ngapi|percent(age)? complete/i

export function detectIntents(question: string): Intent[] {
  const q = question.toLowerCase()
  const out = new Set<Intent>()
  const email = has(q, /\b(e-?mails?|mail|inbox|barua|communications?|mawasiliano|messages?)\b/)
  // a project analysis prompt mentions many topics; the project tool already covers them
  if (has(q, /\(id [^)]+\)|analy[sz]e the project|chambua mradi/) && /\(id [^)\s]+\)/.test(question)) return ['project']
  if (has(q, /\b(reply|respond|response|jibu|andaa jibu)\b/) && email) out.add('reply')
  if (has(q, /complete|full|operations report|ripoti kamili|comprehensive|operations/) && has(q, /report|ripoti|overview|summary/)) out.add('full_report')
  if (has(q, /daily brief|muhtasari wa leo|kila kinachoendelea|everything|what'?s (going on|happening)|overview|hali ya kampuni|habari za kampuni/)) out.add('overview')
  // one email: "summarise the latest email", "nifupishie barua ya mwisho"
  const oneEmail = has(q, /\b(this|that|the|latest|last|newest|hii|hiyo|ya mwisho|mpya zaidi)\b.{0,20}\b(e-?mail|barua)\b|\b(e-?mail|barua( pepe)?)\b.{0,12}\b(hii|hiyo|ya mwisho|mpya zaidi)\b/)
  if (email && !out.has('reply') && oneEmail && has(q, /summari[sz]e|summary|fupisha|nifupishie|muhtasari/)) out.add('summarize_email')
  else if (email && !out.has('reply')) {
    if (has(q, /urgent|haraka|attention|need my|zinahitaji/)) out.add('urgent_emails')
    else if (has(q, /week|wiki|digest|summari[sz]e|muhtasari/)) out.add('communications')
    else out.add('emails_today')
  }
  if (has(q, /behind schedule|nyuma ya ratiba|delayed projects?|late projects?|on track|schedule|ratiba|zimechelewa/) && !has(q, /deliver|supplier|msambazaji|wasambazaji/)) out.add('behind')
  if (has(q, /deliver|supplier|msambazaji|wasambazaji|usafirishaji|purchase orders?/)) out.add('deliveries')
  if (has(q, /approv|idhini|kuidhinishwa|pending/)) out.add('approvals')
  if (!email && has(q, /attention|require|issues|zinahitaji|matatizo|changamoto/)) out.add('attention')
  if (has(q, /payment|invoice|receivable|payable|cash|finance|malipo|fedha|ankara|budget|bajeti/)) out.add('finance')
  if (has(q, /\btasks?\b|kazi zilizochelewa|overdue/) && !email) out.add('tasks')
  if (has(q, /site|safety|incident|usalama|ajali|eneo/)) out.add('site')
  if (has(q, /stock|inventory|materials?|vifaa|store/)) out.add('inventory')
  if (has(q, /workforce|staff|employees?|attendance|wafanyakazi|leave|likizo/)) out.add('workforce')
  if (has(q, /alerts?|tahadhari|warnings?|risks?|hatari/)) out.add('alerts')
  if (has(q, PROGRESS_WORDS)) out.add('progress')
  if (has(q, /polic|sera|company profile|who are we|history|historia|procedure|utaratibu/)) out.add('knowledge')
  return [...out]
}

function plan(intents: Intent[], question: string, today: string): Call[] {
  const calls: Call[] = []
  const add = (name: string, input: Record<string, unknown> = {}) => {
    if (!calls.some((c) => c.name === name && JSON.stringify(c.input) === JSON.stringify(input))) calls.push({ name, input })
  }
  const projectId = question.match(/\(id ([^)\s]+)\)/)?.[1]
  for (const i of intents) {
    switch (i) {
      case 'project':
        if (projectId) add('get_project_details', { project: projectId })
        break
      case 'full_report':
        for (const n of ['get_company_overview', 'get_projects', 'get_pending_approvals', 'list_deliveries', 'get_financial_summary', 'list_site_issues', 'get_inventory_alerts', 'get_workforce_summary', 'list_alerts'])
          add(n)
        add('search_emails', { important_only: true, from_date: addDays(today, -7), limit: 10 })
        break
      case 'overview':
        add('get_company_overview')
        add('list_alerts', { limit: 8 })
        add('get_pending_approvals')
        add('search_emails', { important_only: true, from_date: addDays(today, -2), limit: 8 })
        break
      case 'behind':
        add('get_projects', { behind_schedule: true })
        break
      case 'emails_today':
        add('search_emails', { important_only: true, from_date: today, to_date: today, limit: 20 })
        break
      case 'urgent_emails':
        add('search_emails', { priority: 'high', unanswered_only: true, limit: 15 })
        break
      case 'communications':
        add('search_emails', { important_only: true, from_date: addDays(today, -7), limit: 25 })
        break
      case 'deliveries':
        add('list_deliveries')
        break
      case 'approvals':
        add('get_pending_approvals')
        break
      case 'reply':
        add('search_emails', { category: 'client', limit: 1 })
        break
      case 'attention':
        add('list_alerts', { priority: 'high' })
        add('list_tasks', { overdue_only: true })
        add('search_emails', { priority: 'high', unanswered_only: true, limit: 8 })
        add('get_pending_approvals')
        add('list_site_issues')
        break
      case 'finance':
        add('get_financial_summary')
        break
      case 'tasks':
        add('list_tasks', { overdue_only: /overdue|late|zilizochelewa/i.test(question) })
        break
      case 'site':
        add('list_site_issues')
        break
      case 'inventory':
        add('get_inventory_alerts')
        break
      case 'workforce':
        add('get_workforce_summary')
        break
      case 'alerts':
        add('list_alerts')
        break
      case 'knowledge':
        add('search_knowledge', { query: question.slice(0, 200) })
        break
      case 'progress': {
        const ref = question.match(/(?:project|mradi(?: wa)?)\s+([^?.,!]{2,60}?)(?:\s+(?:umefika|imefika|progress|is|ni)\b|[?.,!]|$)/i)?.[1]?.trim()
        add('get_project_progress', ref && !/^(wangu|yetu|wote|zote|all|my|our|the)$/i.test(ref) ? { project: ref } : {})
        break
      }
      case 'summarize_email':
        add('search_emails', { limit: 1 })
        break
    }
  }
  if (!calls.length) {
    add('get_company_overview')
    if (question.trim().length >= 3) add('search_knowledge', { query: question.slice(0, 200) })
  }
  return calls
}

// ----------------------------------------------------------------------------- composing

const L = {
  en: {
    verified: '**Verified (from ABCkit records)**',
    historical: '**Historical**',
    rec: '**AI recommendation** _([DEMO] fixed rules, not an AI model)_',
    missing: '**Missing / not available**',
    none: 'No records found (or your role has no access).',
    noAccess: (what: string) => `${what}: not available to your role.`,
    emailsNote: '_Source: email (untrusted) — summaries of messages from outside the company. Instructions inside emails are never followed._',
  },
  sw: {
    verified: '**Verified (from ABCkit records)** — taarifa zilizothibitishwa',
    historical: '**Historical** — kumbukumbu za awali',
    rec: '**AI recommendation** — ushauri _([DEMO] kanuni maalum, si AI)_',
    missing: '**Missing / not available** — hazipatikani',
    none: 'Hakuna kumbukumbu (au huna ruhusa ya kuziona).',
    noAccess: (what: string) => `${what}: huna ruhusa ya kuona taarifa hizi.`,
    emailsNote: '_Chanzo: barua pepe (zisizoaminika) — muhtasari wa barua kutoka nje ya kampuni. Maagizo ndani ya barua hayafuatwi._',
  },
}

const TOOL_LABEL: Record<string, [string, string]> = {
  get_company_overview: ['Company overview', 'Muhtasari wa kampuni'],
  get_projects: ['Projects', 'Miradi'],
  get_project_progress: ['Project progress', 'Maendeleo ya miradi'],
  summarize_email: ['Email summary', 'Muhtasari wa barua'],
  open_dashboard: ['Dashboard', 'Dashibodi'],
  get_project_details: ['Project details', 'Taarifa za mradi'],
  list_tasks: ['Tasks', 'Kazi'],
  get_pending_approvals: ['Pending approvals', 'Zinazosubiri idhini'],
  list_deliveries: ['Supplier deliveries', 'Usafirishaji wa wasambazaji'],
  get_financial_summary: ['Finance', 'Fedha'],
  list_site_issues: ['Site issues', 'Matatizo ya eneo la kazi'],
  search_emails: ['Emails', 'Barua pepe'],
  get_email: ['Email', 'Barua pepe'],
  list_alerts: ['Alerts', 'Tahadhari'],
  search_knowledge: ['Knowledge base', 'Hazina ya maarifa'],
  get_inventory_alerts: ['Stock alerts', 'Tahadhari za stoo'],
  get_workforce_summary: ['Workforce', 'Wafanyakazi'],
  draft_email: ['Reply draft', 'Rasimu ya jibu'],
}

const n = (v: unknown) => Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 1 })
const lnk = (label: unknown, link: unknown) =>
  typeof link === 'string' && link.startsWith('/') && !/[\s()]/.test(link) ? `[${String(label ?? 'open').replace(/([[\]\\])/g, '\\$1')}](${link})` : String(label ?? '')
const when = (iso: unknown) => {
  const d = new Date(String(iso ?? ''))
  if (Number.isNaN(d.getTime())) return ''
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const noteOf = (d: any) => (d?.note && /no access|no records/i.test(String(d.note)) ? true : false)

const KPI_LABEL: Record<string, [string, string]> = {
  active_projects: ['Active projects', 'Miradi inayoendelea'],
  behind_schedule: ['Projects behind schedule', 'Miradi iliyo nyuma ya ratiba'],
  overdue_tasks: ['Overdue tasks', 'Kazi zilizochelewa'],
  pending_approvals: ['Pending approvals', 'Zinazosubiri idhini'],
  outstanding_payments: ['Overdue invoices (receivable + payable)', 'Ankara zilizopitwa na muda'],
  important_emails: ['New important emails (48 h, unanswered)', 'Barua pepe muhimu mpya'],
  pending_deliveries: ['Pending supplier deliveries', 'Usafirishaji unaosubiriwa'],
  client_communications: ['Important client communications (7 days)', 'Mawasiliano muhimu ya wateja'],
  site_issues: ['Unresolved site issues', 'Matatizo ya eneo yasiyotatuliwa'],
  critical_alerts: ['Critical alerts', 'Tahadhari muhimu'],
}

function emailLines(list: any[], lang: 'en' | 'sw') {
  return list.map((e) => {
    const flags = [e.priority && `**${e.priority}**`, e.category, e.answered ? (lang === 'sw' ? 'imejibiwa' : 'answered') : lang === 'sw' ? 'haijajibiwa' : 'unanswered'].filter(Boolean).join(' · ')
    const warn = e.suspicious_instructions ? (lang === 'sw' ? ' — **Onyo: barua hii ina maagizo ya kutiliwa shaka (yamepuuzwa).**' : ' — **Warning: contains suspicious instructions (ignored).**') : ''
    const action = e.required_action ? `\n  - ${lang === 'sw' ? 'Hatua' : 'Action'}: ${e.required_action}${e.deadline ? ` (${lang === 'sw' ? 'mwisho' : 'by'} ${e.deadline})` : ''}` : ''
    return `- ${lnk(e.subject, e.link)} — ${e.from ?? ''} (${when(e.date)}) · ${flags}${warn}\n  - ${e.summary}${action}`
  })
}

interface Composed {
  verified: string[]
  recommend: string[]
  missing: string[]
  untrustedEmail: boolean
}

function section(done: Done, lang: 'en' | 'sw', out: Composed, today: string) {
  const { call, ok, data } = done
  const T = L[lang]
  const title = TOOL_LABEL[call.name]?.[lang === 'sw' ? 1 : 0] ?? call.name
  if (!ok || !data) {
    out.missing.push(`${title}: ${data?.error ?? T.none}`)
    return
  }
  const v = out.verified
  switch (call.name) {
    case 'get_company_overview': {
      v.push(`#### ${title} (${data.as_of ?? today})`)
      for (const [k, val] of Object.entries<any>(data.kpis ?? {})) {
        const label = KPI_LABEL[k]?.[lang === 'sw' ? 1 : 0] ?? k
        if (val === 'no access') out.missing.push(T.noAccess(label))
        else v.push(`- ${label}: **${n(val)}**`)
      }
      if (data.critical_alerts?.length) out.recommend.push(lang === 'sw' ? `Shughulikia tahadhari ${data.critical_alerts.length} muhimu kwanza.` : `Deal with the ${data.critical_alerts.length} critical alert(s) first.`)
      break
    }
    case 'get_projects': {
      const ps = data.projects ?? []
      v.push(`#### ${title}${call.input.behind_schedule ? (lang === 'sw' ? ' — nyuma ya ratiba' : ' — behind schedule') : ''}`)
      if (!ps.length) v.push(`- ${call.input.behind_schedule ? (lang === 'sw' ? 'Hakuna mradi ulio nyuma ya ratiba.' : 'No active project is behind schedule.') : T.none}`)
      else {
        v.push(lang === 'sw' ? '| Mradi | Hali | Maendeleo | Muda uliopita | Tofauti |' : '| Project | Status | Progress | Time elapsed | Slip |', '|---|---|---:|---:|---:|')
        for (const p of ps.slice(0, 12))
          v.push(`| ${lnk(p.name, p.link)} | ${p.status}${p.past_end_date ? ' (past end date)' : ''} | ${n(p.progress_pct)}% | ${p.time_elapsed_pct == null ? '—' : `${n(p.time_elapsed_pct)}%`} | ${p.slip_pct == null ? '—' : `${n(p.slip_pct)} pts`} |`)
        const behind = ps.filter((p: any) => p.behind_schedule)
        if (behind.length)
          out.recommend.push(
            lang === 'sw'
              ? `Omba mpango wa kurejesha ratiba kwa: ${behind.map((p: any) => p.name).join(', ')}.`
              : `Ask the project manager(s) for a recovery programme for: ${behind.map((p: any) => p.name).join(', ')} (threshold ${n(data.threshold_pct)} percentage points).`,
          )
      }
      break
    }
    case 'get_project_details': {
      const p = data.project
      if (!p) {
        out.missing.push(`${title}: ${T.none}`)
        break
      }
      const s = data.schedule ?? {}
      v.push(`#### ${lnk(p.name, p.link)}`)
      v.push(`- ${lang === 'sw' ? 'Maendeleo' : 'Progress'}: **${n(s.progress_pct)}%** vs ${lang === 'sw' ? 'muda uliopita' : 'time elapsed'} **${s.elapsed_pct == null ? '—' : `${n(s.elapsed_pct)}%`}**${s.behind ? (lang === 'sw' ? ' — nyuma ya ratiba' : ' — **behind schedule**') : ''}`)
      if (typeof data.budget === 'object') v.push(`- Budget used: **${n(data.budget.budget_used_pct ?? 0)}%** (actual ${n(data.budget.actual_cost ?? 0)} of ${n(data.budget.budget ?? 0)})`)
      else out.missing.push(T.noAccess('Budget'))
      v.push(`- Open tasks: **${n(data.tasks?.open)}**, overdue: **${n(data.tasks?.overdue?.length)}**`)
      for (const t of (data.tasks?.overdue ?? []).slice(0, 5)) v.push(`  - ${t.title} (due ${t.due_date}${t.assignee ? `, ${t.assignee}` : ''})`)
      v.push(`- Pending approvals: **${n(data.pending_approvals?.length)}**`)
      for (const a of (data.pending_approvals ?? []).slice(0, 5)) v.push(`  - ${a.kind}: ${lnk(a.label, a.link)} (${a.age_days ?? 0} d)`)
      if (typeof data.site_issues === 'object') {
        const si = data.site_issues
        v.push(`- Site issues (30 d): **${n(si.open_incidents?.length + si.reported_problems?.length)}**`)
        for (const r of (si.reported_problems ?? []).slice(0, 3)) v.push(`  - ${lnk(r.number ?? 'Report', r.link)} ${r.date}: ${r.problems ?? ''}`)
      }
      if (Array.isArray(data.related_emails) && data.related_emails.length) {
        out.untrustedEmail = true
        v.push(`- Related emails: **${data.related_emails.length}**`, ...emailLines(data.related_emails.slice(0, 4), lang).map((l) => `  ${l}`))
      }
      for (const a of data.alerts ?? []) out.recommend.push(`${a.title}: ${a.recommended_action}`)
      if (s.behind) out.recommend.push('Agree a recovery plan with the project manager and review it at the next site meeting.')
      break
    }
    case 'list_tasks': {
      const ts = data.tasks ?? []
      v.push(`#### ${title}${call.input.overdue_only ? (lang === 'sw' ? ' zilizochelewa' : ' — overdue') : ''}`)
      if (!ts.length) v.push(`- ${call.input.overdue_only ? (lang === 'sw' ? 'Hakuna kazi iliyochelewa.' : 'No overdue tasks.') : T.none}`)
      for (const t of ts.slice(0, 10)) v.push(`- ${lnk(t.title, t.link)} — ${t.priority ?? ''} · due ${t.due_date ?? '—'}${t.assignee ? ` · ${t.assignee}` : ''}${t.project ? ` · ${t.project}` : ''}`)
      if (ts.some((t: any) => t.overdue)) out.recommend.push(lang === 'sw' ? 'Fuatilia kazi zilizochelewa na wahusika leo.' : 'Follow up overdue tasks with their owners today and agree new dates.')
      break
    }
    case 'get_pending_approvals': {
      const items = data.items ?? []
      v.push(`#### ${title}: ${n(data.total)}`)
      if (noteOf(data)) out.missing.push(T.noAccess(title))
      else if (!items.length) v.push(`- ${lang === 'sw' ? 'Hakuna kinachosubiri idhini.' : 'Nothing is waiting for approval.'}`)
      for (const g of data.by_project ?? []) v.push(`- ${g.project}: **${g.count}**`)
      for (const a of items.slice(0, 8)) v.push(`  - ${a.kind}: ${lnk(a.label, a.link)}${a.project ? ` (${a.project})` : ''} — ${a.age_days ?? 0} ${lang === 'sw' ? 'siku' : 'day(s)'}${a.stale ? (lang === 'sw' ? ' — imechelewa' : ' — **waiting too long**') : ''}`)
      if (items.some((a: any) => a.stale)) out.recommend.push(lang === 'sw' ? 'Toa maamuzi kwa vipengele vilivyosubiri muda mrefu.' : 'Decide the items that have waited longer than the approval reminder period.')
      break
    }
    case 'list_deliveries': {
      v.push(`#### ${title}`)
      if (Array.isArray(data.deliveries)) {
        const late = data.deliveries.filter((d: any) => d.overdue)
        if (!data.deliveries.length) v.push(`- ${lang === 'sw' ? 'Hakuna usafirishaji unaosubiriwa.' : 'No open deliveries.'}`)
        for (const d of data.deliveries.slice(0, 10))
          v.push(`- ${lnk(d.number, d.link)} — ${d.supplier ?? '—'}${d.project ? ` · ${d.project}` : ''} · expected ${d.expected_date ?? '—'}${d.overdue ? ` · **${d.days_overdue} day(s) late**` : ''}`)
        if (late.length) {
          v.push(`- ${lang === 'sw' ? 'Wasambazaji waliochelewa' : 'Suppliers with delayed deliveries'}: **${[...new Set(late.map((d: any) => d.supplier))].join(', ')}**`)
          out.recommend.push(lang === 'sw' ? 'Wasiliana na wasambazaji waliochelewa na uthibitishe tarehe mpya za kupeleka.' : 'Call the late suppliers, confirm new delivery dates in writing and check the impact on the programme.')
        }
      } else out.missing.push(T.noAccess(lang === 'sw' ? 'Manunuzi' : 'Procurement'))
      if (data.supplier_delivery_emails?.emails?.length) {
        out.untrustedEmail = true
        v.push(`- ${lang === 'sw' ? 'Barua za wasambazaji kuhusu ucheleweshaji' : 'Supplier emails about delivery problems'}:`, ...emailLines(data.supplier_delivery_emails.emails.slice(0, 5), lang).map((l) => `  ${l}`))
      }
      break
    }
    case 'get_financial_summary': {
      if (noteOf(data)) {
        out.missing.push(T.noAccess(title))
        break
      }
      v.push(`#### ${title}`)
      v.push(`- Receivables outstanding: **${n(data.receivables?.outstanding)}** (${n(data.receivables?.invoices)} invoices), overdue **${n(data.receivables?.overdue_amount)}**`)
      for (const i of data.receivables?.overdue_invoices ?? []) v.push(`  - ${lnk(i.number, i.link)} due ${i.due_date}: ${n(i.balance)} (${i.days_overdue} d overdue)`)
      v.push(`- Payables outstanding: **${n(data.payables?.outstanding)}**, overdue **${n(data.payables?.overdue_amount)}**`)
      for (const i of data.payables?.overdue_invoices ?? []) v.push(`  - ${i.invoice_no}${i.supplier ? ` (${i.supplier})` : ''} due ${i.due_date}: ${n(i.balance)}`)
      v.push(`- Transactions waiting for approval: **${n(data.pending_transactions)}**`)
      const months = (data.monthly ?? []).filter((m: any) => m.income || m.expense)
      if (months.length) {
        out.verified.push('', T.historical, '', '| Month | Income | Expense |', '|---|---:|---:|', ...months.map((m: any) => `| ${m.month} | ${n(m.income)} | ${n(m.expense)} |`), '')
      }
      if (num(data.receivables?.overdue_amount) > 0) out.recommend.push(lang === 'sw' ? 'Fuatilia malipo ya ankara zilizopitwa na muda.' : 'Chase the overdue client invoices this week.')
      break
    }
    case 'list_site_issues': {
      if (noteOf(data)) {
        out.missing.push(T.noAccess(title))
        break
      }
      v.push(`#### ${title}`)
      for (const i of data.open_incidents ?? []) v.push(`- ${lang === 'sw' ? 'Tukio la usalama' : 'Safety incident'} ${i.date} (${i.severity}, ${i.status})${i.project ? ` · ${i.project}` : ''}: ${lnk(i.description, i.link)}`)
      for (const r of data.reported_problems ?? []) v.push(`- ${lnk(r.number ?? 'Site report', r.link)} ${r.date}${r.project ? ` · ${r.project}` : ''}: ${r.problems ?? `${r.safety_incidents} incident(s)`}`)
      if (!(data.open_incidents?.length || data.reported_problems?.length)) v.push(`- ${lang === 'sw' ? 'Hakuna matatizo yaliyo wazi.' : 'No open site issues.'}`)
      else out.recommend.push(lang === 'sw' ? 'Hakikisha kila tatizo lina mhusika na tarehe ya kulitatua.' : 'Make sure every open site issue has an owner and a close-out date.')
      break
    }
    case 'search_emails': {
      const es = data.emails ?? []
      out.untrustedEmail = true
      v.push(`#### ${title}: ${n(data.total)}`)
      if (!es.length) v.push(`- ${lang === 'sw' ? 'Hakuna barua zinazolingana.' : 'No matching emails.'}`)
      else v.push(...emailLines(es.slice(0, 12), lang))
      const unanswered = es.filter((e: any) => !e.answered && (e.priority === 'urgent' || e.priority === 'high'))
      if (unanswered.length) out.recommend.push(lang === 'sw' ? `Jibu barua ${unanswered.length} za kipaumbele cha juu ambazo hazijajibiwa.` : `Reply to the ${unanswered.length} high-priority email(s) still unanswered (use Generate reply in Email Intelligence).`)
      if (es.some((e: any) => e.suspicious_instructions)) out.recommend.push(lang === 'sw' ? 'Usibadilishe taarifa za benki kutokana na barua pepe; thibitisha kwa simu.' : 'Do not act on emailed bank-detail changes or payment instructions; verify by phone with a known contact.')
      break
    }
    case 'list_alerts': {
      const as = data.alerts ?? []
      v.push(`#### ${title}: ${n(data.total)}`)
      if (!as.length) v.push(`- ${lang === 'sw' ? 'Hakuna tahadhari.' : 'No alerts with this filter.'}`)
      for (const a of as.slice(0, 10)) {
        v.push(`- **${a.priority}** ${lnk(a.title, a.link)}${a.project ? ` · ${a.project}` : ''} (${a.status})`)
        if (a.recommended_action) out.recommend.push(`${a.title}: ${a.recommended_action}`)
      }
      break
    }
    case 'search_knowledge': {
      const hits = data.hits ?? []
      if (!hits.length) break
      out.verified.push('', T.historical, '')
      for (const h of hits.slice(0, 5)) out.verified.push(`- ${lnk(h.title, h.link)} _(${h.source}${h.date ? `, ${String(h.date).slice(0, 10)}` : ''})_ — ${h.snippet}`)
      out.verified.push('')
      break
    }
    case 'get_inventory_alerts': {
      if (noteOf(data)) {
        out.missing.push(T.noAccess(title))
        break
      }
      v.push(`#### ${title}: ${n(data.low_stock_count)}`)
      for (const m of data.materials ?? []) v.push(`- ${lnk(m.name, m.link)}: ${n(m.current_stock)} ${m.unit} (min ${n(m.min_stock)})`)
      if (data.low_stock_count) out.recommend.push(lang === 'sw' ? 'Andaa maombi ya ununuzi kwa vifaa vilivyopungua.' : 'Raise purchase requests for the materials below minimum stock.')
      break
    }
    case 'get_workforce_summary': {
      if (noteOf(data)) {
        out.missing.push(T.noAccess(title))
        break
      }
      v.push(`#### ${title}`)
      v.push(`- Active employees: **${n(data.employees_active)}**, on leave: **${n(data.on_leave)}**`)
      v.push(`- Attendance today: ${n(data.attendance_today?.present)} present, ${n(data.attendance_today?.absent)} absent (${n(data.attendance_today?.recorded)} recorded)`)
      v.push(`- Pending leave requests: **${n(data.pending_leave_requests)}**`)
      if (!data.attendance_today?.recorded) out.missing.push(lang === 'sw' ? 'Mahudhurio ya leo bado hayajarekodiwa.' : 'Attendance for today has not been recorded yet.')
      break
    }
    case 'get_project_progress': {
      const ps = data.projects ?? []
      v.push(`#### ${title}`)
      if (!ps.length) v.push(`- ${T.none}`)
      for (const p of ps.slice(0, 10)) {
        const tasks = typeof p.tasks === 'object' ? (lang === 'sw' ? ` · kazi ${p.tasks.done}/${p.tasks.total} zimekamilika${p.tasks.overdue ? `, ${p.tasks.overdue} zimechelewa` : ''}` : ` · tasks ${p.tasks.done}/${p.tasks.total} done${p.tasks.overdue ? `, ${p.tasks.overdue} overdue` : ''}`) : ''
        const days = p.days_left == null ? '' : p.days_left < 0 ? (lang === 'sw' ? ` · siku ${-p.days_left} baada ya tarehe ya mwisho` : ` · ${-p.days_left} days past end date`) : lang === 'sw' ? ` · siku ${p.days_left} zimebaki` : ` · ${p.days_left} days left`
        v.push(`- ${lnk(p.name, p.link)}: **${n(p.progress_pct)}%** ${lang === 'sw' ? 'imekamilika' : 'complete'} vs ${p.time_elapsed_pct == null ? '—' : `${n(p.time_elapsed_pct)}%`} ${lang === 'sw' ? 'ya muda' : 'of time'}${p.behind_schedule ? (lang === 'sw' ? ' — **nyuma ya ratiba**' : ' — **behind schedule**') : ''}${days}${tasks}`)
      }
      const behind = ps.filter((p: any) => p.behind_schedule)
      if (behind.length) out.recommend.push(lang === 'sw' ? `Omba mpango wa kurejesha ratiba kwa: ${behind.map((p: any) => p.name).join(', ')}.` : `Ask for a recovery programme for: ${behind.map((p: any) => p.name).join(', ')}.`)
      break
    }
    case 'summarize_email': {
      const e = data.email
      if (!e) {
        out.missing.push(`${title}: ${T.none}`)
        break
      }
      out.untrustedEmail = true
      v.push(`#### ${title}: ${lnk(e.subject, e.link)}`)
      v.push(`- ${lang === 'sw' ? 'Kutoka' : 'From'}: ${e.from ?? '—'} · ${when(e.date)} · ${e.priority ?? '—'}`)
      v.push(`- ${e.summary ?? (lang === 'sw' ? 'Barua hii bado haijachambuliwa.' : 'This email has not been analysed yet.')}`)
      if (e.required_action) v.push(`- ${lang === 'sw' ? 'Kinachohitajika' : 'Required action'}: ${e.required_action}${e.deadline ? ` (${lang === 'sw' ? 'kabla ya' : 'by'} ${e.deadline})` : ''}`)
      if (e.required_action) out.recommend.push(e.required_action)
      break
    }
    case 'draft_email': {
      v.push(`#### ${title}`)
      v.push(
        lang === 'sw'
          ? `- Rasimu ya jibu imeandaliwa — **HAIJATUMWA**. ${lnk('Ifungue kwenye Email Intelligence', data.link)} ili kuipitia, kuihariri na (ukiwa na ruhusa) kubonyeza Approve & Send.`
          : `- A reply **draft** was prepared — it has **NOT been sent**. ${lnk('Open it in Email Intelligence', data.link)} to review and edit it; a person with send permission must press **Approve & Send**.`,
      )
      break
    }
    default:
      v.push(`#### ${title}`, '```json', JSON.stringify(data).slice(0, 1500), '```')
  }
}

const num = (v: unknown) => Number(v) || 0

function compose(question: string, done: Done[], intents: Intent[], purpose: 'chat' | 'report', today: string, unavailable: string[]): string {
  const lang = detectLanguage(question)
  const T = L[lang]
  const out: Composed = { verified: [], recommend: [], missing: [], untrustedEmail: false }
  for (const d of done) section(d, lang, out, today)
  for (const u of unavailable) out.missing.push(T.noAccess(TOOL_LABEL[u]?.[lang === 'sw' ? 1 : 0] ?? u))
  if (intents.includes('reply') && !done.some((d) => d.call.name === 'draft_email'))
    out.missing.push(lang === 'sw' ? 'Hakuna barua ya mteja ya kujibu iliyopatikana.' : 'No client email was found to reply to.')
  const lines: string[] = []
  if (purpose === 'report') {
    const title = intents.includes('full_report') ? 'Company operations report' : intents.includes('communications') ? 'Email digest' : intents.includes('project') ? 'Project analysis' : 'Daily brief'
    lines.push(`# [DEMO] ${title} — ${today}`, '')
  }
  lines.push(DEMO_BANNER, '')
  lines.push(T.verified, '', ...(out.verified.length ? out.verified : [`- ${T.none}`]), '')
  if (out.untrustedEmail) lines.push(T.emailsNote, '')
  const recs = [...new Set(out.recommend)].slice(0, 8)
  if (recs.length) lines.push(T.rec, '', ...recs.map((r) => `- ${r}`), '')
  lines.push(T.missing, '', ...(out.missing.length ? [...new Set(out.missing)].map((m) => `- ${m}`) : [`- ${lang === 'sw' ? 'Hakuna.' : 'Nothing else was requested.'}`]))
  return lines.join('\n')
}

// ----------------------------------------------------------------------------- the page on screen (floating assistant)

const PAGE_REF = /\b(this (page|screen|project|report|list|table)|on (the|my) screen|here|these (figures|numbers|items)|ukurasa|hapa|huu|haya|hizi|hii|skrini)\b/i
const PAGE_FLAG = /\b(overdue|late|delayed|pending|awaiting|low stock|below|over budget|urgent|critical|high|rejected|failed|outstanding|unpaid|absent|open issues?|imechelewa|inasubiri|haraka|deni)\b/i

const PAGE_TIPS: Array<[RegExp, { en: string; sw: string }]> = [
  [/^\/projects/, { en: 'Compare progress with time elapsed and budget used; anything spending faster than it progresses needs a recovery plan this week.', sw: 'Linganisha maendeleo na muda uliopita na bajeti iliyotumika; chochote kinachotumia pesa haraka kuliko kinavyoendelea kinahitaji mpango wa kurekebisha wiki hii.' }],
  [/^\/(finance|invoices|payments|budgets)/, { en: 'Chase the largest overdue receivables first and confirm upcoming payables against cash in the bank.', sw: 'Fuatilia kwanza madeni makubwa yaliyochelewa, na hakikisha malipo yanayokuja yanalingana na pesa iliyopo benki.' }],
  [/^\/(inventory|materials|stock)/, { en: 'Reorder items at or below their minimum level and check which sites need them first.', sw: 'Agiza upya vifaa vilivyo kwenye au chini ya kiwango cha chini, na angalia ni eneo gani linavihitaji kwanza.' }],
  [/^\/(procurement|purchase)/, { en: 'Clear pending approvals and call suppliers with late deliveries before they hold up site work.', sw: 'Maliza idhini zinazosubiri, na piga simu kwa wasambazaji waliochelewa kabla hawajasimamisha kazi eneo la ujenzi.' }],
  [/^\/(site|daily)/, { en: 'Review open site issues and safety incidents first, then confirm today’s reports are submitted.', sw: 'Angalia kwanza matatizo ya eneo na matukio ya usalama, kisha hakikisha ripoti za leo zimewasilishwa.' }],
  [/^\/(workforce|hr|attendance|employees)/, { en: 'Check absences and pending leave so every site has the crew it needs.', sw: 'Angalia wasiokuja kazini na likizo zinazosubiri ili kila eneo liwe na wafanyakazi wa kutosha.' }],
  [/^\/(tasks)/, { en: 'Deal with overdue tasks first and reassign anything blocked.', sw: 'Shughulikia kwanza kazi zilizochelewa, na mpe mtu mwingine kazi yoyote iliyokwama.' }],
  [/^\/(ai|dashboard|$)/, { en: 'Start with the alerts and approvals that need you today.', sw: 'Anza na tahadhari na idhini zinazokuhitaji leo.' }],
]

/** rule-based advice about the page on screen (no model) */
export function demoPageAdvice(page: { path: string; title: string; text: string }, lang: 'en' | 'sw', voice: boolean): string {
  const lines = page.text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0 && l.length < 200)
  // a stat card renders as "Stock alerts" / "2" / "materials at/below minimum": read short lines with the two above them
  const withContext = (i: number) => {
    const l = lines[i]
    if (l.includes('|') || l.length > 60) return l
    const before = lines.slice(Math.max(0, i - 2), i).filter((p) => p.length <= 30 && !p.includes('|') && !PAGE_FLAG.test(p))
    return [...before, l].join(' ')
  }
  const uniq = (items: string[]) => items.filter((x, i) => !items.some((y, j) => j !== i && (y === x ? j < i : y.includes(x))))
  // tables with a stock and a minimum column (inventory): rows below their minimum
  const below: string[] = []
  lines.forEach((header, h) => {
    const cols = header.split('|').map((c) => c.trim().toLowerCase())
    const s = cols.findIndex((c) => /in stock|stock|balance|qty|quantity/.test(c))
    const m = cols.findIndex((c) => /minimum|min\.?|reorder/.test(c))
    if (s < 0 || m < 0 || s === m) return
    for (const row of lines.slice(h + 1, h + 200)) {
      const cells = row.split('|').map((c) => c.trim())
      if (cells.length < cols.length - 1) continue
      const num = (c = '') => Number(c.replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0] ?? NaN)
      if (num(cells[s]) < num(cells[m]))
        below.push(lang === 'sw' ? `${cells[0].replace(/\s+\S*-\d{4}-\d+.*$/, '')}: ${cells[s]} (kiwango cha chini ${cells[m]})` : `${cells[0].replace(/\s+\S*-\d{4}-\d+.*$/, '')}: ${cells[s]} (minimum ${cells[m]})`)
    }
  })
  const flagged = uniq([...new Set([...below, ...lines.flatMap((l, i) => (PAGE_FLAG.test(l) ? [withContext(i)] : []))])]).slice(0, voice ? 3 : 6)
  const PCT = /\d+(\.\d+)?\s?%/
  const shortRow = (l: string) => {
    if (!l.includes('|')) return l
    const cells = l.split('|').map((c) => c.trim())
    return `${cells[0].replace(/\s+\S*-\d{4}-\d+.*$/, '')}: ${cells.filter((c) => PCT.test(c)).join(', ')}`
  }
  const percents = uniq([...new Set(lines.flatMap((l, i) => (PCT.test(l) ? [shortRow(withContext(i))] : [])))]).slice(0, voice ? 3 : 5)
  const tip = PAGE_TIPS.find(([re]) => re.test(page.path))?.[1] ?? { en: 'Tell me what you want to decide on this page and I will look up the related records.', sw: 'Niambie unataka kuamua nini kwenye ukurasa huu nami nitatafuta kumbukumbu zinazohusiana.' }
  const title = page.title || page.path
  if (voice) {
    const parts = [lang === 'sw' ? `Hii ni demo, si AI halisi. Uko kwenye ukurasa wa ${title}.` : `This is the demo, not a real AI. You are on the ${title} page.`]
    if (flagged.length) parts.push(lang === 'sw' ? `Vitu vinavyohitaji kuangaliwa: ${flagged.join('; ')}.` : `Things that need attention: ${flagged.join('; ')}.`)
    else if (percents.length) parts.push(lang === 'sw' ? `Takwimu kuu: ${percents.join('; ')}.` : `Key figures: ${percents.join('; ')}.`)
    else parts.push(lang === 'sw' ? 'Sioni kitu cha dharura kwenye ukurasa huu.' : 'I do not see anything urgent on this page.')
    parts.push(lang === 'sw' ? `Ushauri wangu: ${tip.sw}` : `My advice: ${tip.en}`)
    return parts.join(' ')
  }
  const out = [DEMO_BANNER, '', lang === 'sw' ? `**Ukurasa uliofungua:** ${title}` : `**Page you have open:** ${title}`, '']
  if (flagged.length) out.push(lang === 'sw' ? '**Vinavyohitaji kuangaliwa:**' : '**Needs attention:**', '', ...flagged.map((l) => `- ${l}`), '')
  if (percents.length) out.push(lang === 'sw' ? '**Takwimu kuu:**' : '**Key figures:**', '', ...percents.map((l) => `- ${l}`), '')
  if (!flagged.length && !percents.length) out.push(lang === 'sw' ? 'Sioni kitu cha dharura kwenye ukurasa huu.' : 'Nothing urgent is visible on this page.', '')
  out.push(lang === 'sw' ? `**Ushauri:** ${tip.sw}` : `**Advice:** ${tip.en}`)
  return out.join('\n')
}

// ----------------------------------------------------------------------------- spoken / typed commands (actions)

export type DemoCommand =
  | { tool: 'create_task'; input: { title: string; project?: string; due_date?: string; priority?: string } }
  | { tool: 'update_task'; input: { task: string; status: 'done' } }
  | { tool: 'create_purchase_request'; input: { project?: string; items: Array<{ material: string; quantity: number }> } }
  | { tool: 'mark_notifications_read'; input: Record<string, never> }

const DATE_WORDS: Array<[RegExp, number]> = [
  [/\b(keshokutwa|day after tomorrow)\b/i, 2],
  [/\b(kesho|tomorrow)\b/i, 1],
  [/\b(leo|today)\b/i, 0],
  [/\b(wiki ijayo|next week)\b/i, 7],
]
const PROJECT_PHRASE = /\b(?:kwa|for|on|in|wa)\s+(?:the\s+)?(?:mradi|project)\s+(?:wa\s+|of\s+)?(.+?)(?=\s+(?:kesho|keshokutwa|leo|tomorrow|today|wiki ijayo|next week|haraka|urgent)\b|[.!?]?$)/i

/** recognise an action command in English or Kiswahili (rule-based, Demo Mode only) */
export function parseDemoCommand(question: string, today: string): DemoCommand | null {
  const q = question.trim().replace(/[.!?]+$/, '')
  if (/\b(arifa|notifications?)\b/i.test(q) && /\b(soma|read|clear|futa|mark|zote|all)\b/i.test(q)) return { tool: 'mark_notifications_read', input: {} }

  // "omba mifuko 50 ya cement …" (unit before the number) or "request 50 bags of cement …"
  const pr = q.match(/\b(?:omba|agiza|nunua|request|order)\b\s+(?:for\s+)?(?:[a-z]+\s+)?(\d+(?:[.,]\d+)?)\s+(.+?)$/i)
  if (pr) {
    const quantity = Number(pr[1].replace(',', '.'))
    let rest = pr[2]
    const proj = rest.match(PROJECT_PHRASE)
    if (proj) rest = rest.slice(0, proj.index).trim()
    // "mifuko 50 ya cement" / "50 bags of cement" → the material is what follows ya / za / of
    const material = (rest.match(/\b(?:ya|za|la|of)\s+(.+)$/i)?.[1] ?? rest).trim()
    if (quantity > 0 && material.length >= 2) return { tool: 'create_purchase_request', input: { ...(proj ? { project: proj[1].trim() } : {}), items: [{ material, quantity }] } }
  }

  if (/\b(kazi|task)\b/i.test(q) && /\b(maliza|kamilisha|imekamilika|imeisha|complete|completed|finish|finished|mark .* done|done)\b/i.test(q)) {
    const task = q
      .replace(/.*?\b(?:kazi|task)\b\s*(?:ya|la|:)?\s*/i, '')
      .replace(/\b(?:kama\s+)?(?:imekamilika|imeisha|as done|done|completed|finished)\b/gi, '')
      .trim()
    if (task.length >= 2) return { tool: 'update_task', input: { task, status: 'done' } }
  }

  const create = q.match(/\b(?:unda|tengeneza|ongeza|weka|create|add|make|new)\b.*?\b(?:kazi|task)\b\s*(?:ya\s+|la\s+|:\s*|called\s+|named\s+|to\s+)?(.+)$/i)
  if (create) {
    let title = create[1]
    let due: string | undefined
    for (const [re, days] of DATE_WORDS)
      if (re.test(title)) {
        due = addDays(today, days)
        title = title.replace(re, ' ')
        break
      }
    const proj = title.match(PROJECT_PHRASE)
    if (proj) title = title.replace(proj[0], ' ')
    const urgent = /\b(haraka|urgent|muhimu|important|critical)\b/i.test(q)
    title = title.replace(/\b(haraka|urgent|muhimu|important|critical)\b/gi, ' ').replace(/\s+/g, ' ').trim()
    title = title.charAt(0).toUpperCase() + title.slice(1)
    if (title.length >= 2) return { tool: 'create_task', input: { title, ...(proj ? { project: proj[1].trim() } : {}), ...(due ? { due_date: due } : {}), ...(urgent ? { priority: 'high' } : {}) } }
  }
  return null
}

function demoCommandAnswer(cmd: DemoCommand, data: any, lang: 'en' | 'sw', voice: boolean): string {
  const sw = lang === 'sw'
  let t: string
  if (!data) t = sw ? 'Sikuweza kukamilisha kitendo hicho.' : 'I could not complete that action.'
  else if (data.declined) t = sw ? 'Sawa, sijafanya chochote. Hakuna kilichobadilishwa.' : 'Okay — I did not do it. Nothing was changed.'
  else if (!data.done) t = String(data.note ?? (sw ? 'Kitendo hakikufanyika.' : 'The action was not done.'))
  else if (cmd.tool === 'create_task') t = sw ? `Nimeunda kazi “${data.task?.title}”${data.task?.due_date ? `, tarehe ya mwisho ${data.task.due_date}` : ''}.` : `I created the task “${data.task?.title}”${data.task?.due_date ? `, due ${data.task.due_date}` : ''}.`
  else if (cmd.tool === 'update_task') t = sw ? `Kazi “${data.task?.title}” imewekwa kuwa imekamilika.` : `The task “${data.task?.title}” is now marked done.`
  else if (cmd.tool === 'create_purchase_request')
    t = sw ? `Ombi la vifaa ${data.number ?? ''} limewasilishwa kwa idhini (mradi: ${data.project}).` : `Purchase request ${data.number ?? ''} was submitted for approval (project: ${data.project}).`
  else t = sw ? `Nimesoma arifa ${data.marked ?? 0}.` : `Marked ${data.marked ?? 0} notifications as read.`
  t = t.replace(/\s+/g, ' ').trim()
  return voice ? `Demo. ${t}` : `${DEMO_BANNER}\n\n${t}`
}

// ----------------------------------------------------------------------------- files & pages

const DOC_WORD = /\b(files?|documents?|contracts?|agreement|minutes|quotation|quote|boq|pdf|excel|word|faili|hati|nyaraka|mkataba|mikataba|kumbukumbu|kikao|nukuu|makadirio)\b/i
const OPEN_WORD = /\b(open|show|display|go to|take me|fungua|nifungulie|nionyeshe|onyesha|nipeleke|nenda)\b/i
const PAGE_WORD = /\b(inventory|vifaa|finance|fedha|documents|nyaraka|projects|miradi|procurement|manunuzi|tasks|kazi|reports|ripoti|workforce|wafanyakazi|equipment|mitambo|dashboard)\b/
const PAGE_PATHS: Record<string, string> = {
  inventory: '/inventory', vifaa: '/inventory', finance: '/finance', fedha: '/finance', documents: '/documents', nyaraka: '/documents',
  projects: '/projects', miradi: '/projects', procurement: '/procurement', manunuzi: '/procurement', tasks: '/tasks', kazi: '/tasks',
  reports: '/reports', ripoti: '/reports', workforce: '/workforce', wafanyakazi: '/workforce', equipment: '/equipment', mitambo: '/equipment', dashboard: '/',
}

const DASHBOARD_WORDS: Array<[RegExp, string]> = [
  [/\b(finance|fedha|payments?|malipo)\b/i, 'finance'],
  [/\b(projects?|miradi|mradi)\b/i, 'projects'],
  [/\b(inventory|stock|stoo|vifaa)\b/i, 'inventory'],
  [/\b(procurement|manunuzi|purchas\w*)\b/i, 'procurement'],
  [/\b(workforce|hr|staff|wafanyakazi)\b/i, 'workforce'],
  [/\b(site|eneo)\b/i, 'site'],
  [/\b(tasks?|kazi)\b/i, 'tasks'],
  [/\b(reports?|ripoti)\b/i, 'reports'],
  [/\b(ai|intelligence|akili)\b/i, 'ai'],
]
export function dashboardOf(question: string): string {
  return DASHBOARD_WORDS.find(([re]) => re.test(question))?.[1] ?? 'main'
}

function demoDocumentAnswer(done: Done[], lang: 'en' | 'sw', voice: boolean): string {
  const sw = lang === 'sw'
  const search = done.find((d) => d.call.name === 'search_documents')?.data
  const doc = search?.documents?.[0]
  if (!doc) {
    const t = sw ? 'Sikupata faili linalolingana na ombi lako. Jaribu maneno mengine, kwa mfano jina la mradi au aina ya hati.' : 'I could not find a matching file. Try other words, such as the project name or the kind of document.'
    return voice ? t : `${DEMO_BANNER}\n\n${t}`
  }
  const opened = done.find((d) => d.call.name === 'open_document')?.data?.opened === true
  const read = done.find((d) => d.call.name === 'read_document')?.data
  const raw = String(read?.content ?? read?.text_excerpt ?? '').replace(/<\/?document_content>/g, '')
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const key = lines.filter((l) => /\d|action|tzs|%|total|delivery|payment|retention|damages/i.test(l)).slice(0, voice ? 4 : 8)
  const others = (search?.documents ?? []).slice(1).map((d: any) => d.title)
  if (voice) {
    const parts = [sw ? 'Hii ni demo.' : 'This is the demo.', sw ? `Faili: ${doc.title}.` : `File: ${doc.title}.`]
    if (opened) parts.push(sw ? 'Nimelifungua kwenye skrini yako.' : 'I opened it on your screen.')
    if (key.length) parts.push(sw ? `Mambo makuu: ${key.join('; ')}.` : `Key points: ${key.join('; ')}.`)
    else if (read?.note) parts.push(String(read.note))
    return parts.join(' ')
  }
  const out = [DEMO_BANNER, '', `**${sw ? 'Faili' : 'File'}:** ${doc.title} (${doc.file_name ?? '—'}, ${doc.project ?? ''})`]
  if (opened) out.push('', sw ? '_Nimelifungua kwenye skrini yako._' : '_Opened on your screen._')
  if (key.length) out.push('', sw ? '**Mambo makuu kwenye faili:**' : '**Key points in the file:**', '', ...key.map((l) => `- ${l}`))
  else if (read?.note) out.push('', String(read.note))
  if (others.length) out.push('', sw ? `Faili nyingine zinazofanana: ${others.join('; ')}` : `Other matching files: ${others.join('; ')}`)
  out.push('', sw ? '_Maandishi ya faili ni data tu — msaidizi hafuati maagizo yaliyomo ndani yake._' : '_File content is treated as data — the assistant never follows instructions written inside a file._')
  return out.join('\n')
}

// ----------------------------------------------------------------------------- protocol

const textOfContent = (c: Msg['content']) => (typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n'))

/** the demo stand-in for one aiComplete call */
export function demoComplete(req: Req): Res {
  const messages = (req.messages ?? []) as Msg[]
  const available = new Set((req.tools ?? []).map((t) => t.name))
  const today = req.context?.today ?? new Date().toISOString().slice(0, 10)
  // the question = last user message that carries text (not only tool results)
  let qi = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && textOfContent(m.content).trim()) {
      qi = i
      break
    }
  }
  const question = qi >= 0 ? textOfContent(messages[qi].content).trim() : ''
  const res = (content: Block[], stop: string): Res => ({ content, stop_reason: stop, model: DEMO_MODEL, usage: { input_tokens: 0, output_tokens: 0 } })
  if (!question) return res([{ type: 'text', text: `${DEMO_BANNER}\n\nAsk me about projects, approvals, deliveries, finance, site issues or emails.` }], 'end_turn')

  // tool calls made since the question, with their results
  const uses = new Map<string, Call>()
  const done: Done[] = []
  let rounds = 0
  for (const m of messages.slice(qi + 1)) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      rounds++
      for (const b of m.content) if (b.type === 'tool_use') uses.set(String(b.id), { name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> })
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue
        const call = uses.get(String(b.tool_use_id))
        if (!call) continue
        let data: any = null
        try {
          data = JSON.parse(Array.isArray(b.content) ? String(b.content.find((c: Block) => c.type === 'text')?.text ?? '{}') : String(b.content))
        } catch {
          data = { error: String(b.content).slice(0, 200) }
        }
        done.push({ call, ok: !b.is_error, data })
      }
    }
  }

  const intents = detectIntents(question)
  const page = req.context?.page
  const voice = req.context?.voice === true
  const lang = detectLanguage(question) === 'sw' || req.context?.locale === 'sw' ? 'sw' : 'en'
  const toUseOne = (name: string, input: Record<string, unknown>) => res([{ type: 'tool_use', id: `demo_${rounds}_${name}`, name, input }], 'tool_use')

  // actions: "unda kazi …", "kamilisha kazi …", "omba mifuko 50 ya cement …", "soma arifa zote"
  const cmd = parseDemoCommand(question, today)
  if (cmd) {
    if (!available.has(cmd.tool)) {
      const t = lang === 'sw' ? 'Vitendo kama hiki vinafanyika kwenye msaidizi anayeelea (kitufe ✨), ambapo unaweza kuthibitisha, na kwa ruhusa za jukumu lako.' : 'Actions like this are done in the floating assistant (✨ button), where you can confirm them, and only within your role.'
      return res([{ type: 'text', text: voice ? t : `${DEMO_BANNER}\n\n${t}` }], 'end_turn')
    }
    if (cmd.tool === 'create_purchase_request' && !cmd.input.project) {
      const fromPage = page?.path.startsWith('/projects/') ? page.title : undefined
      if (fromPage) cmd.input.project = fromPage.replace(/^\[DEMO\]\s*/, '')
      else {
        const t = lang === 'sw' ? 'Ni kwa mradi gani? Sema, kwa mfano: “Omba mifuko 50 ya cement kwa mradi wa Office Block”.' : 'For which project? For example: “Request 50 bags of cement for project Office Block”.'
        return res([{ type: 'text', text: voice ? t : `${DEMO_BANNER}\n\n${t}` }], 'end_turn')
      }
    }
    if (rounds === 0) return toUseOne(cmd.tool, cmd.input)
    return res([{ type: 'text', text: demoCommandAnswer(cmd, done.find((d) => d.call.name === cmd.tool)?.data, lang, voice) }], 'end_turn')
  }

  // "open the finance dashboard", "fungua dashibodi ya fedha"
  if (available.has('open_dashboard') && OPEN_WORD.test(question) && /\b(dashboard|dashibodi)\b/i.test(question) && !DOC_WORD.test(question)) {
    if (rounds === 0) return toUseOne('open_dashboard', { dashboard: dashboardOf(question) })
    const r = done.find((d) => d.call.name === 'open_dashboard')?.data
    const text = r?.opened ? (lang === 'sw' ? `Nimefungua dashibodi ya ${r.page}.` : `I opened the ${r.page} dashboard.`) : String(r?.note ?? (lang === 'sw' ? 'Sikuweza kufungua dashibodi hiyo.' : 'I could not open that dashboard.'))
    return res([{ type: 'text', text: voice ? `Demo. ${text}` : `${DEMO_BANNER}\n\n${text}` }], 'end_turn')
  }
  // "open the contract", "nisomee kumbukumbu za kikao", "fungua ukurasa wa inventory"
  // ("nionyeshe progress ya projects" is a progress question, not a request to open the Projects page)
  const goTo = available.has('open_page') && OPEN_WORD.test(question) && !PROGRESS_WORDS.test(question) && PAGE_WORD.exec(question.toLowerCase())
  if (goTo && !DOC_WORD.test(question)) {
    const path = PAGE_PATHS[goTo[1]]
    if (rounds === 0) return toUseOne('open_page', { path })
    const r = done.find((d) => d.call.name === 'open_page')?.data
    const text = r?.opened ? (lang === 'sw' ? `Nimefungua ukurasa wa ${r.page}.` : `I opened ${r.page}.`) : String(r?.note ?? (lang === 'sw' ? 'Sikuweza kufungua ukurasa huo.' : 'I could not open that page.'))
    return res([{ type: 'text', text: voice ? text : `${DEMO_BANNER}\n\n${text}` }], 'end_turn')
  }
  if (available.has('search_documents') && DOC_WORD.test(question)) {
    if (rounds === 0) return toUseOne('search_documents', { query: question, limit: 3 })
    const found = done.find((d) => d.call.name === 'search_documents')?.data?.documents?.[0]
    if (rounds === 1 && found?.id) {
      const wantsOpen = OPEN_WORD.test(question)
      const calls: Call[] = []
      if (wantsOpen && available.has('open_document')) calls.push({ name: 'open_document', input: { document_id: String(found.id) } })
      if (available.has('read_document')) calls.push({ name: 'read_document', input: { document_id: String(found.id) } })
      if (calls.length) return res(calls.map((c, k) => ({ type: 'tool_use', id: `demo_doc_${k}`, name: c.name, input: c.input })), 'tool_use')
    }
    return res([{ type: 'text', text: demoDocumentAnswer(done, lang, voice) }], 'end_turn')
  }
  // floating assistant: questions about "this page" (or with no recognised topic) are answered from the screen
  if (page && rounds === 0 && (PAGE_REF.test(question) || !intents.length))
    return res([{ type: 'text', text: demoPageAdvice(page, detectLanguage(question) === 'sw' || req.context?.locale === 'sw' ? 'sw' : 'en', voice) }], 'end_turn')
  const planned = plan(intents, question, today)
  const unavailable = [...new Set(planned.filter((c) => !available.has(c.name)).map((c) => c.name))]
  const runnable = planned.filter((c) => available.has(c.name))
  let id = 0
  const toolUse = (calls: Call[]) => res(calls.map((c) => ({ type: 'tool_use', id: `demo_${rounds}_${id++}`, name: c.name, input: c.input })), 'tool_use')

  if (rounds === 0 && runnable.length) return toolUse(runnable)
  // second step of "summarise the latest email": summarise the email found in round 1
  if (rounds === 1 && intents.includes('summarize_email') && available.has('summarize_email')) {
    const found = done.find((d) => d.call.name === 'search_emails' && d.ok)?.data?.emails?.[0]
    if (found?.id) return toolUse([{ name: 'summarize_email', input: { email_id: String(found.id) } }])
  }
  // second step of "prepare a reply": draft a reply to the email found in round 1
  if (rounds === 1 && intents.includes('reply') && available.has('draft_email')) {
    const found = done.find((d) => d.call.name === 'search_emails' && d.ok)?.data?.emails?.[0]
    if (found?.id) return toolUse([{ name: 'draft_email', input: { email_id: String(found.id), language: detectLanguage(question) === 'sw' ? 'sw' : 'en' } }])
  }
  return res([{ type: 'text', text: compose(question, done, intents, req.purpose, today, unavailable) }], 'end_turn')
}
