import type { Hono } from 'hono'
import { html } from 'hono/html'
import type { Bindings } from '../env'

export function registerLandingRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.get('/', async (c) => {
    if (c.env.ASSETS) {
      const assetUrl = new URL(c.req.url)
      assetUrl.pathname = '/landing'
      return c.env.ASSETS.fetch(assetUrl)
    }
    const { results: gateways } = await c.env.DB.prepare(
      `SELECT id, name, location FROM gateways WHERE active = 1`,
    ).all()
    const list: any[] = gateways || []
    return c.html(html`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>ISP Portal</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-950 text-slate-100 min-h-screen p-6 font-sans">
        <div class="max-w-xl mx-auto space-y-6 bg-slate-900 border border-slate-800 p-8 rounded-3xl shadow-2xl">
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 rounded-2xl bg-indigo-600 flex items-center justify-center font-bold text-xl">⚡</div>
            <div>
              <h1 class="text-xl font-bold text-white">Flat Coin Network Portal</h1>
              <p class="text-xs text-emerald-400 font-mono">AAA RADIUS Core Active</p>
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Select Your Access Gateway:</label>
            <select id="gatewaySelect" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-200">
              ${list.length
                ? list.map((gw) => html`<option value="${gw.id}">${gw.name} (${gw.location || ''})</option>`)
                : html`<option value="default">Default Node (Main Hotspot)</option>`}
            </select>
          </div>
          <div class="space-y-3 pt-2">
            <button onclick="navigate('subscription')" class="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 font-semibold rounded-xl text-sm">
              🌐 Buy Internet Pass
            </button>
            <button onclick="navigate('store')" class="w-full py-3.5 bg-slate-800 hover:bg-slate-700 font-semibold rounded-xl text-sm border border-slate-700">
              🛒 Browse Store
            </button>
          </div>
        </div>
        <script>
          function navigate(mode) {
            const gatewayId = document.getElementById('gatewaySelect').value;
            localStorage.setItem('selectedGateway', gatewayId);
            window.location.href = '/' + mode + '?gateway=' + gatewayId;
          }
        </script>
      </body>
      </html>
    `)
  })
}
