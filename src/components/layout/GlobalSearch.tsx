import * as D from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { Boxes, FileStack, FolderKanban, Loader2, Search, Truck, Users, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDebounced } from '@/lib/hooks'
import { P } from '@/lib/permissions'
import { db } from '@/lib/backend'
import { useAuth } from '@/providers/AuthProvider'
import { allowed, NAV } from './nav'

interface Hit {
  kind: string
  icon: LucideIcon
  label: string
  sub?: string
  to: string
}

export function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const term = useDebounced(q.trim(), 250)

  const results = useQuery({
    queryKey: ['global-search', term],
    enabled: open && term.length >= 2,
    queryFn: async () => {
      const like = `%${term.replace(/[%_,()]/g, ' ')}%`
      const tasks: Array<Promise<Hit[]>> = []
      if (can(P.projectsView))
        tasks.push(
          Promise.resolve(db.from('projects').select('id,name,code,location').or(`name.ilike.${like},code.ilike.${like},location.ilike.${like}`).limit(6)).then(
            (r) => (r.data ?? []).map((p) => ({ kind: 'Project', icon: FolderKanban, label: p.name, sub: `${p.code}${p.location ? ' · ' + p.location : ''}`, to: `/projects/${p.id}` })),
          ),
        )
      if (can(P.inventoryView))
        tasks.push(
          Promise.resolve(db.from('materials').select('id,name,code,unit,current_stock').or(`name.ilike.${like},code.ilike.${like}`).limit(5)).then((r) =>
            (r.data ?? []).map((m) => ({ kind: 'Material', icon: Boxes, label: m.name, sub: `${m.code} · ${m.current_stock} ${m.unit} in stock`, to: `/inventory?q=${encodeURIComponent(m.name)}` })),
          ),
        )
      if (can(P.hrView))
        tasks.push(
          Promise.resolve(db.from('employees').select('id,full_name,employee_no,position').or(`full_name.ilike.${like},employee_no.ilike.${like}`).limit(5)).then((r) =>
            (r.data ?? []).map((e) => ({ kind: 'Employee', icon: Users, label: e.full_name, sub: `${e.employee_no} · ${e.position}`, to: `/workforce?q=${encodeURIComponent(e.full_name)}` })),
          ),
        )
      if (can(P.procurementView))
        tasks.push(
          Promise.resolve(db.from('suppliers').select('id,name,category').ilike('name', like).limit(4)).then((r) =>
            (r.data ?? []).map((s) => ({ kind: 'Supplier', icon: Truck, label: s.name, sub: s.category ?? undefined, to: `/procurement?tab=suppliers&q=${encodeURIComponent(s.name)}` })),
          ),
        )
      if (can(P.documentsView))
        tasks.push(
          Promise.resolve(db.from('documents').select('id,title,category').ilike('title', like).limit(5)).then((r) =>
            (r.data ?? []).map((d) => ({ kind: 'Document', icon: FileStack, label: d.title, sub: d.category, to: `/documents?q=${encodeURIComponent(d.title)}` })),
          ),
        )
      return (await Promise.all(tasks)).flat()
    },
  })

  const pages = NAV.filter((n) => allowed(n, can) && (!q || n.label.toLowerCase().includes(q.toLowerCase()))).slice(0, q ? 5 : 8)

  const go = (to: string) => {
    onOpenChange(false)
    setQ('')
    navigate(to)
  }

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <D.Content className="fixed left-1/2 top-[8vh] z-50 w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl" aria-describedby={undefined}>
          <D.Title className="sr-only">Search</D.Title>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-4 text-subtle" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search projects, materials, employees, suppliers, documents…"
              className="h-14 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
              aria-label="Search"
            />
            {results.isFetching && <Loader2 className="size-4 animate-spin text-accent" />}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {pages.length > 0 && (
              <Section title="Go to">
                {pages.map((p) => (
                  <Row key={p.to} icon={p.icon} label={p.label} onClick={() => go(p.to)} />
                ))}
              </Section>
            )}
            {term.length >= 2 && (
              <Section title="Records">
                {(results.data ?? []).length === 0 && !results.isFetching ? (
                  <p className="px-3 py-4 text-sm text-muted">No records match “{term}”.</p>
                ) : (
                  (results.data ?? []).map((h, i) => <Row key={i} icon={h.icon} label={h.label} sub={`${h.kind}${h.sub ? ' · ' + h.sub : ''}`} onClick={() => go(h.to)} />)
                )}
              </Section>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">{title}</p>
      {children}
    </div>
  )
}

function Row({ icon: Icon, label, sub, onClick }: { icon: LucideIcon; label: string; sub?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2 focus:bg-surface-2 focus:outline-none">
      <Icon className="size-4 shrink-0 text-accent-ink" />
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
      </span>
    </button>
  )
}
