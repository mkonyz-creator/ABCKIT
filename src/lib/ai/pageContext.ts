/**
 * What the floating assistant "sees": the route and the visible text of the page's main area.
 * Only text already on the user's screen is sent (it was loaded under their own permissions); form field
 * values, password inputs and anything marked data-ai-ignore are left out.
 */
import { AI_PAGE_TEXT_LIMIT, type AiPageContext } from '@/shared/ai/contract'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'IFRAME', 'TEMPLATE'])
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'UL', 'OL', 'DL', 'DT', 'DD', 'BR', 'FORM', 'FIELDSET', 'NAV', 'ASIDE', 'MAIN', 'FIGURE', 'BLOCKQUOTE', 'PRE'])

type Layout = 'hidden' | 'block' | 'cell' | 'spaced' | 'inline'

/** how an element lays out on screen (computed CSS in the browser; tag names as a fallback) */
function layoutOf(el: Element): Layout {
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden') || el.hasAttribute('data-ai-ignore')) return 'hidden'
  const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(el) : null
  const d = style?.display
  if (!style || !d) return el.tagName === 'TD' || el.tagName === 'TH' ? 'cell' : BLOCK_TAGS.has(el.tagName) ? 'block' : 'inline'
  if (d === 'none' || style.visibility === 'hidden') return 'hidden'
  if (d === 'table-cell') return 'cell'
  if (d === 'contents') return 'inline'
  if (d.startsWith('inline')) return d === 'inline' ? 'inline' : 'spaced'
  return 'block'
}

/** visible text of `root`, one line per block / table row, cells separated by " | " */
export function visibleText(root: Element): string {
  const out: string[] = []
  let line = ''
  const flush = () => {
    const t = line.replace(/\s+/g, ' ').trim()
    if (t) out.push(t)
    line = ''
  }
  const walk = (node: Node, inCell: boolean) => {
    if (node.nodeType === 3) {
      line += node.textContent ?? ''
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    // buttons are skipped (actions, not content) except sortable table headings and tabs, which label what is shown
    if (el.tagName === 'BUTTON' ? !inCell && el.getAttribute('role') !== 'tab' : SKIP_TAGS.has(el.tagName)) return
    let layout = layoutOf(el)
    if (layout === 'hidden') return
    // inside a table cell everything stays on the row's line (name, code and badge of one item)
    if (inCell && layout === 'block') layout = 'spaced'
    if (layout === 'block') flush()
    if (layout === 'spaced') line += ' '
    for (const child of Array.from(el.childNodes)) walk(child, inCell || layout === 'cell')
    if (layout === 'cell') line += ' | '
    if (layout === 'spaced') line += ' '
    if (layout === 'block') flush()
  }
  walk(root, false)
  flush()
  // drop repeated lines (e.g. responsive duplicates) while keeping order
  const seen = new Set<string>()
  return out
    .map((l) => l.replace(/(\s\|\s*)+$/, '').trim())
    .filter((l) => l && !seen.has(l) && (seen.add(l), true))
    .join('\n')
}

export function currentPath(): string {
  if (typeof window === 'undefined') return '/'
  const hash = window.location.hash.replace(/^#/, '')
  return (hash || window.location.pathname || '/').split('?')[0] || '/'
}

/** snapshot of the page the user is looking at right now */
export function capturePageContext(doc: Document = document): AiPageContext {
  const main = doc.getElementById('main') ?? doc.querySelector('main') ?? doc.body
  const heading = main.querySelector('h1')?.textContent?.trim()
  const title = (heading || doc.title || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  let text = visibleText(main)
  if (text.length > AI_PAGE_TEXT_LIMIT) text = `${text.slice(0, AI_PAGE_TEXT_LIMIT - 40)}\n… (page text shortened)`
  return { path: currentPath().slice(0, 300), title, text }
}
