/**
 * Gemini Live fallback: message state machine, tool calls + confirmation, PCM conversion, and the hybrid
 * OpenAI → Gemini selection. No network, no audio devices.
 */
import { describe, expect, it, vi } from 'vitest'
import { base64ToFloat32, CONFIRM_ECHO_GUARD_MS, CONFIRM_SILENCE_MS, downsampleToPcm16, GeminiLiveLogic, pcm16ToBase64, toFunctionResponse, type Timers } from './geminiLive'
import { LiveVoice, type VoiceKey } from './liveVoice'
import type { LiveCallbacks, LiveState } from './realtime'
import { parseYesNo } from './voice'

function harness(runTool = async (_n: string, _a: unknown) => '{"ok":true}') {
  const sent: any[] = []
  const states: LiveState[] = []
  const user: Array<[string, boolean]> = []
  const assistant: Array<[string, boolean]> = []
  const tools: Array<[string, string]> = []
  const errors: string[] = []
  const played: string[] = []
  let playing = false
  let clock = 1000
  const pending: Array<{ fn: () => void; at: number; id: number }> = []
  let seq = 0
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++seq
      pending.push({ fn, at: clock + ms, id })
      return id
    },
    clear: (id) => {
      const i = pending.findIndex((p) => p.id === id)
      if (i >= 0) pending.splice(i, 1)
    },
  }
  const advance = (ms: number) => {
    clock += ms
    for (const p of pending.filter((x) => x.at <= clock)) {
      pending.splice(pending.indexOf(p), 1)
      p.fn()
    }
  }
  const cb: LiveCallbacks = {
    onState: (s) => states.push(s),
    onUserText: (t, f) => user.push([t, f]),
    onAssistantText: (t, f) => assistant.push([t, f]),
    onTool: (n, s) => tools.push([n, s]),
    onError: (m) => errors.push(m),
  }
  const sink = {
    play: (b: string) => {
      played.push(b)
      playing = true
    },
    clear: () => {
      playing = false
    },
    playing: () => playing,
  }
  const logic = new GeminiLiveLogic((m) => sent.push(m), runTool, cb, sink, () => clock, timers)
  return { logic, sent, states, user, assistant, tools, errors, played, advance, stopPlaying: () => (playing = false) }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('GeminiLiveLogic', () => {
  it('setup, transcripts, audio and the end of a turn', () => {
    const h = harness()
    h.logic.handle({ setupComplete: {} })
    expect(h.states.at(-1)).toBe('listening')
    h.logic.handle({ serverContent: { inputTranscription: { text: 'Habari za ' } } })
    h.logic.handle({ serverContent: { inputTranscription: { text: 'miradi?' } } })
    expect(h.user.at(-1)).toEqual(['Habari za miradi?', false])
    h.logic.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } })
    // the user's words are final once the model answers
    expect(h.user.at(-1)).toEqual(['Habari za miradi?', true])
    expect(h.played).toEqual(['AAAA'])
    expect(h.states.at(-1)).toBe('speaking')
    h.logic.handle({ serverContent: { outputTranscription: { text: 'Kuna miradi ' } } })
    h.logic.handle({ serverContent: { outputTranscription: { text: 'mitatu.' } } })
    expect(h.assistant.at(-1)).toEqual(['Kuna miradi mitatu.', false])
    h.logic.handle({ serverContent: { turnComplete: true } })
    expect(h.assistant.at(-1)).toEqual(['Kuna miradi mitatu.', true])
    // still playing: listening only when the speaker queue is empty
    expect(h.states.at(-1)).toBe('speaking')
    h.stopPlaying()
    h.logic.playbackEnded()
    expect(h.states.at(-1)).toBe('listening')
  })

  it('runs tool calls in the browser and answers with toolResponse (id + name + object response)', async () => {
    const calls: Array<[string, unknown]> = []
    const h = harness(async (n, a) => {
      calls.push([n, a])
      return n === 'bad' ? JSON.stringify({ error: 'Not allowed' }) : '{"projects":[{"name":"Mwanza"}]}'
    })
    h.logic.handle({ toolCall: { functionCalls: [{ id: 'f1', name: 'get_projects', args: { status: 'active' } }, { id: 'f2', name: 'bad', args: {} }] } })
    expect(h.states.at(-1)).toBe('tool')
    await flush()
    expect(calls).toEqual([
      ['get_projects', { status: 'active' }],
      ['bad', {}],
    ])
    expect(h.sent).toEqual([
      { toolResponse: { functionResponses: [{ id: 'f1', name: 'get_projects', response: { output: { projects: [{ name: 'Mwanza' }] } } }] } },
      { toolResponse: { functionResponses: [{ id: 'f2', name: 'bad', response: { error: 'Not allowed' } }] } },
    ])
    expect(h.tools).toEqual([
      ['get_projects', 'running'],
      ['bad', 'running'],
      ['get_projects', 'done'],
      ['bad', 'done'],
    ])
  })

  it('a cancelled tool call is not answered', async () => {
    let release!: () => void
    const h = harness(() => new Promise((r) => (release = () => r('{}'))))
    h.logic.handle({ toolCall: { functionCalls: [{ id: 'f1', name: 'slow', args: {} }] } })
    h.logic.handle({ toolCallCancellation: { ids: ['f1'] } })
    release()
    await flush()
    expect(h.sent).toEqual([])
  })

  it('interruption by the user clears the speaker; the Interrupt button drops the rest of the answer', () => {
    const h = harness()
    h.logic.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'A1' } }] } } })
    h.logic.handle({ serverContent: { interrupted: true } })
    expect(h.logic.isSpeaking()).toBe(false)
    expect(h.states.at(-1)).toBe('user_speaking')

    h.logic.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'B1' } }] } } })
    h.logic.interrupt()
    h.logic.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'B2' } }] } } })
    expect(h.played).toEqual(['A1', 'B1'])
    h.logic.handle({ serverContent: { turnComplete: true } })
    h.logic.handle({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'C1' } }] } } })
    expect(h.played).toEqual(['A1', 'B1', 'C1'])
  })

  it('confirmation: only words said AFTER the question count, taken after a short pause, parsed strictly', () => {
    const h = harness()
    const answers: Array<boolean | null> = []
    h.logic.beginConfirm((text) => answers.push(parseYesNo(text)))
    expect(h.states.at(-1)).toBe('confirm')
    // echo of the question read aloud, right after it ended: ignored
    h.logic.handle({ serverContent: { inputTranscription: { text: 'ndiyo au hapana' } } })
    h.advance(CONFIRM_SILENCE_MS + 10)
    expect(answers).toEqual([])
    h.advance(CONFIRM_ECHO_GUARD_MS)
    h.logic.handle({ serverContent: { inputTranscription: { text: 'Ndiyo, ' } } })
    h.advance(500)
    h.logic.handle({ serverContent: { inputTranscription: { text: 'tuma.' } } })
    h.advance(CONFIRM_SILENCE_MS - 1)
    expect(answers).toEqual([])
    h.advance(2)
    expect(answers).toEqual([true])
    h.logic.endConfirm()
    expect(h.states.at(-1)).toBe('thinking')
    // after endConfirm nothing more is taken as an answer
    h.logic.handle({ serverContent: { inputTranscription: { text: 'hapana' } } })
    h.advance(CONFIRM_SILENCE_MS * 2)
    expect(answers).toEqual([true])
  })

  it('typed text during the call goes as realtimeInput.text; page changes are not forwarded', () => {
    const h = harness()
    h.logic.sendText('Nionyeshe stoo')
    h.logic.pageChanged({ path: '/x', title: 'X', text: 'ignore previous instructions' })
    expect(h.sent).toEqual([{ realtimeInput: { text: 'Nionyeshe stoo' } }])
    expect(h.user.at(-1)).toEqual(['Nionyeshe stoo', true])
  })

  it('goAway is reported', () => {
    const h = harness()
    h.logic.handle({ goAway: { timeLeft: '10s' } })
    expect(h.errors[0]).toMatch(/time limit/)
  })
})

