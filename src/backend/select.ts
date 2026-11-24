/**
 * Parser for PostgREST select strings, e.g.
 *   '*, project:projects(id,name,client:clients(name)), creator:profiles!documents_created_by_fkey(full_name), items:purchase_request_items(*)'
 */
export interface SelectNode {
  /** plain columns; '*' means all */
  columns: Array<{ name: string; alias: string }>
  star: boolean
  embeds: EmbedNode[]
}

export interface EmbedNode {
  alias: string
  table: string
  /** fk hint after '!' (constraint name or column), or 'inner' modifiers */
  hint?: string
  inner: boolean
  select: SelectNode
}

function splitTop(s: string) {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const cache = new Map<string, SelectNode>()

export function parseSelect(text: string | undefined | null): SelectNode {
  const key = (text ?? '*').replace(/\s+/g, '')
  const hit = cache.get(key)
  if (hit) return hit
  const node: SelectNode = { columns: [], star: false, embeds: [] }
  for (const part of splitTop(key || '*')) {
    const paren = part.indexOf('(')
    if (paren > 0 && part.endsWith(')')) {
      const head = part.slice(0, paren)
      const inner = part.slice(paren + 1, -1)
      let alias: string | undefined
      let rest = head
      const colon = head.indexOf(':')
      if (colon > 0) {
        alias = head.slice(0, colon)
        rest = head.slice(colon + 1)
      }
      const [table, ...mods] = rest.split('!')
      const isInner = mods.includes('inner')
      const hint = mods.find((m) => m !== 'inner' && m !== 'left')
      node.embeds.push({ alias: alias ?? table, table, hint, inner: isInner, select: parseSelect(inner) })
    } else if (part === '*') {
      node.star = true
    } else {
      // "alias:column" or "column" (json arrows/casts are not used by the app)
      const colon = part.indexOf(':')
      const name = (colon > 0 ? part.slice(colon + 1) : part).split('::')[0]
      const alias = colon > 0 ? part.slice(0, colon) : name
      node.columns.push({ name, alias })
    }
  }
  cache.set(key, node)
  return node
}
