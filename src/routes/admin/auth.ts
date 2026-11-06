import type { Hono } from 'hono'
import type { Bindings } from '../../env'
import { configuredSecret } from '../../lib/helpers'
import { jsonError, readLimitedJson } from '../auth'
import {
  currentAdmin,
  randomAdminToken,
  setAdminCookie,
  clearAdminCookie,
  adminCookieValue,
  adminSessionExpiryIso,
  adminTransportIsSecure,
  hashAdminSessionToken,
  hashAdminPassword,
  verifyStoredAdminPassword,
  writeAdminAudit,
  ADMIN_SESSION_DAYS,
} from '../../lib/auth/admin-auth'

function fail(c: any, message: string, status: 400 | 401 | 403 | 500 | 503 = 400) {
  return c.json({ error: message, ok: false }, status)
}

/**
 * The console is a same-origin app: a forged cross-site form would carry a
 * foreign Origin, so the cookie is only honoured when the Origin matches the
 * origin serving the request (and the configured portal origin, if any).
 */
export function adminOriginAllowed(c: any): boolean {
  const origin = c.req.header('Origin')
  if (!origin) return false
  try {
    if (origin !== new URL(c.req.url).origin) return false
    const portal = c.env.PORTAL_ORIGIN as string | undefined
    if (portal && portal !== origin) return false
    return true
  } catch {
    return false
  }
}

// Staff pages deliberately load nothing third-party: no Tailwind or library CDN
// on a privileged surface, so a compromised upstream cannot reach this origin.
const CONSOLE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #020617; color: #e2e8f0;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { display: flex; align-items: center; justify-content: center; padding: 24px; min-height: 100vh; }
.card { width: 100%; max-width: 380px; background: #0f172a; border: 1px solid #1e293b;
  border-radius: 24px; padding: 24px; box-shadow: 0 20px 50px rgba(2,6,23,.6); }
.brand { width: 52px; height: 52px; margin: 0 auto 10px; border-radius: 18px; background: #dc2626;
  display: flex; align-items: center; justify-content: center; font-size: 22px; }
