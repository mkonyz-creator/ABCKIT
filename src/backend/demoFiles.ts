/**
 * [DEMO] sample files for the Documents module. The document rows are seeded with the demo data
 * (demoSeed.ts); the files themselves are generated on first download (demo storage, demo.ts), so the
 * demo works without bundling binaries: a PDF contract (jsPDF), a Word .docx of site-meeting minutes,
 * an Excel .xlsx supplier quotation and a CSV BOQ extract. All content is fictitious and marked [DEMO].
 */
import { zipStored } from '../lib/ai/fileText'

export interface DemoFile {
  path: string
  project: 'office' | 'health'
  title: string
  category: 'contract' | 'boq' | 'correspondence' | 'other'
  description: string
  tags: string[]
  file_name: string
  mime: string
  approx_bytes: number
  make(): Promise<Blob>
}

const CONTRACT_LINES = [
  '[DEMO] CONTRACT AGREEMENT - SAMPLE ONLY',
  'Project: [DEMO] 4-Storey Office Block, Plot 12, Mikocheni, Dar es Salaam',
  'Employer: [DEMO] Kilimani Developers Ltd',
  'Contractor: ARICOM Building Contractors',
  '',
  '1. Contract sum: TZS 2,450,000,000 (VAT inclusive).',
  '2. Commencement: on handover of site. Duration: 12 months.',
  '3. Liquidated damages: TZS 1,500,000 per day of delay, capped at 10% of the contract sum.',
  '4. Advance payment: 15% against an advance payment guarantee.',
  '5. Interim payments: monthly certificates (IPC), payable within 28 days of certification.',
  '6. Retention: 5% of each certificate, half released at practical completion.',
  '7. Defects liability period: 12 months after practical completion.',
  '8. Performance security: 10% of the contract sum, valid until practical completion.',
  '9. Insurance: contractor all risks and third-party liability for the full contract period.',
  '10. Disputes: amicable settlement first, then adjudication, then arbitration in Dar es Salaam.',
  '',
  'Signed for the Employer: ____________   Signed for the Contractor: ____________',
]

const MINUTES = [
  ['[DEMO] SITE MEETING No. 7 - MINUTES', true],
  ['Project: [DEMO] 4-Storey Office Block - Date: last Wednesday - Venue: site office', false],
  ['Present: Project Manager (Paula Shirima), Site Engineer (Elia Mwanga), QS (Queen Lyimo), Consultant representative', false],
  ['1. Progress: first-floor slab 60% complete; casting planned for next week if steel arrives.', false],
  ['2. Materials: Y12 steel delivery from supplier is 5 days late. Action: Procurement to call supplier today.', false],
  ['3. Safety: one near miss (plank from scaffold). Toe boards installed; toolbox talk held. Action: Site Engineer to inspect scaffolds weekly.', false],
  ['4. Payments: IPC No. 2 to be submitted to the consultant by the QS within 12 days.', false],
  ['5. Permit: building permit renewal is overdue. Action: Project Manager to follow up with the municipality this week.', false],
  ['Next meeting: next Wednesday, 10:00, site office.', false],
] as const

const BOQ_CSV = [
  'Item,Description,Unit,Quantity,Rate (TZS),Amount (TZS)',
  'A1,[DEMO] Remove and dispose of old roofing sheets - Ward B,m2,420,4500,1890000',
  'A2,[DEMO] Supply and fix new IT4 roofing sheets 0.4mm,m2,420,32000,13440000',
  'B1,[DEMO] Repair cracked plaster - walls,m2,260,12000,3120000',
  'B2,[DEMO] Two coats emulsion paint - walls,m2,1850,6500,12025000',
  'C1,[DEMO] Replace toilet cisterns,No.,14,185000,2590000',
  'C2,[DEMO] New PVC water pipes 25mm,m,320,9500,3040000',
  'D1,[DEMO] Electrical rewiring - Ward B,Item,1,18500000,18500000',
  ',,,,Total,54605000',
].join('\n')