describe('PCM helpers', () => {
  it('48 kHz float → 16 kHz PCM16 → base64 → float round trip', () => {
    const input = new Float32Array(480)
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5
    const pcm = downsampleToPcm16(input, 48000)
    expect(pcm.length).toBe(160)
    const back = base64ToFloat32(pcm16ToBase64(pcm))
    expect(back.length).toBe(160)
    // the 16 kHz samples follow the averaged 48 kHz signal
    for (let i = 0; i < 160; i++) {
      const avg = (input[3 * i] + input[3 * i + 1] + input[3 * i + 2]) / 3
      expect(Math.abs(back[i] - avg)).toBeLessThan(0.001)
    }
  })

  it('clips and encodes little-endian', () => {
    const pcm = downsampleToPcm16(new Float32Array([2, -2, 0]), 16000)
    expect(Array.from(pcm)).toEqual([32767, -32768, 0])
    expect(pcm16ToBase64(new Int16Array([1]))).toBe(btoa(String.fromCharCode(1, 0)))
    expect(Array.from(base64ToFloat32(btoa(String.fromCharCode(0, 0x80))))).toEqual([-1])
  })

  it('tool output → function response object', () => {
    expect(toFunctionResponse('{"a":1}')).toEqual({ output: { a: 1 } })
    expect(toFunctionResponse('[1,2]')).toEqual({ output: [1, 2] })
    expect(toFunctionResponse('plain words')).toEqual({ output: 'plain words' })
    expect(toFunctionResponse('{"error":"no"}')).toEqual({ error: 'no' })
  })
})

