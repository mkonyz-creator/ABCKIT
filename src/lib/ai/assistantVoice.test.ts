import { describe, expect, it } from 'vitest'
import { demoComplete } from './demoAssistant'
import { visibleText } from './pageContext'
import { speechChunks, toSpeech } from './voice'

// ---- a tiny DOM stand-in (the unit tests run in node)
type FakeNode = { nodeType: number; textContent?: string; tagName?: string; childNodes: FakeNode[]; attrs?: Record<string, string>; getAttribute?: (k: string) => string | null; hasAttribute?: (k: string) => boolean }
const txt = (s: string): FakeNode => ({ nodeType: 3, textContent: s, childNodes: [] })
const el = (tag: string, children: Array<FakeNode | string>, attrs: Record<string, string> = {}): FakeNode => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  attrs,
  childNodes: children.map((c) => (typeof c === 'string' ? txt(c) : c)),
  getAttribute: (k) => attrs[k] ?? null,
  hasAttribute: (k) => k in attrs,
})

describe('page context: visible text of the page', () => {
  it('keeps headings, paragraphs and table rows; skips inputs, buttons, hidden and data-ai-ignore parts', () => {
    const main = el('main', [
      el('h1', ['[DEMO] Mbezi Villas']),
      el('p', ['Progress ', el('strong', ['42%']), ' — budget used 71%']),
      el('table', [el('tr', [el('th', ['Task']), el('th', ['Status'])]), el('tr', [el('td', ['Roofing']), el('td', ['Overdue'])])]),
      el('input', [], { value: 'secret' }),
      el('button', ['Save']),
      el('div', ['should not appear'], { 'aria-hidden': 'true' }),
      el('div', ['assistant panel'], { 'data-ai-ignore': '' }),
      el('p', ['[DEMO] Mbezi Villas']),
    ])
    const text = visibleText(main as unknown as Element)
    expect(text.split('\n')).toEqual(['[DEMO] Mbezi Villas', 'Progress 42% — budget used 71%', 'Task | Status', 'Roofing | Overdue'])
  })
})

describe('page context: tables', () => {
  it('keeps sortable header buttons and puts each cell on its row line', () => {
    const main = el('main', [
      el('button', ['Export']),
      el('table', [
        el('tr', [el('th', [el('button', ['Material'])]), el('th', [el('button', ['In stock'])]), el('th', ['Minimum'])]),
        el('tr', [el('td', [el('div', ['[DEMO] Diesel']), el('div', ['MAT-2026-0005'])]), el('td', ['350 litre']), el('td', ['500'])]),
      ]),
    ])
    expect(visibleText(main as unknown as Element).split('\n')).toEqual(['Material | In stock | Minimum', '[DEMO] Diesel MAT-2026-0005 | 350 litre | 500'])
  })
})

describe('voice output', () => {
  it('turns a markdown answer into plain sentences to read aloud', () => {
    const md = [
      '> **[DEMO] rule-based assistant.**',
      '## Verified',
      '- Project [Mbezi Villas](/projects/abc) is **behind** schedule',
      '| Task | Status |',
      '|---|---|',
      '| Roofing | Overdue |',
      'Record 1b4e28ba-2fa1-11d2-883f-0016d3cca427 see https://example.com',
    ].join('\n')
    const s = toSpeech(md)
    expect(s).not.toMatch(/[*#|>[\]]|https?:|1b4e28ba/)
    expect(s).toContain('Project Mbezi Villas is behind schedule.')
    expect(s).toContain('Roofing, Overdue.')
    expect(s.startsWith('demo rule-based assistant.')).toBe(true)
  })

  it('caps long answers at a sentence boundary and splits speech into short utterances', () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const s = toSpeech(long, 300)
    expect(s.length).toBeLessThanOrEqual(300)
    expect(s.endsWith('.')).toBe(true)
    const chunks = speechChunks(long)
    expect(chunks.every((c) => c.length <= 220)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long)
  })
})

describe('[DEMO] assistant answers about the page on screen', () => {
  const page = {
    path: '/projects/p1',
    title: '[DEMO] Mbezi Villas',
    text: ['[DEMO] Mbezi Villas', 'Progress 42%', 'Budget used 71%', 'Roofing | Overdue', 'Steel delivery | Pending approval', 'Painting | Done'].join('\n'),
  }
  const req = (question: string, extra: Record<string, unknown> = {}) =>
    demoComplete({
      purpose: 'chat',
      messages: [{ role: 'user', content: question }],
      tools: [{ name: 'get_company_overview', description: 'x', input_schema: { type: 'object' } }],
      context: { today: '2026-11-15', user_name: 'MD', role: 'md', locale: 'sw', page, ...extra },
    })

  it('answers "this page" questions from the screen in Kiswahili, without calling data tools', () => {
    const r = req('Nishauri kuhusu ukurasa huu')
    expect(r.stop_reason).toBe('end_turn')
    const text = (r.content[0] as { text: string }).text
    expect(text).toContain('[DEMO] Mbezi Villas')
    expect(text).toContain('Roofing | Overdue')
    expect(text).toContain('Steel delivery | Pending approval')
    expect(text).not.toContain('Painting | Done')
    expect(text).toMatch(/Ushauri/)
  })

  it('gives a short spoken answer in voice mode', () => {
    const r = req('What needs attention here?', { voice: true, locale: 'en' })
    const text = (r.content[0] as { text: string }).text
    expect(text).toMatch(/^This is the demo, not a real AI\./)
    expect(text).not.toMatch(/[*#>]/)
    expect(text).toContain('Roofing | Overdue')
  })

  it('spots stock below minimum in an inventory table and keeps stat-card numbers', () => {
    const inv = {
      path: '/inventory',
      title: 'Materials & Inventory',
      text: [
        'Stock alerts',
        '2',
        'materials at/below minimum',
        'Material | Category | In stock | Minimum',
        '[DEMO] Diesel MAT-2026-0005 DEMO | Fuel & Lubricants | 350 litre | 500',
        '[DEMO] Portland cement | Cement & Binders | 230 bag | 200',
        '[DEMO] River sand MAT-2026-0002 DEMO | Aggregates | 25 tonne | 40',
      ].join('\n'),
    }
    const r = demoComplete({ purpose: 'chat', messages: [{ role: 'user', content: 'What needs attention here?' }], tools: [], context: { today: '2026-11-15', user_name: 'x', role: 'x', locale: 'en', page: inv } })
    const text = (r.content[0] as { text: string }).text
    expect(text).toContain('[DEMO] Diesel: 350 litre (minimum 500)')
    expect(text).toContain('[DEMO] River sand: 25 tonne (minimum 40)')
    expect(text).not.toContain('Portland cement: 230')
    expect(text).toContain('Stock alerts 2 materials at/below minimum')
  })

  it('still uses the data tools for company questions', () => {
    const r = req('Niambie kila kinachoendelea kwenye kampuni leo.')
    expect(r.stop_reason).toBe('tool_use')
  })
})
