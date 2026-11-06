import { Hono } from 'hono'
import { html } from 'hono/html'
import type { Bindings } from './env'
import { normalizeMac } from './lib/helpers'
import { registerUserRoutes } from './routes/user'
import { registerAdminAuthRoutes } from './routes/admin/auth'
import { registerAdminReadRoutes } from './routes/admin/api'
import { registerAdminMutationRoutes } from './routes/admin/mutations'
import { registerAdminDashboardRoutes } from './routes/admin/dashboard'
import { registerDiscoverableRoutes } from './routes/discoverable'
import { registerPaymentRoutes } from './routes/payments' // This fixes the /api/packages 404
import { registerMarketplaceRoutes } from './routes/marketplace'

const app = new Hono<{ Bindings: Bindings }>()

// User routes (Auth + Wallet UI)
registerUserRoutes(app)

// Payment & Package API routes (fixes 404s)
registerPaymentRoutes(app)

// Marketplace: listings, uploads, quotations, wallet-to-wallet settlement
registerMarketplaceRoutes(app)

// Admin routes. Sign-in answers for itself; every other /api/admin call proves
// its own staff session (or, for the read-only audit export, the machine
// secret) and every write re-checks Origin plus role, so nothing here depends
// on route registration order.
registerAdminAuthRoutes(app)
registerAdminReadRoutes(app)
registerAdminMutationRoutes(app)
registerAdminDashboardRoutes(app)

// Public routes
registerDiscoverableRoutes(app as any)

// Landing Page
app.get('/', async (c) => {
  const mac = normalizeMac(c.req.query('mac'))
  const portalHref = mac ? `/landing?mac=${encodeURIComponent(mac)}` : '/landing'
  return c.html(html`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8" /><title>ISP Portal</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-slate-100 min-h-screen p-6 font-sans flex items-center justify-center">
      <div class="max-w-xl w-full space-y-6 bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-2xl">
        <div class="flex items-center space-x-3">
          <div class="w-10 h-10 rounded-2xl bg-indigo-600 flex items-center justify-center font-bold text-xl">⚡</div>
          <div><h1 class="text-xl font-bold text-white">Flat Coin Network Portal</h1><p class="text-xs text-emerald-400 font-mono">AAA RADIUS Core Active</p></div>
        </div>
        ${mac ? html`<p class="text-xs text-slate-400 font-mono">Router reported node <span class="text-white">${mac}</span></p>` : ''}
        <div class="space-y-3 pt-2">
          <a href="${portalHref}" class="block text-center w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 font-semibold rounded-xl text-sm transition">📶 Hotspot Portal — Buy Access</a>
          <a href="/account" class="block text-center w-full py-3.5 bg-slate-800 hover:bg-slate-700 font-semibold rounded-xl text-sm border border-slate-700 transition">User Login / Register</a>
          <a href="/admin/login" class="block text-center w-full py-3.5 bg-slate-800 hover:bg-slate-700 font-semibold rounded-xl text-sm border border-slate-700 transition">Admin Login</a>
        </div>
      </div>
    </body></html>
  `)
})

export default app
