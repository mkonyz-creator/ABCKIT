/**
 * Voice for the floating assistant, using the browser's built-in speech services:
 *  - speech-to-text: Web Speech API SpeechRecognition (Chrome, Edge, Safari). In Chrome/Edge the audio is
 *    processed by the browser vendor's speech service; nothing is recorded or stored by ABCkit.
 *  - text-to-speech: speechSynthesis with the best installed voice for Kiswahili or English.
 */

export type VoiceLang = 'sw' | 'en'
export const RECOGNITION_LANG: Record<VoiceLang, string> = { sw: 'sw-TZ', en: 'en-US' }

// ----------------------------------------------------------------------------- markdown → speech

/** plain sentences suitable for reading aloud (no markdown, links, ids or tables); capped in length */
export function toSpeech(md: string, maxChars = 900): string {
  let t = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, ', ')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\[DEMO\]/gi, 'demo')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
  t = t
    .split(/\n+/)
    .map((l) => l.replace(/\s*,\s*(,\s*)+/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '').trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;]$/.test(l) ? l : `${l}.`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
    t = `${end > maxChars * 0.5 ? cut.slice(0, end + 1) : cut}`
  }
  return t
}

/** split into utterances of at most ~220 characters (long utterances are cut off by some browsers) */
export function speechChunks(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim())
      cur = ''
    }
    if (s.length > max) {
      for (const part of s.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')) ?? [s]) out.push(part.trim())
    } else cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

// ----------------------------------------------------------------------------- text-to-speech

export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const now = window.speechSynthesis.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => resolve(window.speechSynthesis.getVoices())
    window.speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 1500)
  })
}

/** best installed voice for the language (natural/online voices preferred), or null */
export async function pickVoice(lang: VoiceLang): Promise<SpeechSynthesisVoice | null> {
  if (!ttsSupported()) return null
  const voices = await loadVoices()
  const want = lang === 'sw' ? /^sw/i : /^en/i
  const matches = voices.filter((v) => want.test(v.lang))
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|online|neural|google/i.test(v.name) ? 4 : 0) + (lang === 'sw' && /TZ/i.test(v.lang) ? 2 : 0) + (lang === 'en' && /GB|US/i.test(v.lang) ? 1 : 0) + (v.localService ? 0 : 1)
  return matches.sort((a, b) => score(b) - score(a))[0] ?? null
}

export async function hasVoiceFor(lang: VoiceLang) {
  return !!(await pickVoice(lang))
}

let speakToken = 0

/** reads `text` aloud; resolves when finished or stopped */
export async function speak(text: string, lang: VoiceLang, opts: { rate?: number; onStart?: () => void } = {}): Promise<void> {
  if (!ttsSupported() || !text.trim()) return
  stopSpeaking()
  const token = ++speakToken
  const voice = await pickVoice(lang)
  if (token !== speakToken) return
  opts.onStart?.()
  for (const chunk of speechChunks(text)) {
    if (token !== speakToken) return
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(chunk)
      if (voice) u.voice = voice
      u.lang = voice?.lang ?? RECOGNITION_LANG[lang]
      u.rate = opts.rate ?? 1
      // some browsers occasionally never fire 'end' — never leave the assistant stuck "speaking"
      const guard = setTimeout(resolve, 4000 + chunk.length * 150)
      const finish = () => {
        clearTimeout(guard)
        resolve()
      }
      u.onend = finish
      u.onerror = finish
      window.speechSynthesis.speak(u)
    })
  }
}

export function stopSpeaking() {
  speakToken++
  if (ttsSupported()) window.speechSynthesis.cancel()
}

// ----------------------------------------------------------------------------- speech-to-text

interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: any) => void) | null
  onerror: ((e: any) => void) | null
  onend: (() => void) | null
}

