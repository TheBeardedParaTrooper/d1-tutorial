import type { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { Bindings } from '../../env'
import { authenticatedUser } from '../auth'
import { normalizeMac } from '../../lib/helpers'

export function registerUserWalletRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.get('/wallet', async (c) => {
    const user = await authenticatedUser(c)
    if (!user) return c.redirect('/account?next=%2Fwallet')

    // Interpolated strings are HTML-escaped by hono/html, which is what broke the
    // inline script last time (`&quot;`). Inject the boot payload as `raw` JSON.
    const boot = raw(JSON.stringify({
      userId: user.id,
      phone: user.phone_number,
      username: user.username || '',
      name: user.full_name || '',
      mac: normalizeMac(c.req.query('mac')) || '',
    }))

    return c.html(html`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Wallet - Flat Coin</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-950 text-slate-100 min-h-screen font-sans">
        <header class="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-50">
          <div class="max-w-6xl mx-auto flex flex-wrap gap-3 justify-between items-center px-6 py-4">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-2xl bg-indigo-600 flex items-center justify-center font-bold text-xl">⚡</div>
              <div>
                <h1 class="text-lg font-bold text-white">Dashboard</h1>
                <p class="text-xs text-slate-400 font-mono" id="who"></p>
              </div>
            </div>
            <nav class="flex items-center gap-2 text-sm">
              <a href="/landing" class="px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 hover:bg-slate-700 transition">Hotspot portal</a>
              <a href="/api/meta/catalog" class="px-3 py-1.5 rounded-xl text-slate-400 hover:text-white font-mono text-xs transition">API</a>
              <button id="logout" class="px-3 py-1.5 rounded-xl text-slate-400 hover:text-white transition">Sign out</button>
            </nav>
          </div>
        </header>

        <div id="toast" class="fixed top-5 right-5 z-50 hidden max-w-sm rounded-2xl border px-4 py-3 text-xs font-medium shadow-2xl"></div>

        <main class="max-w-6xl mx-auto px-6 py-8 space-y-6">
          <section class="bg-gradient-to-br from-indigo-950 to-slate-900 border border-indigo-500/30 rounded-3xl p-6 shadow-2xl">
            <p class="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Wallet Balance</p>
            <p class="text-5xl font-extrabold text-white mt-2">
              <span id="balance">—</span> <span class="text-lg text-indigo-300">TZS</span>
            </p>
            <div class="mt-4 flex flex-col sm:flex-row sm:items-end gap-3">
              <div>
                <label for="mac" class="block text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-1">Device MAC (from the router)</label>
                <input id="mac" placeholder="AA:BB:CC:DD:EE:FF" class="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-white w-44 focus:outline-none focus:border-indigo-500" />
              </div>
              <button id="saveMac" class="text-xs bg-slate-800 hover:bg-slate-700 text-indigo-300 px-3 py-2 rounded-xl border border-slate-700 transition">Remember node</button>
              <p id="macHint" class="text-[11px] text-slate-500"></p>
            </div>
          </section>

          <section class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl">
            <div class="flex justify-between items-center mb-4">
              <h2 class="text-lg font-bold text-white">Available Packages</h2>
              <button id="reloadPackages" class="text-xs bg-slate-800 hover:bg-slate-700 text-indigo-400 px-3 py-1.5 rounded-xl border border-slate-700 transition">↻ /api/packages</button>
            </div>
            <div id="tiers" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <p class="text-slate-500 text-sm col-span-full">Loading plans…</p>
            </div>
          </section>

          <section class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl">
            <div class="flex justify-between items-center mb-4">
              <h2 class="text-lg font-bold text-white">Recent Transactions</h2>
              <button id="reloadLedger" class="text-xs bg-slate-800 hover:bg-slate-700 text-indigo-400 px-3 py-1.5 rounded-xl border border-slate-700 transition">↻ Refresh</button>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead>
                  <tr class="border-b border-slate-800 text-slate-500 uppercase text-[10px] font-mono">
                    <th class="py-2 px-3">Reference</th>
                    <th class="py-2 px-3">Type</th>
                    <th class="py-2 px-3">Amount</th>
                    <th class="py-2 px-3">Status</th>
                    <th class="py-2 px-3">Recorded</th>
                  </tr>
                </thead>
                <tbody id="ledger" class="divide-y divide-slate-800/60">
                  <tr><td colspan="5" class="py-6 text-center text-slate-500">Loading ledger…</td></tr>
                </tbody>
              </table>
            </div>
            <p class="text-[11px] text-slate-500 mt-3">Need a PDF receipt? Open the <a class="text-indigo-400 hover:text-indigo-300" href="/landing">hotspot portal</a> — it renders receipts client-side from this same ledger.</p>
          </section>
        </main>

        <script>
          const BOOT = ${boot}
          const el = (id) => document.getElementById(id)
          const CREDIT = /DEPOSIT|TRANSFER_IN|SELL|CREDIT|REFUND/

          function money(value) {
            const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''))
            return Number.isFinite(n) ? n.toLocaleString('en-US') : '0'
          }

          function stamp(value) {
            if (!value) return '—'
            const iso = String(value).indexOf('T') === -1 ? String(value).replace(' ', 'T') + 'Z' : String(value)
            const d = new Date(iso)
            return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
          }

          function titleCase(type) {
            return String(type || 'UNKNOWN').split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')
          }

          function toast(message, ok) {
            const box = el('toast')
            box.textContent = message
            box.className = 'fixed top-5 right-5 z-50 max-w-sm rounded-2xl border px-4 py-3 text-xs font-medium shadow-2xl ' +
              (ok ? 'bg-emerald-950 border-emerald-700 text-emerald-200' : 'bg-rose-950 border-rose-700 text-rose-200')
            setTimeout(() => box.classList.add('hidden'), 4000)
            box.classList.remove('hidden')
          }

          async function api(path, options) {
            const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}, {
              headers: Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {}),
            }))
            const text = await res.text()
            let data = null
            try { data = text ? JSON.parse(text) : null } catch { data = { error: 'Malformed response' } }
            if (!res.ok) {
              const err = new Error((data && data.error) || 'HTTP ' + res.status)
              err.payload = data
              err.status = res.status
              throw err
            }
            return data || {}
          }

          function describeError(err) {
            const p = err && err.payload
            if (p && p.error === 'not_hooked') return 'Not wired on the server yet: ' + (p.path || '')
            if (err && err.status === 401) { window.location.href = '/account?next=%2Fwallet'; return 'Session expired — signing you in again.' }
            if (err && err.status === 403) return 'Rejected by the server: PORTAL_ORIGIN must match this site origin.'
            if (err && err.status === 503) return 'Server secrets are not configured yet.'
            return (err && err.message) || 'Request failed.'
          }

          function idemKey() {
            return window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'dash-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
          }

          // ---------- device MAC ----------
          function currentMac() {
            const compact = (el('mac').value || '').replace(/[^0-9A-Fa-f]/g, '')
            if (compact.length !== 12) return ''
            return (compact.match(/.{2}/g) || []).join(':').toUpperCase()
          }

          function renderMacHint() {
            const mac = currentMac()
            el('macHint').textContent = mac ? 'Passes bind to ' + mac : 'Type the MAC the router reported before buying a pass.'
          }

          function saveMac() {
            const mac = currentMac()
            if (!mac) return toast('A MAC address is 12 hex digits.', false)
            localStorage.setItem('flatcoin.mac', mac)
            el('mac').value = mac
            renderMacHint()
            toast('Node address remembered: ' + mac, true)
          }

          // ---------- data loads ----------
          async function loadWallet() {
            try {
              const data = await api('/api/wallet/' + encodeURIComponent(BOOT.userId))
              el('balance').textContent = money(data.wallet && data.wallet.balance)
            } catch (err) {
              el('balance').textContent = '0'
              toast(describeError(err), false)
            }
          }

          async function loadTiers() {
            const box = el('tiers')
            box.textContent = ''
            try {
              const data = await api('/api/packages')
              const packages = Array.isArray(data.packages) ? data.packages : []
              if (!packages.length) {
                box.textContent = 'No sellable packages in the database — seed the packages table.'
                box.className = 'text-slate-500 text-sm col-span-full'
                return
              }
              packages.forEach((pkg) => box.appendChild(packageCard(pkg)))
            } catch (err) {
              box.textContent = describeError(err)
              box.className = 'text-rose-400 text-sm col-span-full'
            }
          }

          function packageCard(pkg) {
            const card = document.createElement('div')
            card.className = 'bg-slate-950 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between gap-3'

            const name = document.createElement('p')
            name.className = 'font-bold text-white'
            name.textContent = String(pkg.name ?? 'Unnamed package')

            const duration = document.createElement('p')
            duration.className = 'text-xs text-slate-400 mt-1'
            duration.textContent = String(pkg.duration_hours ?? '?') + ' hours access'

            const price = document.createElement('p')
            price.className = 'mt-3 text-lg font-bold text-indigo-400'
            price.textContent = money(pkg.price) + ' TZS'

            const id = document.createElement('p')
            id.className = 'text-[10px] font-mono text-slate-600 mt-1'
            id.textContent = String(pkg.id ?? '')

            const buy = document.createElement('button')
            buy.className = 'mt-3 w-full bg-indigo-600 hover:bg-indigo-500 py-2 rounded-xl text-sm font-semibold transition'
            buy.textContent = 'Buy Now'
            buy.addEventListener('click', () => buyPackage(pkg, buy))

            const top = document.createElement('div')
            top.append(name, duration, price, id)
            card.append(top, buy)
            return card
          }

          async function buyPackage(pkg, button) {
            const mac = currentMac()
            if (!mac) {
              el('mac').focus()
              return toast('Enter the device MAC address first.', false)
            }
            if (!window.confirm('Debit ' + money(pkg.price) + ' TZS for ' + String(pkg.name) + '?')) return
            localStorage.setItem('flatcoin.mac', mac)
            button.disabled = true
            button.textContent = 'Provisioning…'
            try {
              const data = await api('/api/session/buy', {
                method: 'POST',
                headers: { 'Idempotency-Key': idemKey() },
                body: JSON.stringify({ package_id: String(pkg.id), mac_address: mac }),
              })
              const expires = data.session && data.session.expires_at
              toast('Access granted until ' + (expires ? stamp(expires) : 'the scheduled expiry') + '.', true)
              await Promise.all([loadWallet(), loadLedger()])
            } catch (err) {
              toast(describeError(err), false)
            } finally {
              button.disabled = false
              button.textContent = 'Buy Now'
            }
          }

          async function loadLedger() {
            const body = el('ledger')
            body.textContent = ''
            try {
              const data = await api('/api/transactions/' + encodeURIComponent(BOOT.userId))
              const rows = Array.isArray(data.transactions) ? data.transactions : []
              if (!rows.length) {
                const tr = document.createElement('tr')
                const td = document.createElement('td')
                td.colSpan = 5
                td.className = 'py-6 text-center text-slate-500'
                td.textContent = 'No transactions yet — a top-up or pass purchase will show up here.'
                tr.append(td)
                body.append(tr)
                return
              }
              rows.forEach((tx) => body.append(ledgerRow(tx)))
            } catch (err) {
              toast(describeError(err), false)
            }
          }

          function ledgerRow(tx) {
            const credit = CREDIT.test(String(tx.type || '').toUpperCase())
            const tr = document.createElement('tr')
            tr.className = 'hover:bg-slate-800/40 transition'
            const cells = [
              { text: String(tx.reference_id || tx.id || ''), cls: 'py-3 px-3 text-slate-400 font-mono' },
              { text: titleCase(tx.type), cls: 'py-3 px-3 text-slate-300' },
              { text: (credit ? '+' : '-') + money(tx.amount), cls: 'py-3 px-3 font-bold ' + (credit ? 'text-emerald-400' : 'text-rose-400') },
              { text: String(tx.status || ''), cls: 'py-3 px-3' },
              { text: stamp(tx.created_at), cls: 'py-3 px-3 text-slate-500 text-[10px]' },
            ]
            cells.forEach((cell, index) => {
              const td = document.createElement('td')
              td.className = cell.cls
              if (index === 3) {
                const badge = document.createElement('span')
                badge.className = 'px-2 py-0.5 rounded-md border text-[10px] ' +
                  (tx.status === 'success' ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/50' : 'bg-amber-950/80 text-amber-400 border-amber-800/50')
                badge.textContent = cell.text
                td.append(badge)
              } else {
                td.textContent = cell.text
              }
              tr.append(td)
            })
            return tr
          }

          async function logout() {
            try { await api('/api/auth/logout', { method: 'POST' }) } catch {}
            window.location.href = '/account'
          }

          el('who').textContent = (BOOT.username ? '@' + BOOT.username + ' · ' : '') + BOOT.phone
          el('mac').value = BOOT.mac || localStorage.getItem('flatcoin.mac') || ''
          el('mac').addEventListener('input', renderMacHint)
          el('saveMac').addEventListener('click', saveMac)
          el('logout').addEventListener('click', logout)
          el('reloadPackages').addEventListener('click', loadTiers)
          el('reloadLedger').addEventListener('click', loadLedger)

          renderMacHint()
          loadWallet()
          loadTiers()
          loadLedger()
        </script>
      </body></html>
    `)
  })
}
