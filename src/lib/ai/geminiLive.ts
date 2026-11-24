/**
 * Live voice conversation with the Google Gemini Live API (the fallback when OpenAI Realtime is not available).
 *
 *  1. The server (voiceSession callable) creates a single-use ephemeral token. The Live setup (model, ABCkit prompt,
 *     the user's context and page, voice, tool definitions) is LOCKED inside the token; GEMINI_API_KEY stays on
 *     the server.
 *  2. The browser opens a WebSocket (BidiGenerateContentConstrained?access_token=…), streams the microphone as
 *     16 kHz 16-bit PCM and plays the model's 24 kHz 16-bit PCM answer.
 *  3. Tool calls run HERE, through the same tool registry as the text assistant — under the user's own
 *     permissions; action tools ask the user to confirm first (spoken "ndiyo / hapana" or the buttons).
 *
 * GeminiLiveLogic is the message state machine (no browser APIs, unit-tested); GeminiLiveVoice wires it to the
 * WebSocket and Web Audio.
 */
import { makeMeter, type LiveCallbacks, type ToolRunner } from './realtime'

export const GEMINI_INPUT_RATE = 16000
export const GEMINI_OUTPUT_RATE = 24000
export const GEMINI_INPUT_MIME = `audio/pcm;rate=${GEMINI_INPUT_RATE}`
/** after the question is read, a short pause in the transcript ends the user's spoken answer */
export const CONFIRM_SILENCE_MS = 1200
/** transcript that arrives this soon after the question was read may still be the question itself (echo) */
export const CONFIRM_ECHO_GUARD_MS = 300

type Send = (msg: Record<string, unknown>) => void

/** plays the model's audio (PCM16 base64 chunks) */
export interface PcmSink {
  play(pcm16Base64: string): void
  clear(): void
  playing(): boolean
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(id: unknown): void
}
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) }

/** what a tool returns, as the JSON object Gemini expects in functionResponses[].response */
export function toFunctionResponse(output: string): Record<string, unknown> {
  let parsed: unknown = output
  try {
    parsed = JSON.parse(output)
  } catch {
    /* plain text */
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed) return parsed as Record<string, unknown>
  return { output: parsed }
}

/** state machine for the Gemini Live server messages (no WebSocket / audio here) */
export class GeminiLiveLogic {
  private running = 0
  private turnActive = false
  /** after interrupt(): drop the rest of this answer's audio */
  private muted = false
  private userText = ''
  private assistantText = ''
  private cancelled = new Set<string>()
  private confirm: { since: number; answer: (text: string) => void; buf: string; timer: unknown } | null = null

  private send: Send
  private runTool: ToolRunner
  private cb: LiveCallbacks
  private sink: PcmSink
  private now: () => number
  private timers: Timers

  constructor(send: Send, runTool: ToolRunner, cb: LiveCallbacks, sink: PcmSink, now: () => number = () => Date.now(), timers: Timers = realTimers) {
    this.send = send
    this.runTool = runTool
    this.cb = cb
    this.sink = sink
    this.now = now
    this.timers = timers
  }

  /** true while the model's voice is playing (the microphone is not streamed then: no echo loops) */
  isSpeaking() {
    return this.sink.playing()
  }