function recognitionCtor(): (new () => RecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const sttSupported = () => !!recognitionCtor()

export const MIC_ERRORS: Record<string, { en: string; sw: string }> = {
  'not-allowed': { en: 'Microphone access was blocked. Allow the microphone for this site in the browser (padlock icon in the address bar).', sw: 'Ruhusa ya maikrofoni imezuiwa. Ruhusu maikrofoni kwa tovuti hii kwenye kivinjari (alama ya kufuli kwenye anwani).' },
  'service-not-allowed': { en: 'Speech recognition is not allowed in this browser.', sw: 'Kivinjari hiki hakiruhusu utambuzi wa sauti.' },
  'audio-capture': { en: 'No microphone was found.', sw: 'Hakuna maikrofoni iliyopatikana.' },
  network: { en: 'Speech recognition needs an internet connection.', sw: 'Utambuzi wa sauti unahitaji intaneti.' },
  'language-not-supported': { en: 'This browser cannot recognise that language. Try English, or use Chrome / Edge.', sw: 'Kivinjari hiki hakitambui lugha hiyo. Jaribu Kiingereza, au tumia Chrome / Edge.' },
  'no-speech': { en: 'I did not hear anything. Tap the microphone and speak.', sw: 'Sijasikia kitu. Bonyeza maikrofoni kisha uongee.' },
}

export interface Listener {
  stop(): void
  abort(): void
}

/**
 * Listens for one utterance. onInterim gets the live transcript; onFinal the finished sentence (may be empty);
 * onError a SpeechRecognition error code ('not-allowed', 'no-speech', …).
 */
export function listen(lang: VoiceLang, cb: { onInterim?: (t: string) => void; onFinal: (t: string) => void; onError?: (code: string) => void; onEnd?: () => void }): Listener | null {
  const Ctor = recognitionCtor()
  if (!Ctor) return null
  const rec = new Ctor()
  rec.lang = RECOGNITION_LANG[lang]
  rec.continuous = false
  rec.interimResults = true
  rec.maxAlternatives = 1
  let finalText = ''
  let delivered = false
  rec.onresult = (e: any) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) finalText += r[0].transcript
      else interim += r[0].transcript
    }
    cb.onInterim?.((finalText + interim).trim())
  }
  rec.onerror = (e: any) => {
    if (e?.error !== 'aborted') cb.onError?.(String(e?.error ?? 'error'))
  }
  rec.onend = () => {
    if (!delivered) {
      delivered = true
      cb.onFinal(finalText.trim())
    }
    cb.onEnd?.()
  }
  try {
    rec.start()
  } catch {
    return null
  }
  return {
    stop: () => rec.stop(),
    abort: () => {
      delivered = true
      rec.abort()
    },
  }
}

// ----------------------------------------------------------------------------- wake word & yes / no

/**
 * "Hey ABC …" / "Msaidizi …" at the start of what was heard (speech engines write ABC in many ways).
 * Returns the command after the wake word ('' when only the wake word was said), or null when not addressed.
 */
export function parseWake(transcript: string): string | null {
  const t = transcript.trim()
  const m = t.match(/^(?:(?:hey|hi|hello|ok|okay|sasa|haya|ee|eh)[\s,]+)?(?:a\.?\s?b\.?\s?c\.?|abc|ey\s?bee\s?see|eibisi|ebisi|msaidizi)(?=$|[\s,.!?:])[\s,.!?:]*(.*)$/i)
  return m ? m[1].trim() : null
}

/** a yes that is qualified or deferred ("yes, but…", "subiri", "labda") is not an explicit approval */
const HEDGE = /\b(but|wait|hold on|maybe|perhaps|first|later|not sure|lakini|subiri|ngoja|labda|kwanza|baadaye|sijui|sina uhakika)\b/

/**
 * true = yes, false = no, null = not understood.
 * Approval must be explicit: a short answer with a yes word, no "no" word and no hedge. Any clear refusal
 * cancels (declining is always safe).
 */
export function parseYesNo(transcript: string): boolean | null {
  const t = transcript.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim()
  const no = /\b(hapana|no|nope|cancel|acha|sitaki|usifanye|stop|ghairi|siyo|sio)\b/.test(t)
  const yes = /\b(ndiyo|ndio|yes|yeah|yep|sawa|fanya|endelea|confirm|okay|ok|kubali|thibitisha|sure|go ahead|naam)\b/.test(t)
  // both (e.g. the assistant's own question "sema ndiyo au hapana" picked up by the microphone) is not an answer
  if (yes && no) return null
  if (no) return false
  if (!yes || HEDGE.test(t) || t.split(' ').length > 8) return null
  return true
}

export interface WakeListener {
  stop(): void
}

/**
 * Keeps listening (while the page is open) for the wake word. Restarts itself when the browser ends a
 * recognition session; stops for good on permission / device errors (onError).
 */
export function startWakeListener(lang: VoiceLang, cb: { onWake: (command: string) => void; onError?: (code: string) => void }): WakeListener | null {
  const Ctor = recognitionCtor()
  if (!Ctor) return null
  let stopped = false
  let rec: RecognitionLike | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  const begin = () => {
    if (stopped) return
    rec = new Ctor()
    rec.lang = RECOGNITION_LANG[lang]
    rec.continuous = true
    rec.interimResults = false
    rec.maxAlternatives = 1
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue
        const command = parseWake(String(e.results[i][0].transcript ?? ''))
        if (command !== null && !stopped) {
          stopped = true
          rec?.abort()
          cb.onWake(command)
          return
        }
      }
    }
    rec.onerror = (e: any) => {
      const code = String(e?.error ?? '')
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(code)) {
        stopped = true
        cb.onError?.(code)
      }
    }
    rec.onend = () => {
      if (!stopped) restartTimer = setTimeout(begin, 400)
    }
    try {
      rec.start()
    } catch {
      restartTimer = setTimeout(begin, 1000)
    }
  }
  begin()
  return {
    stop() {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      try {
        rec?.abort()
      } catch {
        /* already stopped */
      }
    },
  }
}
