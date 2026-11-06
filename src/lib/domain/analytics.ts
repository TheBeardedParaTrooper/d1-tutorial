import type { Bindings } from '../../env'

export type DashboardStats = {
  users: number
  activeSessions: number
  pendingOrders: number
  completedOrders: number
  totalVolume: number
  totalWalletBalance: number
  recentEvents: Array<{ event_type: string; actor_user_id: string | null; created_at: string }>
}

export async function getDashboard(env: Bindings): Promise<DashboardStats> {
  const [users, sessions, pending, completed, volume, wallets, recent] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM access_sessions WHERE status='active' AND datetime(expires_at)>datetime('now')`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM payment_orders WHERE status='pending'`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM payment_orders WHERE status='paid'`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='DEPOSIT_AZAMPAY' AND status='success'`).first<{ total: number }>(),
    env.DB.prepare(`SELECT COALESCE(SUM(balance),0) AS total FROM wallets`).first<{ total: number }>(),
    env.DB.prepare(`SELECT event_type, actor_user_id, created_at FROM audit_outbox ORDER BY event_id DESC LIMIT 10`).all<{ event_type: string; actor_user_id: string | null; created_at: string }>(),
  ])
  return {
    users: Number(users?.n || 0),
    activeSessions: Number(sessions?.n || 0),
    pendingOrders: Number(pending?.n || 0),
    completedOrders: Number(completed?.n || 0),
    totalVolume: Number(volume?.total || 0),
    totalWalletBalance: Number(wallets?.total || 0),
    recentEvents: recent.results || [],
  }
}

// Add this new function
export async function getChartData(env: Bindings) {
  // Revenue for the last 7 days
  const { results: revenue } = await env.DB.prepare(`
    SELECT date(created_at) as day, SUM(amount) as total
    FROM transactions WHERE type='DEPOSIT_AZAMPAY' AND status='success'
    AND datetime(created_at) > datetime('now', '-7 days')
    GROUP BY date(created_at) ORDER BY day ASC
  `).all<any>()

  // Recent 10 orders
  const { results: recentOrders } = await env.DB.prepare(`
    SELECT merchant_id, phone_number, package_name, expected_amount, status, created_at
    FROM payment_orders ORDER BY created_at DESC LIMIT 10
  `).all<any>()

  return {
    revenue: revenue.map(r => ({ day: r.day, total: r.total || 0 })),
    recentOrders: recentOrders || [],
  }
}
