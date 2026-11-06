import { configuredSecret } from '../helpers'
import { bytesToB64url, b64urlToBytes, hmacSha384, timingSafeEqual, utf8 } from '../security/pq-toolkit'

export const AUTH_COOKIE = 'isp_session'
export const AUTH_SESSION_DAYS = 7
const PBKDF2_ITERATIONS = 100_000

async function deriveBitsB64(password: string, salt: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password) as unknown as BufferSource, 'PBKDF2', false, ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS }, material, 256,
  )
  return bytesToB64url(new Uint8Array(bits))
}

export async function hashPassword(
  password: string,
  salt = crypto.getRandomValues(new Uint8Array(16)),
): Promise<string> {
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToB64url(salt)}$${await deriveBitsB64(password, salt)}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, expected] = encoded.split('$')
  const iterations = Number(iterationsText)
  if (algorithm !== 'pbkdf2-sha256' || iterations !== PBKDF2_ITERATIONS || !saltText || !expected) return false
  const salt = b64urlToBytes(saltText)
  // Compare only the derived segment: the stored value also carries algorithm,
  // iterations and salt, which would never match a bare digest.
  return timingSafeEqual(await deriveBitsB64(password, salt), expected)
}

export async function hashSessionToken(token: string, secret: string): Promise<string> {
  return bytesToB64url(await hmacSha384(utf8(secret), utf8(token)))
}

export function randomToken(bytes = 32): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header || '').split(';')) {
    const sep = part.indexOf('=')
    if (sep > 0 && part.slice(0, sep).trim() === name) return part.slice(sep + 1).trim()
  }
  return null
}

export function setAuthCookie(token: string, secure: boolean): string {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${AUTH_SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`
}

export function clearAuthCookie(secure: boolean): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
}

export async function currentUser(c: any): Promise<
  { id: string; username: string | null; phone_number: string | null; full_name: string } | null
> {
  const secret = c.env.AUTH_SECRET as string | undefined
  const token = cookieValue(c.req.header('Cookie'), AUTH_COOKIE)
  if (!configuredSecret(secret) || !token || token.length > 128) return null
  const tokenHash = await hashSessionToken(token, secret)
  return c.env.DB.prepare(
    `SELECT u.id, u.username, u.phone_number, u.full_name
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL
       AND datetime(s.expires_at) > datetime('now')`,
  ).bind(tokenHash).first()
}
