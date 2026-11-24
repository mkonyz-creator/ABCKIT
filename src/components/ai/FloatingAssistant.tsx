/**
 * "ABC AI" — the floating assistant, on every page for users with `ai.view`.
 *
 *  - Sees the page that is open (route + visible text, src/lib/ai/pageContext.ts), treated as untrusted data.
 *  - Live voice: OpenAI Realtime over WebRTC, or Gemini Live over WebSocket as the fallback, with a short-lived
 *    server credential (src/lib/ai/liveVoice.ts) —
 *    listening / speaking indicators, waveform, transcripts, interruption, Kiswahili / English.
 *  - Fallback voice (and Demo Mode): the browser's speech recognition + speech synthesis, with the text assistant
 *    (OpenAI → Gemini → Claude on the server, or the [DEMO] rule-based assistant).
 *  - "Hey ABC" wake word, recognised offline in the browser (src/lib/ai/wakeWord.ts) — optional, off by default.
 *  - Tools run in the browser under the user's own permissions. Actions (create / update a task, purchase
 *    request, mark notifications read) are shown on a confirmation card and only run after the user says
 *    "ndiyo" / "yes" — spoken after the question — or presses the button. Sending email, payments, approvals,
 *    deletions and purchase orders are not available to the assistant.
 */
import { Bot, Check, Ear, FileText, GripHorizontal, Hand, Mic, MessageSquarePlus, Minus, Phone, PhoneOff, SendHorizontal, Settings2, ShieldQuestion, Sparkles, Square, Trash2, Volume2, VolumeX, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import { alertMessage, useAlertWatch } from '@/components/ai/alertWatch'
import { chatKey, resumeTurns, turnsToChat, type Turn } from '@/components/ai/conversationMemory'
import { Markdown } from '@/components/ai/Markdown'
import { Waveform } from '@/components/ai/Waveform'
import { Button } from '@/components/ui/button'
import { db, IS_DEMO } from '@/lib/backend'
import { callAi } from '@/lib/ai/api'
import type { ApiMessage, LoopStep } from '@/lib/ai/loop'
import { capturePageContext } from '@/lib/ai/pageContext'
import { LiveVoice } from '@/lib/ai/liveVoice'
import type { LiveState } from '@/lib/ai/realtime'
import { createToolEnv, executeTool, memoryContext, toolDefinitions, type ActionConfirm, type ToolEnv, type ToolResult } from '@/lib/ai/tools'
import { hasVoiceFor, listen, MIC_ERRORS, parseYesNo, speak, stopSpeaking, sttSupported, toSpeech, ttsSupported, type Listener, type VoiceLang } from '@/lib/ai/voice'
import { startWakeWord, WAKE_ERRORS, wakeWordSupported, type WakeEngine, type WakeState } from '@/lib/ai/wakeWord'
import { P } from '@/lib/permissions'
import { cn, errorMessage } from '@/lib/utils'
import { AiErrorNotice, TOOL_TITLES, WorkingIndicator } from '@/pages/ai/parts'
import { askAssistant, C, useAiInvalidate, useAiStatus } from '@/pages/ai/useAi'
import { CHAT_PROVIDER_LABEL, type AiChat, type ChatProviderId, type VoiceProviderId } from '@/shared/ai/contract'
import { useAuth } from '@/providers/AuthProvider'

/** browser-voice / text phases (live calls have their own LiveState) */
type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'confirm'

interface Pending {
  req: ActionConfirm
  resolve: (ok: boolean) => void
}

interface Prefs {
  lang: VoiceLang
  speakOn: boolean
  handsFree: boolean
  wake: boolean
  /** 'live' = OpenAI Realtime when available; 'browser' = always the browser's speech engine */
  engine: 'live' | 'browser'
  /** announce new high / urgent alerts (panel message, toast, spoken) */
  alerts: boolean
  /** how solid the panel is, 40–100 (%): lower = more see-through */
  opacity: number
  /** where the user dragged the panel (top-left corner, px); null = default corner */
  pos: { x: number; y: number } | null
}

const clampOpacity = (v: unknown) => (typeof v === 'number' && v >= 40 && v <= 100 ? Math.round(v) : 85)
const validPos = (v: unknown) =>
  v && typeof v === 'object' && Number.isFinite((v as { x: number }).x) && Number.isFinite((v as { y: number }).y) ? { x: (v as { x: number }).x, y: (v as { y: number }).y } : null

const PREFS_KEY = 'abckit-ai-voice'
function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return { lang: p.lang === 'en' ? 'en' : 'sw', speakOn: p.speakOn !== false, handsFree: p.handsFree === true, wake: p.wake === true, engine: p.engine === 'browser' ? 'browser' : 'live', alerts: p.alerts !== false, opacity: clampOpacity(p.opacity), pos: validPos(p.pos) }
  } catch {
    return { lang: 'sw', speakOn: true, handsFree: false, wake: false, engine: 'live', alerts: true, opacity: 85, pos: null }
  }
}

