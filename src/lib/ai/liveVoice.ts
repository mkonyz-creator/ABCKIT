/**
 * Hybrid live voice: OpenAI Realtime (WebRTC) first, Google Gemini Live (WebSocket) as the fallback.
 *
 * The server (voiceSession) picks the provider: OpenAI when it is configured and answers, otherwise Gemini.
 * If the browser then cannot connect to OpenAI (blocked network, refused SDP…), it asks once more with
 * exclude: ['openai'] and continues with Gemini. A conversation runs on ONE provider; there is no mid-call switch.
 */
import type { VoiceProviderId } from '@/shared/ai/contract'
import { GeminiLiveVoice } from './geminiLive'
import { RealtimeVoice, type LiveCallbacks, type ToolRunner } from './realtime'

export interface VoiceKey {
  provider: VoiceProviderId
  client_secret: string
  model: string
  voice: string
  ws_url?: string
  setup?: Record<string, unknown>
  fallback_from?: VoiceProviderId[]
}

/** the controls the assistant panel uses during a call (same for both providers) */
export interface LiveControl {
  beginConfirm(answer: (text: string) => void): void
  endConfirm(): void
  interrupt(): void
  pageChanged(page: { path: string; title: string; text: string }): void
  sendText(text: string): void
}

interface Inner {
  logic: LiveControl | null
  micLevels: (() => number[]) | null
  speakerLevels: (() => number[]) | null
  start(): Promise<void>
  stop(): void
  dispose(): void
}

export interface LiveVoiceOptions {
  /** voiceSession callable; exclude = providers the browser could not connect to */
  getKey: (exclude: VoiceProviderId[]) => Promise<VoiceKey>
  runTool: ToolRunner
  cb: LiveCallbacks
  /** which provider the call runs on (shown in the panel) */
  onProvider?: (provider: VoiceProviderId, fallbackFrom: VoiceProviderId[]) => void
  /** test seam */
  make?: (key: VoiceKey, runTool: ToolRunner, cb: LiveCallbacks) => Inner
}

const defaultMake = (key: VoiceKey, runTool: ToolRunner, cb: LiveCallbacks): Inner =>
  key.provider === 'gemini' ? new GeminiLiveVoice({ key, runTool, cb }) : new RealtimeVoice({ getKey: async () => key, runTool, cb })

export class LiveVoice {
  private inner: Inner | null = null
  private closed = false
  private opts: LiveVoiceOptions
  provider: VoiceProviderId | null = null

  constructor(opts: LiveVoiceOptions) {
    this.opts = opts
  }

  /** true when the browser can run at least one of the two providers */
  static supported() {
    return RealtimeVoice.supported() || GeminiLiveVoice.supported()
  }

  get logic(): LiveControl | null {
    return this.inner?.logic ?? null
  }
  get micLevels() {
    return this.inner?.micLevels ?? null
  }
  get speakerLevels() {
    return this.inner?.speakerLevels ?? null
  }

  async start() {
    const key = await this.opts.getKey([])
    if (this.closed) return
    try {
      await this.run(key)
    } catch (e) {
      // OpenAI handed out a key but the browser could not connect: try Gemini once (if the server has it)
      if (this.closed || key.provider !== 'openai') throw e
      this.inner?.dispose()
      this.inner = null
      let next: VoiceKey
      try {
        next = await this.opts.getKey(['openai'])
      } catch {
        throw e
      }
      if (this.closed) return
      await this.run({ ...next, fallback_from: next.fallback_from ?? ['openai'] })
    }
  }

  private async run(key: VoiceKey) {
    const make = this.opts.make ?? defaultMake
    const inner = make(key, this.opts.runTool, this.opts.cb)
    this.inner = inner
    this.provider = key.provider
    this.opts.onProvider?.(key.provider, key.fallback_from ?? [])
    await inner.start()
  }

  stop() {
    if (this.closed) return
    this.closed = true
    if (this.inner) this.inner.stop()
    else this.opts.cb.onState('closed')
  }
}
