import type { Hono } from 'hono'
import type { Bindings } from '../env'
import { normalizeMac, configuredSecret } from '../lib/helpers'
import { normalizeTzPhone, isValidE164, requireSharedSecret } from '../lib/phone'
import { verifyAzampayWebhook } from '../lib/azampay'
import { hotspotMacLogin } from '../lib/mikrotik'
import { authenticatedUser, mutationOriginAllowed, readLimitedJson, jsonError } from './auth'

function randomId(): string { return crypto.randomUUID() }
function validMoneyAmount(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2_000_000_000 }
function randomRadiusToken(): string { const bytes = crypto.getRandomValues(new Uint8Array(24)); return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase() }
function idempotencyOk(key: string): boolean { return /^[A-Za-z0-9._:-]{8,128}$/.test(key) }

export function registerPaymentRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.get('/api/packages', async (c) => {
    // Archived tiers stay in the database for old orders but leave the shop window.
    const { results } = await c.env.DB.prepare(`SELECT id, name, duration_hours, price FROM packages WHERE active = 1 ORDER BY price ASC`).all()
    const packages = (results || []).filter((pkg: any) => Number.isSafeInteger(pkg.price) && pkg.price > 0 && Number.isSafeInteger(pkg.duration_hours) && pkg.duration_hours > 0)
    return c.json({ currency: 'TZS', packages })
  })

  app.post('/api/radius/authorize', async (c) => {
    const provided = c.req.header('X-RADIUS-Secret')
    const check = await requireSharedSecret(provided, c.env.RADIUS_SHARED_SECRET)
    if (check === 'unconfigured') return c.json({ control: { 'Auth-Type': 'Reject' }, reply: { 'Reply-Message': 'RADIUS unavailable' } }, 503)
    if (check === 'unauthorized') return c.json({ control: { 'Auth-Type': 'Reject' }, reply: { 'Reply-Message': 'Unauthorized' } }, 401)
    try {
      const body: any = await readLimitedJson(c, 4096)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ control: { 'Auth-Type': 'Reject' }, reply: { 'Reply-Message': 'Invalid' } }, 400)
      const tokenRaw = (body['User-Name'] || body.username || body.token || '').toString().trim()
      const macInput = (body['Calling-Station-Id'] || body.mac || '').toString().trim()
      const token = tokenRaw.length <= 128 ? tokenRaw : ''
      const macAddress = macInput ? normalizeMac(macInput) : null
      if (!token || !macAddress) return c.json({ control: { 'Auth-Type': 'Reject' }, reply: { 'Reply-Message': 'Token & MAC required' } }, 400)
      const session: any = await c.env.DB.prepare(`SELECT id, mac_address, expires_at FROM access_sessions WHERE token = ? AND status = 'active' AND datetime(expires_at) > datetime('now') ORDER BY created_at DESC LIMIT 1`).bind(token.toUpperCase()).first()
      if (!session) return c.json({ control: { 'Auth-Type': 'Reject' }, reply: { 'Reply-Message': 'Invalid session' } }, 403)
      if (normalizeMac(String(session.mac_address)) !== macAddress) return c.json({ control: { 'Auth-Type': 'Reject' }, reply: { 'Reply-Message': 'Wrong device' } }, 403)
      const expiresAt = new Date(session.expires_at).getTime()
      const sessionTimeout = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))
      return c.json({ control: { 'Auth-Type': 'Accept' }, reply: { 'Reply-Message': 'Success', 'Session-Timeout': sessionTimeout, 'Idle-Timeout': 600, 'Acct-Interim-Interval': 300 } })
    } catch { return c.json({ control: { 'Auth-Type': 'Reject' }, reply: { 'Reply-Message': 'RADIUS failed' } }, 500) }
  })

  app.post('/api/payments/orders', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const idempotencyKey = c.req.header('Idempotency-Key') || ''
    if (!idempotencyOk(idempotencyKey)) return jsonError(c, 'Idempotency-Key required')
    try {
      const body: any = await readLimitedJson(c, 4096)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(c, 'Invalid body')
      const packageId = typeof body.package_id === 'string' ? body.package_id.trim() : ''
      const phoneInput = typeof body.phone_number === 'string' ? body.phone_number.trim() : ''
      const phone = normalizeTzPhone(phoneInput) || (isValidE164(phoneInput) ? phoneInput : null)
      const macInput = body.mac_address == null ? '' : typeof body.mac_address === 'string' ? body.mac_address.trim() : '!invalid!'
      const macAddress = macInput ? normalizeMac(macInput) : null
      if (!packageId || packageId.length > 100 || !phone || (macInput && !macAddress)) return jsonError(c, 'Invalid package/phone/MAC')
      const pkg: any = await c.env.DB.prepare(`SELECT id, name, duration_hours, price FROM packages WHERE id = ? AND active = 1`).bind(packageId).first()
      if (!pkg || !validMoneyAmount(pkg.price) || !Number.isSafeInteger(pkg.duration_hours) || pkg.duration_hours < 1 || pkg.duration_hours > 8760) return jsonError(c, 'Package unavailable', 404)
      const merchantId = randomId()
      const auditDetails = JSON.stringify({ package_id: pkg.id, expected_amount: pkg.price, currency: 'TZS' })
      const results = await c.env.DB.batch([
        c.env.DB.prepare(`INSERT OR IGNORE INTO idempotency_keys (user_id, idempotency_key, operation) VALUES (?, ?, 'payment_order')`).bind(user.id, idempotencyKey),
        c.env.DB.prepare(`INSERT INTO payment_orders (merchant_id, user_id, package_id, package_name, duration_hours, phone_number, mac_address, expected_amount, currency, status, provider_state, idempotency_key) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'TZS', 'pending', 'unconfigured', ? WHERE changes() = 1`).bind(merchantId, user.id, pkg.id, pkg.name, pkg.duration_hours, phone, macAddress, pkg.price, idempotencyKey),
        c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) SELECT ?, 'payment.order_created', ?, ? WHERE changes() = 1`).bind(user.id, merchantId, auditDetails)
      ])
      if (results[0].meta.changes !== 1) return jsonError(c, 'Idempotency key used', 409)
      if (results[1].meta.changes !== 1) return jsonError(c, 'Order failed', 500)
      return c.json({ order: { merchant_id: merchantId, package_id: pkg.id, expected_amount: pkg.price, currency: 'TZS', status: 'pending', provider_state: 'unconfigured' }, payment: { provider: 'AzamPay', status: 'pending', configured: false, confirmation_required: true } }, 201)
    } catch { return c.json({ error: 'Order failed' }, 500) }
  })

  app.get('/api/payments/orders/:merchantId', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const merchantId = c.req.param('merchantId')
    if (merchantId.length > 100) return jsonError(c, 'Invalid ID')
    const order = await c.env.DB.prepare(`SELECT merchant_id, package_id, package_name, duration_hours, expected_amount, currency, status, provider_reference, provider_state, created_at, updated_at FROM payment_orders WHERE merchant_id = ? AND user_id = ?`).bind(merchantId, user.id).first()
    if (!order) return jsonError(c, 'Not found', 404)
    return c.json({ order, payment: { provider: 'AzamPay', configured: false, confirmation_required: true } })
  })

  app.post('/api/session/buy', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const idempotencyKey = c.req.header('Idempotency-Key') || ''
    if (!idempotencyOk(idempotencyKey)) return jsonError(c, 'Idempotency-Key required')
    try {
      const body: any = await readLimitedJson(c, 8192)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(c, 'Invalid body')
      const packageId = typeof body.package_id === 'string' ? body.package_id : ''
      const macInput = typeof body.mac_address === 'string' ? body.mac_address.trim() : ''
      const macAddress = normalizeMac(macInput)
      if (!packageId || packageId.length > 100 || !macAddress) return jsonError(c, 'Invalid package/MAC')
      const pkg: any = await c.env.DB.prepare(`SELECT id, price, duration_hours FROM packages WHERE id = ? AND active = 1`).bind(packageId).first()
      if (!pkg || !validMoneyAmount(pkg.price) || !Number.isSafeInteger(pkg.duration_hours) || pkg.duration_hours < 1 || pkg.duration_hours > 8760) return jsonError(c, 'Package unavailable', 404)
      // Checked before the batch: the poisoned audit row would otherwise surface as a 500.
      const buyerWallet: any = await c.env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(user.id).first()
      if (!buyerWallet || Number(buyerWallet.balance) < pkg.price) return jsonError(c, 'Insufficient balance', 400)
      const radiusToken = randomRadiusToken()
      const sessionId = randomId()
      const transactionId = randomId()
      const expiresAt = new Date(Date.now() + pkg.duration_hours * 3_600_000).toISOString()
      const results = await c.env.DB.batch([
        c.env.DB.prepare(`INSERT OR IGNORE INTO idempotency_keys (user_id, idempotency_key, operation) VALUES (?, ?, 'session_buy')`).bind(user.id, idempotencyKey),
        c.env.DB.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ? AND changes() = 1`).bind(pkg.price, user.id, pkg.price),
        c.env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) SELECT ?, ?, 'SPEND_TIME_PASS', ?, 'success', ? WHERE changes() = 1`).bind(transactionId, user.id, pkg.price, `Pass:${packageId}:${idempotencyKey}`),
        c.env.DB.prepare(`INSERT INTO access_sessions (id, user_id, mac_address, token, duration_hours, expires_at, status) SELECT ?, ?, ?, ?, ?, ?, 'active' WHERE changes() = 1`).bind(sessionId, user.id, macAddress, radiusToken, pkg.duration_hours, expiresAt),
        c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (?, 'wallet.session_purchased', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END)`).bind(user.id, sessionId, JSON.stringify({ package_id: packageId, transaction_id: transactionId, amount: pkg.price, currency: 'TZS' }))
      ])
      if (results[0].meta.changes !== 1) return jsonError(c, 'Idempotency key used', 409)
      if (results[1].meta.changes !== 1) return jsonError(c, 'Insufficient balance', 400)
      return c.json({ success: true, session: { id: sessionId, radius_token: radiusToken, expires_at: expiresAt }, charged: { amount: pkg.price, currency: 'TZS' }, router_access: 'radius_pull' }, 201)
    } catch { return jsonError(c, 'Purchase failed', 500) }
  })

  app.post('/api/transfer', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const sender = await authenticatedUser(c)
    if (!sender) return jsonError(c, 'Auth required', 401)
    const idempotencyKey = c.req.header('Idempotency-Key') || ''
    if (!idempotencyOk(idempotencyKey)) return jsonError(c, 'Idempotency-Key required')
    try {
      const body: any = await readLimitedJson(c, 8192)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(c, 'Invalid body')
      const rawRecipient = typeof body.recipient_id === 'string' ? body.recipient_id.trim() : ''
      const amount = body.amount
      if (!rawRecipient || rawRecipient.length > 100 || !validMoneyAmount(amount)) return jsonError(c, 'Invalid amount')
      // A payer should not need a UUID: user id, @username or phone number all work.
      const handle = rawRecipient.replace(/^@/, '').toLowerCase()
      const phone = normalizeTzPhone(rawRecipient)
      const recipient: any = await c.env.DB.prepare(
        `SELECT u.id, u.username, u.full_name FROM users u JOIN wallets w ON w.user_id = u.id
         WHERE u.id = ? OR (u.username IS NOT NULL AND lower(u.username) = ?) OR (? IS NOT NULL AND u.phone_number = ?)`,
      ).bind(rawRecipient, handle, phone, phone).first()
      if (!recipient) return jsonError(c, 'No wallet for that username, number or user id', 404)
      if (recipient.id === sender.id) return jsonError(c, 'Cannot transfer to yourself')
      const recipientId = recipient.id
      const existingKey = await c.env.DB.prepare(`SELECT 1 AS present FROM idempotency_keys WHERE user_id = ? AND idempotency_key = ?`).bind(sender.id, idempotencyKey).first()
      if (existingKey) return jsonError(c, 'Idempotency key used', 409)
      const senderWallet: any = await c.env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(sender.id).first()
      if (!senderWallet || senderWallet.balance < amount) return jsonError(c, 'Insufficient balance', 400)
      const txOut = randomId()
      const txIn = randomId()
      const results = await c.env.DB.batch([
        c.env.DB.prepare(`INSERT OR IGNORE INTO idempotency_keys (user_id, idempotency_key, operation) VALUES (?, ?, 'transfer')`).bind(sender.id, idempotencyKey),
        c.env.DB.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ? AND changes() = 1`).bind(amount, sender.id, amount),
        c.env.DB.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND changes() = 1`).bind(amount, recipientId),
        c.env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) SELECT ?, ?, 'TRANSFER_OUT', ?, 'success', ? WHERE changes() = 1`).bind(txOut, sender.id, amount, `transfer:${idempotencyKey}:out`),
        c.env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) SELECT ?, ?, 'TRANSFER_IN', ?, 'success', ? WHERE changes() = 1`).bind(txIn, recipientId, amount, `transfer:${idempotencyKey}:in`),
        c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) SELECT ?, 'wallet.transfer', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`).bind(sender.id, txOut, JSON.stringify({ recipient_user_id: recipientId, outgoing_transaction_id: txOut, incoming_transaction_id: txIn, amount, currency: 'TZS' }))
      ])
      if (results[0].meta.changes !== 1) return jsonError(c, 'Idempotency key used', 409)
      if (results[1].meta.changes !== 1) return jsonError(c, 'Insufficient balance', 400)
      if (results.slice(2).some((r: any) => r.meta.changes !== 1)) return c.json({ error: 'Transfer could not be completed' }, 500)
      return c.json({ success: true, transfer: { recipient_id: recipientId, recipient_username: recipient.username ?? null, recipient_name: recipient.full_name ?? null, amount, currency: 'TZS' } })
    } catch { return jsonError(c, 'Transfer failed', 500) }
  })

  app.get('/api/wallet/:id', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    if (c.req.param('id') !== user.id) return jsonError(c, 'Forbidden', 403)
    const wallet = await c.env.DB.prepare(`SELECT user_id, balance, updated_at FROM wallets WHERE user_id = ?`).bind(user.id).first()
    if (!wallet) return jsonError(c, 'Wallet not found', 404)
    return c.json({ wallet, currency: 'TZS' })
  })

  app.get('/api/transactions/:id', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    if (c.req.param('id') !== user.id) return jsonError(c, 'Forbidden', 403)
    const { results } = await c.env.DB.prepare(`SELECT id, type, amount, status, reference_id, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).bind(user.id).all()
    return c.json({ transactions: results || [], currency: 'TZS' })
  })

  app.post('/api/webhook/azampay', async (c) => {
    const rawBody = await c.req.text()
    const sigHeader = c.req.header('X-AzamPay-Signature') || c.req.header('X-Signature') || c.req.header('X-Azampay-Signature')
    const verified = await verifyAzampayWebhook(c.env, rawBody, sigHeader)
    if (!verified.ok) { const status = verified.reason === 'unconfigured' ? 503 : 401; return c.json({ received: false, error: verified.reason }, status) }
    const payload = verified.payload
    const order: any = await c.env.DB.prepare(`SELECT merchant_id, user_id, package_id, duration_hours, phone_number, mac_address, expected_amount, status FROM payment_orders WHERE merchant_id = ?`).bind(payload.externalId).first()
    if (!order) return c.json({ received: false, error: 'order_not_found' }, 404)
    if (order.status === 'paid') return c.json({ received: true, idempotent: true })
    if (order.status !== 'pending') return c.json({ received: false, error: 'order_not_pending' }, 409)
    if (payload.amount !== order.expected_amount) {
      await c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (NULL, 'payment.amount_mismatch', ?, ?)`).bind(order.merchant_id, JSON.stringify({ expected: order.expected_amount, received: payload.amount, msisdn: payload.msisdn })).run().catch(() => {})
      return c.json({ received: false, error: 'amount_mismatch' }, 409)
    }
    const txId = randomId()
    const sessionId = randomId()
    const radiusToken = randomRadiusToken()
    const expiresAt = new Date(Date.now() + order.duration_hours * 3_600_000).toISOString()
    try {
      const results = await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(order.expected_amount, order.user_id),
        c.env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES (?, ?, 'DEPOSIT_AZAMPAY', ?, 'success', ?)`).bind(txId, order.user_id, order.expected_amount, order.merchant_id),
        c.env.DB.prepare(`UPDATE payment_orders SET status = 'paid', provider_state = 'paid', provider_reference = ?, updated_at = CURRENT_TIMESTAMP WHERE merchant_id = ? AND status = 'pending' AND changes() = 1`).bind(payload.reference || payload.msisdn, order.merchant_id),
        c.env.DB.prepare(`INSERT INTO access_sessions (id, user_id, mac_address, token, duration_hours, expires_at, status) SELECT ?, ?, ?, ?, ?, ?, 'active' WHERE changes() = 1`).bind(sessionId, order.user_id, order.mac_address || 'UNBOUND', radiusToken, order.duration_hours, expiresAt),
        c.env.DB.prepare(`INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) SELECT ?, 'payment.webhook_credited', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`).bind(order.user_id, order.merchant_id, JSON.stringify({ amount: order.expected_amount, currency: 'TZS', msisdn: payload.msisdn, session_id: sessionId, transaction_id: txId }))
      ])
      if (results[2].meta.changes !== 1) return c.json({ received: true, idempotent: true })
      if (results.slice(3).some((r: any) => r.meta.changes !== 1)) return c.json({ received: false, error: 'fulfilment_failed' }, 500)
    } catch { return c.json({ received: false, error: 'fulfilment_failed' }, 500) }
    if (order.mac_address) {
      await hotspotMacLogin(c.env, { mac: order.mac_address, user: order.mac_address.replace(/:/g, '').toUpperCase() }).catch(() => {})
    }
    return c.json({ received: true, session: { id: sessionId, radius_token: radiusToken, expires_at: expiresAt } })
  })
}