const T = {
  sw: {
    title: 'ABC AI',
    sees: 'Anaona',
    hint: 'Bonyeza maikrofoni uongee, au andika. Ninaona ukurasa uliofungua sasa.',
    hintLive: 'Bonyeza simu kuanza mazungumzo ya moja kwa moja. Unaweza kunikatiza wakati wowote.',
    examples: ['Nishauri kuhusu ukurasa huu.', 'Nini kinahitaji kuangaliwa hapa?', 'Niambie kila kinachoendelea kwenye kampuni leo.', 'Unda kazi ya kukagua scaffold kesho.'],
    state: { idle: 'Tayari', listening: 'Ninasikiliza…', user_speaking: 'Unaongea…', thinking: 'Ninafikiri…', speaking: 'Ninaongea…', tool: 'Ninatafuta data…', confirm: 'Nasubiri “ndiyo” au “hapana”', connecting: 'Ninaunganisha…', closed: 'Mazungumzo yamekwisha', error: 'Hitilafu' },
    placeholder: 'Andika swali…',
    handsFree: 'Mazungumzo endelevu (sauti ya kivinjari)',
    noStt: 'Kivinjari hiki hakitambui sauti. Tumia Google Chrome au Microsoft Edge — au andika swali.',
    noSwVoice: 'Kompyuta hii haina sauti ya Kiswahili ya kivinjari; majibu yatasomwa kwa sauti iliyopo.',
    demo: 'Demo: majibu na vitendo vyote ni [DEMO] — hakuna AI halisi wala data halisi.',
    newChat: 'Mazungumzo mapya',
    clear: 'Futa mazungumzo (simu inaendelea)',
    hide: 'Ficha (inaendelea kusikiliza)',
    endAndClose: 'Funga na umalize simu',
    opacity: 'Uwazi wa kisanduku',
    move: 'Buruta kuhamisha · bofya mara mbili kurudisha pembeni',
    hidden: 'ABC AI iko hewani — bofya kuifungua',
    stop: 'Simamisha',
    startLive: 'Anza mazungumzo ya moja kwa moja',
    endLive: 'Maliza mazungumzo',
    interrupt: 'Nikatize',
    wake: '“Hey ABC” — niamshe kwa sauti',
    alerts: 'Nitangazie matatizo mapya mara moja (tahadhari za dharura / muhimu)',
    wakeHint: 'Hutambuliwa ndani ya kompyuta yako (modeli ya ~41 MB inapakuliwa mara moja). Sauti haitumwi popote hadi uamshe msaidizi. Inasimama ukifunga tab.',
    wakeState: { loading: 'Inapakia…', listening: 'Inasikiliza “Hey ABC”', paused: 'Imesimama kwa muda', error: 'Imezimwa', stopped: 'Imezimwa' },
    engine: 'Injini ya sauti',
    engineLive: 'Moja kwa moja (OpenAI Realtime / Gemini Live)',
    engineBrowser: 'Kivinjari + maandishi',
    answer: 'Naam?',
    confirmTitle: 'Thibitisha kitendo',
    yes: 'Ndiyo, fanya',
    no: 'Hapana',
    askYesNo: 'Nifanye? Sema ndiyo au hapana.',
    sayYesNo: 'Sikuelewa. Sema ndiyo au hapana.',
    settings: 'Mipangilio',
    provider: 'Mtoa huduma',
    notConfigured: 'Hakuna mtoa huduma aliyewekwa',
    fallback: 'akiba',
  },
  en: {
    title: 'ABC AI',
    sees: 'Sees',
    hint: 'Tap the microphone and talk, or type. I can see the page you have open.',
    hintLive: 'Tap the phone to start a live conversation. You can interrupt me at any time.',
    examples: ['Advise me on this page.', 'What needs attention here?', 'What is happening in the company today?', 'Create a task to inspect the scaffold tomorrow.'],
    state: { idle: 'Ready', listening: 'Listening…', user_speaking: 'You are speaking…', thinking: 'Thinking…', speaking: 'Speaking…', tool: 'Looking up data…', confirm: 'Waiting for “yes” or “no”', connecting: 'Connecting…', closed: 'Conversation ended', error: 'Error' },
    placeholder: 'Type a question…',
    handsFree: 'Hands-free conversation (browser voice)',
    noStt: 'This browser cannot recognise speech. Use Google Chrome or Microsoft Edge — or type your question.',
    noSwVoice: '',
    demo: 'Demo: all answers and actions are [DEMO] — no real AI and no real data.',
    newChat: 'New conversation',
    clear: 'Clear the chat (the call continues)',
    hide: 'Hide (keeps listening)',
    endAndClose: 'Close and end the call',
    opacity: 'Panel transparency',
    move: 'Drag to move · double-click to put it back',
    hidden: 'ABC AI is live — click to open',
    stop: 'Stop',
    startLive: 'Start a live conversation',
    endLive: 'End conversation',
    interrupt: 'Interrupt',
    wake: '“Hey ABC” — wake me by voice',
    alerts: 'Tell me about new problems right away (urgent / high alerts)',
    wakeHint: 'Recognised on this computer (a ~41 MB model is downloaded once). No audio is sent anywhere until you wake the assistant. Stops when the tab is closed.',
    wakeState: { loading: 'Loading…', listening: 'Listening for “Hey ABC”', paused: 'Paused', error: 'Off', stopped: 'Off' },
    engine: 'Voice engine',
    engineLive: 'Live (OpenAI Realtime / Gemini Live)',
    engineBrowser: 'Browser + text',
    answer: 'Yes?',
    confirmTitle: 'Confirm action',
    yes: 'Yes, do it',
    no: 'No',
    askYesNo: 'Shall I do it? Say yes or no.',
    sayYesNo: 'Sorry, say yes or no.',
    settings: 'Settings',
    provider: 'Provider',
    notConfigured: 'No AI provider configured',
    fallback: 'fallback',
  },
}

