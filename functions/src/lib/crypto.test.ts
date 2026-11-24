import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { configured, parseOrigins } from './params.js'
import { CryptoConfigError, decrypt, encrypt, parseKey } from './crypto.js'

const KEY_B64 = randomBytes(32).toString('base64')

describe('AES-256-GCM credential encryption', () => {
  it('round-trips and uses a fresh IV per encryption', () => {
    const key = parseKey(KEY_B64)
    const a = encrypt('1//refresh-token-ü', key, 'gmail-abc')
    const b = encrypt('1//refresh-token-ü', key, 'gmail-abc')
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(decrypt(a, key, 'gmail-abc')).toBe('1//refresh-token-ü')
  })

  it('detects tampering with the ciphertext, tag or IV', () => {
    const key = parseKey(KEY_B64)
    const e = encrypt('secret', key)
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64')
      buf[0] ^= 1
      return buf.toString('base64')
    }
    expect(() => decrypt({ ...e, ciphertext: flip(e.ciphertext) }, key)).toThrow()
    expect(() => decrypt({ ...e, tag: flip(e.tag) }, key)).toThrow()
    expect(() => decrypt({ ...e, iv: flip(e.iv) }, key)).toThrow()
  })

  it('rejects the wrong key and a different associated account id', () => {
    const e = encrypt('secret', parseKey(KEY_B64), 'acc-1')
    expect(() => decrypt(e, parseKey(randomBytes(32).toString('base64')), 'acc-1')).toThrow()
    expect(() => decrypt(e, parseKey(KEY_B64), 'acc-2')).toThrow()
  })

  it('validates EMAIL_TOKEN_KEY', () => {
    expect(() => parseKey(null)).toThrow(CryptoConfigError)
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
  })
})

describe('secret / param helpers', () => {
  it('treats empty and "unset" as not configured', () => {
    expect(configured('')).toBeNull()
    expect(configured(' unset ')).toBeNull()
    expect(configured('UNSET')).toBeNull()
    expect(configured(undefined)).toBeNull()
    expect(configured('sk-ant-x')).toBe('sk-ant-x')
  })
  it('parses APP_ORIGINS', () => {
    expect(parseOrigins(' https://a.web.app/, http://localhost:5173 ,,')).toEqual(['https://a.web.app', 'http://localhost:5173'])
  })
})
