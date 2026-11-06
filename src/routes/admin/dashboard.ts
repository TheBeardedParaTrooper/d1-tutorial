import type { Hono } from 'hono'
import type { Bindings } from '../../env'
import { requireAdmin, type Admin } from '../../lib/auth/admin-auth'
import { CONSOLE_SCRIPT, CONSOLE_STYLE, PANEL_ROUTES } from './console-script'

const NAV: Array<[string, string]> = [
  ['overview', '📊 Overview'],
  ['customers', '👥 Customers'],
  ['ledger', '💰 Ledger'],
  ['tiers', '📶 Tiers'],
  ['orders', '🧾 Orders'],
  ['hotspot', '📡 Hotspot'],
  ['marketplace', '🛍️ Marketplace'],
  ['staff', '🔑 Staff'],
  ['audit', '🧭 Audit trail'],
  ['settings', '⚙️ My access'],
]

function shell(admin: Admin, initialTab: string) {
  const tabs = NAV.map(
    ([key, label]) =>
      `<button type="button" class="tab" role="tab" data-tab="${key}">${label}</button>`,
  ).join('\n')

  const boot = {
    admin: {
      id: admin.id,
      username: admin.username,
      email: admin.email,
      role: admin.role,
      must_change_password: Number(admin.must_change_password) === 1,
    },
    initialTab,
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Staff console · Flat Coin Network</title>
<style>${CONSOLE_STYLE}</style>
</head>
<body>
<div class="wrap">
  <nav class="side">
    <div class="brandrow">
      <div class="mark">⚡</div>
      <div><b>Flat Coin</b><span>staff console</span></div>
    </div>
${tabs}
    <div class="who">
      <b id="who-name">@${admin.username}</b><br />
      <span id="who-role">${admin.role}</span>
    </div>
  </nav>

  <main>
    <div class="head">
      <div>
        <h1 id="tab-title">Staff console</h1>
        <p id="tab-sub">Loading…</p>
      </div>
      <button type="button" class="act" data-action="signOut">Sign out</button>
    </div>
    <div id="panel"><div class="empty">Loading…</div></div>
    <div class="hint" style="font-size:11px;color:#475569">
      Read and write access to the same database the customer portal and the router use.
      Every action here is written to the append-only audit outbox.
    </div>
  </main>
</div>

<div id="toast" aria-live="polite"></div>

<script>window.__FLATCOIN_ADMIN__ = ${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>
<script>${CONSOLE_SCRIPT}</script>
</body>
</html>`
}

export function registerAdminDashboardRoutes(app: Hono<{ Bindings: Bindings }>) {
  const handler = async (c: any) => {
    const admin = (c as any).get('admin') as Admin
    const slug = c.req.param('panel') || ''
    const initialTab = PANEL_ROUTES[slug] || 'overview'
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    c.header('X-Frame-Options', 'DENY')
    c.header('Referrer-Policy', 'no-referrer')
    return c.html(shell(admin, initialTab))
  }

  app.get('/admin', requireAdmin as any, handler)
  app.get('/admin/:panel', requireAdmin as any, handler)
}