function toApi(turns: Turn[]): ApiMessage[] {
  const out: ApiMessage[] = []
  for (const m of turns.slice(-12)) {
    if (!m.text.trim()) continue
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) prev.content = `${prev.content as string}\n\n${m.text}`
    else out.push({ role: m.role, content: m.text })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

/** what a live-voice tool call hands back to the model (text only: pictures / PDFs cannot be attached in voice) */
export function toolResultForVoice(r: ToolResult): string {
  if (typeof r.content === 'string') return r.content
  const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '{}'
  return r.content.length > 1 ? `${text}\n(Note: the file's pictures / PDF pages cannot be viewed in a voice call — suggest opening it on screen or asking in the text chat.)` : text
}

export function FloatingAssistant() {
  const { can, profile, session } = useAuth()
  const uid = session?.user.id
  const canUse = can(P.aiView)
  const status = useAiStatus()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [prefs, setPrefs] = useState(readPrefs)
  const [turns, setTurns] = useState<Turn[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [interim, setInterim] = useState('')
  const [input, setInput] = useState('')
  const [steps, setSteps] = useState<LoopStep[]>([])
  const [error, setError] = useState<unknown>(null)
  const [micError, setMicError] = useState<string | null>(null)
  const [pageTitle, setPageTitle] = useState('')
  const [noSwVoice, setNoSwVoice] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [live, setLive] = useState<LiveState>('idle')
  const [liveUser, setLiveUser] = useState('')
  const [liveAssistant, setLiveAssistant] = useState('')
  const [liveTool, setLiveTool] = useState<string | null>(null)
  const [wakeState, setWakeState] = useState<WakeState>('stopped')
  const [wakeError, setWakeError] = useState<string | null>(null)
  const [answeredBy, setAnsweredBy] = useState<{ provider?: ChatProviderId; fallback_from: ChatProviderId[] } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [liveProvider, setLiveProvider] = useState<{ provider: VoiceProviderId; fallback_from: VoiceProviderId[] } | null>(null)
  const listener = useRef<Listener | null>(null)
  const abort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const turnsRef = useRef<Turn[]>([])
  const prefsRef = useRef(prefs)
  const pendingRef = useRef<Pending | null>(null)
  const liveRef = useRef<LiveVoice | null>(null)
  const liveEnv = useRef<Promise<ToolEnv> | null>(null)
  const wakeRef = useRef<WakeEngine | null>(null)
  const providerRef = useRef<ChatProviderId | undefined>(undefined)
  useEffect(() => {
    turnsRef.current = turns
  }, [turns])
  useEffect(() => {
    prefsRef.current = prefs
  }, [prefs])
  const t = T[prefs.lang]
  const configured = status.data?.ai_providers
  const liveAvailable = !IS_DEMO && LiveVoice.supported() && !!(configured?.openai || configured?.gemini)
  const useLive = liveAvailable && prefs.engine === 'live'
  const connecting = live === 'connecting'
  const inCall = !['idle', 'closed', 'error', 'connecting'].includes(live)

  const savePrefs = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        /* storage blocked */
      }
      return next
    })

  // what the assistant "sees": refresh the title when the page changes; tell a live call about the new page
  useEffect(() => {
    const update = () => {
      const page = capturePageContext()
      if (open) setPageTitle(page.title || location.pathname)
      liveRef.current?.logic?.pageChanged(page)
    }
    if (!open && !liveRef.current) return
    const id = setTimeout(update, 900)
    return () => clearTimeout(id)
  }, [open, location.pathname])

  useEffect(() => {
    if (open && prefs.lang === 'sw' && ttsSupported()) void hasVoiceFor('sw').then((ok) => setNoSwVoice(!ok))
  }, [open, prefs.lang])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [turns.length, phase, interim, steps.length, liveUser, liveAssistant, pending])

  const panelRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  const fit = (x: number, y: number) => {
    const el = panelRef.current
    const w = el?.offsetWidth ?? 430
    return { x: Math.round(Math.min(Math.max(8 - w + 120, x), window.innerWidth - 120)), y: Math.round(Math.min(Math.max(8, y), window.innerHeight - 56)) }
  }
  const onDragStart = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, a, [role="group"]')) return
    const r = panelRef.current?.getBoundingClientRect()
    if (!r) return
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    setDragPos({ x: r.left, y: r.top })
  }
  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current
    if (d) setDragPos(fit(e.clientX - d.dx, e.clientY - d.dy))
  }
  const onDragEnd = () => {
    if (!dragRef.current) return
    dragRef.current = null
    if (dragPos) savePrefs({ pos: dragPos })
    setDragPos(null)
  }
  const panelPos = dragPos ?? prefs.pos
  // a window made smaller must not leave the panel out of reach
  useEffect(() => {
    if (!prefs.pos) return
    const onResize = () => {
      const p = prefsRef.current.pos
      if (p) {
        const f = fit(p.x, p.y)
        if (f.x !== p.x || f.y !== p.y) savePrefs({ pos: f })
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  const pushTurn = (turn: Turn) => setTurns((cur) => [...cur, { ...turn, at: turn.at ?? new Date().toISOString() }])


  // ---- "the first to know": keep the monitor running and announce new high / urgent alerts
  const invalidateAi = useAiInvalidate()

  // ---- memory of the conversation: every exchange (typed or spoken) is saved as the user's private chat, so it
  // survives a reload, shows in AI → Chat, and the assistant can search it later (search_my_memory)
  const chatIdRef = useRef<string | null>(null)
  const savedRef = useRef('')
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const [resumed, setResumed] = useState(false)
  useEffect(() => {
    if (!uid || !canUse) return
    let cancelled = false
    void (async () => {
      const { data } = await db.from(C.chats).select('*').eq('user_id', uid).order('updated_at', { ascending: false }).limit(1)
      const last = (data?.[0] ?? null) as AiChat | null
      const back = resumeTurns(last)
      if (cancelled) return
      if (back && last && !turnsRef.current.length) {
        chatIdRef.current = last.id
        savedRef.current = chatKey(turnsToChat(back)?.messages ?? [])
        setTurns(back)
      }
      setResumed(true)
    })().catch(() => setResumed(true))
    return () => {
      cancelled = true
    }
  }, [uid, canUse])
  useEffect(() => {
    if (!resumed || !uid) return
    const chat = turnsToChat(turns)
    if (!chat) return
    const key = chatKey(chat.messages)
    if (key === savedRef.current) return
    const timer = setTimeout(() => {
      saveQueue.current = saveQueue.current.then(async () => {
        if (key === savedRef.current) return
        let error: unknown = null
        if (chatIdRef.current) {
          const r = await db.from(C.chats).update({ messages: chat.messages }).eq('id', chatIdRef.current).select('id')
          error = r.error
          // deleted in AI → Chat meanwhile: start a new saved conversation
          if (!r.error && !r.data?.length) chatIdRef.current = null
        }
        if (!chatIdRef.current && !error) {
          const r = await db.from(C.chats).insert(chat).select('id').single()
          error = r.error
          if (r.data) chatIdRef.current = String((r.data as { id: string }).id)
        }
        if (error) return void console.warn('[ai] conversation not saved', error)
        savedRef.current = key
        void invalidateAi(C.chats)
      })
    }, 1200)
    return () => clearTimeout(timer)
  }, [turns, resumed, uid, invalidateAi])

  useAlertWatch({
    enabled: canUse && prefs.alerts,
    status: status.data,
    onMonitorRun: () => void invalidateAi(C.status, C.alerts),
    onAlert: (a) => {
      const { lang, speakOn } = prefsRef.current
      const m = alertMessage(a, lang)
      pushTurn({ role: 'assistant', text: m.text })
      toast.warning(a.title, {
        description: a.description.slice(0, 160),
        action: { label: lang === 'sw' ? 'Fungua ABC AI' : 'Open ABC AI', onClick: () => setOpen(true) },
      })
      // speak only when the assistant is not busy (never over a live call or an answer)
      if (speakOn && ttsSupported() && !liveRef.current && phase === 'idle' && !pendingRef.current) void speak(m.speech, lang)
    },
  })

  // ---- confirmation of actions: a card, the question read aloud, and "ndiyo / hapana" linked to THIS action
  const settle = (ok: boolean) => {
    const p = pendingRef.current
    if (!p) return
    pendingRef.current = null
    setPending(null)
    listener.current?.abort()
    listener.current = null
    stopSpeaking()
    setInterim('')
    liveRef.current?.logic?.endConfirm()
    if (!liveRef.current) setPhase('thinking')
    p.resolve(ok)
  }

  const listenYesNo = (tries: number) => {
    if (!pendingRef.current) return
    const lang = prefsRef.current.lang
    const l = listen(lang, {
      onInterim: setInterim,
      onFinal: (text) => {
        listener.current = null
        setInterim('')
        if (!pendingRef.current) return
        const yn = parseYesNo(text)
        if (yn !== null) return settle(yn)
        if (tries > 1)
          void (async () => {
            if (prefsRef.current.speakOn && ttsSupported()) await speak(T[lang].sayYesNo, lang)
            listenYesNo(tries - 1)
          })()
      },
      onError: () => {
        listener.current = null
      },
    })
    if (l) listener.current = l
  }

  const confirmAction = (req: ActionConfirm, viaVoice: boolean) =>
    new Promise<boolean>((resolve) => {
      const p: Pending = { req, resolve }
      pendingRef.current = p
      setPending(p)
      setOpen(true)
      const { lang, speakOn } = prefsRef.current
      const title = lang === 'sw' ? req.title_sw : req.title
      const lines = lang === 'sw' ? req.lines_sw : req.lines
      const question = `${title}. ${lines.join('. ')}. ${T[lang].askYesNo}`
      void (async () => {
        const call = liveRef.current?.logic
        if (call) {
          // live call: read the question, THEN take the next thing the user says as the answer to this action
          if (ttsSupported()) await speak(question, lang)
          if (pendingRef.current === p) call.beginConfirm((text) => pendingRef.current === p && parseYesNo(text) !== null && settle(parseYesNo(text)!))
          return
        }
        setPhase('confirm')
        if (speakOn && ttsSupported()) await speak(question, lang)
        if ((viaVoice || prefsRef.current.handsFree || prefsRef.current.wake) && sttSupported() && pendingRef.current === p) listenYesNo(2)
      })()
    })

  // ---- stop everything (panel closed, new chat, sign-out)
  const stopLive = useCallback(() => {
    liveRef.current?.stop()
    liveRef.current = null
    liveEnv.current = null
    setLive('idle')
    setLiveUser('')
    setLiveAssistant('')
    setLiveTool(null)
  }, [])

  const stopAll = useCallback(() => {
    const p = pendingRef.current
    if (p) {
      pendingRef.current = null
      setPending(null)
      p.resolve(false)
    }
    listener.current?.abort()
    listener.current = null
    abort.current?.abort()
    abort.current = null
    stopSpeaking()
    setInterim('')
    setPhase('idle')
    stopLive()
  }, [stopLive])

  const close = () => {
    stopAll()
    setOpen(false)
  }
  useEffect(() => () => stopAll(), [stopAll])

  // ---- text question (typed, or browser voice)
  const ask = async (question: string, viaVoice: boolean) => {
    const q = question.trim()
    if (!q) return
    const page = capturePageContext()
    if (liveRef.current?.logic) {
      pushTurn({ role: 'user', text: q, page: page.title || page.path })
      setInput('')
      liveRef.current.logic.sendText(q)
      return
    }
    stopSpeaking()
    const userTurn: Turn = { role: 'user', text: q, page: page.title || page.path, voice: viaVoice, at: new Date().toISOString() }
    const history = [...turnsRef.current, userTurn]
    setTurns(history)
    setInput('')
    setError(null)
    setSteps([])
    setPhase('thinking')
    const ctrl = new AbortController()
    abort.current = ctrl
    const { lang, speakOn } = prefsRef.current
    let failure: unknown = null
    try {
      const r = await askAssistant({
        purpose: 'chat',
        messages: toApi(history),
        userName: profile?.full_name ?? '',
        role: profile?.role?.name ?? '',
        page,
        voice: speakOn,
        locale: lang,
        signal: ctrl.signal,
        providerHint: providerRef.current,
        confirm: (req) => confirmAction(req, viaVoice),
        onStep: (s) => setSteps((prev) => [...prev.filter((p) => p.round !== s.round), s]),
      })
      if (ctrl.signal.aborted) return
      providerRef.current = r.provider
      setAnsweredBy({ provider: r.provider, fallback_from: r.fallback_from })
      pushTurn({ role: 'assistant', text: r.text })
      if (speakOn && ttsSupported()) {
        setPhase('speaking')
        await speak(toSpeech(r.text), lang)
        if (abort.current !== ctrl) return
      }
      setPhase('idle')
      if (prefsRef.current.handsFree && sttSupported() && abort.current === ctrl) startListening()
    } catch (e) {
      if (ctrl.signal.aborted) return
      failure = e
      setError(e)
      setPhase('idle')
    } finally {
      // audit trail, like the AI Intelligence chat
      void db
        .from(C.activity)
        .insert({ action: 'chat', detail: `[assistant on ${page.path}${viaVoice ? ', voice' : ''}] ${q.slice(0, 280)}${failure ? ` — failed: ${errorMessage(failure)}` : ''}`.slice(0, 500), ok: !failure, is_demo: IS_DEMO })
        .then((res) => res.error && console.warn('[ai] activity not recorded', res.error))
    }
  }

  const startListening = () => {
    stopSpeaking()
    setMicError(null)
    setInterim('')
    const lang = prefsRef.current.lang
    const l = listen(lang, {
      onInterim: setInterim,
      onFinal: (text) => {
        listener.current = null
        setInterim('')
        if (text) void ask(text, true)
        else setPhase((p) => (p === 'listening' ? 'idle' : p))
      },
      onError: (code) => {
        setMicError((MIC_ERRORS[code] ?? { en: `Microphone error (${code}).`, sw: `Hitilafu ya maikrofoni (${code}).` })[lang])
        setPhase('idle')
      },
    })
    if (!l) {
      setMicError(T[lang].noStt)
      return
    }
    listener.current = l
    setPhase('listening')
  }

  // ---- live voice (OpenAI Realtime, Gemini Live fallback)
  const toolEnv = () => {
    if (!liveEnv.current) liveEnv.current = createToolEnv(db, { fns: db.functions, confirm: (req) => confirmAction(req, true) })
    return liveEnv.current
  }

  const startLive = async () => {
    if (liveRef.current) return
    setOpen(true)
    setError(null)
    setMicError(null)
    stopSpeaking()
    const call = new LiveVoice({
      getKey: async (exclude) => {
        const env = await toolEnv()
        const memories = await memoryContext(db, env.me.uid)
        return callAi(db.functions, 'voiceSession', {
          tools: toolDefinitions(env.me, { actions: true }),
          context: { today: env.today, locale: prefsRef.current.lang, page: capturePageContext(), ...(memories.length ? { memories } : {}) },
          exclude,
        })
      },
      onProvider: (provider, fallback_from) => setLiveProvider({ provider, fallback_from }),
      runTool: async (name, args) => toolResultForVoice(await executeTool(name, args, await toolEnv())),
      cb: {
        onState: (s) => setLive(s),
        onUserText: (text, final) => {
          if (final) {
            setLiveUser('')
            pushTurn({ role: 'user', text, voice: true, page: capturePageContext().title })
          } else setLiveUser(text)
        },
        onAssistantText: (text, final) => {
          if (final) {
            setLiveAssistant('')
            pushTurn({ role: 'assistant', text })
          } else setLiveAssistant(text)
        },
        onTool: (name, s) => setLiveTool(s === 'running' ? name : null),
        onError: (message) => setError(new Error(message)),
      },
    })
    liveRef.current = call
    try {
      await call.start()
    } catch (e) {
      stopLive()
      setError(e)
    }
  }

  const onMic = () => {
    if (liveRef.current) return stopLive()
    if (useLive) return void startLive()
    if (phase === 'listening') return listener.current?.stop()
    if (phase === 'speaking' || phase === 'thinking' || phase === 'confirm') return stopAll()
    startListening()
  }

  // ---- "Hey ABC" (offline wake word)
  const onWakeRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    onWakeRef.current = () => {
      setOpen(true)
      if (liveRef.current || phase !== 'idle') return
      if (useLive) return void startLive()
      void (async () => {
        setPhase('listening')
        if (prefsRef.current.speakOn && ttsSupported()) await speak(T[prefsRef.current.lang].answer, prefsRef.current.lang)
        startListening()
      })()
    }
  })

  useEffect(() => {
    if (!canUse || !prefs.wake) return
    let engine: WakeEngine | null = null
    let cancelled = false
    setWakeError(null)
    void startWakeWord({
      onWake: () => onWakeRef.current(),
      onState: (s, code) => {
        setWakeState(s)
        if (s === 'error') {
          setWakeError(code ?? 'unsupported')
          savePrefs({ wake: false })
        }
      },
    }).then((e) => {
      if (cancelled) e?.stop()
      else {
        engine = e
        wakeRef.current = e
      }
    })
    return () => {
      cancelled = true
      engine?.stop()
      wakeRef.current = null
      setWakeState('stopped')
    }
  }, [canUse, prefs.wake])

  // the wake word sleeps while the assistant itself listens / talks
  const busy = phase !== 'idle' || inCall || connecting
  useEffect(() => {
    if (busy) wakeRef.current?.pause()
    else wakeRef.current?.resume()
  }, [busy, wakeState])

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (phase === 'thinking') return
    void ask(input, false)
  }

  if (!canUse) return null

  const stateKey = inCall || connecting ? live : phase === 'idle' ? 'idle' : phase
  const stateLabel = t.state[stateKey as keyof typeof t.state] ?? ''
  const speaking = live === 'speaking' || phase === 'speaking'
  const listening = live === 'listening' || live === 'user_speaking' || phase === 'listening' || live === 'confirm' || phase === 'confirm'
  const providerChip = IS_DEMO
    ? '[DEMO] rule-based'
    : inCall
      ? liveProvider?.provider === 'gemini'
        ? `Gemini Live${liveProvider.fallback_from.length ? ` (${t.fallback})` : ''}`
        : 'OpenAI Realtime'
      : answeredBy?.provider
        ? `${CHAT_PROVIDER_LABEL[answeredBy.provider]}${answeredBy.fallback_from.length ? ` (${t.fallback})` : ''}`
        : configured
          ? (['openai', 'gemini', 'claude'] as const).filter((p) => configured[p]).map((p) => CHAT_PROVIDER_LABEL[p].replace(/^(Google|Anthropic) /, '')).join(' · ') || t.notConfigured
          : ''

  return (
    <div data-ai-ignore className="no-print">
      {!open && inCall && (
        <button
          type="button"
          onClick={stopLive}
          className="fixed bottom-[10rem] right-6 z-40 flex size-9 items-center justify-center rounded-full bg-danger text-white shadow-lg ring-2 ring-surface lg:bottom-[5.5rem] lg:right-8"
          aria-label={T[prefs.lang].endLive}
          title={T[prefs.lang].endLive}
        >
          <PhoneOff className="size-4" />
        </button>
      )}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            'fixed bottom-24 right-4 z-40 flex size-14 items-center justify-center rounded-full bg-accent text-black shadow-xl ring-4 ring-surface transition-transform hover:scale-105 focus-visible:outline-none lg:bottom-6 lg:right-6',
            inCall && 'animate-pulse',
          )}
          aria-label={T[prefs.lang].title}
          title={inCall ? T[prefs.lang].hidden : wakeState === 'listening' ? T[prefs.lang].wakeState.listening : T[prefs.lang].title}
        >
          <Sparkles className="size-6" />
          {wakeState === 'listening' && (
            <span className="absolute -right-0.5 -top-0.5 flex size-5 items-center justify-center rounded-full bg-success text-white ring-2 ring-surface" aria-hidden>
              <Ear className="size-3" />
            </span>
          )}
        </button>
      )}

      {open && (
        <section
          ref={panelRef}
          role="dialog"
          aria-label={t.title}
          className={cn(
            'fixed z-50 flex h-[min(660px,calc(100dvh-7rem))] flex-col overflow-hidden rounded-2xl border border-border shadow-2xl backdrop-blur-md',
            panelPos ? 'w-[calc(100vw-1rem)] sm:w-[430px]' : 'inset-x-2 bottom-20 sm:inset-x-auto sm:right-4 sm:w-[430px] lg:bottom-6 lg:right-6',
          )}
          style={{
            backgroundColor: `color-mix(in srgb, var(--surface) ${prefs.opacity}%, transparent)`,
            ...(panelPos ? { left: panelPos.x, top: panelPos.y } : {}),
          }}
        >
          {/* header (drag it to move the panel) */}
          <div
            className={cn('flex touch-none select-none items-center gap-2 border-b border-border bg-surface-2/40 px-3 py-2', dragPos ? 'cursor-grabbing' : 'cursor-grab')}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && savePrefs({ pos: null })}
            title={t.move}
          >
            <GripHorizontal className="-mx-1 size-4 shrink-0 text-subtle" aria-hidden />
            <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-black">
              <Sparkles className="size-4" />
              {wakeState === 'listening' && <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-success ring-2 ring-surface" title={t.wakeState.listening} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                {t.title}
                {providerChip && <span className={cn('truncate rounded px-1.5 py-px text-[10px] font-semibold', IS_DEMO ? 'bg-warning-soft text-warning' : 'bg-surface text-muted ring-1 ring-border')} title={t.provider}>{providerChip}</span>}
              </p>
              <p className="flex items-center gap-1 truncate text-[11px] text-muted" title={pageTitle}>
                <FileText className="size-3 shrink-0" /> {t.sees}: {pageTitle || '…'}
              </p>
            </div>
            <div className="flex rounded-md border border-border text-[11px] font-semibold" role="group" aria-label="Language / Lugha">
              {(['sw', 'en'] as const).map((l) => (
                <button key={l} type="button" onClick={() => savePrefs({ lang: l })} aria-pressed={prefs.lang === l} className={cn('px-2 py-1 uppercase', prefs.lang === l ? 'bg-foreground text-background' : 'text-muted hover:text-foreground')}>
                  {l}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                if (prefs.speakOn) stopSpeaking()
                savePrefs({ speakOn: !prefs.speakOn })
              }}
              aria-pressed={prefs.speakOn}
              aria-label={prefs.speakOn ? 'Mute spoken answers' : 'Speak answers aloud'}
            >
              {prefs.speakOn ? <Volume2 /> : <VolumeX />}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings} aria-label={t.settings}>
              <Settings2 />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => (stopAll(), setTurns([]), setError(null), setAnsweredBy(null), (providerRef.current = undefined), (chatIdRef.current = null), (savedRef.current = ''))} aria-label={t.newChat} title={t.newChat} disabled={!turns.length}>
              <MessageSquarePlus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => (setTurns([]), setError(null), setSteps([]), (chatIdRef.current = null), (savedRef.current = ''))}
              aria-label={t.clear}
              title={t.clear}
              disabled={!turns.length}
            >
              <Trash2 />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label={t.hide} title={t.hide}>
              <Minus />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={close} aria-label={t.endAndClose} title={t.endAndClose}>
              <X />
            </Button>
          </div>

          {/* settings */}
          {showSettings && (
            <div className="space-y-2 border-b border-border bg-surface-2/40 px-3 py-2 text-xs">
              {liveAvailable && (
                <label className="flex items-center justify-between gap-2">
                  <span className="font-medium">{t.engine}</span>
                  <select className="h-7 rounded border border-border bg-surface px-1" value={prefs.engine} onChange={(e) => savePrefs({ engine: e.target.value as Prefs['engine'] })} disabled={inCall}>
                    <option value="live">{t.engineLive}</option>
                    <option value="browser">{t.engineBrowser}</option>
                  </select>
                </label>
              )}
              <label className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" className="mt-0.5 size-3.5 accent-[var(--accent)]" checked={prefs.wake} disabled={!wakeWordSupported()} onChange={(e) => savePrefs({ wake: e.target.checked })} />
                <span>
                  <span className="font-medium">{t.wake}</span> <span className="text-muted">— {prefs.wake ? t.wakeState[wakeState] : t.wakeState.stopped}</span>
                  <span className="block text-[11px] text-muted">{t.wakeHint}</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={prefs.alerts} onChange={(e) => savePrefs({ alerts: e.target.checked })} />
                {t.alerts}
              </label>
              <label className="flex items-center gap-2">
                <span className="shrink-0 font-medium">{t.opacity}</span>
                <input type="range" min={40} max={100} step={5} value={prefs.opacity} onChange={(e) => savePrefs({ opacity: clampOpacity(Number(e.target.value)) })} className="h-1 flex-1 accent-[var(--accent)]" aria-label={t.opacity} />
                <span className="w-9 text-right tabular-nums text-muted">{100 - prefs.opacity}%</span>
              </label>
              {!useLive && (
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={prefs.handsFree} onChange={(e) => savePrefs({ handsFree: e.target.checked })} />
                  {t.handsFree}
                </label>
              )}
              {configured && !IS_DEMO && (
                <p className="text-[11px] text-muted">
                  {t.provider}: {(['openai', 'gemini', 'claude'] as const).map((p) => `${CHAT_PROVIDER_LABEL[p]} ${configured[p] ? '✓' : '—'}`).join(' · ')}
                </p>
              )}
            </div>
          )}

          {/* status + waveform */}
          {(inCall || connecting || phase !== 'idle') && (
            <div className="flex items-center gap-3 border-b border-border px-3 py-1.5" aria-live="polite">
              <span className={cn('size-2 shrink-0 rounded-full', listening ? 'bg-danger animate-pulse' : speaking ? 'bg-accent' : 'bg-subtle')} />
              <span className="shrink-0 text-xs font-medium">{liveTool ? `${TOOL_TITLES[liveTool] ?? liveTool}…` : stateLabel}</span>
              <Waveform levels={speaking ? liveRef.current?.speakerLevels : liveRef.current?.micLevels} active={listening || speaking} tone={listening ? 'danger' : 'accent'} />
            </div>
          )}

          {/* conversation */}
          <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {IS_DEMO && <p className="rounded-md border border-warning/30 bg-warning-soft px-2.5 py-1.5 text-[11px] text-warning">{t.demo}</p>}
            {!turns.length && phase === 'idle' && !inCall && (
              <div className="space-y-2 py-2 text-center">
                <Bot className="mx-auto size-8 text-subtle" />
                <p className="text-sm text-muted">{useLive ? t.hintLive : t.hint}</p>
                <div className="grid gap-1.5 pt-1">
                  {t.examples.map((ex) => (
                    <button key={ex} type="button" onClick={() => void ask(ex, false)} className="rounded-lg border border-border px-3 py-1.5 text-left text-xs hover:border-accent hover:bg-accent-soft/40">
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="flex flex-col items-end gap-0.5">
                  <div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-foreground px-3 py-1.5 text-sm whitespace-pre-wrap break-words text-background">{m.text}</div>
                  {m.page && (
                    <span className="flex items-center gap-1 text-[10px] text-subtle">
                      {m.voice && <Mic className="size-2.5" />}
                      <FileText className="size-2.5" /> {m.page}
                    </span>
                  )}
                </div>
              ) : (
                <div key={i} className="rounded-2xl rounded-tl-sm border border-border bg-surface-2/40 px-3 py-2 text-sm">
                  <Markdown text={m.text} />
                </div>
              ),
            )}
            {liveUser && <p className="ml-auto max-w-[88%] rounded-2xl rounded-tr-sm border border-dashed border-border px-3 py-1.5 text-right text-sm text-muted">{liveUser}…</p>}
            {liveAssistant && <p className="max-w-[92%] rounded-2xl rounded-tl-sm border border-dashed border-border px-3 py-1.5 text-sm text-muted">{liveAssistant}…</p>}
            {phase === 'listening' && interim && <p className="rounded-lg border border-accent/40 bg-accent-soft/40 px-3 py-2 text-sm">{interim}</p>}
            {pending && (
              <div role="alertdialog" aria-label={t.confirmTitle} className="rounded-xl border-2 border-accent bg-accent-soft/40 p-3">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-ink">
                  <ShieldQuestion className="size-3.5" /> {t.confirmTitle} {IS_DEMO && '[DEMO]'}
                </p>
                <p className="mt-1 text-sm font-semibold">{prefs.lang === 'sw' ? pending.req.title_sw : pending.req.title}</p>
                <ul className="mt-1 space-y-0.5 text-sm text-muted">
                  {(prefs.lang === 'sw' ? pending.req.lines_sw : pending.req.lines).map((l) => (
                    <li key={l}>• {l}</li>
                  ))}
                </ul>
                {interim && (
                  <p className="mt-2 text-xs text-muted">
                    <Mic className="mr-1 inline size-3" /> {interim}
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => settle(true)}>
                    <Check /> {t.yes}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => settle(false)}>
                    <X /> {t.no}
                  </Button>
                </div>
              </div>
            )}
            {phase === 'thinking' && <WorkingIndicator steps={steps} label={t.state.thinking.replace('…', '')} />}
            {error ? <AiErrorNotice error={error} title={prefs.lang === 'sw' ? 'Msaidizi hakuweza kujibu' : 'The assistant could not answer'} /> : null}
            {micError && <p className="rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{micError}</p>}
            {wakeError && <p className="rounded-md border border-warning/30 bg-warning-soft px-2.5 py-1.5 text-xs text-warning">{WAKE_ERRORS[wakeError]?.[prefs.lang] ?? wakeError}</p>}
            {!useLive && !sttSupported() && <p className="text-[11px] text-muted">{t.noStt}</p>}
            {!useLive && noSwVoice && prefs.speakOn && <p className="text-[11px] text-muted">{t.noSwVoice}</p>}
          </div>

          {/* controls */}
          <div className="flex items-center gap-2 border-t border-border p-3">
            <button
              type="button"
              onClick={onMic}
              disabled={!useLive && !sttSupported() && phase === 'idle'}
              aria-label={liveRef.current ? t.endLive : useLive ? t.startLive : phase === 'idle' ? 'Microphone' : t.stop}
              title={liveRef.current ? t.endLive : useLive ? t.startLive : undefined}
              className={cn(
                'relative flex size-12 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40',
                liveRef.current ? 'bg-danger text-white' : listening ? 'bg-danger text-white' : phase === 'idle' ? 'bg-accent text-black hover:bg-accent-strong' : 'bg-foreground text-background',
              )}
            >
              {(listening || connecting) && <span className="absolute inset-0 animate-ping rounded-full bg-danger/30" />}
              {liveRef.current ? <PhoneOff className="relative size-5" /> : useLive ? <Phone className="relative size-5" /> : phase === 'idle' ? <Mic className="relative size-5" /> : <Square className="relative size-4" />}
            </button>
            {inCall && live === 'speaking' && (
              <Button variant="outline" size="icon" onClick={() => liveRef.current?.logic?.interrupt()} aria-label={t.interrupt} title={t.interrupt}>
                <Hand />
              </Button>
            )}
            <form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center gap-1.5">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t.placeholder}
                maxLength={2000}
                aria-label={t.placeholder}
                className="h-10 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm focus:border-accent focus:outline-none"
              />
              <Button type="submit" variant="primary" size="icon" disabled={!input.trim() || phase === 'thinking'} aria-label="Send">
                <SendHorizontal />
              </Button>
            </form>
          </div>
        </section>
      )}
    </div>
  )
}
