/** Small fetch helpers for the Gmail / Microsoft Graph / OAuth REST calls (fetch is injectable for tests). */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
  }
}

/** Mailbox authorisation is no longer valid (revoked / expired refresh token, wrong password). */
export class ProviderAuthError extends Error {}

export async function fetchJson<T = any>(f: FetchLike, url: string, init: RequestInit & { what: string }): Promise<T> {
  const { what, ...rest } = init
  let res: Response
  try {
    res = await f(url, rest)
  } catch (e) {
    throw new Error(`${what}: network error (${(e as Error)?.message ?? e})`)
  }
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      const j = JSON.parse(text)
      detail = j.error_description || j.error?.message || (typeof j.error === 'string' ? j.error : '') || detail
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new ProviderAuthError(`${what}: authorisation rejected (${detail})`)
    throw new HttpError(`${what} failed (${res.status}): ${detail}`, res.status, text)
  }
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${what}: invalid JSON response`)
  }
}

export function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra }
}

export function b64urlDecode(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export function b64urlEncode(data: string | Buffer): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeCharset(buf: Buffer, charset: string | null | undefined): string {
  const cs = (charset ?? 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase()
  try {
    return new TextDecoder(cs === 'utf8' ? 'utf-8' : cs).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}
