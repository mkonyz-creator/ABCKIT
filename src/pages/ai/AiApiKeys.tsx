/**
 * "AI API keys" card — shown in AI → Settings (AI Control Center) and System Settings → AI API keys (ai.manage).
 * Keys go once to the aiManageKeys callable, are tested with the provider, stored encrypted on the server and never
 * come back to the app: it only sees ai_status.ai_keys (source, last 4 characters, who / when, last test).
 */
import { Check, ExternalLink, Eye, EyeOff, KeyRound, Pencil, Plus, Server, ShieldCheck, Trash2, X, Zap } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input } from '@/components/ui/form'
import { Badge, Card, CardHeader, Skeleton } from '@/components/ui/misc'
import { IS_DEMO } from '@/lib/backend'
import { CHAT_PROVIDER_LABEL, CHAT_PROVIDERS, type AiKeyInfo, type ChatProviderId } from '@/shared/ai/contract'
import { formatDateTime, timeAgo } from '@/lib/utils'
import { AiErrorNotice } from './parts'
import { C, useAiInvalidate, useAiStatus, useCallable } from './useAi'


/** what each provider's key is used for, and where to get one */
const KEY_HELP: Record<ChatProviderId, { use: string; use_sw: string; url: string; placeholder: string }> = {
  openai: { use: 'Chat assistant (primary) and live voice (“Hey ABC”, phone button)', use_sw: 'Msaidizi wa maandishi (wa kwanza) na mazungumzo ya sauti', url: 'https://platform.openai.com/api-keys', placeholder: 'sk-proj-…' },
  gemini: { use: 'Fallback for chat and live voice (Gemini Live) when OpenAI fails', use_sw: 'Akiba ya mazungumzo na sauti (Gemini Live) OpenAI ikishindwa', url: 'https://aistudio.google.com/app/apikey', placeholder: 'AIza… or AQ.…' },
  claude: { use: 'Reports, email analysis and reply drafts', use_sw: 'Ripoti, uchambuzi wa barua pepe na rasimu za majibu', url: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
}

function KeyBadge({ info }: { info: AiKeyInfo | undefined }) {
  if (!info || info.source === 'none')
    return (
      <Badge tone="danger">
        <X className="size-3" /> No key · Hakuna key
      </Badge>
    )
  const masked = info.last4 ? ` ••••${info.last4}` : ''
  return info.source === 'admin' ? (
    <Badge tone="success">
      <Check className="size-3" /> Saved in ABCkit{masked}
    </Badge>
  ) : (
    <Badge tone="info">
      <Server className="size-3" /> Server secret{masked}
    </Badge>
  )
}

export function AiApiKeys() {
  const call = useCallable()
  const invalidate = useAiInvalidate()
  const status = useAiStatus()
  const [edit, setEdit] = useState<ChatProviderId | null>(null)
  const [remove, setRemove] = useState<ChatProviderId | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const keys = status.data?.ai_keys
  const configured = status.data?.ai_providers

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      if (success) toast.success(success)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
      await invalidate(C.status, C.activity)
    }
  }

  return (
    <Card>
      <CardHeader
        title="AI API keys"
        description="Weka API keys za AI hapa. Each key is sent once to the server over HTTPS, tested with the provider, stored encrypted and never shown again (only its last 4 characters). A key saved here replaces the deployed server secret straight away, with no redeploy."
      />
      <div className="space-y-3 p-4 sm:p-5">
        {error ? <AiErrorNotice error={error} title="API key not changed" /> : null}
        {status.isLoading ? (
          <Skeleton className="h-28" />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {CHAT_PROVIDERS.map((p) => {
              const info: AiKeyInfo | undefined =
                keys?.[p] ?? (configured?.[p] ? { source: 'server', last4: null, updated_at: null, updated_by_name: null, last_test: null } : undefined)
              const has = !!info && info.source !== 'none'
              return (
                <li key={p} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      <KeyRound className="size-4 text-muted" />
                      {CHAT_PROVIDER_LABEL[p]}
                      <KeyBadge info={info} />
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {KEY_HELP[p].use} · <span lang="sw">{KEY_HELP[p].use_sw}</span>
                    </p>
                    {info?.source === 'admin' && info.updated_at && (
                      <p className="mt-0.5 text-xs text-muted">
                        Saved {formatDateTime(info.updated_at)}
                        {info.updated_by_name ? ` by ${info.updated_by_name}` : ''}
                      </p>
                    )}
                    {info?.last_test && (
                      <p className={`mt-0.5 text-xs ${info.last_test.ok ? 'text-success' : 'text-danger'}`}>
                        Last test {timeAgo(info.last_test.at)}: {info.last_test.message}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant={has ? 'outline' : 'primary'} disabled={IS_DEMO} onClick={() => setEdit(p)}>
                      {has ? <Pencil /> : <Plus />} {has ? 'Replace key' : 'Add key'}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!has || IS_DEMO}
                      loading={busy === `test-${p}`}
                      onClick={() =>
                        run(`test-${p}`, async () => {
                          const r = await call('aiManageKeys', { action: 'test', provider: p })
                          if (r.info.last_test?.ok) toast.success(r.info.last_test.message)
                          else throw new Error(r.info.last_test?.message ?? 'The key did not work')
                        })
                      }
                    >
                      <Zap /> Test
                    </Button>
                    {info?.source === 'admin' && (
                      <Button size="sm" variant="ghost" disabled={IS_DEMO} onClick={() => setRemove(p)}>
                        <Trash2 /> Remove
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <p className="text-xs text-muted">
          OpenAI answers first; Google Gemini is used only if OpenAI fails (order under “AI behaviour &amp; notifications”). Saving needs <code>EMAIL_TOKEN_KEY</code> on the server, which encrypts the keys. Set a monthly budget with each provider.
        </p>
      </div>
      <KeyDialog provider={edit} onClose={() => setEdit(null)} onSaved={() => invalidate(C.status, C.activity)} />
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title="Remove API key?"
        message={
          remove
            ? `The ${CHAT_PROVIDER_LABEL[remove]} key saved in ABCkit is deleted on the server. If a server secret was deployed it is used again; otherwise ${CHAT_PROVIDER_LABEL[remove]} stops working until a new key is added.`
            : ''
        }
        confirmLabel="Remove key"
        danger
        loading={busy === 'remove'}
        onConfirm={() => {
          const p = remove!
          setRemove(null)
          void run('remove', () => call('aiManageKeys', { action: 'remove', provider: p }), `${CHAT_PROVIDER_LABEL[p]} key removed`)
        }}
      />
    </Card>
  )
}

function KeyDialog({ provider, onClose, onSaved }: { provider: ChatProviderId | null; onClose: () => void; onSaved: () => void }) {
  const call = useCallable()
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [test, setTest] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const ready = key.trim().length >= 20 && !busy
  const close = () => {
    setKey('')
    setShow(false)
    setTest(true)
    setError(null)
    onClose()
  }
  const submit = async () => {
    if (!provider || !ready) return
    setBusy(true)
    setError(null)
    try {
      const r = await call('aiManageKeys', { action: 'set', provider, key: key.trim(), skip_test: !test })
      toast.success(`${CHAT_PROVIDER_LABEL[provider]} key saved (••••${r.info.last4 ?? ''})${test ? ' and tested' : ''}`)
      onSaved()
      close()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const help = provider ? KEY_HELP[provider] : null
  return (
    <Dialog
      open={!!provider}
      onOpenChange={(o) => !o && close()}
      title={provider ? `${CHAT_PROVIDER_LABEL[provider]} API key` : ''}
      description="Bandika (paste) key yako hapa. It is sent once over HTTPS, encrypted on the server and never returned to the app."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!ready}>
            <ShieldCheck /> {test ? 'Test & save' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <AiErrorNotice error={error} title="The key was not saved" /> : null}
        <Field label="API key" required hint={help ? `Used for: ${help.use}` : undefined}>
          <div className="flex gap-2">
            <Input
              type={show ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder={help?.placeholder}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <Button size="icon" variant="outline" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide key' : 'Show key'}>
              {show ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        </Field>
        <Checkbox label="Test the key with the provider before saving (recommended)" checked={test} onChange={(e) => setTest(e.target.checked)} />
        {help && provider && (
          <a href={help.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">
            <ExternalLink className="size-3" /> Get a {CHAT_PROVIDER_LABEL[provider]} key
          </a>
        )}
      </div>
    </Dialog>
  )
}
