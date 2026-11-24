import { useQuery } from '@tanstack/react-query'
import { Bot, ExternalLink, History, MessageSquarePlus, PanelLeft, SendHorizontal, Sparkles, Trash2, User, Wrench } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Markdown } from '@/components/ai/Markdown'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/form'
import { Badge, Card, EmptyState, Skeleton } from '@/components/ui/misc'
import { db, IS_DEMO, unwrap } from '@/lib/backend'
import type { ApiMessage, LoopStep } from '@/lib/ai/loop'
import type { AiChat, AiChatMessage } from '@/shared/ai/contract'
import { cn, errorMessage, formatDateTime, timeAgo } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'
import { AiErrorNotice, DemoNote, TOOL_TITLES, WorkingIndicator } from './parts'
import { askAssistant, C, useAiInvalidate } from './useAi'

export const SUGGESTED_PROMPTS = [
  'Niambie kila kinachoendelea kwenye kampuni leo.',
  'Which projects are behind schedule?',
  'Show me all important emails received today.',
  'Are there any urgent emails that need my attention?',
  'Which suppliers have delayed deliveries?',
  'Which projects have pending approvals?',
  'Summarize all important communications from this week.',
  'Prepare a reply to the latest client email.',
  'Give me a complete company operations report.',
  'Which issues require my attention today?',
]

