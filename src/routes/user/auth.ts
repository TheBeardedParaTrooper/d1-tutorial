import type { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { Bindings } from '../../env'
import { registerAuthRoutes, authenticatedUser } from '../auth'

// Only same-origin absolute paths, never scheme/full URLs (blocks open redirects).
const SAFE_NEXT = /^\/[A-Za-z0-9.?&=%#:@_-]*$/
function safeNext(value: string | undefined): string {
  const target = (value || '').trim()
  if (!target || target.startsWith('//') || !SAFE_NEXT.test(target)) return '/wallet'
  return target
}

export function registerUserAuthRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.get('/account', async (c) => {
    const next = safeNext(c.req.query('next'))
    const session = await authenticatedUser(c)
    // /account?mode=register lands straight on the sign-up pane (the portal sends
    // sellers there, so nobody has to guess which tab creates the account).
    const startMode = c.req.query('mode') === 'register' ? 'register' : 'login'
    const boot = raw(JSON.stringify({ next, mode: startMode }))

    return c.html(html`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Account - Flat Coin</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6 font-sans">
      <div class="w-full max-w-md space-y-6">
        <div class="text-center space-y-1">
          <div class="mx-auto w-11 h-11 rounded-2xl bg-indigo-600 flex items-center justify-center font-bold text-xl">⚡</div>
          <h2 class="text-2xl font-bold text-white">Flat Coin Account</h2>
          <p class="text-xs text-slate-400">Sign in with your username or your Tanzanian number.</p>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-6 rounded-3xl shadow-2xl space-y-5">
          <noscript>
            <p class="rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-xs text-amber-300">
              JavaScript is off, so this form cannot reach the server. Enable it to sign in or register.
            </p>
          </noscript>
          <div class="grid grid-cols-2 gap-2" role="tablist" aria-label="Account access">
            <button id="tab-in" type="button" role="tab" aria-selected="true" onclick="setMode('login')" class="py-2.5 rounded-xl text-xs font-semibold border transition">Sign In</button>
            <button id="tab-up" type="button" role="tab" aria-selected="false" onclick="setMode('register')" class="py-2.5 rounded-xl text-xs font-semibold border transition">Create Account</button>
          </div>
          <p class="text-[11px] text-slate-500 text-center -mt-2">No account yet? Use <span class="text-slate-300">Create Account</span> first — signing in only works after that.</p>

          <p id="msg" class="text-xs rounded-xl border px-3 py-2 hidden"></p>

          <!-- SIGN IN -->
          <form id="pane-login" class="space-y-4" onsubmit="return false">
            <div>
              <label class="text-xs font-semibold text-slate-400 mb-1.5 block">Username or phone number</label>
              <input id="identifier" type="text" autocomplete="username" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500" placeholder="g or 0712234432" />
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-400 mb-1.5 block">Password</label>
              <input id="login-pass" type="password" autocomplete="current-password" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500" placeholder="Your password" />
            </div>
            <button id="btn-login" type="button" onclick="submitAuth('login')" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-semibold text-sm transition">Sign In</button>
            <p class="text-center text-xs text-slate-400">
              New to Flat Coin?
              <button type="button" onclick="setMode('register')" class="text-indigo-400 hover:text-white font-semibold">Create an account</button>
            </p>
          </form>

          <!-- REGISTER -->
          <form id="pane-register" class="space-y-4 hidden" onsubmit="return false">
            <div>
              <label class="text-xs font-semibold text-slate-400 mb-1.5 block">Name on the account</label>
              <input id="fullname" type="text" maxlength="60" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500" placeholder="e.g. G" />
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-400 mb-1.5 block">Username <span class="text-slate-500 font-normal">(optional, lets buyers find you as @name)</span></label>
              <input id="username" type="text" maxlength="30" autocomplete="off" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500" placeholder="e.g. g" />
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-400 mb-1.5 block">Tanzanian phone number</label>
              <input id="phone" type="tel" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500" placeholder="+255712345678 or 0712345678" />
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-400 mb-1.5 block">Password <span class="text-slate-500 font-normal">(12 characters or more)</span></label>
              <input id="pass" type="password" autocomplete="new-password" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500" placeholder="At least 12 characters" />
              <p class="text-[10px] text-slate-500 mt-1.5">Stored as PBKDF2-SHA256, 100,000 iterations with a per-account salt.</p>
            </div>
            <button id="btn-register" type="button" onclick="submitAuth('register')" class="w-full py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-semibold text-sm transition">Create Account &amp; Sign In</button>
            <p class="text-center text-xs text-slate-400">
              Already registered?
              <button type="button" onclick="setMode('login')" class="text-indigo-400 hover:text-white font-semibold">Sign in instead</button>
            </p>
          </form>
        </div>

        ${session ? html`
          <div class="rounded-2xl border border-emerald-800/60 bg-emerald-950/40 p-4 text-xs space-y-2">
            <p class="text-emerald-300 font-semibold">Already signed in as <span class="font-mono">${session.username ? '@' + session.username : session.phone_number}</span></p>
            <a href="${next}" class="block text-center bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl py-2.5 transition">Continue</a>
            <a href="/landing" class="block text-center text-slate-400 hover:text-white transition">Hotspot portal instead</a>
          </div>
        ` : ''}
        <p class="text-center text-xs space-x-3">
          <a href="/landing" class="text-indigo-400 hover:text-indigo-300">Hotspot portal</a>
          <a href="/wallet" class="text-indigo-400 hover:text-indigo-300">Dashboard</a>
          <a href="/" class="text-indigo-400 hover:text-indigo-300">← Back to Portal</a>
        </p>
      </div>
      <script>
        const BOOT = ${boot}
        const NEXT = BOOT.next
        let mode = 'login'

        function el(id) { return document.getElementById(id) }

        function setMode(next) {
          mode = next === 'register' ? 'register' : 'login'
          const active = 'bg-indigo-600 text-white border-indigo-500'
          const idle = 'bg-slate-950 text-slate-400 border-slate-800 hover:border-slate-700'
          el('tab-in').className = 'py-2.5 rounded-xl text-xs font-semibold border transition ' + (mode === 'login' ? active : idle)
          el('tab-up').className = 'py-2.5 rounded-xl text-xs font-semibold border transition ' + (mode === 'register' ? active : idle)
          el('tab-in').setAttribute('aria-selected', mode === 'login' ? 'true' : 'false')
          el('tab-up').setAttribute('aria-selected', mode === 'register' ? 'true' : 'false')
          el('pane-login').classList.toggle('hidden', mode !== 'login')
          el('pane-register').classList.toggle('hidden', mode !== 'register')
          say('', 'idle')
        }

        function say(text, kind) {
          const box = el('msg')
          if (!text) { box.classList.add('hidden'); return }
          const styles = kind === 'ok'
            ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
            : 'border-rose-900 bg-rose-950/40 text-rose-300'
          box.className = 'text-xs rounded-xl border px-3 py-2 ' + styles
          box.textContent = text
        }

        function busy(on) {
          el('btn-login').disabled = on
          el('btn-register').disabled = on
          el('btn-login').classList.toggle('opacity-60', on)
          el('btn-register').classList.toggle('opacity-60', on)
          el('btn-login').textContent = on ? 'Checking…' : 'Sign In'
          el('btn-register').textContent = on ? 'Creating…' : 'Create Account & Sign In'
        }

        async function postJson(path, payload) {
          const res = await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const text = await res.text()
          let data = null
          try { data = text ? JSON.parse(text) : null } catch { data = null }
          if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
          return data || {}
        }

        async function signedIn() {
          try {
            const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
            return res.ok
          } catch { return false }
        }

        function readForm() {
          return {
            identifier: el('identifier').value.trim(),
            loginPass: el('login-pass').value,
            fullName: el('fullname').value.trim(),
            username: el('username').value.trim(),
            phone: el('phone').value.trim(),
            pass: el('pass').value,
          }
        }

        async function submitAuth(requested) {
          const action = requested || mode
          const form = readForm()
          say('', 'idle')

          if (action === 'login') {
            if (!form.identifier) { say('Type your username or phone number.', 'err'); return }
            if (!form.loginPass) { say('Type your password.', 'err'); return }
          } else {
            if (!form.fullName) { say('Enter the name on the account.', 'err'); return }
            if (form.username && !/^[A-Za-z0-9_]{1,30}$/.test(form.username)) {
              say('Username: 1-30 letters, digits or underscore, no spaces.', 'err'); return
            }
            // No backslash escapes in this pattern: the whole page is a template
            // literal, so a digit class has to be spelled out as a range.
            var digits = form.phone.replace(/[^0-9]/g, '')
            if (digits.indexOf('255') === 0) digits = digits.slice(3)
            if (digits.charAt(0) === '0') digits = digits.slice(1)
            if (!/^[67][1-9][0-9]{7}$/.test(digits)) {
              say('Enter a valid Tanzanian number, e.g. 0712 234 432 or +255712234432.', 'err'); return
            }
            if (form.pass.length < 12) { say('Password must be at least 12 characters.', 'err'); return }
          }

          busy(true)
          try {
            if (action === 'register') {
              await postJson('/api/auth/register', {
                full_name: form.fullName,
                username: form.username || null,
                phone_number: form.phone,
                password: form.pass,
              })
              // Registration signs the account straight in; only if the server could
              // not issue a cookie do we sign in with the credentials just created.
              if (!(await signedIn())) {
                await postJson('/api/auth/login', { identifier: form.phone, password: form.pass })
              }
            } else {
              await postJson('/api/auth/login', { identifier: form.identifier, password: form.loginPass })
            }
            say('Welcome in — opening your portal…', 'ok')
            window.location.href = NEXT
          } catch (e) {
            say(e.message, 'err')
            busy(false)
          }
        }

        el('pane-login').addEventListener('submit', (event) => { event.preventDefault(); submitAuth('login') })
        el('pane-register').addEventListener('submit', (event) => { event.preventDefault(); submitAuth('register') })
        setMode(BOOT.mode)
      </script>
    </body></html>
    `)
  })
  registerAuthRoutes(app)
}
