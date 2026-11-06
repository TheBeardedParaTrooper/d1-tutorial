import type { Bindings } from '../../env'
import { ok, fail, Result } from '../helpers'

export type PaymentOrder = {
  merchant_id: string; user_id: string; package_id: string; package_name: string
  duration_hours: number; phone_number: string; mac_address: string | null
  expected_amount: number; currency: string; status: string; provider_state: string
}

export async function createPending(
  env: Bindings,
  input: { userId: string; packageId: string; phoneNumber: string; macAddress: string | null; idempotencyKey: string },
): Promise<Result<PaymentOrder>> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) return fail('bad_key', 'Invalid Idempotency-Key')
  const pkg = await env.DB.prepare(
    `SELECT id, name, duration_hours, price FROM packages WHERE id = ? AND active = 1`,
  ).bind(input.packageId).first<{ id: string; name: string; duration_hours: number; price: number }>()
  if (!pkg) return fail('no_package', 'Package is unavailable', 404)

  const merchantId = crypto.randomUUID()
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (user_id, idempotency_key, operation) VALUES (?, ?, 'payment_order')`,
    ).bind(input.userId, input.idempotencyKey),
    env.DB.prepare(
      `INSERT INTO payment_orders
        (merchant_id, user_id, package_id, package_name, duration_hours, phone_number, mac_address,
         expected_amount, currency, status, provider_state, idempotency_key)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'TZS', 'pending', 'unconfigured', ? WHERE changes() = 1`,
    ).bind(merchantId, input.userId, pkg.id, pkg.name, pkg.duration_hours, input.phoneNumber, input.macAddress, pkg.price, input.idempotencyKey),
  ])
  if (results[0].meta.changes !== 1) return fail('idem_used', 'Idempotency key already used', 409)
  if (results[1].meta.changes !== 1) return fail('insert_failed', 'Could not create order', 500)
  return ok({
    merchant_id: merchantId, user_id: input.userId, package_id: pkg.id, package_name: pkg.name,
    duration_hours: pkg.duration_hours, phone_number: input.phoneNumber, mac_address: input.macAddress,
    expected_amount: pkg.price, currency: 'TZS', status: 'pending', provider_state: 'unconfigured',
  })
}

export async function getByMerchantId(env: Bindings, merchantId: string, userId: string) {
  return env.DB.prepare(
    `SELECT merchant_id, package_id, package_name, duration_hours,
            expected_amount, currency, status, provider_reference, provider_state, created_at, updated_at
     FROM payment_orders WHERE merchant_id = ? AND user_id = ?`,
  ).bind(merchantId, userId).first<any>()
}

export async function listForAdmin(env: Bindings, limit = 100): Promise<any[]> {
  const { results } = await env.DB.prepare(
    `SELECT o.merchant_id, o.user_id, u.username, u.phone_number, o.package_name,
            o.expected_amount, o.currency, o.status, o.provider_state, o.created_at
     FROM payment_orders o JOIN users u ON u.id = o.user_id
     ORDER BY o.created_at DESC LIMIT ?`,
  ).bind(Math.min(500, limit)).all<any>()
  return results || []
}

export async function cancel(env: Bindings, merchantId: string, adminId: string): Promise<Result<{ merchantId: string }>> {
  const r = await env.DB.prepare(
    `UPDATE payment_orders SET status = 'failed', updated_at = CURRENT_TIMESTAMP
     WHERE merchant_id = ? AND status = 'pending'`,
  ).bind(merchantId).run()
  if (!r.meta.changes || r.meta.changes !== 1) return fail('not_found', 'Pending order not found', 404)
  return ok({ merchantId })
}