h1 { margin: 0; font-size: 21px; color: #fff; text-align: center; }
.sub { margin: 6px 0 22px; font-size: 12px; color: #94a3b8; text-align: center; }
label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
  font-weight: 700; color: #94a3b8; margin: 0 0 6px; }
input, select, textarea { width: 100%; background: #020617; border: 1px solid #1e293b; border-radius: 12px;
  padding: 11px 12px; color: #e2e8f0; font-size: 14px; font-family: inherit; }
input:focus, select:focus, textarea:focus { outline: none; border-color: #dc2626; }
.field { margin-bottom: 14px; }
button { cursor: pointer; border: 0; border-radius: 12px; padding: 11px 14px; font-size: 13px;
  font-weight: 600; font-family: inherit; }
button.primary { width: 100%; background: #dc2626; color: #fff; }
button.primary:hover { background: #ef4444; }
button.ghost { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }
button.ghost:hover { background: #334155; }
button:disabled { opacity: .5; cursor: progress; }
.msg { font-size: 13px; margin: 0 0 12px; }
.msg.err { color: #fb7185; }
.msg.ok { color: #34d399; }
.msg.hide { display: none; }
.foot { margin-top: 18px; font-size: 11px; color: #64748b; text-align: center; }
.foot a { color: #818cf8; text-decoration: none; }
`

export function registerAdminAuthRoutes(app: Hono<{ Bindings: Bindings }>) {
  app.get('/admin/login', async (c) => {
    const next = String(c.req.query('next') || '/admin')
    const safeNext = next.startsWith('/admin') ? next : '/admin'
    try {
      if (await currentAdmin(c)) return c.redirect(safeNext)
    } catch (e) {
      console.error(e)
    }

    return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Staff sign in · Flat Coin Network</title>
<style>${CONSOLE_CSS}</style>
</head>
<body>
<main>
  <div class="card">
    <div class="brand">🔐</div>
    <h1>Staff Console</h1>
    <p class="sub">Flat Coin Network · privileged access</p>
    <form id="f">
      <div class="field">
        <label for="identifier">Username</label>
        <input id="identifier" name="identifier" type="text" autocomplete="username" spellcheck="false" required />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
      </div>
      <p id="msg" class="msg hide"></p>
      <button id="btn" class="primary" type="submit">Sign in to console</button>
    </form>
    <p class="foot">Staff only. Customers use the <a href="/account">user portal</a>.</p>
    <noscript><p class="msg err">Staff sign-in needs JavaScript enabled.</p></noscript>
  </div>
</main>
<script>
  var form = document.getElementById('f');
  var msg = document.getElementById('msg');
  var btn = document.getElementById('btn');
  function say(text, good) {
    msg.textContent = text;
    msg.className = 'msg ' + (good ? 'ok' : 'err');
  }
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    msg.className = 'msg hide';
    btn.disabled = true;
    btn.textContent = 'Checking credentials…';
    try {
      var res = await fetch('/api/admin/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: document.getElementById('identifier').value,
          password: document.getElementById('password').value
        })
      });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Sign-in failed');
      window.location.href = ${JSON.stringify(safeNext)};
    } catch (error) {
      say(error.message, false);
      btn.disabled = false;
      btn.textContent = 'Sign in to console';
    }
  });
<\/script>
</body>
</html>`)
  })

  app.post('/api/admin/auth/login', async (c) => {
    try {
      if (!adminOriginAllowed(c)) return fail(c, 'Invalid or missing Origin', 403)
      const secret = c.env.AUTH_SECRET
      if (!configuredSecret(secret)) return fail(c, 'AUTH_SECRET not configured', 503)

      const body: any = await readLimitedJson(c, 4096)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(c, 'Invalid request body')
      const identifier = typeof body.identifier === 'string' ? body.identifier.trim().toLowerCase() : ''
      const legacyEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const login = (identifier || legacyEmail).slice(0, 120)
      const password = typeof body.password === 'string' ? body.password : ''
      if (!login || !password || password.length > 200) return fail(c, 'Username and password are required')

      const admin: any = await c.env.DB.prepare(
        `SELECT id, username, email, password_hash, role, active, must_change_password
         FROM admin_users WHERE lower(username) = ? OR (email IS NOT NULL AND lower(email) = ?)`,
      ).bind(login, login).first()

      const outcome = admin ? await verifyStoredAdminPassword(password, admin.password_hash) : 'invalid'
      if (!admin || outcome === 'invalid') {
        await writeAdminAudit(c.env, admin ? (admin as any) : null, 'admin.login_failed', admin?.id ?? null, {
          attempted: login,
          reason: admin ? 'bad_password' : 'unknown_account',
        })
        return fail(c, 'Wrong username or password', 401)
      }
      if (!admin.active) return fail(c, 'This staff account is disabled', 403)

      // Unsalted digests from the pre-console code stop existing on the first
      // good sign-in.
      if (outcome === 'legacy') {
        await c.env.DB.prepare(`UPDATE admin_users SET password_hash = ? WHERE id = ?`)
          .bind(await hashAdminPassword(password), admin.id).run()
      }

      const token = randomAdminToken()
      const tokenHash = await hashAdminSessionToken(token, secret)
      const sessionId = crypto.randomUUID()
      const agent = (c.req.header('User-Agent') || '').slice(0, 300)
      const expiresAt = adminSessionExpiryIso()

      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO admin_sessions (id, admin_id, token_hash, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)`,
        ).bind(sessionId, admin.id, tokenHash, agent, expiresAt),
        c.env.DB.prepare(
          `UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ).bind(admin.id),
      ])
      if (results[0].meta.changes !== 1) return fail(c, 'Could not open a staff session', 500)

      c.header('Set-Cookie', setAdminCookie(token, adminTransportIsSecure(c.req.url)))
      await writeAdminAudit(c.env, admin, 'admin.login', admin.id, {
        via: outcome === 'legacy' ? 'password_upgraded' : 'password',
        session_id: sessionId,
        expires_at: expiresAt,
      })

      return c.json({
        ok: true,
        admin: {
          id: admin.id,
          username: admin.username,
          email: admin.email ?? null,
          role: admin.role,
          must_change_password: Number(admin.must_change_password) === 1,
          session_days: ADMIN_SESSION_DAYS,
        },
      })
    } catch {
      return fail(c, 'Staff sign-in failed', 500)
    }
  })

  app.get('/api/admin/me', async (c) => {
    const admin = await currentAdmin(c)
    if (!admin) return jsonError(c, 'Authentication required', 401)
    return c.json({ admin })
  })

  app.post('/api/admin/auth/logout', async (c) => {
    const admin = await currentAdmin(c)
    const secret = c.env.AUTH_SECRET
    const token = adminCookieValue(c.req.header('Cookie'))
    if (admin && configuredSecret(secret) && token && token.length <= 128) {
      const tokenHash = await hashAdminSessionToken(token, secret)
      await c.env.DB.prepare(
        `UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL`,
      ).bind(tokenHash).run().catch(() => {})
      await writeAdminAudit(c.env, admin, 'admin.logout', admin.id, { session_revoked: true })
    }
    c.header('Set-Cookie', clearAdminCookie(adminTransportIsSecure(c.req.url)))
    return c.json({ ok: true })
  })
}
