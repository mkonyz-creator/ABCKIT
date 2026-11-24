import { CircleHelp, History, ShieldCheck, Sparkles } from 'lucide-react'
import { Fragment, useMemo, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline, type LabelKind } from '@/lib/ai/markdown'
import { cn } from '@/lib/utils'

/** Safe Markdown renderer: builds React elements from the AST (no dangerouslySetInnerHTML). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <div className={cn('ai-md space-y-3 text-sm leading-relaxed break-words', className)}>{blocks.map((b, i) => renderBlock(b, i))}</div>
}

export const LABEL_STYLE: Record<LabelKind, { label: string; icon: typeof ShieldCheck; box: string; chip: string }> = {
  verified: { label: 'Verified', icon: ShieldCheck, box: 'border-success/40 bg-success-soft/40', chip: 'bg-success-soft text-success border-success/30' },
  historical: { label: 'Historical', icon: History, box: 'border-info/40 bg-info-soft/40', chip: 'bg-info-soft text-info border-info/30' },
  recommendation: { label: 'AI recommendation', icon: Sparkles, box: 'border-accent/50 bg-accent-soft/40', chip: 'bg-accent-soft text-accent-ink border-accent/30' },
  missing: { label: 'Missing / not available', icon: CircleHelp, box: 'border-warning/40 bg-warning-soft/40', chip: 'bg-warning-soft text-warning border-warning/30' },
}

function renderInline(c: Inline[], key = 'i'): ReactNode[] {
  return c.map((x, i) => {
    const k = `${key}-${i}`
    switch (x.t) {
      case 'text':
        return <Fragment key={k}>{x.v}</Fragment>
      case 'strong':
        return <strong key={k} className="font-semibold">{renderInline(x.c, k)}</strong>
      case 'em':
        return <em key={k}>{renderInline(x.c, k)}</em>
      case 'code':
        return (
          <code key={k} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">
            {x.v}
          </code>
        )
      case 'link':
        return x.external ? (
          <a key={k} href={x.href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-accent-ink underline underline-offset-2 hover:text-accent">
            {renderInline(x.c, k)}
          </a>
        ) : (
          <a key={k} href={x.href} className="font-medium text-accent-ink underline underline-offset-2 hover:text-accent">
            {renderInline(x.c, k)}
          </a>
        )
    }
  })
}

function renderBlock(b: Block, i: number): ReactNode {
  const k = `b-${i}`
  switch (b.t) {
    case 'h': {
      const cls = ['', 'text-lg font-bold', 'text-base font-bold', 'text-sm font-bold', 'text-sm font-semibold', 'text-sm font-semibold', 'text-xs font-semibold uppercase'][b.level]
      const Tag = (`h${Math.min(6, b.level + 1)}`) as 'h2'
      return (
        <Tag key={k} className={cn('tracking-tight', cls, i > 0 && 'pt-1')}>
          {renderInline(b.c, k)}
        </Tag>
      )
    }
    case 'p':
      return <p key={k}>{renderInline(b.c, k)}</p>
    case 'hr':
      return <hr key={k} className="border-border" />
    case 'code':
      return (
        <pre key={k} className="scrollbar-thin overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed">
          <code>{b.v}</code>
        </pre>
      )
    case 'quote':
      return (
        <blockquote key={k} className="space-y-2 border-l-2 border-border-strong pl-3 text-muted">
          {b.c.map((x, j) => renderBlock(x, j))}
        </blockquote>
      )
    case 'list': {
      const items = b.items.map((it, j) => (
        <li key={j} className="pl-1 [&>p]:inline [&>ul]:mt-1 [&>ol]:mt-1">
          {it.map((x, n) => renderBlock(x, n))}
        </li>
      ))
      return b.ordered ? (
        <ol key={k} start={b.start} className="list-decimal space-y-1 pl-5 marker:text-subtle">
          {items}
        </ol>
      ) : (
        <ul key={k} className="list-disc space-y-1 pl-5 marker:text-accent">
          {items}
        </ul>
      )
    }
    case 'table':
      return (
        <div key={k} className="scrollbar-thin overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-2">
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} className={cn('whitespace-nowrap px-3 py-2 font-semibold', b.align[j] === 'right' && 'text-right', b.align[j] === 'center' && 'text-center')}>
                    {renderInline(c, `${k}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, n) => (
                <tr key={n} className="border-t border-border">
                  {r.map((c, j) => (
                    <td key={j} className={cn('px-3 py-2 align-top', b.align[j] === 'right' && 'text-right tabular', b.align[j] === 'center' && 'text-center')}>
                      {renderInline(c, `${k}-${n}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'section': {
      const s = LABEL_STYLE[b.kind]
      const Icon = s.icon
      return (
        <section key={k} data-label={b.kind} className={cn('space-y-2 rounded-lg border-l-4 border-y border-r px-3 py-2.5', s.box)}>
          <p>
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide', s.chip)}>
              <Icon className="size-3" /> {b.title || s.label}
            </span>
          </p>
          {b.c.map((x, j) => renderBlock(x, j))}
        </section>
      )
    }
  }
}
