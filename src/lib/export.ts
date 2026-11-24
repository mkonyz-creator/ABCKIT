import { downloadBlob, formatDate, formatMoney, formatNumber, slug } from './utils'

export type ExportFormat = 'text' | 'money' | 'number' | 'date' | 'percent'

export interface ExportColumn<T> {
  header: string
  value: (row: T) => string | number | null | undefined
  format?: ExportFormat
  width?: number
}

export interface ExportMeta {
  title: string
  subtitle?: string
  company?: { name: string; address?: string | null; phone?: string | null; email?: string | null; tin?: string | null }
  currency?: string
  totals?: Array<{ label: string; value: string }>
  orientation?: 'portrait' | 'landscape'
  footerNote?: string
  /** Rendered as label/value pairs above the table (e.g. project, date) */
  fields?: Array<{ label: string; value: string }>
}

function display<T>(col: ExportColumn<T>, row: T, currency?: string): string {
  const v = col.value(row)
  if (v === null || v === undefined || v === '') return ''
  switch (col.format) {
    case 'money':
      return formatMoney(v as number, currency).replace(/^[A-Z]{3} /, '')
    case 'number':
      return formatNumber(v as number, 3)
    case 'percent':
      return `${formatNumber(v as number, 1)}%`
    case 'date':
      return formatDate(String(v))
    default:
      return String(v)
  }
}

function fileBase(meta: ExportMeta) {
  return `${slug(meta.title)}-${new Date().toISOString().slice(0, 10)}`
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
export function exportCSV<T>(meta: ExportMeta, columns: ExportColumn<T>[], rows: T[]) {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const lines = [columns.map((c) => esc(c.header)).join(',')]
  for (const r of rows) {
    lines.push(
      columns
        .map((c) => {
          const v = c.value(r)
          if (v === null || v === undefined) return ''
          // keep numbers raw in CSV so spreadsheets can compute with them
          if (c.format === 'money' || c.format === 'number' || c.format === 'percent') return String(v)
          return esc(c.format === 'date' ? String(v).slice(0, 10) : String(v))
        })
        .join(','),
    )
  }
  // BOM so Excel opens UTF-8 (e.g. m², m³) correctly
  downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${fileBase(meta)}.csv`)
}

// ---------------------------------------------------------------------------
// Excel (exceljs is loaded on demand)
// ---------------------------------------------------------------------------
export async function exportExcel<T>(meta: ExportMeta, columns: ExportColumn<T>[], rows: T[]) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ABCkit'
  wb.created = new Date()
  const ws = wb.addWorksheet(meta.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), {
    pageSetup: { orientation: meta.orientation ?? 'portrait', fitToPage: true, fitToWidth: 1 },
  })

  let r = 1
  if (meta.company) {
    ws.getCell(r, 1).value = meta.company.name
    ws.getCell(r, 1).font = { bold: true, size: 14 }
    r++
  }
  ws.getCell(r, 1).value = meta.title
  ws.getCell(r, 1).font = { bold: true, size: 12, color: { argb: 'FFFF6B00' } }
  r++
  if (meta.subtitle) {
    ws.getCell(r, 1).value = meta.subtitle
    ws.getCell(r, 1).font = { italic: true, color: { argb: 'FF555555' } }
    r++
  }
  for (const f of meta.fields ?? []) {
    ws.getCell(r, 1).value = f.label
    ws.getCell(r, 1).font = { bold: true }
    ws.getCell(r, 2).value = f.value
    r++
  }
  r++

  const headerRow = ws.getRow(r)
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = c.header
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } }
    cell.alignment = { vertical: 'middle', wrapText: true }
    ws.getColumn(i + 1).width = c.width ?? Math.min(48, Math.max(12, c.header.length + 4))
  })
  headerRow.height = 22
  const firstDataRow = r + 1

  for (const row of rows) {
    r++
    const xr = ws.getRow(r)
    columns.forEach((c, i) => {
      const v = c.value(row)
      const cell = xr.getCell(i + 1)
      if (v === null || v === undefined || v === '') return
      if (c.format === 'money' || c.format === 'number' || c.format === 'percent') {
        cell.value = Number(v)
        cell.numFmt = c.format === 'money' ? '#,##0.00' : c.format === 'percent' ? '0.0"%"' : '#,##0.###'
      } else if (c.format === 'date') {
        const d = new Date(String(v))
        cell.value = isNaN(d.getTime()) ? String(v) : d
        cell.numFmt = 'dd mmm yyyy'
      } else {
        cell.value = String(v)
        cell.alignment = { wrapText: true, vertical: 'top' }
      }
    })
  }
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: firstDataRow - 1, column: 1 }, to: { row: r, column: columns.length } }
  }
  ws.views = [{ state: 'frozen', ySplit: firstDataRow - 1 }]

  if (meta.totals?.length) {
    r += 2
    for (const t of meta.totals) {
      ws.getCell(r, Math.max(1, columns.length - 1)).value = t.label
      ws.getCell(r, Math.max(1, columns.length - 1)).font = { bold: true }
      ws.getCell(r, columns.length).value = t.value
      ws.getCell(r, columns.length).font = { bold: true }
      r++
    }
  }

  const buf = await wb.xlsx.writeBuffer()
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${fileBase(meta)}.xlsx`,
  )
}

