/**
 * Safe Markdown → AST for assistant answers and reports. The renderer (components/ai/Markdown.tsx) turns the
 * AST into React elements — raw HTML is never interpreted (it stays literal text, escaped by React), and links
 * are allowed only to in-app hash routes ("#/…" or "/…") or https URLs.
 *
 * Supported: headings, paragraphs, bold/italic, inline code, fenced code, ordered/unordered (nested) lists,
 * tables, blockquotes, horizontal rules, links/autolinks, and the answer labels
 * "Verified", "Historical", "AI recommendation", "Missing / not available" (grouped into labelled sections).
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; external: boolean; c: Inline[] }

export type LabelKind = 'verified' | 'historical' | 'recommendation' | 'missing'

export type Block =
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: Array<'left' | 'right' | 'center' | null> }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'section'; kind: LabelKind; title: string; c: Block[] }

// ----------------------------------------------------------------------------- links

/** returns a safe href, or null when the link must be dropped (javascript:, data:, http:, protocol-relative…) */
export function safeHref(raw: string): { href: string; external: boolean } | null {
  const s = String(raw ?? '').trim()
  if (!s || /[\s\u0000-\u001f\u007f\\]/.test(s)) return null
  if (s.startsWith('#/')) return { href: s, external: false }
  if (s.startsWith('/') && !s.startsWith('//')) return { href: `#${s}`, external: false }
  if (/^https:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null
      return { href: u.href, external: true }
    } catch {
      return null
    }
  }
  return null
}

// ----------------------------------------------------------------------------- inline

