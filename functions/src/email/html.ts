/**
 * Safe HTML → plain text for email bodies. No DOM, no script execution: a linear tag-stripping pass that drops
 * <script>/<style>/<head>/comments, turns block elements into line breaks, keeps link targets and decodes entities.
 */

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€',
  pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷', laquo: '«', raquo: '»', shy: '', zwnj: '', zwj: '',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ''
      return String.fromCodePoint(code)
    }
    const v = NAMED[e.toLowerCase()]
    return v === undefined ? m : v
  })
}

const BLOCK = /^(p|div|br|tr|li|ul|ol|table|h[1-6]|blockquote|pre|hr|section|article|header|footer|address|dl|dt|dd)$/i

export function htmlToText(html: string): string {
  if (!html) return ''
  let s = html
  // remove non-content sections entirely
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|head|title|noscript|template|svg|object|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
  s = s.replace(/<(script|style|head)\b[^>]*\/?>/gi, '')
  // links: keep the visible text and the target (helps reviewers spot phishing)
  s = s.replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, h1, h2, h3, inner: string) => {
    const href = (h1 ?? h2 ?? h3 ?? '').trim()
    const text = inner.replace(/<[^>]*>/g, '').trim()
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return text
    const cleanHref = href.replace(/^mailto:/i, '')
    return text && decodeEntities(text) !== decodeEntities(cleanHref) ? `${text} (${cleanHref})` : cleanHref
  })
  s = s.replace(/<li\b[^>]*>/gi, '\n• ')
  s = s.replace(/<(td|th)\b[^>]*>/gi, '\t')
  s = s.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (_m, tag: string) => (BLOCK.test(tag) ? '\n' : ''))
  s = s.replace(/<[^>]*>/g, '') // stray / malformed tags
  s = decodeEntities(s)
  s = s.replace(/\r\n?/g, '\n')
  s = s.replace(/[ \t\f\v ]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
