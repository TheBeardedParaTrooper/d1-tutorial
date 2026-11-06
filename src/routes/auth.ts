import type { Hono } from 'hono'
import type { Bindings } from '../env'
import { normalizeTzPhone, isValidE164 } from '../lib/phone'
import { configuredSecret } from '../lib/helpers'
import { hashPassword as hashPbkdf2, verifyPassword as verifyPbkdf2 } from '../lib/auth/user-auth'
import { bytesToB64url, hmacSha384, timingSafeEqual, utf8 } from '../lib/security/pq-toolkit'

const AUTH_COOKIE = 'isp_session'
const AUTH_SESSION_DAYS = 7

function randomId(): string { return crypto.randomUUID() }
function randomToken(bytes = 32): string { return bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes))) }
async function hashSessionToken(token: string, secret: string): Promise<string> { return bytesToB64url(await hmacSha384(utf8(secret), utf8(token))) }

// Legacy accounts were created with a single unsalted SHA-256 digest. They stay
// usable, and the next successful sign-in transparently upgrades them to PBKDF2.
async function hashPasswordLegacy(password: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password) as BufferSource)
  return bytesToB64url(new Uint8Array(hash))
}

function isLegacyHash(encoded: string): boolean {
  return !encoded.startsWith('pbkdf2-sha256$')
}

async function verifyStoredPassword(password: string, encoded: string | null): Promise<'pbkdf2' | 'legacy' | 'invalid'> {
  if (!encoded) return 'invalid'
  if (!isLegacyHash(encoded)) return (await verifyPbkdf2(password, encoded)) ? 'pbkdf2' : 'invalid'
  return (await timingSafeEqual(await hashPasswordLegacy(password), encoded)) ? 'legacy' : 'invalid'
}

export const USERNAME_PATTERN = /^[a-z0-9_]{1,30}$/

// Single-letter handles are allowed (a user may be "G"), but the operator and
// protocol names stay locked so nobody can impersonate the ISP on a listing.
export const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'support', 'help', 'system', 'staff', 'moderator',
  'api', 'flatcoin', 'flat', 'coin', 'isp', 'mikrotik', 'azampay', 'payment', 'payments',
  'wallet', 'marketplace', 'seller', 'buyer', 'portal', 'null', 'undefined',
])

export function normalizeUsername(raw: unknown): string | null {
  const value = String(raw ?? '').trim().replace(/^@/, '').toLowerCase()
  if (!value) return null
  if (!USERNAME_PATTERN.test(value)) return null
  return RESERVED_USERNAMES.has(value) ? null : value
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header || '').split(';')) {
    const sep = part.indexOf('=')
    if (sep > 0 && part.slice(0, sep).trim() === name) return part.slice(sep + 1).trim()
  }
  return null
}

function validPortalOrigin(requestOrigin: string | undefined, configuredOrigin: string | undefined): boolean {
  if (!configuredOrigin || !requestOrigin) return false
  try {
    const expected = new URL(configuredOrigin)
    return expected.origin === configuredOrigin && requestOrigin === configuredOrigin
  } catch { return false }
}

// EXPORTED HELPERS for payments.ts
export async function readLimitedJson(c: any, maxBytes: number): Promise<any | null> {
  const length = c.req.header('Content-Length')
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return null
  const text = await c.req.text()
  if (new TextEncoder().encode(text).length > maxBytes) return null
  try { return JSON.parse(text) } catch { return null }
}

export function jsonError(c: any, message: string, status: 400 | 401 | 403 | 404 | 409 | 410 | 500 | 503 = 400) { 
  return c.json({ error: message }, status) 
}

export function mutationOriginAllowed(c: any): boolean { 
  return validPortalOrigin(c.req.header('Origin'), c.env.PORTAL_ORIGIN) 
}

