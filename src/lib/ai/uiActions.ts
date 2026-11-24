/**
 * Things the assistant can do on the user's screen (never data changes): open a file in the in-app viewer,
 * or go to a page. Tools run in the browser, so they signal the UI through window events that
 * FileViewer / AppShell listen to.
 */
export interface OpenFileRequest {
  bucket: 'documents'
  path: string
  fileName: string
  mime: string
  title: string
}

export const OPEN_FILE_EVENT = 'abckit:open-file'
export const NAVIGATE_EVENT = 'abckit:navigate'

const canSignal = () => typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function'

/** shows the file in the in-app viewer; false when there is no screen (tests) */
export function requestOpenFile(r: OpenFileRequest): boolean {
  if (!canSignal()) return false
  window.dispatchEvent(new CustomEvent<OpenFileRequest>(OPEN_FILE_EVENT, { detail: r }))
  return true
}

export function requestNavigate(path: string): boolean {
  if (!canSignal()) return false
  window.dispatchEvent(new CustomEvent<string>(NAVIGATE_EVENT, { detail: path }))
  return true
}

// ----------------------------------------------------------------------------- clicking on the screen

/**
 * Words on buttons that change data, spend money or end the session: the assistant never presses these itself
 * (the user presses them, or the assistant uses its confirmed action tools). Everything else — tabs, links,
 * menus, "New …" / "View" / filter buttons that only open or show something — it may press directly.
 */
export const DANGEROUS_CLICK =
  /\b(delete|remove|futa|ondoa|approve|idhinisha|reject|kataa|pay|lipa|send|tuma|submit|wasilisha|save|hifadhi|confirm|thibitisha|zuia|deactivate|activate|disable|enable|archive|restore|sign\s?out|log\s?out|toka|reset|discard|void|post|create|unda|generate|tengeneza|sync|run|import|resolve|acknowledge|mark|record|rekodi|assign|transfer|invite|update|badilisha|upload|pakia|disconnect|connect|revoke)\b|^(un)?block\b|\b(un)?block (user|account|access)\b/i

export interface ClickCandidate {
  label: string
  /** link, tab, menu, button… */
  kind: string
  /** a submit button or a label that changes data */
  danger: boolean
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

/** which element to press for what the user said: exact label, then label containing it, then all its words */
export function pickClickTarget(cands: ClickCandidate[], target: string): { index: number } | { error: string; options: string[] } {
  const t = norm(target)
  const options = [...new Set(cands.filter((c) => !c.danger).map((c) => c.label))].slice(0, 80)
  if (!t) return { error: 'Say what to click.', options }
  const tw = t.split(' ').filter((w) => w.length >= 2)
  const tiers = [
    (l: string) => l === t,
    (l: string) => l.startsWith(t) || l.includes(` ${t}`),
    (l: string) => l.includes(t),
    (l: string) => tw.length > 0 && tw.every((w) => l.includes(w)),
  ]
  for (const ok of tiers) {
    const hits = cands.map((c, index) => ({ c, index })).filter(({ c }) => ok(norm(c.label)))
    if (!hits.length) continue
    const safe = hits.find(({ c }) => !c.danger)
    if (safe) return { index: safe.index }
    return { error: `"${hits[0].c.label}" changes data, so the assistant does not press it. Use the matching assistant command (it asks for confirmation) or let the user press it.`, options }
  }
  return { error: `Nothing called "${target}" can be clicked on this screen.`, options }
}

const CLICKABLE = 'a[href], button, [role="tab"], [role="menuitem"], [role="button"], [role="link"], [role="option"], summary'

function labelOf(el: Element): string {
  const t = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
  return t.slice(0, 120)
}

/** presses the visible element the user named (never inside the assistant panel, never a data-changing button) */
export async function clickOnScreen(target: string): Promise<{ clicked: boolean; label?: string; note: string; options?: string[] }> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return { clicked: false, note: 'There is no screen to click on.' }
  const els = Array.from(document.querySelectorAll<HTMLElement>(CLICKABLE)).filter((el) => {
    if (el.closest('[data-ai-ignore]')) return false
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false
    return el.getClientRects().length > 0 && !!labelOf(el)
  })
  // dialogs on top come first (what the user is looking at)
  els.sort((a, b) => Number(!!b.closest('[role="dialog"]')) - Number(!!a.closest('[role="dialog"]')))
  const cands: ClickCandidate[] = els.map((el) => {
    const label = labelOf(el)
    const submit = el.tagName === 'BUTTON' && (el as HTMLButtonElement).type === 'submit' && !!el.closest('form')
    const kind = el.getAttribute('role') ?? (el.tagName === 'A' ? 'link' : el.tagName.toLowerCase())
    // links and tabs only open or show something, whatever their text (a project may be called "Office Block")
    const opensOnly = kind === 'link' || kind === 'tab'
    return { label, kind, danger: submit || (!opensOnly && DANGEROUS_CLICK.test(label)) }
  })
  const pick = pickClickTarget(cands, target)
  if ('error' in pick) return { clicked: false, note: pick.error, options: pick.options }
  const el = els[pick.index]
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  el.click()
  await new Promise((r) => setTimeout(r, 450))
  return { clicked: true, label: cands[pick.index].label, note: `Clicked "${cands[pick.index].label}" on the user's screen.` }
}

// ----------------------------------------------------------------------------- phone

/** a Tanzanian number as an international tel: target (0780… → +255780…) */
export function telTarget(number: string): string | null {
  const d = number.replace(/[^\d+]/g, '')
  if (/^0\d{9}$/.test(d)) return `+255${d.slice(1)}`
  if (/^\+?\d{9,15}$/.test(d)) return d.startsWith('+') ? d : d.length === 12 && d.startsWith('255') ? `+${d}` : d
  return null
}

/** opens the phone's dialer (on a computer: the calling app, e.g. Phone Link) with the number filled in */
export function requestCall(number: string): boolean {
  const tel = telTarget(number)
  if (!tel || typeof window === 'undefined' || typeof document === 'undefined') return false
  const a = document.createElement('a')
  a.href = `tel:${tel}`
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  return true
}
