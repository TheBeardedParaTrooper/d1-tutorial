import type { Hono } from 'hono'
import type { Bindings } from '../../env'
import { configuredSecret } from '../../lib/helpers'
import { requireSharedSecret } from '../../lib/phone'
import { currentAdmin } from '../../lib/auth/admin-auth'
import { jsonError } from '../auth'

function paging(c: any, fallback: number, max: number): { limit: number; offset: number } {
  const limitText = c.req.query('limit') || String(fallback)
  const offsetText = c.req.query('offset') || '0'
  if (!/^\d+$/.test(limitText) || !/^\d+$/.test(offsetText)) return { limit: fallback, offset: 0 }
  return {
    limit: Math.min(max, Math.max(1, Number(limitText))),
    offset: Math.max(0, Number(offsetText)),
  }
}

/**
 * Reads only. Money-moving and state-changing work lives in mutations.ts, where
 * every call is origin-checked, role-checked, idempotent and audited.
 */
async function adminRead(c: any, next: () => Promise<void>): Promise<Response | void> {
  const admin = await currentAdmin(c)
  if (!admin) return c.json({ error: 'Authentication required' }, 401)
  c.set('admin', admin)
  await next()
}

export function registerAdminReadRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.get('/api/admin/overview', adminRead as any, async (c) => {
    const db = c.env.DB
    const [users, suspended, float, ledger, pendingOrders, paidOrders, listings, quotes, hotspot, staff, revenue, recent] =
      await Promise.all([
        db.prepare(`SELECT COUNT(*) n FROM users`).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) n FROM users WHERE active = 0`).first<{ n: number }>(),
        db.prepare(`SELECT COALESCE(SUM(balance), 0) total FROM wallets`).first<{ total: number }>(),
        db.prepare(`SELECT type, COUNT(*) n, COALESCE(SUM(amount), 0) total FROM transactions GROUP BY type ORDER BY total DESC`).all(),
        db.prepare(`SELECT COUNT(*) n FROM payment_orders WHERE status = 'pending'`).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) n FROM payment_orders WHERE status = 'paid'`).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) n FROM marketplace_items WHERE status = 'active'`).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) n FROM marketplace_quotes WHERE status IN ('pending','accepted')`).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) n FROM access_sessions WHERE status = 'active' AND datetime(expires_at) > datetime('now')`).first<{ n: number }>(),
        db.prepare(`SELECT COUNT(*) n FROM admin_users WHERE active = 1`).first<{ n: number }>(),
        db.prepare(
          `SELECT date(created_at) day, SUM(amount) total FROM transactions
           WHERE status = 'success' AND datetime(created_at) > datetime('now', '-7 days')
           GROUP BY date(created_at) ORDER BY day ASC`,
        ).all(),
        db.prepare(
          `SELECT a.event_id, a.actor_user_id, a.actor_admin_id, au.username AS admin_username,
                  a.event_type, a.target_id, a.details_json, a.created_at
           FROM audit_outbox a LEFT JOIN admin_users au ON au.id = a.actor_admin_id
           ORDER BY a.event_id DESC LIMIT 12`,
        ).all(),
      ])

    return c.json({
      currency: 'TZS',
      counts: {
        users: Number(users?.n || 0),
        suspended_users: Number(suspended?.n || 0),
        wallet_float: Number(float?.total || 0),
        pending_orders: Number(pendingOrders?.n || 0),
        paid_orders: Number(paidOrders?.n || 0),
        live_listings: Number(listings?.n || 0),
        open_quotes: Number(quotes?.n || 0),
        hotspot_sessions: Number(hotspot?.n || 0),
        staff: Number(staff?.n || 0),
      },
      ledger: ledger.results || [],
      revenue: (revenue.results || []).map((r: any) => ({ day: r.day, total: Number(r.total || 0) })),
      recent_events: (recent.results || []).map((e: any) => ({
        event_id: e.event_id,
        actor_user_id: e.actor_user_id,
        actor_admin_id: e.actor_admin_id,
        admin_username: e.admin_username,
        event_type: e.event_type,
        target_id: e.target_id,
        details: JSON.parse(String(e.details_json)),
        created_at: e.created_at,
      })),
    })
  })

  app.get('/api/admin/users', adminRead as any, async (c) => {
    const { limit, offset } = paging(c, 50, 200)
    const q = (c.req.query('q') || '').trim().slice(0, 60)
    const like = `%${q}%`
    const { results } = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.phone_number, u.full_name, u.active, u.created_at,
              COALESCE(w.balance, 0) AS balance,
              (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) AS tx_count,
              (SELECT COUNT(*) FROM marketplace_items m WHERE m.seller_id = u.id) AS listings_count
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       WHERE (? = '' OR u.phone_number LIKE ? OR IFNULL(u.username,'') LIKE ? OR IFNULL(u.full_name,'') LIKE ? OR u.id = ?)
       ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(q, like, like, like, q, limit, offset)
      .all()
    return c.json({ users: results || [], currency: 'TZS', limit, offset })
  })

  app.get('/api/admin/users/:id', adminRead as any, async (c) => {
    const id = c.req.param('id')
    if (!id || id.length > 100) return jsonError(c, 'Invalid user id')
    const user: any = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.phone_number, u.full_name, u.active, u.suspended_at, u.created_at,
              COALESCE(w.balance, 0) AS balance, w.updated_at AS wallet_updated_at
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = ? OR lower(IFNULL(u.username,'')) = lower(?)`,
    )
      .bind(id, id.replace(/^@/, ''))
      .first()
    if (!user) return jsonError(c, 'User not found', 404)

    const [transactions, sessions, hotspot, listings, quotes, events] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, type, amount, status, reference_id, created_at FROM transactions
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`,
      ).bind(user.id).all(),
      c.env.DB.prepare(
        `SELECT id, expires_at, revoked_at, created_at FROM auth_sessions
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
      ).bind(user.id).all(),
      c.env.DB.prepare(
        `SELECT id, mac_address, token, duration_hours, expires_at, status, created_at FROM access_sessions
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
      ).bind(user.id).all(),
      c.env.DB.prepare(
        `SELECT id, kind, title, price, status, negotiable, pay_wallet, pay_mobile_money, created_at, updated_at
         FROM marketplace_items WHERE seller_id = ? ORDER BY created_at DESC LIMIT 25`,
      ).bind(user.id).all(),
      c.env.DB.prepare(
        `SELECT q.id, q.item_id, q.buyer_id, q.seller_id, q.requested_price, q.accepted_price, q.status,
                q.message, q.created_at, i.title AS item_title
         FROM marketplace_quotes q JOIN marketplace_items i ON i.id = q.item_id
         WHERE q.buyer_id = ? OR q.seller_id = ? ORDER BY q.created_at DESC LIMIT 25`,
      ).bind(user.id, user.id).all(),
      c.env.DB.prepare(
        `SELECT a.event_id, a.actor_user_id, a.actor_admin_id, au.username AS admin_username,
                a.event_type, a.target_id, a.details_json, a.created_at
         FROM audit_outbox a LEFT JOIN admin_users au ON au.id = a.actor_admin_id
         WHERE a.actor_user_id = ? OR a.target_id = ? ORDER BY a.event_id DESC LIMIT 25`,
      ).bind(user.id, user.id).all(),
    ])

    return c.json({
      user,
      currency: 'TZS',
      transactions: transactions.results || [],
      auth_sessions: sessions.results || [],
      access_sessions: hotspot.results || [],
      listings: listings.results || [],
      quotes: quotes.results || [],
      events: (events.results || []).map((e: any) => ({
        event_id: e.event_id,
        actor_user_id: e.actor_user_id,
        actor_admin_id: e.actor_admin_id,
        admin_username: e.admin_username,
        event_type: e.event_type,
        target_id: e.target_id,
        details: JSON.parse(String(e.details_json)),
        created_at: e.created_at,
      })),
    })
  })

  app.get('/api/admin/ledger', adminRead as any, async (c) => {
    const { limit, offset } = paging(c, 60, 300)
    const type = (c.req.query('type') || '').trim().slice(0, 40)
    const userId = (c.req.query('user_id') || '').trim().slice(0, 100)
    const { results } = await c.env.DB.prepare(
      `SELECT t.id, t.user_id, u.username, u.phone_number, u.full_name, t.type, t.amount, t.status,
              t.reference_id, t.created_at
       FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE (? = '' OR t.type = ?) AND (? = '' OR t.user_id = ?)
       ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(type, type, userId, userId, limit, offset)
      .all()
    return c.json({ transactions: results || [], currency: 'TZS', limit, offset })
  })

  app.get('/api/admin/tiers', adminRead as any, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, duration_hours, price, bandwidth_limit_mb, active, created_at, updated_at
       FROM packages ORDER BY active DESC, price ASC`,
    ).all()
    return c.json({ tiers: results || [], currency: 'TZS' })
  })

  app.get('/api/admin/orders', adminRead as any, async (c) => {
    const { limit, offset } = paging(c, 50, 200)
    const status = (c.req.query('status') || '').trim()
    if (status && !['pending', 'paid', 'failed', 'cancelled'].includes(status)) {
      return jsonError(c, 'Invalid status filter')
    }
    const { results } = await c.env.DB.prepare(
      `SELECT o.merchant_id, o.user_id, u.username, u.phone_number, o.package_id, o.package_name,
              o.duration_hours, o.expected_amount, o.currency, o.status, o.provider_state,
              o.provider_reference, o.mac_address, o.created_at, o.updated_at
       FROM payment_orders o JOIN users u ON u.id = o.user_id
       WHERE (? = '' OR o.status = ?)
       ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(status, status, limit, offset)
      .all()
    return c.json({ orders: results || [], currency: 'TZS' })
  })

  app.get('/api/admin/sessions', adminRead as any, async (c) => {
    const { limit } = paging(c, 50, 200)
    const phone = (c.req.query('q') || c.req.query('phone') || '').trim().slice(0, 60)
    const status = c.req.query('status') || ''
    if (status && !['active', 'expired', 'revoked'].includes(status)) {
      return jsonError(c, 'Invalid status filter')
    }
    const statusExpr = `CASE WHEN s.status = 'active' AND datetime(s.expires_at) <= datetime('now') THEN 'expired' ELSE s.status END`
    const clauses: string[] = ["(? = '' OR u.phone_number LIKE ? OR IFNULL(u.username,'') LIKE ?)"]
    const bindings: any[] = [phone, `%${phone}%`, `%${phone}%`]
    if (status) {
      clauses.push(`${statusExpr} = ?`)
      bindings.push(status)
    }
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.user_id, u.username, u.phone_number, u.full_name, s.mac_address,
              s.token, s.duration_hours, s.expires_at, ${statusExpr} AS status, s.created_at
       FROM access_sessions s JOIN users u ON u.id = s.user_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY s.created_at DESC LIMIT ?`,
    )
      .bind(...bindings, limit)
      .all()
    return c.json({ sessions: results || [] })
  })

  app.get('/api/admin/marketplace', adminRead as any, async (c) => {
    const { limit, offset } = paging(c, 60, 200)
    const status = (c.req.query('status') || '').trim()
    if (status && !['draft', 'active', 'sold', 'cancelled'].includes(status)) {
      return jsonError(c, 'Invalid status filter')
    }
    const { results } = await c.env.DB.prepare(
      `SELECT i.id, i.seller_id, su.username AS seller_username, su.phone_number AS seller_phone,
              i.kind, i.title, i.description, i.price, i.currency, i.status, i.negotiable,
              i.pay_wallet, i.pay_mobile_money, i.payment_notes, i.item_condition, i.location,
              i.contact_phone, i.created_at, i.updated_at, i.published_at, i.sold_at,
              a.id AS asset_id, a.purpose, a.file_name, a.content_type, a.size_bytes, a.sha256
       FROM marketplace_items i
       JOIN users su ON su.id = i.seller_id
       LEFT JOIN marketplace_assets a ON a.id = i.asset_id
       WHERE (? = '' OR i.status = ?)
       ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(status, status, limit, offset)
      .all()

    const { results: quotes } = await c.env.DB.prepare(
      `SELECT q.id, q.item_id, q.buyer_id, q.seller_id, bu.username AS buyer_username,
              su.username AS seller_username, q.requested_price, q.accepted_price, q.status,
              q.message, q.seller_note, q.created_at, q.responded_at, q.paid_at, i.title AS item_title
       FROM marketplace_quotes q
       JOIN marketplace_items i ON i.id = q.item_id
       JOIN users bu ON bu.id = q.buyer_id
       JOIN users su ON su.id = q.seller_id
       ORDER BY q.created_at DESC LIMIT 60`,
    ).all()

    return c.json({ items: results || [], quotes: quotes || [], currency: 'TZS' })
  })

  app.get('/api/admin/staff', adminRead as any, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.username, a.email, a.full_name, a.role, a.active, a.must_change_password,
              a.created_at, a.last_login_at,
              (SELECT COUNT(*) FROM admin_sessions s
                WHERE s.admin_id = a.id AND s.revoked_at IS NULL
                  AND datetime(s.expires_at) > datetime('now')) AS live_sessions
       FROM admin_users a ORDER BY a.created_at ASC`,
    ).all()
    const sessions = await c.env.DB.prepare(
      `SELECT s.id, s.admin_id, a.username, s.user_agent, s.created_at, s.expires_at, s.revoked_at
       FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
       ORDER BY s.created_at DESC LIMIT 30`,
    ).all()
    return c.json({ staff: results || [], sessions: sessions.results || [] })
  })

  /**
   * Append-only audit export. The offline exporter in scripts/sync_audit.py
   * authenticates with the machine secret, the console uses its staff session,
   * and both read the identical paginated payload.
   */
  app.get('/api/admin/audit/events', async (c) => {
    const viaSession = await currentAdmin(c)
    if (!viaSession) {
      const check = await requireSharedSecret(c.req.header('X-Admin-Secret'), c.env.ADMIN_SECRET)
      if (check === 'unconfigured') return jsonError(c, 'Admin access is not configured', 503)
      if (check === 'unauthorized') return jsonError(c, 'Unauthorized', 401)
    }

    const afterText = c.req.query('after_id') || '0'
    const limitText = c.req.query('limit') || '100'
    if (!/^\d+$/.test(afterText) || !/^\d+$/.test(limitText)) {
      return jsonError(c, 'Invalid audit pagination')
    }
    const afterId = Number(afterText)
    const limit = Number(limitText)
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      return jsonError(c, 'Invalid audit pagination')
    }
    const eventType = (c.req.query('event_type') || '').trim().slice(0, 100)
    const { results } = await c.env.DB.prepare(
      `SELECT a.event_id, a.actor_user_id, a.actor_admin_id, au.username AS admin_username,
              a.event_type, a.target_id, a.details_json, a.created_at
       FROM audit_outbox a LEFT JOIN admin_users au ON au.id = a.actor_admin_id
       WHERE a.event_id > ? AND (? = '' OR a.event_type = ?)
       ORDER BY a.event_id ASC LIMIT ?`,
    )
      .bind(afterId, eventType, eventType, limit + 1)
      .all()
    const rows: any[] = results || []
    const page = rows.slice(0, limit).map((row) => ({
      event_id: row.event_id,
      actor_user_id: row.actor_user_id,
      actor_admin_id: row.actor_admin_id,
      admin_username: row.admin_username,
      event_type: row.event_type,
      target_id: row.target_id,
      details: JSON.parse(String(row.details_json)),
      created_at: row.created_at,
    }))
    return c.json({
      events: page,
      next_after_id: page.length ? page[page.length - 1].event_id : afterId,
      has_more: rows.length > limit,
    })
  })
}