/** plain-text history sent back to the model (tool rounds are not stored) */
function toApi(messages: AiChatMessage[]): ApiMessage[] {
  const out: ApiMessage[] = []
  for (const m of messages.slice(-20)) {
    if (!m.text.trim()) continue
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) prev.content = `${prev.content as string}\n\n${m.text}`
    else out.push({ role: m.role, content: m.text })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

export function ChatTab() {
  const { session, profile } = useAuth()
  const uid = session?.user.id
  const invalidate = useAiInvalidate()
  const chats = useQuery({
    queryKey: [C.chats, 'mine', uid],
    enabled: !!uid,
    queryFn: async () => unwrap(await db.from(C.chats).select('*').eq('user_id', uid!).order('updated_at', { ascending: false }).limit(100)) as AiChat[],
  })
  const [chatId, setChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<LoopStep[]>([])
  const [error, setError] = useState<unknown>(null)
  const [showList, setShowList] = useState(false)
  const [remove, setRemove] = useState<AiChat | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  // keep the newest message in view (scrolls the message pane only, not the page)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, busy, steps.length])

  const open = (c: AiChat | null) => {
    if (busy) return
    setChatId(c?.id ?? null)
    setMessages(c?.messages ?? [])
    setError(null)
    setSteps([])
    setShowList(false)
  }

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    const userMsg: AiChatMessage = { role: 'user', text: q, at: new Date().toISOString() }
    const history = [...messages, userMsg]
    setMessages(history)
    setInput('')
    setBusy(true)
    setError(null)
    setSteps([])
    let answer: AiChatMessage | null = null
    let failure: unknown = null
    try {
      const r = await askAssistant({
        purpose: 'chat',
        messages: toApi(history),
        userName: profile?.full_name ?? '',
        role: profile?.role?.name ?? '',
        onStep: (s) => setSteps((prev) => [...prev.filter((p) => p.round !== s.round), s]),
      })
      answer = { role: 'assistant', text: r.text, at: new Date().toISOString(), tools_used: r.toolsUsed, links: r.links }
    } catch (e) {
      failure = e
      setError(e)
    }
    const final = answer ? [...history, answer] : history
    setMessages(final)
    setBusy(false)
    // audit trail: one row per question (the server also logs each model turn); the query builder only runs when awaited
    const logged = await db.from(C.activity).insert({ action: 'chat', detail: `${q.slice(0, 300)}${failure ? ` — failed: ${errorMessage(failure)}` : ''}`.slice(0, 500), ok: !failure, is_demo: IS_DEMO })
    if (logged.error) console.warn('[ai] activity not recorded', logged.error)
    // save the conversation (private to this user)
    try {
      if (chatId) unwrap(await db.from(C.chats).update({ messages: final }).eq('id', chatId))
      else {
        const row = unwrap(await db.from(C.chats).insert({ title: q.slice(0, 80), messages: final }).select().single()) as AiChat
        setChatId(row.id)
      }
      await invalidate(C.chats, C.activity)
    } catch (e) {
      toast.error(`Conversation not saved: ${errorMessage(e)}`)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className={cn('flex max-h-[60vh] flex-col lg:h-[calc(100dvh-16rem)] lg:max-h-none', !showList && 'hidden lg:flex')}>
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <History className="size-4 text-subtle" /> Conversations
          </p>
          <Button size="sm" variant="primary" onClick={() => open(null)} disabled={busy}>
            <MessageSquarePlus /> New
          </Button>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
          {chats.isLoading ? (
            <Skeleton className="h-20" />
          ) : !chats.data?.length ? (
            <p className="p-3 text-xs text-muted">No saved conversations yet. They are private to you.</p>
          ) : (
            <ul className="space-y-1">
              {chats.data.map((c) => (
                <li key={c.id} className="group flex items-center gap-1">
                  <button onClick={() => open(c)} className={cn('min-w-0 flex-1 rounded-md px-2.5 py-2 text-left hover:bg-surface-2', c.id === chatId && 'bg-accent-soft/60')}>
                    <p className="truncate text-sm font-medium">{c.title}</p>
                    <p className="text-[11px] text-subtle">
                      {c.messages.length} messages · {timeAgo(c.updated_at)}
                    </p>
                  </button>
                  <Button variant="ghost" size="icon-sm" className="opacity-60 group-hover:opacity-100" aria-label={`Delete ${c.title}`} onClick={() => setRemove(c)}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card className="flex h-[calc(100dvh-13rem)] min-h-[460px] flex-col lg:h-[calc(100dvh-16rem)]">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setShowList((v) => !v)} aria-label="Conversations">
              <PanelLeft />
            </Button>
            <p className="truncate text-sm font-semibold">{chatId ? (chats.data?.find((c) => c.id === chatId)?.title ?? 'Conversation') : 'New conversation'}</p>
          </div>
          <Badge tone={IS_DEMO ? 'warning' : 'accent'}>
            <Sparkles className="size-3" /> {IS_DEMO ? '[DEMO] rule-based' : 'AI assistant'}
          </Badge>
        </div>

        <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-3 sm:p-4">
          {IS_DEMO && <DemoNote>Demo Mode: answers come from a [DEMO] rule-based assistant — no AI model is called. It reads the same demo records your role can see.</DemoNote>}
          {!messages.length && !busy && (
            <div className="py-4">
              <EmptyState
                icon={<Bot className="size-6" />}
                title="Ask about anything happening in the company"
                description="The assistant reads only the ABCkit records your role can open, and links every answer to the source records. It cannot send email or change data."
              />
              <div className="mx-auto grid max-w-3xl gap-2 sm:grid-cols-2">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button key={p} onClick={() => void send(p)} className="rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm transition-colors hover:border-accent hover:bg-accent-soft/40">
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <ChatBubble key={i} m={m} />
          ))}
          {busy && <WorkingIndicator steps={steps} label={IS_DEMO ? 'Looking up demo records' : 'Thinking'} />}
          {error ? <AiErrorNotice error={error} title="The assistant could not answer" /> : null}
        </div>

        <form
          className="flex items-end gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault()
            void send(input)
          }}
        >
          <Textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask a question in English or Kiswahili…  (Enter to send, Shift+Enter for a new line)"
            aria-label="Message"
            maxLength={4000}
            className="min-h-[44px] resize-none"
          />
          <Button type="submit" variant="primary" size="icon" loading={busy} disabled={!input.trim()} aria-label="Send">
            {!busy && <SendHorizontal />}
          </Button>
        </form>
      </Card>

      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title="Delete conversation?"
        message={`“${remove?.title ?? ''}” will be deleted permanently. The AI audit log keeps a record that questions were asked.`}
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          const c = remove!
          setRemove(null)
          const { error: err } = await db.from(C.chats).delete().eq('id', c.id)
          if (err) return toast.error(errorMessage(err))
          if (c.id === chatId) open(null)
          await invalidate(C.chats)
        }}
      />
    </div>
  )
}

function ChatBubble({ m }: { m: AiChatMessage }) {
  if (m.role === 'user')
    return (
      <div className="flex justify-end gap-2">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-foreground px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-background">{m.text}</div>
        <span className="mt-1 hidden size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-subtle sm:flex">
          <User className="size-4" />
        </span>
      </div>
    )
  return (
    <div className="flex gap-2">
      <span className="mt-1 hidden size-7 shrink-0 items-center justify-center rounded-full bg-accent text-black sm:flex">
        <Bot className="size-4" />
      </span>
      <div className="min-w-0 max-w-full flex-1 rounded-2xl rounded-tl-sm border border-border bg-surface px-3.5 py-3 sm:max-w-[92%]">
        <Markdown text={m.text} />
        {!!(m.tools_used?.length || m.links?.length) && (
          <div className="mt-3 space-y-2 border-t border-border pt-2">
            {m.tools_used?.length ? (
              <p className="flex flex-wrap items-center gap-1 text-[11px] text-subtle">
                <Wrench className="size-3" /> Data used:
                {m.tools_used.map((t) => (
                  <Badge key={t}>{TOOL_TITLES[t]?.replace(/^(Reading|Checking|Looking for|Searching|Opening|Preparing) /, '') ?? t}</Badge>
                ))}
              </p>
            ) : null}
            {m.links?.length ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted hover:text-foreground">Linked records ({m.links.length})</summary>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {m.links.slice(0, 20).map((l, i) => (
                    <li key={i}>
                      <Link to={l.link ?? '/'} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 hover:border-accent hover:text-accent-ink">
                        <ExternalLink className="size-3" /> {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        )}
        <p className="mt-1 text-[10px] text-subtle">{formatDateTime(m.at)}</p>
      </div>
    </div>
  )
}
