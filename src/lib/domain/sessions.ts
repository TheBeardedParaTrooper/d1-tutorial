import type { Bindings } from '../../env'
import { ok, fail, Result } from '../helpers'
import { normalizeMac } from '../helpers'
import { debitWalletStmt, insertTxStmt } from './transactions'

export type SessionInfo = { id: string; radiusToken: string; expiresAt: string; amount: number }

function randomRadiusToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

export async function buyWithWallet(
  env: Bindings,
  input: { userId: string; packageId: string; macAddress: string; idempotencyKey: string },
): Promise<Result<SessionInfo>> {
  const mac = normalizeMac(input.macAddress)
  if (!mac) return fail('bad_mac', 'Invalid MAC address')
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) return fail('bad_key', 'Invalid Idempotency-Key')

  const pkg = await env.DB.prepare(
    `SELECT id, price, duration_hours FROM packages WHERE id = ? AND active = 1`,
  ).bind(input.packageId).first<{ id: string; price: number; duration_hours: number }>()
  if (!pkg) return fail('no_package', 'Package is unavailable', 404)
  if (!Number.isSafeInteger(pkg.price) || pkg.price <= 0) return fail('bad_package', 'Package is misconfigured', 500)

  const sessionId = crypto.randomUUID()
  const txId = crypto.randomUUID()
  const radiusToken = randomRadiusToken()
  const expiresAt = new Date(Date.now() + pkg.duration_hours * 3_600_000).toISOString()

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (user_id, idempotency_key, operation) VALUES (?, ?, 'session_buy')`,
    ).bind(input.userId, input.idempotencyKey),
    debitWalletStmt(env.DB, input.userId, pkg.price),
    insertTxStmt(env.DB, { id: txId, userId: input.userId, type: 'SPEND_TIME_PASS', amount: pkg.price, referenceId: `Pass:${input.packageId}:${input.idempotencyKey}` }),
    env.DB.prepare(
      `INSERT INTO access_sessions (id, user_id, mac_address, token, duration_hours, expires_at, status)
       SELECT ?, ?, ?, ?, ?, ?, 'active' WHERE changes() = 1`,
    ).bind(sessionId, input.userId, mac, radiusToken, pkg.duration_hours, expiresAt),
    env.DB.prepare(
      `INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json)
       VALUES (?, 'wallet.session_purchased', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END)`,
    ).bind(input.userId, sessionId, JSON.stringify({ package_id: input.packageId, transaction_id: txId, amount: pkg.price, currency: 'TZS' })),
  ])
  if (results[0].meta.changes !== 1) return fail('idem_used', 'Idempotency key already used', 409)
  if (results[1].meta.changes !== 1) return fail('insufficient', 'Insufficient balance', 400)
  if (results.slice(2).some((r) => r.meta.changes !== 1)) {
    // audit CHECK(json_valid) rolled the batch back
    return fail('internal', 'Session purchase failed', 500)
  }
  return ok({ id: sessionId, radiusToken, expiresAt, amount: pkg.price })
}

export async function validateRadius(
  env: Bindings,
  input: { token: string; macAddress: string },
): Promise<Result<{ sessionTimeout: number }>> {
  const token = input.token.trim().toUpperCase()
  const mac = normalizeMac(input.macAddress)
  if (!token || !mac) return fail('bad_input', 'Token and Calling-Station-Id required', 400)

  const row = await env.DB.prepare(
    `SELECT id, mac_address, expires_at FROM access_sessions
     WHERE token = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(token).first<{ id: string; mac_address: string; expires_at: string }>()
  if (!row) return fail('no_session', 'Invalid or expired session', 403)
  if (normalizeMac(row.mac_address) !== mac) return fail('mac_mismatch', 'Session bound to different device', 403)

  const expires = new Date(row.expires_at).getTime()
  const sessionTimeout = Math.max(1, Math.floor((expires - Date.now()) / 1000))
  return ok({ sessionTimeout })
}

export async function listForAdmin(
  env: Bindings,
  filters: { phone?: string; status?: string; limit?: number },
): Promise<any[]> {
  const limit = Math.min(100, Math.max(1, filters.limit || 50))
  const phone = (filters.phone || '').trim().slice(0, 16)
  const status = filters.status || ''
  const statusExpr = `CASE WHEN s.status = 'active' AND datetime(s.expires_at) <= datetime('now') THEN 'expired' ELSE s.status END`
  const clauses = ["(? = '' OR u.phone_number LIKE ? OR u.username LIKE ?)"]
  const bindings: any[] = [phone, `%${phone}%`, `%${phone}%`]
  if (status) { clauses.push(`${statusExpr} = ?`); bindings.push(status) }
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.user_id, u.username, u.phone_number, u.full_name, s.mac_address,
            s.duration_hours, s.expires_at, ${statusExpr} AS status, s.created_at
     FROM access_sessions s JOIN users u ON u.id = s.user_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY s.created_at DESC LIMIT ?`,
  ).bind(...bindings, limit).all<any>()
  return results || []
}

export async function revokeSession(env: Bindings, id: string): Promise<Result<{ id: string }>> {
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE access_sessions SET status = 'revoked' WHERE id = ? AND status = 'active'`).bind(id),
    env.DB.prepare(
      `INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json)
       SELECT NULL, 'admin.session_revoked', id, '{"actor":"admin"}' FROM access_sessions WHERE id = ? AND status = 'revoked' AND changes() = 1`,
    ).bind(id),
  ])
  if (results[0].meta.changes !== 1) return fail('not_found', 'Active session not found', 404)
  return ok({ id })
}
