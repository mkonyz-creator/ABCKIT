/** Safe Markdown renderer: HTML is never interpreted, unsafe links are dropped, answer labels are recognised. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/components/ai/Markdown'
import { parseMarkdown, safeHref } from './markdown'

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

describe('markdown renderer', () => {
  it('escapes raw HTML instead of rendering it', () => {
    const out = html('Hello <script>alert(1)</script> <img src=x onerror="alert(2)"> **bold**')
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).toContain('<strong class="font-semibold">bold</strong>')
  })

  it('blocks javascript:, data:, http: and protocol-relative links but keeps their text', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'http://evil.example', '//evil.example', 'vbscript:x', '/\\evil.example'])
      expect(safeHref(bad), bad).toBeNull()
    const out = html('[click me](javascript:alert(1)) and [ok](/projects/p1) and [web](https://example.com/a?b=1)')
    expect(out).not.toMatch(/javascript:/i)
    expect(out).toContain('click me')
    expect(out).toContain('href="#/projects/p1"')
    expect(out).toContain('href="https://example.com/a?b=1"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
    expect(out).toContain('target="_blank"')
    expect(html('[\\[DEMO\\] PO-1](/procurement?tab=orders)')).toContain('href="#/procurement?tab=orders" class="font-medium text-accent-ink underline underline-offset-2 hover:text-accent">[DEMO] PO-1</a>')
  })

  it('renders headings, lists, tables and code', () => {
    const out = html('# Title\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n| A | B |\n|---|--:|\n| x | 2 |\n\n```\ncode <b>\n```')
    expect(out).toContain('<h2')
    expect(out.match(/<ul/g)).toHaveLength(2)
    expect(out).toContain('<ol')
    expect(out).toContain('<table')
    expect(out).toContain('text-right')
    expect(out).toContain('code &lt;b&gt;')
  })

  it('groups Verified / Historical / AI recommendation / Missing sections', () => {
    const blocks = parseMarkdown('**Verified (from ABCkit records)**\n- fact\n\n**Historical**: last month\n\n**AI recommendation**\n- do x\n\n**Missing / not available**\n- y\n\n## Next\ntext')
    expect(blocks.filter((b) => b.t === 'section').map((b) => (b as { kind: string }).kind)).toEqual(['verified', 'historical', 'recommendation', 'missing'])
    expect(blocks.at(-1)).toMatchObject({ t: 'p' })
    const out = html('**Verified (from ABCkit records)**\n- fact')
    expect(out).toContain('data-label="verified"')
  })
})
