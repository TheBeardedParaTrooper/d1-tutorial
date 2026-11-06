/**
 * Application-layer post-quantum toolkit (FIPS 203 / 204).
 * ML-KEM-1024, ML-DSA-87, HKDF-SHA-384, HMAC-SHA-384, AES-256-GCM.
 * Not a replacement for TLS. Cookies use HMAC-SHA-384 (ML-DSA sigs are ~4.6 KiB).
 */
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa'
import { ml_kem1024 } from '@noble/post-quantum/ml-kem'

export const PQ_SUITE = {
  kem: 'ML-KEM-1024',
  signature: 'ML-DSA-87',
  aead: 'AES-256-GCM',
  kdf: 'HKDF-SHA-384',
  mac: 'HMAC-SHA-384',
  nist: ['FIPS 203', 'FIPS 204'],
  cookie_mac: 'HMAC-SHA-384',
  transport_note: 'Rely on Cloudflare hybrid PQ TLS. Never send these secrets over cleartext HTTP.',
} as const

const TE = new TextEncoder()

export function bytesToB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16_384) throw new Error('invalid_b64url')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

// WebCrypto wants a view over a plain ArrayBuffer, so the byte helpers hand out
// that exact type instead of the wider Uint8Array<ArrayBufferLike>.
export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return TE.encode(value)
}

export async function sha384(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-384', data as any as BufferSource))
}

export async function hmacSha384(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as any as BufferSource,
    { name: 'HMAC', hash: 'SHA-384' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as any as BufferSource))
}

export async function timingSafeEqual(
  left: string | Uint8Array,
  right: string | Uint8Array,
): Promise<boolean> {
  const a = typeof left === 'string' ? utf8(left) : left
  const b = typeof right === 'string' ? utf8(right) : right
  const max = Math.max(a.length, b.length, 1)
  const pa = new Uint8Array(max)
  const pb = new Uint8Array(max)
  pa.set(a)
  pb.set(b)
  let diff = a.length ^ b.length
  for (let i = 0; i < max; i++) diff |= pa[i] ^ pb[i]
  return diff === 0
}

async function hkdfSha384(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', ikm as any as BufferSource, 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-384', salt: salt as any as BufferSource, info: utf8(info) },
    baseKey,
    length * 8,
  )
  return new Uint8Array(bits)
}

export type PqKeys = {
  dsaPublicKey: Uint8Array
  dsaSecretKey: Uint8Array
  kemPublicKey: Uint8Array
  kemSecretKey: Uint8Array
  macKey: Uint8Array
}

export async function derivePqKeys(authSecret: string): Promise<PqKeys> {
  const ikm = utf8(authSecret)
  const salt = utf8('flatcoin-isp.pq.v1')
  const dsaSeed = await hkdfSha384(ikm, salt, 'ml-dsa-87.seed', 32)
  const kemSeed = await hkdfSha384(ikm, salt, 'ml-kem-1024.seed', 64)
  const macKey = await hkdfSha384(ikm, salt, 'hmac-sha384.mac', 48)
  const dsa = ml_dsa87.keygen(dsaSeed)
  const kem = ml_kem1024.keygen(kemSeed)
  dsaSeed.fill(0)
  kemSeed.fill(0)
  return {
    dsaPublicKey: dsa.publicKey,
    dsaSecretKey: dsa.secretKey,
    kemPublicKey: kem.publicKey,
    kemSecretKey: kem.secretKey,
    macKey,
  }
}

// @noble/post-quantum takes (secretKey, message) and (publicKey, message, signature).
// Passing them in any other order fails the fixed-size key decode, so the wrapper
// keeps one canonical argument order for the rest of the app.
export function signMlDsa87(keys: PqKeys, message: Uint8Array): Uint8Array {
  return ml_dsa87.sign(keys.dsaSecretKey, message)
}

export function verifyMlDsa87(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return ml_dsa87.verify(publicKey, message, signature)
  } catch {
    return false
  }
}

export type HybridBox = {
  v: 1
  kem: typeof PQ_SUITE.kem
  aead: typeof PQ_SUITE.aead
  ct: string
  iv: string
  ciphertext: string
}

export async function hybridSeal(
  keys: PqKeys,
  plaintext: Uint8Array,
  aad: string,
): Promise<HybridBox> {
  const msgRand = crypto.getRandomValues(new Uint8Array(32))
  const { cipherText, sharedSecret } = ml_kem1024.encapsulate(keys.kemPublicKey, msgRand)
  msgRand.fill(0)
  const aesKeyBytes = await hkdfSha384(sharedSecret, utf8('flatcoin-aead'), `aes-256-gcm|${aad}`, 32)
  sharedSecret.fill(0)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await crypto.subtle.importKey('raw', aesKeyBytes as any as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ])
  aesKeyBytes.fill(0)
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 },
      aesKey,
      plaintext as any as BufferSource,
    ),
  )
  return {
    v: 1,
    kem: PQ_SUITE.kem,
    aead: PQ_SUITE.aead,
    ct: bytesToB64url(cipherText),
    iv: bytesToB64url(iv),
    ciphertext: bytesToB64url(encrypted),
  }
}

export async function hybridOpen(
  keys: PqKeys,
  box: HybridBox,
  aad: string,
): Promise<Uint8Array> {
  if (box.v !== 1 || box.kem !== PQ_SUITE.kem || box.aead !== PQ_SUITE.aead) {
    throw new Error('unsupported_box')
  }
  const sharedSecret = ml_kem1024.decapsulate(b64urlToBytes(box.ct), keys.kemSecretKey)
  const aesKeyBytes = await hkdfSha384(sharedSecret, utf8('flatcoin-aead'), `aes-256-gcm|${aad}`, 32)
  sharedSecret.fill(0)
  const aesKey = await crypto.subtle.importKey('raw', aesKeyBytes as any as BufferSource, 'AES-GCM', false, [
    'decrypt',
  ])
  aesKeyBytes.fill(0)
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: b64urlToBytes(box.iv) as any as BufferSource,
        additionalData: utf8(aad),
        tagLength: 128,
      },
      aesKey,
      b64urlToBytes(box.ciphertext) as any as BufferSource,
    ),
  )
}

export async function macCompact(keys: PqKeys, message: Uint8Array): Promise<string> {
  return bytesToB64url(await hmacSha384(keys.macKey, message))
}

export async function macCompactVerify(
  keys: PqKeys,
  message: Uint8Array,
  tagB64: string,
): Promise<boolean> {
  const expected = await hmacSha384(keys.macKey, message)
  try {
    return timingSafeEqual(expected, b64urlToBytes(tagB64))
  } catch {
    return false
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

const keyCache = new Map<string, Promise<PqKeys>>()

export function pqKeysForSecret(authSecret: string): Promise<PqKeys> {
  let hit = keyCache.get(authSecret)
  if (!hit) {
    hit = derivePqKeys(authSecret)
    keyCache.set(authSecret, hit)
  }
  return hit
}
