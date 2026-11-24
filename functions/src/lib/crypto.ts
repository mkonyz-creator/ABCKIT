/** AES-256-GCM encryption of mailbox credentials (refresh tokens / IMAP passwords) with EMAIL_TOKEN_KEY. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface Encrypted {
  /** base64 ciphertext */
  ciphertext: string
  /** base64 12-byte nonce */
  iv: string
  /** base64 16-byte GCM auth tag */
  tag: string
}

export class CryptoConfigError extends Error {}

/** EMAIL_TOKEN_KEY must be 32 random bytes, base64 encoded (e.g. `openssl rand -base64 32`). */
export function parseKey(b64: string | null | undefined): Buffer {
  if (!b64) throw new CryptoConfigError('EMAIL_TOKEN_KEY is not configured')
  const key = Buffer.from(b64.trim(), 'base64')
  if (key.length !== 32) throw new CryptoConfigError('EMAIL_TOKEN_KEY must be 32 bytes encoded as base64')
  return key
}

/** `aad` binds the ciphertext to a context (we use the account id) so blobs cannot be swapped between accounts. */
export function encrypt(plaintext: string, key: Buffer, aad = ''): Encrypted {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

/** Throws when the key is wrong or the data/tag/aad were tampered with. */
export function decrypt(data: Encrypted, key: Buffer, aad = ''): string {
  const iv = Buffer.from(data.iv, 'base64')
  const tag = Buffer.from(data.tag, 'base64')
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted credential')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function shortHash(s: string, len = 16): string {
  return createHash('sha256').update(s).digest('hex').slice(0, len)
}
