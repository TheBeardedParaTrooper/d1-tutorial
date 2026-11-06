import { configuredSecret } from '../helpers'
import { bytesToB64url, b64urlToBytes, hmacSha384, timingSafeEqual, utf8 } from '../security/pq-toolkit'

export const ADMIN_COOKIE = 'admin_session'
export const ADMIN_SESSION_DAYS = 7
const PBKDF2_ITERATIONS = 100_000

export type AdminRole = 'super_admin' | 'operator' | 'viewer'

export type Admin = {
  id: string
  username: string
  email: string | null
  role: AdminRole
  must_change_password: number
}

// Staff escalate one way: a viewer may read, an operator may act on customers,
// a super_admin may also manage staff. Nothing above is ever implied downwards.
const ROLE_RANK: Record<AdminRole, number> = { viewer: 1, operator: 2, super_admin: 3 }

export function isRole(value: unknown): value is AdminRole {
  return value === 'super_admin' || value === 'operator' || value === 'viewer'
}

export function roleAtLeast(role: AdminRole, minimum: AdminRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

async function deriveBitsB64(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password) as unknown as BufferSource, 'PBKDF2', false, ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations }, material, 256,
  )
  return bytesToB64url(new Uint8Array(bits))
}

export async function hashAdminPassword(
  password: string,
  salt = crypto.getRandomValues(new Uint8Array(16)),
): Promise<string> {
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToB64url(salt)}$${await deriveBitsB64(password, salt, PBKDF2_ITERATIONS)}`
}

export async function verifyAdminPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, expected] = encoded.split('$')
  const iterations = Number(iterationsText)
  if (algorithm !== 'pbkdf2-sha256' || iterations !== PBKDF2_ITERATIONS || !saltText || !expected) return false
  const salt = b64urlToBytes(saltText)
  // Only the derived segment can match; the stored string also carries
  // algorithm, iterations and salt.
  return timingSafeEqual(await deriveBitsB64(password, salt, iterations), expected)
}

// Accounts created before the console existed held a single unsalted SHA-256
// digest. They still sign in, and the good password upgrades them on the spot.
async function hashLegacy(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password) as BufferSource)
  return bytesToB64url(new Uint8Array(digest))
}

export async function verifyStoredAdminPassword(
  password: string,
  encoded: string | null,
): Promise<'pbkdf2' | 'legacy' | 'invalid'> {
  if (!encoded) return 'invalid'
  if (encoded.startsWith('pbkdf2-sha256$')) {
    return (await verifyAdminPassword(password, encoded)) ? 'pbkdf2' : 'invalid'
  }
  return (await timingSafeEqual(await hashLegacy(password), encoded)) ? 'legacy' : 'invalid'
}

export function hashAdminSessionToken(token: string, secret: string): Promise<string> {
  return hmacSha384(utf8(`${secret}:admin-v1`), utf8(token)).then(bytesToB64url)
}

export function randomAdminToken(bytes = 32): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export function adminCookieValue(header: string | undefined): string | null {
  for (const part of (header || '').split(';')) {
    const sep = part.indexOf('=')
    if (sep > 0 && part.slice(0, sep).trim() === ADMIN_COOKIE) return part.slice(sep + 1).trim()
  }
  return null
}

export function setAdminCookie(token: string, secure: boolean): string {
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`
}

export function clearAdminCookie(secure: boolean): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
}

export function adminSessionExpiryIso(): string {
  return new Date(Date.now() + ADMIN_SESSION_DAYS * 86_400_000).toISOString()
}

export function adminTransportIsSecure(requestUrl: string): boolean {
  try {
    return new URL(requestUrl).protocol === 'https:'
  } catch {
    return false
  }
}

export async function currentAdmin(c: any): Promise<Admin | null> {
  const secret = c.env.AUTH_SECRET as string | undefined
  const token = adminCookieValue(c.req.header('Cookie'))
  if (!configuredSecret(secret) || !token || token.length > 128) return null
  const tokenHash = await hashAdminSessionToken(token, secret)
  const db = c.env.DB as D1Database
  const row = await db
    .prepare(
      `SELECT a.id, a.username, a.email, a.role, a.must_change_password
     FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL
       AND a.active = 1
       AND datetime(s.expires_at) > datetime('now')`,
    )
    .bind(tokenHash)
    .first<Admin>()
  return row ?? null
}

function unauthenticated(c: any): Response {
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return c.json({ error: 'Authentication required' }, 401)
  }
  return c.redirect('/admin/login')
}

// Any active staff account, whatever its role.
export async function requireAdmin(c: any, next: () => Promise<void>): Promise<Response | void> {
  const admin = await currentAdmin(c)
  if (!admin) return unauthenticated(c)
  c.set('admin', admin)
  await next()
}

// Writes need more than a session: the browser must be the portal the worker
// is configured to serve, and the actor must outrank the action.
export function requireRole(minimum: AdminRole) {
  return async (c: any, next: () => Promise<void>): Promise<Response | void> => {
    const admin = await currentAdmin(c)
    if (!admin) return unauthenticated(c)
    if (!roleAtLeast(admin.role, minimum)) {
      return c.json({ error: `This action needs the ${minimum} role` }, 403)
    }
    c.set('admin', admin)
    await next()
  }
}

/**
 * Every console mutation lands in the same append-only outbox the audit
 * exporter reads, with the acting staff account recorded separately from the
 * customer the action touched.
 */
export async function writeAdminAudit(
  env: { DB: D1Database },
  admin: Admin | null,
  eventType: string,
  targetId: string | null,
  details: Record<string, unknown>,
  actorUserId: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_outbox (actor_user_id, actor_admin_id, event_type, target_id, details_json)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(actorUserId, admin?.id ?? null, eventType, targetId, JSON.stringify(details))
    .run()
    .catch(() => {})
}