  handle(msg: any): void {
    if (!msg || typeof msg !== 'object') return
    if (msg.setupComplete) this.cb.onState('listening')
    if (msg.toolCallCancellation) for (const id of msg.toolCallCancellation.ids ?? []) this.cancelled.add(String(id))
    if (msg.toolCall) {
      this.finishUser()
      for (const fc of msg.toolCall.functionCalls ?? []) void this.callTool(String(fc.id ?? ''), String(fc.name ?? ''), fc.args ?? {})
    }
    const sc = msg.serverContent
    if (sc) {
      if (sc.inputTranscription?.text) this.onInput(String(sc.inputTranscription.text))
      if (sc.interrupted) {
        this.sink.clear()
        this.finishAssistant()
        this.muted = false
        this.cb.onState('user_speaking')
      }
      if (sc.modelTurn?.parts?.length) {
        this.finishUser()
        this.turnActive = true
        for (const p of sc.modelTurn.parts) {
          if (p?.inlineData?.data && !this.muted) {
            this.sink.play(String(p.inlineData.data))
            this.cb.onState('speaking')
          }
        }
      }
      if (sc.outputTranscription?.text && !this.muted) {
        this.finishUser()
        this.assistantText += String(sc.outputTranscription.text)
        this.cb.onAssistantText(this.assistantText.trim(), false)
      }
      if (sc.turnComplete) {
        this.finishUser()
        this.finishAssistant()
        this.turnActive = false
        this.muted = false
        if (!this.running && !this.confirm && !this.sink.playing()) this.cb.onState('listening')
      }
    }
    if (msg.goAway) this.cb.onError('The Gemini voice session is reaching its time limit. Start a new call to continue.')
  }

  /** the speaker queue ran empty */
  playbackEnded() {
    if (!this.running && !this.confirm && !this.turnActive) this.cb.onState('listening')
  }

  private onInput(text: string) {
    this.userText += text
    if (!this.confirm) this.cb.onState('user_speaking')
    this.cb.onUserText(this.userText.trim(), false)
    const c = this.confirm
    // an action waits for yes / no: collect what the user says after the question, answer after a short pause
    if (c && this.now() - c.since >= CONFIRM_ECHO_GUARD_MS) {
      c.buf += text
      if (c.timer !== null) this.timers.clear(c.timer)
      c.timer = this.timers.set(() => {
        if (this.confirm !== c) return
        const said = c.buf.trim()
        c.buf = ''
        c.timer = null
        this.finishUser()
        if (said) c.answer(said)
      }, CONFIRM_SILENCE_MS)
    }
  }

  private finishUser() {
    const text = this.userText.trim()
    this.userText = ''
    if (text) this.cb.onUserText(text, true)
  }

  private finishAssistant() {
    const text = this.assistantText.trim()
    this.assistantText = ''
    if (text) this.cb.onAssistantText(text, true)
  }

  private async callTool(id: string, name: string, args: unknown) {
    this.running++
    this.cb.onState('tool')
    this.cb.onTool(name, 'running')
    let output: string
    let ok = true
    try {
      output = await this.runTool(name, args)
    } catch (e) {
      ok = false
      output = JSON.stringify({ error: (e as Error)?.message ?? String(e) })
    }
    this.running--
    if (!this.cancelled.has(id)) {
      this.send({ toolResponse: { functionResponses: [{ id, name, response: toFunctionResponse(output) }] } })
      // Gemini continues by itself after the tool response
      if (!this.running && !this.confirm) this.cb.onState('thinking')
    }
    this.cb.onTool(name, ok ? 'done' : 'error')
  }

  /**
   * An action waits for the user's spoken yes / no. The tool call is still open, so the model waits for its
   * result; what the user says after this moment is the answer (parsed strictly by the caller).
   */
  beginConfirm(answer: (text: string) => void) {
    this.finishUser()
    this.confirm = { since: this.now(), answer, buf: '', timer: null }
    this.cb.onState('confirm')
  }

  endConfirm() {
    const c = this.confirm
    if (!c) return
    if (c.timer !== null) this.timers.clear(c.timer)
    this.confirm = null
    this.cb.onState(this.running ? 'tool' : 'thinking')
  }

  /** stop the model talking (barge-in by button) */
  interrupt() {
    this.sink.clear()
    if (this.turnActive) this.muted = true
    this.finishAssistant()
    if (!this.running && !this.confirm) this.cb.onState('listening')
  }

  /**
   * The setup (with the page the call started on) is locked in the token; mid-call context messages are not
   * sent to Gemini Live, so a page change is not forwarded. The model can still read data through its tools.
   */
  pageChanged(_page: { path: string; title: string; text: string }) {
    /* intentionally not forwarded */
  }