export async function authenticatedUser(c: any): Promise<any | null> {
  const secret = c.env.AUTH_SECRET
  const token = cookieValue(c.req.header('Cookie'), AUTH_COOKIE)
  if (!configuredSecret(secret) || !token || token.length > 128) return null
  const tokenHash = await hashSessionToken(token, secret)
  // u.active = 1 means a suspension from the staff console takes effect on the
  // very next request, not merely at the next sign-in.
  return c.env.DB.prepare(`SELECT u.id, u.username, u.phone_number, u.full_name FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND u.active = 1 AND datetime(s.expires_at) > datetime('now')`).bind(tokenHash).first()
}

/** Phone is mandatory; username is optional but unique, and can be used to sign in. */
function readCredentials(body: any): { phone: string | null, username: string | null, password: string, fullName: string, identifier: string } {
  const rawPhone = typeof body.phone_number === 'string' ? body.phone_number : (typeof body.identifier === 'string' ? body.identifier : '')
  const rawIdentifier = typeof body.identifier === 'string' ? body.identifier.trim() : ''
  return {
    phone: normalizeTzPhone(rawPhone) || (isValidE164(rawPhone) ? rawPhone.trim() : null),
    username: normalizeUsername(body.username ?? (rawIdentifier && !rawIdentifier.includes('+') && !/^\d+$/.test(rawIdentifier) ? rawIdentifier : null)),
    password: String(body.password ?? ''),
    fullName: String(body.full_name ?? '').trim().slice(0, 60),
    identifier: rawIdentifier,
  }
}

async function issueSession(c: any, userId: string): Promise<string> {
  const secret = c.env.AUTH_SECRET as string
  const token = randomToken()
  const tokenHash = await hashSessionToken(token, secret)
  const expiresAt = new Date(Date.now() + AUTH_SESSION_DAYS * 86_400_000).toISOString()
  await c.env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(randomId(), userId, tokenHash, expiresAt).run()
  // Secure only when the portal itself is served over HTTPS.
  const secure = (c.env.PORTAL_ORIGIN || '').startsWith('https://')
  c.header('Set-Cookie', `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${AUTH_SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`)
  return token
}