const ESCAPABLE = /[\\`*_[\]()#+\-.!|~<>{}]/

function findClose(s: string, from: number, token: string) {
  let i = from
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2
      continue
    }
    if (s.startsWith(token, i)) return i
    i++
  }
  return -1
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf })
    buf = ''
  }
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    const prev = i > 0 ? s[i - 1] : ' '
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      buf += s[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > i) {
        flush()
        out.push({ t: 'code', v: s.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (depth < 6 && (s.startsWith('**', i) || s.startsWith('__', i))) {
      const tok = s.slice(i, i + 2)
      const end = findClose(s, i + 2, tok)
      if (end > i + 2) {
        flush()
        out.push({ t: 'strong', c: parseInline(s.slice(i + 2, end), depth + 1) })
        i = end + 2
        continue
      }
    }
    if (depth < 6 && (ch === '*' || (ch === '_' && !/[A-Za-z0-9]/.test(prev))) && s[i + 1] && s[i + 1] !== ' ' && s[i + 1] !== ch) {
      const end = findClose(s, i + 1, ch)
      if (end > i + 1 && s[end - 1] !== ' ' && (ch === '*' || !/[A-Za-z0-9]/.test(s[end + 1] ?? ' '))) {
        flush()
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, end), depth + 1) })
        i = end + 1
        continue
      }
    }
    if (ch === '[') {
      const close = findClose(s, i + 1, ']')
      if (close > i && s[close + 1] === '(') {
        const end = s.indexOf(')', close + 2)
        if (end > close) {
          const label = s.slice(i + 1, close)
          const href = safeHref(s.slice(close + 2, end).replace(/\s+"[^"]*"$/, ''))
          flush()
          const c = parseInline(label, depth + 1)
          if (href) out.push({ t: 'link', ...href, c })
          else out.push(...c) // unsafe target: keep the text, drop the link
          i = end + 1
          continue
        }
      }
    }
    if (ch === '<' && s.startsWith('<https://', i)) {
      const end = s.indexOf('>', i)
      const href = end > i ? safeHref(s.slice(i + 1, end)) : null
      if (href) {
        flush()
        out.push({ t: 'link', ...href, c: [{ t: 'text', v: s.slice(i + 1, end) }] })
        i = end + 1
        continue
      }
    }
    if (ch === 'h' && s.startsWith('https://', i) && /[\s(]/.test(prev)) {
      let end = i
      while (end < s.length && !/[\s<>)]/.test(s[end])) end++
      while (end > i && /[.,;:!?'"]/.test(s[end - 1])) end--
      const raw = s.slice(i, end)
      const href = safeHref(raw)
      if (href) {
        flush()
        out.push({ t: 'link', ...href, c: [{ t: 'text', v: raw }] })
        i = end
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

export function inlineText(c: Inline[]): string {
  return c.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : inlineText(x.c))).join('')
}

// ----------------------------------------------------------------------------- blocks

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(line: string) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (s[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

const indentOf = (l: string) => (l.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length
function dedent(l: string, n: number) {
  const s = l.replace(/^\t+/, (t) => '    '.repeat(t.length))
  let k = 0
  while (k < n && s[k] === ' ') k++
  return s.slice(k)
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = []
  let i = 0
  const startsBlock = (l: string, next?: string) =>
    HEADING.test(l) || HR.test(l) || FENCE.test(l) || LIST.test(l) || l.trimStart().startsWith('>') || (l.includes('|') && next !== undefined && TABLE_SEP.test(next))
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = line.match(FENCE)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++])
      i++
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') })
      continue
    }
    const h = line.match(HEADING)
    if (h) {
      out.push({ t: 'h', level: h[1].length, c: parseInline(h[2]) })
      i++
      continue
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }
    if (line.trimStart().startsWith('>')) {
      const body: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('>')) body.push(lines[i++].trimStart().replace(/^>\s?/, ''))
      out.push({ t: 'quote', c: depth < 8 ? parseBlocks(body, depth + 1) : [{ t: 'p', c: parseInline(body.join(' ')) }] })
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null)) as Array<'left' | 'right' | 'center' | null>
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i++])
        rows.push(head.map((_, k) => parseInline(cells[k] ?? '')))
      }
      out.push({ t: 'table', head: head.map((c) => parseInline(c)), rows, align })
      continue
    }
    const li = line.match(LIST)
    if (li) {
      const base = indentOf(line)
      const ordered = /\d/.test(li[2])
      const items: string[][] = []
      while (i < lines.length) {
        const l = lines[i]
        if (!l.trim()) {
          // a blank line ends the list unless an indented continuation or another item follows
          const next = lines[i + 1]
          if (next !== undefined && (indentOf(next) > base || (LIST.test(next) && indentOf(next) === base))) {
            i++
            continue
          }
          break
        }
        const m = l.match(LIST)
        if (m && indentOf(l) === base) {
          if (/\d/.test(m[2]) !== ordered && items.length) break
          items.push([m[3]])
        } else if (indentOf(l) > base && items.length) items[items.length - 1].push(dedent(l, base + 2))
        else if (!startsBlock(l) && items.length && !m) items[items.length - 1].push(l.trim())
        else break
        i++
      }
      out.push({
        t: 'list',
        ordered,
        start: ordered ? Number.parseInt(li[2], 10) || 1 : 1,
        items: items.map((it) => (depth < 8 ? parseBlocks(it, depth + 1) : [{ t: 'p', c: parseInline(it.join(' ')) }])),
      })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim())
    out.push({ t: 'p', c: parseInline(para.join(' ')) })
  }
  return out
}

// ----------------------------------------------------------------------------- answer labels

const LABELS: Array<[LabelKind, RegExp]> = [
  ['verified', /^verified\b/i],
  ['historical', /^historical\b/i],
  ['recommendation', /^(ai\s+)?recommendations?\b/i],
  ['missing', /^missing\b/i],
]
function labelOf(text: string): LabelKind | null {
  const s = text.replace(/^[\s[(]+/, '').replace(/^\[?demo\]?\s*/i, '')
  for (const [k, re] of LABELS) if (re.test(s)) return k
  return null
}

/** a paragraph/heading that starts with a bold label, e.g. "**Verified (from ABCkit records)**: …" */
function asLabel(b: Block): { kind: LabelKind; title: string; rest: Inline[] } | null {
  if (b.t === 'h' && b.level >= 2) {
    const first = b.c[0]
    const text = inlineText(b.c)
    const k = labelOf(first?.t === 'strong' ? inlineText(first.c) : text)
    return k ? { kind: k, title: text.replace(/[:：]\s*$/, ''), rest: [] } : null
  }
  if (b.t === 'p' && b.c[0]?.t === 'strong') {
    const title = inlineText(b.c[0].c)
    const k = labelOf(title)
    if (!k) return null
    const rest = b.c.slice(1)
    if (rest[0]?.t === 'text') rest[0] = { t: 'text', v: rest[0].v.replace(/^\s*[:：—–-]?\s*/, '') }
    return { kind: k, title: title.replace(/[:：]\s*$/, ''), rest: rest.filter((x) => x.t !== 'text' || x.v) }
  }
  return null
}

function groupSections(blocks: Block[]): Block[] {
  const out: Block[] = []
  let cur: Extract<Block, { t: 'section' }> | null = null
  for (const b of blocks) {
    const lab = asLabel(b)
    if (lab) {
      cur = { t: 'section', kind: lab.kind, title: lab.title, c: lab.rest.length ? [{ t: 'p', c: lab.rest }] : [] }
      out.push(cur)
      continue
    }
    if (cur && (b.t === 'hr' || (b.t === 'h' && b.level <= 2))) cur = null
    if (cur) cur.c.push(b)
    else out.push(b)
  }
  return out
}

export function parseMarkdown(src: string): Block[] {
  const lines = String(src ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  return groupSections(parseBlocks(lines, 0))
}
