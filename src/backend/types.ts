export interface ColumnDefault {
  kind: 'uuid' | 'uid' | 'now' | 'today' | 'value' | 'unknown'
  value?: unknown
  expr?: string
}
export interface ColumnSchema {
  type: string
  notNull?: boolean
  default?: ColumnDefault
  generated?: string
  identity?: boolean
}
export interface ForeignKey {
  table: string
  column: string
  onDelete: string
}
export interface TableSchema {
  columns: Record<string, ColumnSchema>
  pk: string[]
  fks: Record<string, ForeignKey>
  uniques: string[][]
}
