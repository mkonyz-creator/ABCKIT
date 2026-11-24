/**
 * Reading company files for the AI assistant (and the in-app file viewer), entirely in the browser.
 *  - text, CSV, JSON, Markdown → text
 *  - Word .docx / PowerPoint .pptx → text (own small ZIP reader using DecompressionStream)
 *  - Excel .xlsx → one CSV block per sheet (exceljs)
 *  - images → downscaled JPEG/PNG that the AI model can look at
 *  - PDF → the PDF itself for the AI model (it reads PDFs natively, including scans), plus best-effort text
 * Everything here is untrusted content: callers must label it as such for the model.
 */

export type Extracted =
  | { kind: 'text'; format: string; text: string; truncated: boolean }
  | { kind: 'image'; media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; data: string; width?: number; height?: number }
  | { kind: 'pdf'; data: string | null; text: string; truncated: boolean; too_large: boolean }
  | { kind: 'unsupported'; reason: string }

export const FILE_LIMITS = {
  /** characters of extracted text handed to the model */
  maxChars: 30_000,
  /** PDFs larger than this are not sent to the model as a document (text only) */
  maxPdfBytes: 3 * 1024 * 1024,
  /** longest image edge sent to the model */
  maxImageEdge: 1568,
  maxImageBytes: 3_500_000,
}

const ext = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()

export function fileKind(fileName: string, mime = ''): 'text' | 'docx' | 'pptx' | 'xlsx' | 'image' | 'pdf' | 'other' {
  const e = ext(fileName)
  const m = mime.toLowerCase()
  if (e === 'pdf' || m === 'application/pdf') return 'pdf'
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(e) || /^image\/(jpeg|png|webp|gif)$/.test(m)) return 'image'
  if (e === 'docx' || m.includes('wordprocessingml')) return 'docx'
  if (e === 'pptx' || m.includes('presentationml')) return 'pptx'
  if (e === 'xlsx' || m.includes('spreadsheetml')) return 'xlsx'
  if (['txt', 'csv', 'tsv', 'md', 'json', 'log', 'xml'].includes(e) || m.startsWith('text/') || m === 'application/json') return 'text'
  return 'other'
}

// ----------------------------------------------------------------------------- base64

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function clipText(text: string, max: number) {
  const t = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > max ? { text: `${t.slice(0, max)}\n…`, truncated: true } : { text: t, truncated: false }
}

// ----------------------------------------------------------------------------- ZIP (read + a tiny "stored" writer)

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds))
  return new Uint8Array(await out.arrayBuffer())
}

/** entries of a ZIP archive (only the ones `want` accepts are decompressed) */
export async function unzip(buf: ArrayBuffer, want: (name: string) => boolean = () => true): Promise<Map<string, Uint8Array>> {
  const b = new Uint8Array(buf)
  const v = new DataView(buf)
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new Error('Not a ZIP-based file (it may be damaged or an older .doc/.xls format)')
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out = new Map<string, Uint8Array>()
  const dec = new TextDecoder()
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break
    const method = v.getUint16(p + 10, true)
    const csize = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    if (!want(name)) continue
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const raw = b.subarray(start, start + csize)
    if (method === 0) out.set(name, raw)
    else if (method === 8) out.set(name, await inflateRaw(raw))
  }
  return out
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(d: Uint8Array) {
  let c = 0xffffffff
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** a ZIP with uncompressed entries (used to build the demo .docx) */
export function zipStored(files: Array<[name: string, content: string]>): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of files) {
    const nb = enc.encode(name)
    const data = enc.encode(content)
    const crc = crc32(data)
    const lh = new Uint8Array(30 + nb.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nb.length, true)
    lh.set(nb, 30)
    const ch = new Uint8Array(46 + nb.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nb.length, true)
    cv.setUint32(42, offset, true)
    ch.set(nb, 46)
    parts.push(lh, data)
    central.push(ch)
    offset += lh.length + data.length
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0))
  let o = 0
  for (const x of all) {
    out.set(x, o)
    o += x.length
  }
  return out
}

// ----------------------------------------------------------------------------- Office XML → text

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')

/** text of a WordprocessingML document.xml: paragraphs on lines, table cells separated by " | " */
export function docxXmlToText(xml: string): string {
  return decodeXml(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:tc>/g, ' | ')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/(\s*\|\s*)+$/, '').trimEnd())
    .join('\n')
}

async function officeText(buf: ArrayBuffer, kind: 'docx' | 'pptx'): Promise<string> {
  const dec = new TextDecoder()
  if (kind === 'docx') {
    const files = await unzip(buf, (n) => n === 'word/document.xml')
    const xml = files.get('word/document.xml')
    if (!xml) throw new Error('This Word file has no document body')
    return docxXmlToText(dec.decode(xml))
  }
  const files = await unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  const slides = [...files.entries()].sort((a, b) => Number(a[0].match(/\d+/)![0]) - Number(b[0].match(/\d+/)![0]))
  return slides
    .map(([, x], i) => {
      const texts = [...dec.decode(x).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]))
      return `--- Slide ${i + 1} ---\n${texts.join('\n')}`
    })
    .join('\n\n')
}

async function xlsxText(buf: ArrayBuffer, maxChars: number): Promise<string> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const out: string[] = []
  let size = 0
  wb.eachSheet((ws) => {
    if (size > maxChars) return
    out.push(`--- Sheet: ${ws.name} ---`)
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (size > maxChars) return
      const vals = (row.values as unknown[]).slice(1).map((v) => {
        if (v == null) return ''
        if (typeof v === 'object') {
          const o = v as { result?: unknown; text?: unknown; richText?: Array<{ text: string }>; hyperlink?: string }
          if (o.result !== undefined) return String(o.result)
          if (o.richText) return o.richText.map((r) => r.text).join('')
          if (o.text !== undefined) return String(o.text)
          if (v instanceof Date) return v.toISOString().slice(0, 10)
          return ''
        }
        return String(v)
      })
      const line = vals.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')
      size += line.length + 1
      out.push(line)
    })
  })
  return out.join('\n')
}