  /** a typed message during a live call */
  sendText(text: string) {
    this.finishUser()
    this.send({ realtimeInput: { text } })
    this.cb.onUserText(text, true)
    this.cb.onState('thinking')
  }
}

// ----------------------------------------------------------------------------- PCM helpers (unit-tested)

/** mono float samples at `inRate` → 16 kHz 16-bit PCM (averaging decimation, clipped) */
export function downsampleToPcm16(input: Float32Array, inRate: number, outRate = GEMINI_INPUT_RATE): Int16Array {
  const ratio = inRate / outRate
  const n = Math.floor(input.length / ratio)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio)
    const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let j = a; j < b; j++) sum += input[j]
    const v = Math.max(-1, Math.min(1, sum / (b - a)))
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff)
  }
  return out
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** base64 little-endian 16-bit PCM → float samples */
export function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64)
  const n = bin.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)
    if (v >= 0x8000) v -= 0x10000
    out[i] = v / 0x8000
  }
  return out
}

// ----------------------------------------------------------------------------- browser wiring

/** schedules 24 kHz chunks back to back on the AudioContext */
class PcmPlayer implements PcmSink {
  private next = 0
  private sources = new Set<AudioBufferSourceNode>()
  private ctx: AudioContext
  private out: AudioNode
  private onIdle: () => void

  constructor(ctx: AudioContext, out: AudioNode, onIdle: () => void) {
    this.ctx = ctx
    this.out = out
    this.onIdle = onIdle
  }

  play(b64: string) {
    const samples = base64ToFloat32(b64)
    if (!samples.length) return
    const buf = this.ctx.createBuffer(1, samples.length, GEMINI_OUTPUT_RATE)
    buf.getChannelData(0).set(samples)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.out)
    const at = Math.max(this.ctx.currentTime + 0.03, this.next)
    src.start(at)
    this.next = at + buf.duration
    this.sources.add(src)
    src.onended = () => {
      this.sources.delete(src)
      if (!this.sources.size) this.onIdle()
    }
  }

  clear() {
    for (const s of this.sources) {
      s.onended = null
      try {
        s.stop()
      } catch {
        /* not started */
      }
    }
    this.sources.clear()
    this.next = 0
  }

  playing() {
    return this.sources.size > 0
  }
}

/** copies microphone frames to the main thread */
const CAPTURE_WORKLET = `class AbcPcmCapture extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true }
}
registerProcessor('abc-pcm-capture', AbcPcmCapture)`

export interface GeminiKey {
  client_secret: string
  model: string
  ws_url?: string
  setup?: Record<string, unknown>
}

export interface GeminiLiveOptions {
  key: GeminiKey
  runTool: ToolRunner
  cb: LiveCallbacks
}

const DEFAULT_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'

/** one live Gemini voice call over WebSocket */
export class GeminiLiveVoice {
  logic: GeminiLiveLogic | null = null
  micLevels: (() => number[]) | null = null
  speakerLevels: (() => number[]) | null = null
  private ws: WebSocket | null = null
  private ctx: AudioContext | null = null
  private mic: MediaStream | null = null
  private player: PcmPlayer | null = null
  private node: AudioWorkletNode | null = null
  private ready = false
  private closed = false
  private opts: GeminiLiveOptions

  constructor(opts: GeminiLiveOptions) {
    this.opts = opts
  }

  static supported() {
    return typeof WebSocket !== 'undefined' && typeof AudioWorkletNode !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  }