function docxFromParagraphs(paras: ReadonlyArray<readonly [string, boolean]>): Blob {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = paras.map(([t, bold]) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`).join('')
  const bytes = zipStored([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`],
  ])
  return new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}

export const DEMO_FILES: DemoFile[] = [
  {
    path: 'demo/office-block/contract-agreement.pdf',
    project: 'office',
    title: '[DEMO] Main contract agreement – 4-Storey Office Block',
    category: 'contract',
    description: '[DEMO] Signed contract: sum, payment terms, retention, liquidated damages',
    tags: ['contract', 'mkataba', 'agreement'],
    file_name: 'contract-agreement.pdf',
    mime: 'application/pdf',
    approx_bytes: 4200,
    async make() {
      const { jsPDF } = await import('jspdf')
      const doc = new jsPDF({ unit: 'mm', format: 'a4' })
      doc.setFontSize(14)
      doc.text(CONTRACT_LINES[0], 15, 20)
      doc.setFontSize(10)
      CONTRACT_LINES.slice(1).forEach((l, i) => doc.text(l, 15, 32 + i * 7))
      return doc.output('blob')
    },
  },
  {
    path: 'demo/office-block/site-meeting-07-minutes.docx',
    project: 'office',
    title: '[DEMO] Site meeting No. 7 – minutes',
    category: 'correspondence',
    description: '[DEMO] Minutes of the weekly site meeting with actions',
    tags: ['minutes', 'kumbukumbu', 'meeting', 'kikao'],
    file_name: 'site-meeting-07-minutes.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    approx_bytes: 2600,
    async make() {
      return docxFromParagraphs(MINUTES)
    },
  },
  {
    path: 'demo/office-block/steel-quotation.xlsx',
    project: 'office',
    title: '[DEMO] Supplier quotation – reinforcement steel',
    category: 'other',
    description: '[DEMO] Quotation for Y10/Y12/Y16 bars from a sample supplier',
    tags: ['quotation', 'nukuu', 'steel', 'bei'],
    file_name: 'steel-quotation.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    approx_bytes: 7000,
    async make() {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Quotation')
      ws.addRow(['[DEMO] Quotation Q-2026-118 – valid 14 days'])
      ws.addRow(['Item', 'Size', 'Unit', 'Quantity', 'Unit price (TZS)', 'Amount (TZS)'])
      const rows: Array<[string, string, string, number, number]> = [
        ['Deformed bar', 'Y10 x 12 m', 'pc', 400, 16500],
        ['Deformed bar', 'Y12 x 12 m', 'pc', 650, 26500],
        ['Deformed bar', 'Y16 x 12 m', 'pc', 220, 46000],
        ['Binding wire', '25 kg roll', 'roll', 30, 95000],
      ]
      for (const r of rows) ws.addRow([...r, r[3] * r[4]])
      ws.addRow(['', '', '', '', 'Total', rows.reduce((s, r) => s + r[3] * r[4], 0)])
      ws.addRow(['Delivery: 7 days after order. Payment: 50% advance, 50% on delivery.'])
      const buf = await wb.xlsx.writeBuffer()
      return new Blob([buf as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    },
  },
  {
    path: 'demo/health-centre/boq-ward-b.csv',
    project: 'health',
    title: '[DEMO] BOQ extract – Ward B renovation',
    category: 'boq',
    description: '[DEMO] Bill of quantities for roofing, finishes, plumbing and electrical works in Ward B',
    tags: ['boq', 'makadirio', 'vipimo'],
    file_name: 'boq-ward-b.csv',
    mime: 'text/csv',
    approx_bytes: BOQ_CSV.length,
    async make() {
      return new Blob([BOQ_CSV], { type: 'text/csv' })
    },
  },
]

const BY_PATH = new Map(DEMO_FILES.map((f) => [f.path, f]))

/** the generated sample file for a demo storage path, or null */
export async function demoFileBlob(bucket: string, path: string): Promise<Blob | null> {
  if (bucket !== 'documents') return null
  const f = BY_PATH.get(path.replace(/^\/+/, ''))
  return f ? f.make() : null
}