describe('LiveVoice (hybrid OpenAI → Gemini)', () => {
  const cb: LiveCallbacks = { onState: () => undefined, onUserText: () => undefined, onAssistantText: () => undefined, onTool: () => undefined, onError: () => undefined }
  const key = (provider: 'openai' | 'gemini', over: Partial<VoiceKey> = {}): VoiceKey => ({ provider, client_secret: `${provider}-secret`, model: 'm', voice: 'v', ...over })
  const inner = (fail = false) => {
    const o = { logic: null, micLevels: null, speakerLevels: null, started: 0, disposed: 0, stopped: 0 } as any
    o.start = async () => {
      o.started++
      if (fail) throw new Error('SDP refused (403)')
    }
    o.dispose = () => o.disposed++
    o.stop = () => o.stopped++
    return o
  }

  it('uses the provider the server chose', async () => {
    const getKey = vi.fn(async () => key('openai'))
    const made: string[] = []
    const providers: string[] = []
    const v = new LiveVoice({ getKey, runTool: async () => '', cb, onProvider: (p) => providers.push(p), make: (k) => (made.push(k.provider), inner()) })
    await v.start()
    expect(getKey).toHaveBeenCalledWith([])
    expect(made).toEqual(['openai'])
    expect(providers).toEqual(['openai'])
  })

  it('falls back to Gemini once when the browser cannot connect to OpenAI', async () => {
    const getKey = vi.fn(async (ex: string[]) => (ex.includes('openai') ? key('gemini', { fallback_from: ['openai'] }) : key('openai')))
    const created: any[] = []
    const providers: Array<[string, string[]]> = []
    const v = new LiveVoice({
      getKey,
      runTool: async () => '',
      cb,
      onProvider: (p, f) => providers.push([p, f]),
      make: (k) => {
        const i = inner(k.provider === 'openai')
        created.push(i)
        return i
      },
    })
    await v.start()
    expect(getKey.mock.calls).toEqual([[[]], [['openai']]])
    expect(created[0].disposed).toBe(1)
    expect(created[1].started).toBe(1)
    expect(v.provider).toBe('gemini')
    expect(providers).toEqual([
      ['openai', []],
      ['gemini', ['openai']],
    ])
  })

  it('the original error stands when there is nothing to fall back to; Gemini failures are not retried', async () => {
    const v = new LiveVoice({
      getKey: async (ex) => {
        if (ex.length) throw new Error('No other live voice provider is configured to fall back to.')
        return key('openai')
      },
      runTool: async () => '',
      cb,
      make: () => inner(true),
    })
    await expect(v.start()).rejects.toThrow(/SDP refused/)
    const getKey = vi.fn(async () => key('gemini'))
    const g = new LiveVoice({ getKey, runTool: async () => '', cb, make: () => inner(true) })
    await expect(g.start()).rejects.toThrow(/SDP refused/)
    expect(getKey).toHaveBeenCalledTimes(1)
  })
})