  async start() {
    const { cb, key } = this.opts
    cb.onState('connecting')
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
    if (this.closed) return this.dispose()
    const ctx = new AudioContext()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)
    this.micLevels = makeMeter(ctx, this.mic)
    const out = ctx.createGain()
    out.connect(ctx.destination)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 64
    out.connect(analyser)
    const bins = new Uint8Array(analyser.frequencyBinCount)
    this.speakerLevels = () => {
      analyser.getByteFrequencyData(bins)
      return Array.from(bins.slice(0, 24), (v) => v / 255)
    }
    this.player = new PcmPlayer(ctx, out, () => this.logic?.playbackEnded())
    this.logic = new GeminiLiveLogic((m) => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify(m)), this.opts.runTool, cb, this.player)

    const url = key.ws_url || DEFAULT_WS
    try {
      this.ws = await this.connect(url)
    } catch (e) {
      // the docs and the SDK disagree on v1beta / v1alpha for ephemeral tokens: try the other one once
      if (this.closed || !url.includes('.v1beta.')) throw e
      this.ws = await this.connect(url.replace('.v1beta.', '.v1alpha.'))
    }
    if (this.closed) return this.dispose()
    await this.startMic()
  }

  /** opens the socket, sends the setup and resolves on setupComplete */
  private connect(url: string): Promise<WebSocket> {
    const { key, cb } = this.opts
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url}?access_token=${key.client_secret}`)
      this.ws = ws
      let queue = Promise.resolve()
      let opened = false
      const timer = setTimeout(() => {
        reject(new Error('Gemini Live did not answer in time.'))
        ws.close()
      }, 15000)
      ws.onopen = () => {
        // the token's locked setup wins; this one is identical (or just the model)
        ws.send(JSON.stringify({ setup: key.setup ?? { model: `models/${key.model}` } }))
      }
      ws.onmessage = (m) => {
        queue = queue
          .then(async () => {
            const text = typeof m.data === 'string' ? m.data : await (m.data as Blob).text()
            const msg = JSON.parse(text)
            if (!opened && msg.setupComplete) {
              opened = true
              this.ready = true
              clearTimeout(timer)
              resolve(ws)
            }
            this.logic?.handle(msg)
          })
          .catch(() => undefined)
      }
      ws.onerror = () => undefined // onclose follows with the code
      ws.onclose = (e) => {
        clearTimeout(timer)
        const why = `${e.code}${e.reason ? `: ${e.reason.slice(0, 200)}` : ''}`
        if (!opened) return reject(new Error(`Gemini Live refused the connection (${why}).`))
        if (this.closed || this.ws !== ws) return
        cb.onError(`The Gemini voice connection was closed (${why}).`)
        this.stop()
      }
    })
  }

  /** microphone → 16 kHz PCM, ~100 ms per message; not streamed while the model's voice plays (no echo loop) */
  private async startMic() {
    const ctx = this.ctx!
    const blobUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(blobUrl)
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
    if (this.closed) return
    const src = ctx.createMediaStreamSource(this.mic!)
    const node = new AudioWorkletNode(ctx, 'abc-pcm-capture')
    this.node = node
    const silent = ctx.createGain()
    silent.gain.value = 0
    src.connect(node)
    node.connect(silent)
    silent.connect(ctx.destination)
    const chunk = Math.round(ctx.sampleRate / 10)
    let frames: Float32Array[] = []
    let count = 0
    node.port.onmessage = (e) => {
      const f = e.data as Float32Array
      frames.push(f)
      count += f.length
      if (count < chunk) return
      const all = new Float32Array(count)
      let o = 0
      for (const fr of frames) {
        all.set(fr, o)
        o += fr.length
      }
      frames = []
      count = 0
      if (!this.ready || this.ws?.readyState !== WebSocket.OPEN || this.logic?.isSpeaking()) return
      const data = pcm16ToBase64(downsampleToPcm16(all, ctx.sampleRate))
      this.ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: GEMINI_INPUT_MIME } } }))
    }
  }

  stop() {
    if (this.closed) return
    this.closed = true
    this.dispose()
    this.opts.cb.onState('closed')
  }

  /** releases everything without reporting 'closed' (used when falling back to another provider) */
  dispose() {
    this.closed = true
    this.ready = false
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
    if (this.node) this.node.port.onmessage = null
    this.player?.clear()
    this.mic?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => undefined)
    this.ws = null
    this.mic = null
    this.node = null
    this.micLevels = null
    this.speakerLevels = null
  }
}
