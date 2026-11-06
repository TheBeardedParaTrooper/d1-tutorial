import type { Bindings } from '../../env'
import { ok, fail, Result } from '../helpers'
import { hashPassword, verifyPassword, hashSessionToken, randomToken, AUTH_SESSION_DAYS } from '../auth/user-auth'
import { normalizeTzPhone, isValidE164 } from '../phone'
import { logUserEvent } from './audit'

export type PublicUser = { id: string; username: string | null; phone_number: string | null; full_name: string }

export async function createUser(
  env: Bindings,
  input: { username?: string; phoneNumber?: string; password: string; fullName?: string },
): Promise<Result<PublicUser>> {
  const username = (input.username || '').trim()
  const phoneInput = (input.phoneNumber || '').trim()
  const password = input.password
  const fullName = (input.fullName || '').trim()

  if (!username && !phoneInput) return fail('missing_identifier', 'Username or phone number is required')
  if (username && (username.length < 3 || username.length > 30)) return fail('bad_username', 'Username must be 3-30 characters')
  const phone = phoneInput ? (normalizeTzPhone(phoneInput) || (isValidE164(phoneInput) ? phoneInput : null)) : null
  if (phoneInput && !phone) return fail('bad_phone', 'Invalid phone number format')
  if (password.length < 12 || password.length > 128) return fail('bad_password', 'Password must be 12-128 characters')
  if (fullName.length > 100) return fail('bad_name', 'Name too long')

  if (username) {
    const exists = await env.DB.prepare(`SELECT id FROM users WHERE username = ?`).bind(username).first()
    if (exists) return fail('username_taken', 'Username is already taken', 409)
  }
  if (phone) {
    const exists = await env.DB.prepare(`SELECT id FROM users WHERE phone_number = ?`).bind(phone).first()
    if (exists) return fail('phone_taken', 'Phone number is already registered', 409)
  }

  const passwordHash = await hashPassword(password)
  const userId = crypto.randomUUID()
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, username, phone_number, full_name, password_hash) VALUES (?, ?, ?, ?, ?)`)
        .bind(userId, username || null, phone || null, fullName, passwordHash),
      env.DB.prepare(`INSERT INTO wallets (user_id, balance) VALUES (?, 0)`).bind(userId),
    ])
  } catch {
    return fail('insert_failed', 'Could not create account', 500)
  }
  await logUserEvent(env, { actorUserId: userId, eventType: 'account.registered', targetId: userId, details: {} })
  return ok({ id: userId, username: username || null, phone_number: phone, full_name: fullName })
}

export async function verifyLogin(
  env: Bindings,
  input: { identifier: string; password: string },
): Promise<Result<{ user: PublicUser; token: string; expiresAt: string }>> {
  const identifier = input.identifier.trim()
  const password = input.password
  if (!identifier || password.length > 128) return fail('invalid', 'Invalid credentials', 401)

  const row: any = await env.DB.prepare(
    `SELECT id, username, phone_number, full_name, password_hash FROM users WHERE username = ? OR phone_number = ?`,
  ).bind(identifier, identifier).first()
  if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) {
    return fail('invalid', 'Invalid username or password', 401)
  }

  const token = randomToken()
  const tokenHash = await hashSessionToken(token, env.AUTH_SECRET as string)
  const expiresAt = new Date(Date.now() + AUTH_SESSION_DAYS * 86_400_000).toISOString()
  const sid = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(sid, row.id, tokenHash, expiresAt),
  ])
  await logUserEvent(env, { actorUserId: row.id, eventType: 'auth.login', targetId: sid, details: {} })
  return ok({
    user: { id: row.id, username: row.username, phone_number: row.phone_number, full_name: row.full_name },
    token, expiresAt,
  })
}

export async function revokeSession(env: Bindings, token: string, userId: string): Promise<void> {
  const tokenHash = await hashSessionToken(token, env.AUTH_SECRET as string)
  await env.DB.batch([
    env.DB.prepare(`UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL`).bind(tokenHash),
  ])
  await logUserEvent(env, { actorUserId: userId, eventType: 'auth.logout', targetId: null, details: {} })
}