export function registerAuthRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.post('/api/auth/register', async (c) => {
    try {
      const body: any = await readLimitedJson(c, 8192)
      if (!body || typeof body !== 'object') return jsonError(c, 'Invalid body')
      const { phone, username, password, fullName } = readCredentials(body)
      if (!phone) return jsonError(c, 'Enter a Tanzanian number, e.g. 0712 234 432 or +255712234432')
      if (password.length < 12) return jsonError(c, 'Password must be at least 12 characters')
      if (!fullName) return jsonError(c, 'Name on the account is required')
      if (String(body.username ?? '').trim() && !username) {
        return jsonError(c, 'Username must be 1-30 letters, digits or underscore, and is not a reserved name')
      }

      if (username) {
        const clash = await c.env.DB.prepare(`SELECT id FROM users WHERE lower(username) = ?`).bind(username).first()
        if (clash) return jsonError(c, 'That username is taken', 409)
      }
      const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE phone_number = ?`).bind(phone).first()
      if (existing) return jsonError(c, 'That number is already registered — sign in instead', 409)

      const passwordHash = await hashPbkdf2(password)
      const userId = randomId()
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(`INSERT INTO users (id, phone_number, full_name, username, password_hash) VALUES (?, ?, ?, ?, ?)`)
            .bind(userId, phone, fullName, username, passwordHash),
          c.env.DB.prepare(`INSERT INTO wallets (user_id, balance) VALUES (?, 0)`).bind(userId),
          c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (?, 'user.registered', ?, ?)`)
            .bind(userId, userId, JSON.stringify({ username, phone_number: phone, has_username: Boolean(username) })),
        ])
      } catch (e) {
        const text = String(e)
        if (text.includes('UNIQUE') && text.includes('username')) return jsonError(c, 'That username is taken', 409)
        if (text.includes('UNIQUE')) return jsonError(c, 'That number is already registered — sign in instead', 409)
        return jsonError(c, 'Registration failed', 500)
      }

      // Sign the new account straight in so ?next= round trips work immediately.
      if (configuredSecret(c.env.AUTH_SECRET)) await issueSession(c, userId).catch(() => {})
      return c.json({
        success: true,
        signed_in: true,
        user: { id: userId, phone_number: phone, full_name: fullName, username },
      }, 201)
    } catch { return jsonError(c, 'Registration failed', 500) }
  })

  app.post('/api/auth/login', async (c) => {
    try {
      const secret = c.env.AUTH_SECRET
      if (!configuredSecret(secret)) return jsonError(c, 'Auth not configured', 503)
      const body: any = await readLimitedJson(c, 8192)
      if (!body || typeof body !== 'object') return jsonError(c, 'Invalid body')
      const { phone, username, password } = readCredentials(body)
      if (!password) return jsonError(c, 'Password required')

      const lookup = phone
        ? c.env.DB.prepare(`SELECT id, phone_number, full_name, username, password_hash, active FROM users WHERE phone_number = ?`).bind(phone)
        : username
          ? c.env.DB.prepare(`SELECT id, phone_number, full_name, username, password_hash, active FROM users WHERE lower(username) = ?`).bind(username)
          : null
      if (!lookup) return jsonError(c, 'Sign in with your username or the phone number you registered')

      const user: any = await lookup.first()
      const outcome = user ? await verifyStoredPassword(password, user.password_hash) : 'invalid'
      if (!user || outcome === 'invalid') {
        await c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (?, 'user.login_failed', ?, ?)`)
          .bind(user?.id ?? null, user?.id ?? null, JSON.stringify({ attempted: phone || `@${username || 'unknown'}` })).run().catch(() => {})
        return jsonError(c, 'Wrong number/username or password', 401)
      }
      // A suspended account has the right password but no service.
      if (Number(user.active ?? 1) !== 1) {
        await c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (?, 'user.login_blocked_suspended', ?, ?)`)
          .bind(user.id, user.id, JSON.stringify({ attempted: phone || `@${username || 'unknown'}` })).run().catch(() => {})
        return jsonError(c, 'This account is suspended. Contact the network office to restore it.', 403)
      }

      // Migrate unsalted SHA-256 hashes to PBKDF2 on the first good sign-in.
      if (outcome === 'legacy') {
        await c.env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(await hashPbkdf2(password), user.id).run().catch(() => {})
      }

      await issueSession(c, user.id)
      await c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (?, 'user.login', ?, ?)`)
        .bind(user.id, user.id, JSON.stringify({ via: phone ? 'phone' : 'username', upgraded_from_legacy: outcome === 'legacy' })).run().catch(() => {})

      return c.json({ success: true, user: { id: user.id, phone_number: user.phone_number, full_name: user.full_name, username: user.username } })
    } catch { return jsonError(c, 'Login failed', 500) }
  })

  app.post('/api/auth/logout', async (c) => {
    const secret = c.env.AUTH_SECRET
    const token = cookieValue(c.req.header('Cookie'), AUTH_COOKIE)
    if (configuredSecret(secret) && token && token.length <= 128) {
      const tokenHash = await hashSessionToken(token, secret)
      const user: any = await c.env.DB.prepare(`SELECT user_id FROM auth_sessions WHERE token_hash = ?`).bind(tokenHash).first()
      await c.env.DB.prepare(`UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL`)
        .bind(tokenHash).run().catch(() => {})
      if (user) {
        await c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (?, 'user.logout', ?, ?)`)
          .bind(user.user_id, user.user_id, JSON.stringify({ revoked: true })).run().catch(() => {})
      }
    }
    c.header('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
    return c.json({ success: true })
  })

  app.get('/api/auth/me', async (c) => {
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Authentication required', 401)
    const wallet = await c.env.DB.prepare(`SELECT balance, updated_at FROM wallets WHERE user_id = ?`).bind(user.id).first()
    return c.json({ user, wallet: wallet ?? { balance: 0, updated_at: null } })
  })
}