// ---------------------------------------------------------------------------
// PDF (jsPDF + autotable, loaded on demand)
// ---------------------------------------------------------------------------
export interface PdfSection<T = unknown> {
  heading?: string
  columns: ExportColumn<T>[]
  rows: T[]
  footRows?: string[][]
}

export async function buildPdf(meta: ExportMeta, sections: PdfSection<any>[], extra?: (doc: any, y: number) => number) {
  const { jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default
  const doc = new jsPDF({ orientation: meta.orientation ?? 'portrait', unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const margin = 14

  // Header band
  doc.setFillColor(0, 0, 0)
  doc.rect(0, 0, pageW, 24, 'F')
  doc.setFillColor(255, 107, 0)
  doc.rect(0, 24, pageW, 1.6, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text(meta.company?.name ?? 'ARICOM BUILDING CONTRACTORS', margin, 10)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  const contact = [meta.company?.address, meta.company?.phone, meta.company?.email, meta.company?.tin ? `TIN ${meta.company.tin}` : '']
    .filter(Boolean)
    .join('  ·  ')
  if (contact) doc.text(contact, margin, 16, { maxWidth: pageW - margin * 2 - 30 })
  doc.setTextColor(255, 107, 0)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.text('ABCkit', pageW - margin, 10, { align: 'right' })

  doc.setTextColor(0, 0, 0)
  doc.setFontSize(15)
  doc.text(meta.title, margin, 36)
  let y = 41
  if (meta.subtitle) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(90, 90, 90)
    doc.text(meta.subtitle, margin, y)
    y += 5
  }
  if (meta.fields?.length) {
    doc.setFontSize(9)
    const colW = (pageW - margin * 2) / 2
    meta.fields.forEach((f, i) => {
      const x = margin + (i % 2) * colW
      const yy = y + Math.floor(i / 2) * 5.5
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(0, 0, 0)
      doc.text(`${f.label}:`, x, yy)
      doc.setFont('helvetica', 'normal')
      doc.text(String(f.value ?? ''), x + 32, yy, { maxWidth: colW - 34 })
    })
    y += Math.ceil(meta.fields.length / 2) * 5.5 + 2
  }

  for (const s of sections) {
    if (s.heading) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10.5)
      doc.setTextColor(0, 0, 0)
      if (y > doc.internal.pageSize.getHeight() - 30) {
        doc.addPage()
        y = 18
      }
      doc.text(s.heading, margin, y + 4)
      y += 6
    }
    autoTable(doc, {
      startY: y + 1,
      margin: { left: margin, right: margin },
      head: [s.columns.map((c) => c.header)],
      body: s.rows.map((r) => s.columns.map((c) => display(c, r, meta.currency))),
      foot: s.footRows,
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.8, lineColor: [210, 210, 205], lineWidth: 0.15, textColor: [20, 20, 20] },
      headStyles: { fillColor: [0, 0, 0], textColor: [255, 255, 255], fontStyle: 'bold' },
      footStyles: { fillColor: [255, 241, 230], textColor: [0, 0, 0], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [248, 248, 246] },
      columnStyles: Object.fromEntries(
        s.columns.map((c, i) => [i, c.format && c.format !== 'text' && c.format !== 'date' ? { halign: 'right' } : {}]),
      ),
    })
    y = (doc as any).lastAutoTable.finalY + 6
  }

  if (meta.totals?.length) {
    doc.setFontSize(10)
    for (const t of meta.totals) {
      if (y > doc.internal.pageSize.getHeight() - 20) {
        doc.addPage()
        y = 18
      }
      doc.setFont('helvetica', 'bold')
      doc.text(t.label, pageW - margin - 70, y)
      doc.text(t.value, pageW - margin, y, { align: 'right' })
      y += 6
    }
  }
  if (extra) y = extra(doc, y)

  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    const h = doc.internal.pageSize.getHeight()
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(120, 120, 120)
    doc.text(
      `${meta.footerNote ?? 'Generated by ABCkit'} · ${new Date().toLocaleString()}`,
      margin,
      h - 8,
    )
    doc.text(`Page ${i} of ${pages}`, pageW - margin, h - 8, { align: 'right' })
  }
  return doc
}

export async function exportPDF<T>(meta: ExportMeta, columns: ExportColumn<T>[], rows: T[]) {
  const doc = await buildPdf(meta, [{ columns, rows }])
  doc.save(`${fileBase(meta)}.pdf`)
}
