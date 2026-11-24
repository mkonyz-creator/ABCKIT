/**
 * Secrets and parameters (set with `firebase functions:secrets:set NAME`; see functions/AI_SETUP.md).
 * A secret whose value is empty or the literal "unset" counts as "not configured".
 */
import { defineSecret, defineString } from 'firebase-functions/params'

export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY')
export const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY')
// the NAME of the secret — never the key itself (the key goes in functions/.secret.local, Secret Manager,
// or System Settings → AI API keys)
export const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY')
export const EMAIL_TOKEN_KEY = defineSecret('EMAIL_TOKEN_KEY')
export const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID')
export const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET')
export const MS_CLIENT_ID = defineSecret('MS_CLIENT_ID')
export const MS_CLIENT_SECRET = defineSecret('MS_CLIENT_SECRET')

export const APP_ORIGINS = defineString('APP_ORIGINS', {
  default: 'https://abckt-6b791.web.app,https://abckt-6b791.firebaseapp.com,http://localhost:5173,http://127.0.0.1:5173',
  description: 'Comma-separated list of web origins the OAuth flow may return to',
})

/** Optional override of the OAuth redirect URI ("unset" = use the default function URL). */
export const OAUTH_REDIRECT_URI = defineString('OAUTH_REDIRECT_URI', {
  default: 'unset',
  description: 'Override for the emailOAuthCallback URL registered with Google / Microsoft ("unset" = default URL)',
})

/** Model choices (override with params in functions/.env.<project> or at deploy time). */
export const OPENAI_CHAT_MODEL = defineString('OPENAI_CHAT_MODEL', { default: 'gpt-5.5', description: 'OpenAI model for the chat assistant (Responses API)' })
export const OPENAI_REALTIME_MODEL = defineString('OPENAI_REALTIME_MODEL', { default: 'gpt-realtime', description: 'OpenAI Realtime model for live voice' })
export const OPENAI_REALTIME_VOICE = defineString('OPENAI_REALTIME_VOICE', { default: 'marin', description: 'Voice of the live assistant (e.g. marin, cedar, alloy)' })
export const GEMINI_MODEL = defineString('GEMINI_MODEL', { default: 'gemini-3.5-flash', description: 'Gemini model for the chat assistant fallback' })
export const GEMINI_LIVE_MODEL = defineString('GEMINI_LIVE_MODEL', { default: 'gemini-3.8-live', description: 'Gemini Live API model for the live-voice fallback' })
export const GEMINI_LIVE_VOICE = defineString('GEMINI_LIVE_VOICE', { default: 'Kore', description: 'Prebuilt Gemini Live voice (e.g. Kore)' })

export const REGION = process.env.FUNCTIONS_REGION || 'us-central1'
/** Company local time zone (ARICOM operates in Tanzania). */
export const COMPANY_TZ = 'Africa/Dar_es_Salaam'

/** AI provider keys + EMAIL_TOKEN_KEY, which decrypts keys saved in the AI Control Center (ai/keys.ts) */
export const AI_SECRETS = [ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, EMAIL_TOKEN_KEY]
export const ALL_SECRETS = [ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, EMAIL_TOKEN_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MS_CLIENT_ID, MS_CLIENT_SECRET]

/** Normalises a secret value: null when empty / "unset" / not available. */
export function configured(value: string | undefined | null): string | null {
  const v = (value ?? '').trim()
  if (!v || v.toLowerCase() === 'unset') return null
  return v
}

function read(s: { value(): string }): string | null {
  try {
    return configured(s.value())
  } catch {
    return null
  }
}

export interface ProviderCreds {
  clientId: string
  clientSecret: string
}

export interface RuntimeConfig {
  anthropicKey: string | null
  openaiKey: string | null
  geminiKey: string | null
  models: { openaiChat: string; openaiRealtime: string; openaiVoice: string; gemini: string; geminiLive: string; geminiVoice: string }
  tokenKey: string | null
  google: ProviderCreds | null
  microsoft: ProviderCreds | null
  appOrigins: string[]
  redirectUri: string
}

export function parseOrigins(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

export function defaultRedirectUri(): string {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'abckt-6b791'
  if (process.env.FUNCTIONS_EMULATOR === 'true') return `http://127.0.0.1:5001/${project}/${REGION}/emailOAuthCallback`
  return `https://${REGION}-${project}.cloudfunctions.net/emailOAuthCallback`
}

/** Reads all secrets / params at call time (only inside a function that declared the secrets). */
export function runtimeConfig(): RuntimeConfig {
  const gId = read(GOOGLE_CLIENT_ID)
  const gSecret = read(GOOGLE_CLIENT_SECRET)
  const mId = read(MS_CLIENT_ID)
  const mSecret = read(MS_CLIENT_SECRET)
  let origins = ''
  let redirect = ''
  try {
    origins = APP_ORIGINS.value()
  } catch {
    origins = ''
  }
  try {
    redirect = configured(OAUTH_REDIRECT_URI.value()) ?? ''
  } catch {
    redirect = ''
  }
  const param = (p: { value(): string }, d: string) => {
    try {
      return configured(p.value()) ?? d
    } catch {
      return d
    }
  }
  return {
    anthropicKey: read(ANTHROPIC_API_KEY),
    openaiKey: read(OPENAI_API_KEY),
    geminiKey: read(GEMINI_API_KEY),
    models: {
      openaiChat: param(OPENAI_CHAT_MODEL, 'gpt-5.5'),
      openaiRealtime: param(OPENAI_REALTIME_MODEL, 'gpt-realtime'),
      openaiVoice: param(OPENAI_REALTIME_VOICE, 'marin'),
      gemini: param(GEMINI_MODEL, 'gemini-3.5-flash'),
      geminiLive: param(GEMINI_LIVE_MODEL, 'gemini-3.8-live'),
      geminiVoice: param(GEMINI_LIVE_VOICE, 'Kore'),
    },
    tokenKey: read(EMAIL_TOKEN_KEY),
    google: gId && gSecret ? { clientId: gId, clientSecret: gSecret } : null,
    microsoft: mId && mSecret ? { clientId: mId, clientSecret: mSecret } : null,
    appOrigins: parseOrigins(origins || 'https://abckt-6b791.web.app,http://localhost:5173,http://127.0.0.1:5173'),
    redirectUri: redirect || defaultRedirectUri(),
  }
}
