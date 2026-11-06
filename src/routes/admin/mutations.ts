import type { Hono } from 'hono'
import type { Bindings } from '../../env'
import { jsonError, readLimitedJson } from '../auth'
import {
  currentAdmin,
  roleAtLeast,
  writeAdminAudit,
  hashAdminPassword,
  verifyStoredAdminPassword,
  type Admin,
  type AdminRole,
} from '../../lib/auth/admin-auth'
import { adminOriginAllowed } from './auth'

const IDEMPOTENT_KEY = /^[A-Za-z0-9._:-]{8,128}$/
const STAFF_USERNAME = /^[a-z0-9_]{1,30}$/

function money(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2_000_000_000
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/**
 * Console writes: same-origin proof, a role that outranks the action, and — for
 * anything that touches money — an idempotency key so a double click or a retry
 * after a timeout can never pay out twice.
 */
function adminWrite(minimum: AdminRole) {
  return async (c: any, next: () => Promise<void>): Promise<Response | void> => {
    if (!adminOriginAllowed(c)) return c.json({ ok: false, error: 'Invalid or missing Origin' }, 403)
    const admin = await currentAdmin(c)
    if (!admin) return c.json({ ok: false, error: 'Authentication required' }, 401)
    if (!roleAtLeast(admin.role, minimum)) {
      return c.json({ ok: false, error: `This action needs the ${minimum} role` }, 403)
    }
    c.set('admin', admin)
    await next()
  }
}

async function body(c: any, maxBytes = 8192): Promise<any | null> {
  const parsed = await readLimitedJson(c, maxBytes)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

function idempotency(c: any): string {
  return c.req.header('Idempotency-Key') || ''
}

/**
 * Money writes are replay-guarded twice on purpose. The cheap SELECT answers the
 * common case (an operator double-clicking) without starting a batch at all; the
 * catch covers the race where the key lands between the two, because in that case
 * the INSERT OR IGNORE changes no row, every dependent statement changes no row,
 * and the poisoned audit value is what aborts the batch. Same customer-visible
 * answer either way: 409, never a 500.
 */
async function idempotencyAlreadyUsed(db: D1Database, adminId: string, key: string): Promise<boolean> {
  const seen = await db
    .prepare(`SELECT 1 AS present FROM admin_idempotency_keys WHERE admin_id = ? AND idempotency_key = ?`)
    .bind(adminId, key)
    .first()
  return Boolean(seen)
}

async function commitBatch(c: any, steps: any[], conflict: string): Promise<any[] | Response> {
  try {
    return await c.env.DB.batch(steps)
  } catch (error) {
    console.warn('admin batch rolled back:', error instanceof Error ? error.message : error)
    return jsonError(c, conflict, 409)
  }
}

function notRows(value: any): value is Response {
  return !Array.isArray(value)
}

async function resolveUser(db: D1Database, handle: string): Promise<any | null> {
  return db.prepare(
    `SELECT u.id, u.username, u.phone_number, u.full_name, u.active
     FROM users u
     WHERE u.id = ? OR (u.username IS NOT NULL AND lower(u.username) = ?) OR u.phone_number = ?`,
  )
    .bind(handle, handle.replace(/^@/, '').toLowerCase(), handle)
    .first()
}

function badRequest(c: any, message: string) {
  return c.json({ ok: false, error: message }, 400)
}

// ---------- password rules shared by self-service and staff management ----------
function passwordProblem(password: string, username: string): string | null {
  if (password.length < 8) return 'Staff passwords need at least 8 characters'
  if (password.length > 200) return 'Staff passwords are too long'
  if (password.toLowerCase() === 'admin') return 'The seeded default password must be replaced with something else'
  if (username && password.toLowerCase() === username.toLowerCase()) return 'The password cannot be the same as the username'
  return null
}

export function registerAdminMutationRoutes(app: Hono<{ Bindings: Bindings }>) {
  // ============ WALLET: MANUAL LEDGER MOVES ============

  app.post('/api/admin/wallet/credit', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const key = idempotency(c)
    if (!IDEMPOTENT_KEY.test(key)) return badRequest(c, 'Idempotency-Key header required')
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const handle = text(input.user, 100)
    const amount = input.amount
    const note = text(input.note, 200)
    if (!handle || !money(amount)) return badRequest(c, 'user and an integer TZS amount are required')

    const user = await resolveUser(c.env.DB, handle)
    if (!user) return jsonError(c, 'No such customer (id, @username or phone)', 404)
    const wallet: any = await c.env.DB.prepare(`SELECT user_id FROM wallets WHERE user_id = ?`)
      .bind(user.id).first()
    if (!wallet) return jsonError(c, 'That customer has no wallet row', 404)

    const txId = crypto.randomUUID()
    const details = JSON.stringify({
      amount,
      currency: 'TZS',
      transaction_id: txId,
      note: note || null,
      actor_username: admin.username,
    })
    if (await idempotencyAlreadyUsed(c.env.DB, admin.id, key)) {
      return jsonError(c, 'That Idempotency-Key was already used', 409)
    }
    const results = await commitBatch(c, [
      c.env.DB.prepare(`INSERT OR IGNORE INTO admin_idempotency_keys (admin_id, idempotency_key, operation) VALUES (?, ?, 'admin.wallet_credit')`)
        .bind(admin.id, key),
      c.env.DB.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND changes() = 1`)
        .bind(amount, user.id),
      c.env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) SELECT ?, ?, 'ADMIN_CREDIT', ?, 'success', ? WHERE changes() = 1`)
        .bind(txId, user.id, amount, `admin-credit:${key}`),
      c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, actor_admin_id, event_type, target_id, details_json) SELECT ?, ?, 'admin.wallet_credit', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`)
        .bind(user.id, admin.id, txId, details),
    ], 'That Idempotency-Key was already used')
    if (notRows(results)) return results
    if (results[0].meta.changes !== 1) return jsonError(c, 'That Idempotency-Key was already used', 409)
    if (results[3].meta.changes !== 1) return c.json({ ok: false, error: 'Credit could not be posted' }, 500)

    const after: any = await c.env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(user.id).first()
    return c.json({
      ok: true,
      credit: { user_id: user.id, amount, currency: 'TZS', transaction_id: txId, balance: Number(after?.balance || 0) },
    }, 201)
  })

  app.post('/api/admin/wallet/debit', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const key = idempotency(c)
    if (!IDEMPOTENT_KEY.test(key)) return badRequest(c, 'Idempotency-Key header required')
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const handle = text(input.user, 100)
    const amount = input.amount
    const note = text(input.note, 200)
    if (!handle || !money(amount)) return badRequest(c, 'user and an integer TZS amount are required')

    const user = await resolveUser(c.env.DB, handle)
    if (!user) return jsonError(c, 'No such customer (id, @username or phone)', 404)
    const before: any = await c.env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(user.id).first()
    // Checked up front so a short wallet is a clear 400 rather than a rolled-back batch.
    if (!before) return jsonError(c, 'That customer has no wallet row', 404)
    if (Number(before.balance) < amount) {
      return badRequest(c, `Wallet only holds ${before.balance} TZS`)
    }
    if (await idempotencyAlreadyUsed(c.env.DB, admin.id, key)) {
      return jsonError(c, 'That Idempotency-Key was already used', 409)
    }

    const txId = crypto.randomUUID()
    const details = JSON.stringify({
      amount,
      currency: 'TZS',
      transaction_id: txId,
      note: note || null,
      balance_before: Number(before.balance),
      actor_username: admin.username,
    })
    const results = await commitBatch(c, [
      c.env.DB.prepare(`INSERT OR IGNORE INTO admin_idempotency_keys (admin_id, idempotency_key, operation) VALUES (?, ?, 'admin.wallet_debit')`)
        .bind(admin.id, key),
      c.env.DB.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ? AND changes() = 1`)
        .bind(amount, user.id, amount),
      c.env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) SELECT ?, ?, 'ADMIN_DEBIT', ?, 'success', ? WHERE changes() = 1`)
        .bind(txId, user.id, amount, `admin-debit:${key}`),
      c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, actor_admin_id, event_type, target_id, details_json) SELECT ?, ?, 'admin.wallet_debit', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`)
        .bind(user.id, admin.id, txId, details),
    ], 'That Idempotency-Key was already used, or the wallet changed under us')
    if (notRows(results)) return results
    if (results[0].meta.changes !== 1) return jsonError(c, 'That Idempotency-Key was already used', 409)
    if (results[3].meta.changes !== 1) return c.json({ ok: false, error: 'Debit could not be posted' }, 500)

    const after: any = await c.env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(user.id).first()
    return c.json({
      ok: true,
      debit: { user_id: user.id, amount, currency: 'TZS', transaction_id: txId, balance: Number(after?.balance || 0) },
    }, 201)
  })

  // ============ CUSTOMER ACCOUNT STATE ============

  app.post('/api/admin/users/:id/status', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const active = input.active === true || input.active === 1 ? 1 : input.active === false || input.active === 0 ? 0 : null
    if (active === null) return badRequest(c, 'active must be true or false')
    const reason = text(input.reason, 200) || 'no reason given'

    const user = await resolveUser(c.env.DB, c.req.param('id'))
    if (!user) return jsonError(c, 'No such customer', 404)
    if (user.id === admin.id) return badRequest(c, 'Staff accounts are managed under Staff, not customers')

    const updated = await c.env.DB.prepare(
      `UPDATE users SET active = ?, suspended_at = CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE id = ? AND active != ?`,
    ).bind(active, active, user.id, active).run()

    // A suspended customer loses every live portal session in the same action.
    let revokedLogins = 0
    if (!active) {
      const revoked = await c.env.DB.prepare(
        `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL`,
      ).bind(user.id).run()
      revokedLogins = Number(revoked.meta.changes || 0)
    }

    await writeAdminAudit(c.env, admin, active ? 'admin.user_reinstated' : 'admin.user_suspended', user.id, {
      phone_number: user.phone_number,
      username: user.username,
      reason,
      revoked_logins: revokedLogins,
    }, user.id)

    if (updated.meta.changes !== 1 && active) return jsonError(c, 'Customer already in that state', 409)
    return c.json({ ok: true, user_id: user.id, active: Boolean(active), revoked_logins: revokedLogins })
  })

  app.post('/api/admin/users/:id/password', adminWrite('super_admin'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const user = await resolveUser(c.env.DB, c.req.param('id'))
    if (!user) return jsonError(c, 'No such customer', 404)
    const password = typeof input.password === 'string' ? input.password : ''
    if (password.length < 12) return badRequest(c, 'Customer passwords need at least 12 characters')
    const forceSignOut = input.force_signout === undefined ? true : Boolean(input.force_signout)

    const changed = await c.env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
      .bind(await hashAdminPassword(password), user.id).run()
    let revokedLogins = 0
    if (forceSignOut) {
      const revoked = await c.env.DB.prepare(
        `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL`,
      ).bind(user.id).run()
      revokedLogins = Number(revoked.meta.changes || 0)
    }
    await writeAdminAudit(c.env, admin, 'admin.user_password_reset', user.id, {
      phone_number: user.phone_number,
      username: user.username,
      revoked_logins: revokedLogins,
    }, user.id)

    if (changed.meta.changes !== 1) return c.json({ ok: false, error: 'Password reset failed' }, 500)
    return c.json({ ok: true, user_id: user.id, revoked_logins: revokedLogins })
  })

  // ============ HOTSPOT ACCESS ============

  app.post('/api/admin/sessions/:id/revoke', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const id = c.req.param('id')
    if (!id || id.length > 100) return jsonError(c, 'Invalid session ID')
    const revoked = await c.env.DB.prepare(
      `UPDATE access_sessions SET status = 'revoked' WHERE id = ? AND status = 'active'`,
    ).bind(id).run()
    if (revoked.meta.changes !== 1) return jsonError(c, 'Active session not found', 404)

    const session: any = await c.env.DB.prepare(
      `SELECT s.user_id, s.mac_address, u.phone_number FROM access_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    ).bind(id).first()
    await writeAdminAudit(c.env, admin, 'admin.session_revoked', id, {
      user_id: session?.user_id ?? null,
      phone_number: session?.phone_number ?? null,
      mac_address: session?.mac_address ?? null,
    }, session?.user_id ?? null)
    return c.json({ ok: true, id })
  })

  app.post('/api/admin/passes/issue', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const key = idempotency(c)
    if (!IDEMPOTENT_KEY.test(key)) return badRequest(c, 'Idempotency-Key header required')
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const handle = text(input.user, 100)
    const packageId = text(input.package_id, 100)
    const mac = text(input.mac_address, 40).toUpperCase().replace(/[^0-9A-F:]/g, '')
    const chargeWallet = Boolean(input.charge_wallet)
    if (!handle || !packageId) return badRequest(c, 'user and package_id are required')

    const user = await resolveUser(c.env.DB, handle)
    if (!user) return jsonError(c, 'No such customer', 404)
    const pkg: any = await c.env.DB.prepare(
      `SELECT id, name, duration_hours, price FROM packages WHERE id = ? AND active = 1`,
    ).bind(packageId).first()
    if (!pkg) return jsonError(c, 'Tier not found or archived', 404)
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return badRequest(c, 'mac_address must look like AA:BB:CC:DD:EE:FF')

    const wallet: any = await c.env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(user.id).first()
    if (chargeWallet && (!wallet || Number(wallet.balance) < Number(pkg.price))) {
      return badRequest(c, `Wallet only holds ${wallet ? wallet.balance : 0} TZS`)
    }

    const sessionId = crypto.randomUUID()
    const txId = crypto.randomUUID()
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
    const expiresAt = new Date(Date.now() + Number(pkg.duration_hours) * 3_600_000).toISOString()
    const details = JSON.stringify({
      package_id: pkg.id,
      duration_hours: pkg.duration_hours,
      charged: chargeWallet ? Number(pkg.price) : 0,
      transaction_id: chargeWallet ? txId : null,
      session_id: sessionId,
      mac_address: mac,
      actor_username: admin.username,
    })

    const steps = [
      c.env.DB.prepare(`INSERT OR IGNORE INTO admin_idempotency_keys (admin_id, idempotency_key, operation) VALUES (?, ?, 'admin.pass_issue')`)
        .bind(admin.id, key),
      chargeWallet
        ? c.env.DB.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ? AND changes() = 1`)
            .bind(Number(pkg.price), user.id, Number(pkg.price))
        : c.env.DB.prepare(`UPDATE wallets SET updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND changes() = 1`).bind(user.id),
    ]
    if (chargeWallet) {
      steps.push(
        c.env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) SELECT ?, ?, 'SPEND_TIME_PASS', ?, 'success', ? WHERE changes() = 1`)
          .bind(txId, user.id, Number(pkg.price), `staff-pass:${key}`),
      )
    }
    steps.push(
      c.env.DB.prepare(
        `INSERT INTO access_sessions (id, user_id, mac_address, token, duration_hours, expires_at, status)
         SELECT ?, ?, ?, ?, ?, ?, 'active' WHERE changes() = 1`,
      ).bind(sessionId, user.id, mac, token, Number(pkg.duration_hours), expiresAt),
      c.env.DB.prepare(
        `INSERT INTO audit_outbox (actor_user_id, actor_admin_id, event_type, target_id, details_json)
         SELECT ?, ?, 'admin.pass_issued', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`,
      ).bind(user.id, admin.id, sessionId, details),
    )

    if (await idempotencyAlreadyUsed(c.env.DB, admin.id, key)) {
      return jsonError(c, 'That Idempotency-Key was already used', 409)
    }
    const results = await commitBatch(c, steps, 'That Idempotency-Key was already used, or the wallet changed under us')
    if (notRows(results)) return results
    if (results[0].meta.changes !== 1) return jsonError(c, 'That Idempotency-Key was already used', 409)
    const last = results[results.length - 1]
    if (last.meta.changes !== 1) return c.json({ ok: false, error: 'Pass could not be issued' }, 500)

    return c.json({
      ok: true,
      session: { id: sessionId, radius_token: token, expires_at: expiresAt, mac_address: mac },
      charged: chargeWallet ? Number(pkg.price) : 0,
      currency: 'TZS',
    }, 201)
  })

  // ============ TIERS THAT THE PORTAL SELLS ============

  app.post('/api/admin/tiers', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const input = await body(c, 4096)
    if (!input) return badRequest(c, 'Invalid body')
    const name = text(input.name, 100)
    const duration = input.duration_hours
    const price = input.price
    if (!name) return badRequest(c, 'Tier name is required')
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 8760) return badRequest(c, 'duration_hours must be 1..8760')
    if (!money(price)) return badRequest(c, 'price must be a whole TZS number')

    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tier'}-${crypto.randomUUID().slice(0, 8)}`
    await c.env.DB.prepare(
      `INSERT INTO packages (id, name, duration_hours, price, bandwidth_limit_mb, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(id, name, duration, price).run()
    await writeAdminAudit(c.env, admin, 'admin.tier_created', id, {
      name,
      duration_hours: duration,
      price,
      currency: 'TZS',
    })
    const tier = await c.env.DB.prepare(
      `SELECT id, name, duration_hours, price, bandwidth_limit_mb, active, created_at, updated_at FROM packages WHERE id = ?`,
    ).bind(id).first()
    return c.json({ ok: true, tier }, 201)
  })

  app.patch('/api/admin/tiers/:id', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const id = c.req.param('id')
    if (!id || id.length > 100) return jsonError(c, 'Invalid tier ID')
    const input = await body(c, 4096)
    if (!input) return badRequest(c, 'Invalid body')

    const existing: any = await c.env.DB.prepare(
      `SELECT id, name, duration_hours, price, active FROM packages WHERE id = ?`,
    ).bind(id).first()
    if (!existing) return jsonError(c, 'Tier not found', 404)

    const name = input.name !== undefined ? text(input.name, 100) : existing.name
    const duration = input.duration_hours !== undefined ? input.duration_hours : existing.duration_hours
    const price = input.price !== undefined ? input.price : existing.price
    const active = input.active !== undefined ? (input.active ? 1 : 0) : existing.active

    if (!name) return badRequest(c, 'Tier name is required')
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 8760) return badRequest(c, 'duration_hours must be 1..8760')
    if (!money(price)) return badRequest(c, 'price must be a whole TZS number')

    await c.env.DB.prepare(
      `UPDATE packages SET name = ?, duration_hours = ?, price = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(name, duration, price, active, id).run()
    await writeAdminAudit(c.env, admin, 'admin.tier_updated', id, {
      before: { name: existing.name, duration_hours: existing.duration_hours, price: existing.price, active: existing.active },
      after: { name, duration_hours: duration, price, active },
    })
    const tier = await c.env.DB.prepare(
      `SELECT id, name, duration_hours, price, bandwidth_limit_mb, active, created_at, updated_at FROM packages WHERE id = ?`,
    ).bind(id).first()
    return c.json({ ok: true, tier })
  })

  app.delete('/api/admin/tiers/:id', adminWrite('super_admin'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const id = c.req.param('id')
    if (!id || id.length > 100) return jsonError(c, 'Invalid tier ID')
    // Soft archive: sold passes and old orders keep pointing at this row.
    const archived = await c.env.DB.prepare(
      `UPDATE packages SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1`,
    ).bind(id).run()
    if (archived.meta.changes !== 1) return jsonError(c, 'Active tier not found', 404)
    await writeAdminAudit(c.env, admin, 'admin.tier_archived', id, { actor_username: admin.username })
    return c.json({ ok: true, id, active: false })
  })

  // ============ PAYMENT ORDERS TAKEN BY HAND ============

  app.post('/api/admin/orders/:merchantId/settle', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const key = idempotency(c)
    if (!IDEMPOTENT_KEY.test(key)) return badRequest(c, 'Idempotency-Key header required')
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const merchantId = c.req.param('merchantId')
    if (!merchantId || merchantId.length > 100) return jsonError(c, 'Invalid order')
    const reference = text(input.reference, 120) || `staff:${admin.username}`
    const creditWallet = input.credit_wallet === undefined ? true : Boolean(input.credit_wallet)

    const order: any = await c.env.DB.prepare(
      `SELECT merchant_id, user_id, package_id, package_name, expected_amount, status FROM payment_orders WHERE merchant_id = ?`,
    ).bind(merchantId).first()
    if (!order) return jsonError(c, 'Order not found', 404)
    if (order.status !== 'pending') return jsonError(c, `Order is already ${order.status}`, 409)

    const txId = crypto.randomUUID()
    const details = JSON.stringify({
      order_amount: Number(order.expected_amount),
      credited: creditWallet ? Number(order.expected_amount) : 0,
      transaction_id: creditWallet ? txId : null,
      reference,
      provider_state: 'paid_by_staff',
      actor_username: admin.username,
    })
    const steps = [
      c.env.DB.prepare(`INSERT OR IGNORE INTO admin_idempotency_keys (admin_id, idempotency_key, operation) VALUES (?, ?, 'admin.order_settle')`)
        .bind(admin.id, key),
      c.env.DB.prepare(
        `UPDATE payment_orders SET status = 'paid', provider_state = 'paid_by_staff', provider_reference = ?, updated_at = CURRENT_TIMESTAMP
         WHERE merchant_id = ? AND status = 'pending' AND changes() = 1`,
      ).bind(reference, merchantId),
    ]
    if (creditWallet) {
      steps.push(
        c.env.DB.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND changes() = 1`)
          .bind(Number(order.expected_amount), order.user_id),
        c.env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) SELECT ?, ?, 'DEPOSIT_MANUAL', ?, 'success', ? WHERE changes() = 1`)
          .bind(txId, order.user_id, Number(order.expected_amount), `settle:${merchantId}`),
      )
    }
    steps.push(
      c.env.DB.prepare(
        `INSERT INTO audit_outbox (actor_user_id, actor_admin_id, event_type, target_id, details_json)
         SELECT ?, ?, 'admin.order_settled', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`,
      ).bind(order.user_id, admin.id, merchantId, details),
    )

    if (await idempotencyAlreadyUsed(c.env.DB, admin.id, key)) {
      return jsonError(c, 'That Idempotency-Key was already used', 409)
    }
    const results = await commitBatch(c, steps, 'That Idempotency-Key was already used, or the order was settled by someone else')
    if (notRows(results)) return results
    if (results[0].meta.changes !== 1) return jsonError(c, 'That Idempotency-Key was already used', 409)
    if (results[results.length - 1].meta.changes !== 1) return c.json({ ok: false, error: 'Settlement failed' }, 500)

    return c.json({ ok: true, order_id: merchantId, status: 'paid', credited: creditWallet ? Number(order.expected_amount) : 0 }, 201)
  })

  // ============ MARKETPLACE MODERATION ============

  app.post('/api/admin/marketplace/items/:id/takedown', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const id = c.req.param('id')
    if (!id || id.length > 100) return jsonError(c, 'Invalid listing ID')
    const input = await body(c)
    const reason = input ? text(input.reason, 200) || 'policy breach' : 'policy breach'

    const item: any = await c.env.DB.prepare(
      `SELECT id, seller_id, title, status FROM marketplace_items WHERE id = ?`,
    ).bind(id).first()
    if (!item) return jsonError(c, 'Listing not found', 404)
    // Sold and cancelled rows are already frozen by database triggers.
    if (item.status !== 'active' && item.status !== 'draft') {
      return badRequest(c, `Listing is already ${item.status}`)
    }
    const taken = await c.env.DB.prepare(
      `UPDATE marketplace_items SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`,
    ).bind(id, item.status).run()
    if (taken.meta.changes !== 1) return c.json({ ok: false, error: 'Takedown failed' }, 500)

    await writeAdminAudit(c.env, admin, 'admin.listing_removed', id, {
      title: item.title,
      seller_id: item.seller_id,
      reason,
      from_status: item.status,
    }, item.seller_id)
    return c.json({ ok: true, id, status: 'cancelled', reason })
  })

  app.post('/api/admin/marketplace/quotes/:id/expire', adminWrite('operator'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const id = c.req.param('id')
    if (!id || id.length > 100) return jsonError(c, 'Invalid quote ID')
    const input = await body(c)
    const reason = input ? text(input.reason, 200) || 'closed by staff' : 'closed by staff'

    const quote: any = await c.env.DB.prepare(
      `SELECT id, item_id, buyer_id, seller_id, status FROM marketplace_quotes WHERE id = ?`,
    ).bind(id).first()
    if (!quote) return jsonError(c, 'Quotation not found', 404)
    if (quote.status !== 'pending' && quote.status !== 'accepted') {
      return badRequest(c, `Quotation is already ${quote.status}`)
    }
    const expired = await c.env.DB.prepare(
      `UPDATE marketplace_quotes SET status = 'expired', responded_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`,
    ).bind(id, quote.status).run()
    if (expired.meta.changes !== 1) return c.json({ ok: false, error: 'Could not close the quotation' }, 500)

    await writeAdminAudit(c.env, admin, 'admin.quote_expired', id, {
      item_id: quote.item_id,
      buyer_id: quote.buyer_id,
      seller_id: quote.seller_id,
      reason,
    }, quote.buyer_id)
    return c.json({ ok: true, id, status: 'expired', reason })
  })

  // ============ STAFF ACCOUNTS ============

  app.post('/api/admin/staff', adminWrite('super_admin'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const username = text(input.username, 30).toLowerCase().replace(/^@/, '')
    const fullName = text(input.full_name, 80)
    const email = text(input.email, 120).toLowerCase() || null
    const role = text(input.role, 20) as AdminRole
    const password = typeof input.password === 'string' ? input.password : ''
    if (!STAFF_USERNAME.test(username)) return badRequest(c, 'Staff username: 1-30 letters, digits or underscore')
    if (!['super_admin', 'operator', 'viewer'].includes(role)) return badRequest(c, 'role must be super_admin, operator or viewer')
    const problem = passwordProblem(password, username)
    if (problem) return badRequest(c, problem)

    const clash = await c.env.DB.prepare(`SELECT id FROM admin_users WHERE lower(username) = ?`).bind(username).first()
    if (clash) return jsonError(c, 'That staff username is taken', 409)

    const id = crypto.randomUUID()
    await c.env.DB.prepare(
      `INSERT INTO admin_users (id, username, email, full_name, password_hash, role, active, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    ).bind(id, username, email, fullName || null, await hashAdminPassword(password), role).run()
    await writeAdminAudit(c.env, admin, 'admin.staff_created', id, {
      username,
      role,
      email,
      full_name: fullName || null,
    })
    return c.json({ ok: true, staff: { id, username, role, email, active: 1 } }, 201)
  })

  app.post('/api/admin/staff/:id/password', adminWrite('super_admin'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const target = await c.env.DB.prepare(`SELECT id, username, role FROM admin_users WHERE id = ?`)
      .bind(c.req.param('id')).first<any>()
    if (!target) return jsonError(c, 'Staff account not found', 404)
    const password = typeof input.password === 'string' ? input.password : ''
    const problem = passwordProblem(password, target.username)
    if (problem) return badRequest(c, problem)

    await c.env.DB.prepare(
      `UPDATE admin_users SET password_hash = ?, must_change_password = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(await hashAdminPassword(password), target.id).run()
    // The colleague has to change a password they did not choose themselves.
    const revoked = await c.env.DB.prepare(
      `UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_id = ? AND revoked_at IS NULL`,
    ).bind(target.id).run()
    await writeAdminAudit(c.env, admin, 'admin.staff_password_reset', target.id, {
      username: target.username,
      revoked_sessions: Number(revoked.meta.changes || 0),
      must_change_password: true,
    })
    return c.json({ ok: true, id: target.id, revoked_sessions: Number(revoked.meta.changes || 0) })
  })

  app.post('/api/admin/staff/:id/status', adminWrite('super_admin'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const active = input.active === true || input.active === 1 ? 1 : 0
    const targetId = c.req.param('id')
    if (targetId === admin.id && !active) return badRequest(c, 'You cannot lock yourself out of your own account')
    const target: any = await c.env.DB.prepare(`SELECT id, username, role, active FROM admin_users WHERE id = ?`)
      .bind(targetId).first()
    if (!target) return jsonError(c, 'Staff account not found', 404)

    if (!active && target.role === 'super_admin') {
      const others = await c.env.DB.prepare(
        `SELECT COUNT(*) n FROM admin_users WHERE role = 'super_admin' AND active = 1 AND id != ?`,
      ).bind(target.id).first<{ n: number }>()
      if (!Number(others?.n || 0)) return badRequest(c, 'Refusing to leave the network without a super admin')
    }

    await c.env.DB.prepare(
      `UPDATE admin_users SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(active, target.id).run()
    let revoked = 0
    if (!active) {
      const result = await c.env.DB.prepare(
        `UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_id = ? AND revoked_at IS NULL`,
      ).bind(target.id).run()
      revoked = Number(result.meta.changes || 0)
    }
    await writeAdminAudit(c.env, admin, active ? 'admin.staff_reinstated' : 'admin.staff_disabled', target.id, {
      username: target.username,
      role: target.role,
      revoked_sessions: revoked,
    })
    return c.json({ ok: true, id: target.id, active: Boolean(active), revoked_sessions: revoked })
  })

  // ============ MY OWN CREDENTIALS (any signed-in staff) ============

  app.post('/api/admin/settings/password', adminWrite('viewer'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const current = typeof input.current_password === 'string' ? input.current_password : ''
    const next = typeof input.new_password === 'string' ? input.new_password : ''
    const problem = passwordProblem(next, admin.username)
    if (problem) return badRequest(c, problem)
    if (next === current) return badRequest(c, 'Choose a different password')

    const row: any = await c.env.DB.prepare(`SELECT id, password_hash FROM admin_users WHERE id = ? AND active = 1`)
      .bind(admin.id).first()
    if (!row || (await verifyStoredAdminPassword(current, row.password_hash)) === 'invalid') {
      await writeAdminAudit(c.env, admin, 'admin.password_change_failed', admin.id, { reason: 'current_password_wrong' })
      return jsonError(c, 'Current password is wrong', 401)
    }

    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE admin_users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).bind(await hashAdminPassword(next), admin.id),
      // Other machines lose their sessions; this tab keeps its own cookie.
      c.env.DB.prepare(
        `UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_id = ? AND revoked_at IS NULL`,
      ).bind(admin.id),
    ])
    await writeAdminAudit(c.env, admin, 'admin.password_changed', admin.id, { username: admin.username })
    return c.json({ ok: true, rotated: true, note: 'Other staff sessions for this account were signed out.' })
  })

  app.post('/api/admin/settings/username', adminWrite('viewer'), async (c) => {
    const admin = (c as any).get('admin') as Admin
    const input = await body(c)
    if (!input) return badRequest(c, 'Invalid body')
    const username = text(input.username, 30).toLowerCase().replace(/^@/, '')
    const password = typeof input.password === 'string' ? input.password : ''
    if (!STAFF_USERNAME.test(username)) return badRequest(c, 'Username: 1-30 letters, digits or underscore')

    const row: any = await c.env.DB.prepare(`SELECT id, password_hash FROM admin_users WHERE id = ? AND active = 1`)
      .bind(admin.id).first()
    if (!row || (await verifyStoredAdminPassword(password, row.password_hash)) === 'invalid') {
      return jsonError(c, 'Password is wrong', 401)
    }
    const clash = await c.env.DB.prepare(`SELECT id FROM admin_users WHERE lower(username) = ? AND id != ?`)
      .bind(username, admin.id).first()
    if (clash) return jsonError(c, 'That staff username is taken', 409)

    await c.env.DB.prepare(
      `UPDATE admin_users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(username, admin.id).run()
    await writeAdminAudit(c.env, admin, 'admin.username_changed', admin.id, { from: admin.username, to: username })
    return c.json({ ok: true, username })
  })
}