// ----------------------------------------------------------------------------- PDF (best-effort text)

function pdfStrings(content: string): string {
  const out: string[] = []
  const unescape = (s: string) => s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => ({ n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' })[c as 'n'] ?? String.fromCharCode(parseInt(c, 8)))
  const re = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[((?:\\.|[^\]])*)\]\s*TJ|(T\*|Td|TD|ET)/g
  let m: RegExpExecArray | null
  let line = ''
  while ((m = re.exec(content))) {
    if (m[2]) {
      if (line.trim()) out.push(line.trim())
      line = ''
    } else if (m[1] !== undefined) {
      line += [...m[1].matchAll(/\((?:\\.|[^\\)])*\)/g)].map((x) => unescape(x[0].slice(1, -1))).join('')
    } else line += unescape(m[0].slice(m[0].indexOf('(') + 1, m[0].lastIndexOf(')')))
  }
  if (line.trim()) out.push(line.trim())
  return out.join('\n')
}

/** text drawn with simple fonts (uncompressed or Flate-compressed content streams); '' when not readable this way */
export async function pdfText(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf)
  const latin = new TextDecoder('latin1').decode(bytes)
  const texts: string[] = []
  const re = /<<([^]*?)>>\s*stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(latin)) && texts.join('').length < 200_000) {
    const start = m.index + m[0].length
    const end = latin.indexOf('endstream', start)
    if (end < 0) break
    let data = bytes.subarray(start, end)
    if (/\/FlateDecode/.test(m[1])) {
      try {
        const ds = new DecompressionStream('deflate')
        data = new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds)).arrayBuffer())
      } catch {
        continue
      }
    } else if (/\/Filter/.test(m[1])) continue
    const t = pdfStrings(new TextDecoder('latin1').decode(data))
    if (t) texts.push(t)
    re.lastIndex = end
  }
  const text = texts.join('\n')
  // custom-encoded fonts produce gibberish: keep only text that is mostly readable
  const readable = (text.match(/[A-Za-z0-9 .,:;%()\-\n]/g) ?? []).length
  return text.length && readable / text.length > 0.85 ? text : ''
}

// ----------------------------------------------------------------------------- images

async function prepareImage(blob: Blob, kind: string): Promise<Extracted> {
  const type = (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(blob.type) ? blob.type : `image/${kind === 'jpg' ? 'jpeg' : kind}`) as 'image/jpeg'
  if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
    try {
      const bmp = await createImageBitmap(blob)
      const scale = Math.min(1, FILE_LIMITS.maxImageEdge / Math.max(bmp.width, bmp.height))
      if (scale < 1 || blob.size > FILE_LIMITS.maxImageBytes) {
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(bmp.width * scale)
        canvas.height = Math.round(bmp.height * scale)
        canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
        const jpeg = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
        if (jpeg) return { kind: 'image', media_type: 'image/jpeg', data: toBase64(new Uint8Array(await jpeg.arrayBuffer())), width: canvas.width, height: canvas.height }
      }
      return { kind: 'image', media_type: type, data: toBase64(new Uint8Array(await blob.arrayBuffer())), width: bmp.width, height: bmp.height }
    } catch {
      /* fall through */
    }
  }
  if (blob.size > FILE_LIMITS.maxImageBytes) return { kind: 'unsupported', reason: 'The picture is too large to analyse in this browser.' }
  return { kind: 'image', media_type: type, data: toBase64(new Uint8Array(await blob.arrayBuffer())) }
}

// ----------------------------------------------------------------------------- entry point

export async function extractFile(blob: Blob, fileName: string, mime = '', maxChars = FILE_LIMITS.maxChars): Promise<Extracted> {
  const kind = fileKind(fileName, mime || blob.type)
  try {
    if (kind === 'text') {
      const c = clipText(await blob.text(), maxChars)
      return { kind: 'text', format: ext(fileName) || 'txt', ...c }
    }
    if (kind === 'docx' || kind === 'pptx') {
      const c = clipText(await officeText(await blob.arrayBuffer(), kind), maxChars)
      return { kind: 'text', format: kind, ...c }
    }
    if (kind === 'xlsx') {
      const c = clipText(await xlsxText(await blob.arrayBuffer(), maxChars), maxChars)
      return { kind: 'text', format: 'xlsx', ...c }
    }
    if (kind === 'image') return await prepareImage(blob, ext(fileName))
    if (kind === 'pdf') {
      const buf = await blob.arrayBuffer()
      const c = clipText(await pdfText(buf), maxChars)
      const tooLarge = blob.size > FILE_LIMITS.maxPdfBytes
      return { kind: 'pdf', data: tooLarge ? null : toBase64(new Uint8Array(buf)), text: c.text, truncated: c.truncated, too_large: tooLarge }
    }
  } catch (e) {
    return { kind: 'unsupported', reason: `Could not read this file: ${(e as Error)?.message ?? e}` }
  }
  const e = ext(fileName)
  return {
    kind: 'unsupported',
    reason: ['doc', 'xls', 'ppt'].includes(e)
      ? `Old .${e} format cannot be read here — save it as .${e}x and upload again.`
      : `.${e || 'unknown'} files (e.g. CAD drawings, archives) cannot be read by the assistant; it can still open/download them.`,
  }
}
