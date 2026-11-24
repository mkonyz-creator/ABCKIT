/**
 * "Hey ABC" wake word, recognised entirely in the browser with Vosk (WebAssembly speech recognition).
 * No audio leaves the device for wake-word detection: the microphone is read by a local recogniser that only
 * knows a tiny grammar ("hey a b c"). The model (~41 MB, public/models/vosk-small-en.tar.gz) is downloaded once,
 * the first time someone switches the wake word on, and then cached.
 *
 * The listener pauses while the browser tab is hidden and while the assistant itself is listening / speaking,
 * and reports microphone problems (permission denied, device unplugged).
 */

export const WAKE_MODEL_URL = `${import.meta.env.BASE_URL}models/vosk-small-en.tar.gz`
/** the recogniser may only output these phrases (plus [unk] for everything else) */
/**
 * Common words give ordinary speech somewhere to go: with only the wake phrase in the grammar, the recogniser
 * forces any sentence onto "a b c" (false wake-ups). [unk] catches the rest.
 */
export const WAKE_DISTRACTORS = (
  'the a an and to of in on for is are was be it this that with you we they he she i me my our your please ' +
  'call send open show tell what when where how who why yes no okay ok hello hi hay day say way may today tomorrow ' +
  'team site work project cement steel delivery supplier late again about bars crane arrives monday friday ' +
  'see bee be sea be he key cake play stay great good thanks thank time can will go get make take one two three'
)
  .split(' ')
  .filter((w, i, all) => w && all.indexOf(w) === i)
export const WAKE_GRAMMAR = ['hey a b c', ...WAKE_DISTRACTORS, '[unk]']

export interface WakeWord {
  word: string
  conf: number
}

/** minimum recogniser confidence of every word of the wake phrase */
export const WAKE_MIN_CONFIDENCE = 0.8

/**
 * True only when a finished utterance is the wake phrase itself: "hey a b c" — nothing before or after it,
 * each word recognised with enough confidence. (Text-only input, e.g. tests, counts as confident.)
 */
export function isWakePhrase(text: string, words?: WakeWord[]): boolean {
  const t = text.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
  // the utterance must START with the phrase ("Hey ABC" or "Hey ABC, create a task…" said in one breath)
  if (t !== 'hey a b c' && !t.startsWith('hey a b c ')) return false
  return !words?.length || (words.length >= 4 && words.slice(0, 4).every((w) => w.conf >= WAKE_MIN_CONFIDENCE))
}

export type WakeState = 'loading' | 'listening' | 'paused' | 'error' | 'stopped'

export function wakeWordSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined'
  )
}

export interface WakeEngine {
  /** temporarily stop feeding audio (the assistant is busy, or the tab is hidden) */
  pause(): void
  resume(): void
  stop(): void
}

type VoskModel = Awaited<ReturnType<typeof import('vosk-browser')['createModel']>>
let modelPromise: Promise<VoskModel> | null = null

function loadModel(): Promise<VoskModel> {
  if (!modelPromise)
    modelPromise = import('vosk-browser')
      .then((m) => m.createModel(WAKE_MODEL_URL, -1))
      .catch((e) => {
        modelPromise = null
        throw e
      })
  return modelPromise
}

export const WAKE_ERRORS: Record<string, { en: string; sw: string }> = {
  unsupported: { en: 'This browser cannot run the offline wake word. Use the microphone button.', sw: 'Kivinjari hiki hakiwezi kusikiliza “Hey ABC”. Tumia kitufe cha maikrofoni.' },
  'not-allowed': { en: 'Microphone access was blocked — allow it for this site to use “Hey ABC”.', sw: 'Ruhusa ya maikrofoni imezuiwa — iruhusu kwa tovuti hii ili kutumia “Hey ABC”.' },
  'no-device': { en: 'No microphone was found.', sw: 'Hakuna maikrofoni iliyopatikana.' },
  'mic-ended': { en: 'The microphone was disconnected. Switch “Hey ABC” on again.', sw: 'Maikrofoni imeondolewa. Washa “Hey ABC” tena.' },
  model: { en: 'The wake-word model could not be loaded. Check the connection and try again.', sw: 'Modeli ya “Hey ABC” haikupakia. Angalia mtandao kisha ujaribu tena.' },
}

/**
 * Starts listening for "Hey ABC". Requests microphone permission (the browser asks the user).
 * onState('error', code) uses the keys of WAKE_ERRORS.
 */
export async function startWakeWord(opts: { onWake: () => void; onState: (s: WakeState, code?: string) => void }): Promise<WakeEngine | null> {
  if (!wakeWordSupported()) {
    opts.onState('error', 'unsupported')
    return null
  }
  opts.onState('loading')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false })
  } catch (e) {
    const name = (e as DOMException)?.name
    opts.onState('error', name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed' : name === 'NotFoundError' ? 'no-device' : 'not-allowed')
    return null
  }
  let model: VoskModel
  try {
    model = await loadModel()
  } catch {
    stream.getTracks().forEach((t) => t.stop())
    opts.onState('error', 'model')
    return null
  }

  const ctx = new AudioContext()
  const recognizer = new model.KaldiRecognizer(ctx.sampleRate, JSON.stringify(WAKE_GRAMMAR))
  let paused = false
  let stopped = false
  let lastWake = 0
  recognizer.setWords(true)
  const debug = (() => {
    try {
      return localStorage.getItem('abckit-wake-debug') === '1'
    } catch {
      return false
    }
  })()
  const fire = (text: string, words?: WakeWord[]) => {
    if (debug) ((window as unknown as { __abcWake?: unknown[] }).__abcWake ??= []).push({ text, words })
    if (stopped || paused || !isWakePhrase(text, words)) return
    const now = Date.now()
    if (now - lastWake < 2500) return
    lastWake = now
    opts.onWake()
  }
  // finished utterances only (partial results are too eager)
  recognizer.on('result', (m: any) => fire(String(m?.result?.text ?? ''), Array.isArray(m?.result?.result) ? m.result.result : undefined))

  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessor is deprecated but universally available; the audio stays in this page
  const node = ctx.createScriptProcessor(4096, 1, 1)
  node.onaudioprocess = (e) => {
    if (paused || stopped) return
    try {
      recognizer.acceptWaveform(e.inputBuffer)
    } catch {
      /* a dropped chunk is harmless */
    }
  }
  source.connect(node)
  node.connect(ctx.destination)

  const track = stream.getAudioTracks()[0]
  const onEnded = () => {
    if (stopped) return
    engine.stop()
    opts.onState('error', 'mic-ended')
  }
  track?.addEventListener('ended', onEnded)

  const setPaused = (p: boolean) => {
    if (stopped) return
    paused = p
    if (track) track.enabled = !p
    void (p ? ctx.suspend() : ctx.resume()).catch(() => undefined)
    opts.onState(p ? 'paused' : 'listening')
  }
  const onVisibility = () => setPaused(document.hidden)
  document.addEventListener('visibilitychange', onVisibility)

  const engine: WakeEngine = {
    pause: () => setPaused(true),
    resume: () => setPaused(document.hidden),
    stop() {
      if (stopped) return
      stopped = true
      document.removeEventListener('visibilitychange', onVisibility)
      track?.removeEventListener('ended', onEnded)
      node.onaudioprocess = null
      try {
        source.disconnect()
        node.disconnect()
      } catch {
        /* already disconnected */
      }
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close().catch(() => undefined)
      try {
        recognizer.remove()
      } catch {
        /* model gone */
      }
      opts.onState('stopped')
    },
  }
  setPaused(document.hidden)
  return engine
}
