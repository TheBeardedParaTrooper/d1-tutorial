import type { Hono } from 'hono'
import type { Bindings } from '../../env'
import { requireAdmin, type Admin } from '../../lib/auth/admin-auth'

// The staff console loads nothing third-party. Every pixel and every line of
// behaviour below is served by this worker, so a CDN compromise cannot reach a
// privileged session, and the page still works on a shutdown network.
export const CONSOLE_STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #020617; color: #e2e8f0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: #818cf8; text-decoration: none; }
.wrap { display: flex; min-height: 100vh; }
nav.side { width: 210px; flex: 0 0 210px; background: #0f172a; border-right: 1px solid #1e293b; padding: 16px 12px; display: flex; flex-direction: column; gap: 4px; }
.brandrow { display: flex; align-items: center; gap: 10px; padding: 4px 8px 14px; border-bottom: 1px solid #1e293b; margin-bottom: 10px; }
.brandrow .mark { width: 32px; height: 32px; border-radius: 10px; background: #dc2626; display: flex; align-items: center; justify-content: center; font-weight: 800; }
.brandrow b { font-size: 13px; color: #fff; display: block; }
.brandrow span { font-size: 11px; color: #64748b; }
.tab { text-align: left; background: transparent; border: 0; color: #94a3b8; padding: 9px 11px; border-radius: 11px; font-size: 13px; width: 100%; cursor: pointer; }
.tab:hover { background: #1e293b; color: #fff; }
.tab[aria-selected="true"] { background: #1e293b; color: #fff; font-weight: 700; }
.who { margin-top: auto; border-top: 1px solid #1e293b; padding-top: 12px; font-size: 11px; color: #64748b; }
.who b { color: #fff; font-size: 12px; }
main { flex: 1; padding: 22px 26px 60px; min-width: 0; }
.head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.head h1 { margin: 0; font-size: 20px; color: #fff; }
.head p { margin: 4px 0 0; font-size: 12px; color: #94a3b8; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 18px; }
.kpi { background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 14px 16px; }
.kpi small { display: block; font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: #64748b; font-weight: 700; }
.kpi b { display: block; font-size: 22px; margin-top: 4px; color: #fff; }
.kpi.good b { color: #34d399; } .kpi.warn b { color: #fbbf24; } .kpi.bad b { color: #fb7185; }
.card { background: #0f172a; border: 1px solid #1e293b; border-radius: 18px; padding: 16px; margin-bottom: 16px; }
.card h2 { margin: 0 0 12px; font-size: 14px; color: #fff; }
.card .hint { font-size: 11px; color: #64748b; margin: -6px 0 12px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.row > * { flex: 0 0 auto; }
.grow { flex: 1 1 200px !important; }
input, select, textarea { background: #020617; border: 1px solid #1e293b; border-radius: 10px; padding: 9px 10px; color: #e2e8f0; font: inherit; font-size: 13px; }
input:focus, select:focus, textarea:focus { outline: none; border-color: #6366f1; }
label.stack { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: #94a3b8; }
button.act { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 10px; padding: 7px 11px; font-size: 12px; cursor: pointer; }
button.act:hover { background: #334155; color: #fff; }
button.go { background: #4f46e5; color: #fff; border: 0; border-radius: 10px; padding: 9px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
button.go:hover { background: #6366f1; }
button.danger { background: #7f1d1d; color: #fecaca; border: 1px solid #991b1b; border-radius: 10px; padding: 7px 11px; font-size: 12px; cursor: pointer; }
button.danger:hover { background: #991b1b; }
button:disabled { opacity: .5; cursor: progress; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; padding: 8px 10px; color: #64748b; text-transform: uppercase; letter-spacing: .05em; font-size: 10px; border-bottom: 1px solid #1e293b; }
td { padding: 9px 10px; border-bottom: 1px solid #111a2b; vertical-align: middle; }
tbody tr:hover { background: #0b1220; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #94a3b8; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.pill.on { background: #052e1c; color: #4ade80; } .pill.off { background: #1e293b; color: #94a3b8; }
.pill.warn { background: #3b2f0b; color: #fcd34d; } .pill.bad { background: #3f1220; color: #fda4af; }
.pill.coin { background: #1e1b4b; color: #a5b4fc; }
.bars { display: flex; align-items: flex-end; gap: 6px; height: 120px; }
.bars div { flex: 1; background: #4f46e5; border-radius: 4px 4px 0 0; min-height: 2px; position: relative; }
.bars div span { position: absolute; bottom: -18px; left: 0; right: 0; text-align: center; font-size: 9px; color: #64748b; }
.notice { border-radius: 14px; padding: 12px 14px; font-size: 13px; margin-bottom: 16px; }
.notice.red { background: #3f1220; border: 1px solid #9f1239; color: #fecdd3; }
.notice.blue { background: #111c3a; border: 1px solid #26355f; color: #c7d2fe; }
#toast { position: fixed; right: 18px; top: 18px; z-index: 50; display: flex; flex-direction: column; gap: 8px; max-width: 380px; }
#toast div { background: #0f172a; border: 1px solid #334155; border-radius: 14px; padding: 11px 14px; font-size: 12px; box-shadow: 0 14px 34px rgba(2,6,23,.55); }
#toast div.ok { border-color: #14532d; color: #bbf7d0; }
#toast div.err { border-color: #9f1239; color: #fecdd3; }
.empty { padding: 26px; text-align: center; color: #64748b; font-size: 12px; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } nav.side { display: none; } }
`

// Deep links from the old console map onto the same tab set.
export const PANEL_ROUTES: Record<string, string> = {
  users: 'customers',
  orders: 'orders',
  sessions: 'hotspot',
  ledger: 'ledger',
  tiers: 'tiers',
  marketplace: 'marketplace',
  staff: 'staff',
  audit: 'audit',
  settings: 'settings',
  overview: 'overview',
}

export const CONSOLE_SCRIPT = String.raw`
var BOOT = window.__FLATCOIN_ADMIN__ || { admin: {}, initialTab: 'overview' };
var busy = false;

function el(id) { return document.getElementById(id); }
function money(n) { var v = Number(n || 0); return v.toLocaleString('en-US'); }
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function short(id) { var s = String(id || ''); return s.length > 14 ? s.slice(0, 8) + '…' + s.slice(-4) : s; }
function pill(text, kind) { return '<span class="pill ' + kind + '">' + esc(text) + '</span>'; }
function statusPill(value) {
  var v = String(value || '').toLowerCase();
  if (v === 'active' || v === 'paid' || v === 'on' || v === 'accepted' || v === 'true' || v === '1') return pill(v, 'on');
  if (v === 'pending' || v === 'draft' || v === 'unconfigured') return pill(v, 'warn');
  if (v === 'cancelled' || v === 'failed' || v === 'revoked' || v === 'declined' || v === 'expired' || v === 'false' || v === '0') return pill(v, 'bad');
  if (v === 'sold' || v === 'completed') return pill(v, 'coin');
  return pill(v || '—', 'off');
}

function toast(message, good) {
  var box = el('toast');
  var item = document.createElement('div');
  item.className = good ? 'ok' : 'err';
  item.textContent = message;
  box.appendChild(item);
  setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 5200);
}

async function callApi(path, options) {
  var init = options || {};
  var headers = { 'Accept': 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.key) headers['Idempotency-Key'] = init.key;
  var response = await fetch(path, {
    method: init.method || 'GET',
    credentials: 'same-origin',
    headers: headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  var payload = null;
  try { payload = await response.json(); } catch (e) { payload = null; }
  if (!response.ok) {
    var detail = payload && payload.error ? payload.error : 'HTTP ' + response.status;
    throw new Error(detail);
  }
  return payload;
}

function newKey(scope) {
  var rand = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
  return 'admin-' + scope + '-' + rand;
}

function val(id) { var node = el(id); return node ? node.value.trim() : ''; }
function num(id) { var raw = val(id); if (raw === '') return null; var n = Number(raw); return (isFinite(n) && Math.floor(n) === n) ? n : null; }

async function run(work) {
  if (busy) return;
  busy = true;
  var buttons = document.querySelectorAll('button[data-action]');
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
  try { await work(); } catch (error) { toast('✗ ' + error.message, false); }
  busy = false;
  for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
}

function tableOf(headers, rows, emptyText) {
  if (!rows.length) return '<div class="empty">' + esc(emptyText || 'Nothing here yet.') + '</div>';
  var html = '<div style="overflow-x:auto"><table><thead><tr>';
  for (var i = 0; i < headers.length; i++) html += '<th>' + esc(headers[i]) + '</th>';
  html += '</tr></thead><tbody>';
  for (var r = 0; r < rows.length; r++) {
    html += '<tr>';
    for (var c = 0; c < headers.length; c++) html += '<td>' + (rows[r][c] == null ? '' : rows[r][c]) + '</td>';
    html += '</tr>';
  }
  return html + '</tbody></table></div>';
}

function actionButton(action, label, id, extra, danger) {
  return '<button class="' + (danger ? 'danger' : 'act') + '" data-action="' + action + '"'
    + (id ? ' data-id="' + esc(id) + '"' : '')
    + (extra ? ' data-extra="' + esc(extra) + '"' : '') + '>' + esc(label) + '</button>';
}

var TABS = ['overview', 'customers', 'ledger', 'tiers', 'orders', 'hotspot', 'marketplace', 'staff', 'audit', 'settings'];
var TITLES = {
  overview: ['Network overview', 'Everything the portal and the router are doing right now.'],
  customers: ['Customers', 'Search, fund, correct, suspend and reset subscriber accounts.'],
  ledger: ['Money ledger', 'Every wallet movement on the network, newest first.'],
  tiers: ['Tiers', 'What the Plans tab of the portal sells. Changes are live immediately.'],
  orders: ['Payment orders', 'AzamPay and walk-in orders waiting to be settled.'],
  hotspot: ['Hotspot sessions', 'RADIUS passes bound to device addresses.'],
  marketplace: ['Marketplace moderation', 'Listings and quotations, including what sellers uploaded.'],
  staff: ['Staff accounts', 'Who may sign in here, and what each account is allowed to do.'],
  audit: ['Audit trail', 'The append-only outbox the offline exporter reads.'],
  settings: ['My access', 'Change your own username and password.'],
};

var state = { userQuery: '', ledgerType: '', orderStatus: '', itemStatus: '', sessionStatus: '', auditFilter: '', auditAfter: 0, auditEvents: [], focusUser: '' };

function setTab(tab) {
  if (TABS.indexOf(tab) < 0) tab = 'overview';
  location.hash = tab;
  renderTab(tab);
}

async function renderTab(tab) {
  var panel = el('panel');
  var meta = TITLES[tab] || TITLES.overview;
  el('tab-title').textContent = meta[0];
  el('tab-sub').textContent = meta[1];
  var buttons = document.querySelectorAll('.tab');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].setAttribute('aria-selected', buttons[i].getAttribute('data-tab') === tab ? 'true' : 'false');
  }
  panel.innerHTML = '<div class="empty">Loading…</div>';
  try {
    var html = await (loaders[tab] || loaders.overview)();
    panel.innerHTML = html;
    if (afterRender[tab]) afterRender[tab]();
  } catch (error) {
    panel.innerHTML = '<div class="notice red">✗ ' + esc(error.message) + '</div>';
  }
}

var afterRender = {};
var loaders = {};

loaders.overview = async function () {
  var data = await callApi('/api/admin/overview');
  var counts = data.counts;
  var kpi = function (label, value, kind) {
    return '<div class="kpi ' + (kind || '') + '"><small>' + esc(label) + '</small><b>' + esc(value) + '</b></div>';
  };
  var html = '';
  if (BOOT.admin.must_change_password) {
    html += '<div class="notice red">This account is still using the seeded password. Open <b>My access</b> and set a real one.</div>';
  }
  html += '<div class="kpis">'
    + kpi('Customers', money(counts.users), '')
    + kpi('Suspended', money(counts.suspended_users), counts.suspended_users ? 'bad' : '')
    + kpi('Wallet float', money(counts.wallet_float) + ' TZS', 'good')
    + kpi('Hotspot passes live', money(counts.hotspot_sessions), '')
    + kpi('Orders pending', money(counts.pending_orders), counts.pending_orders ? 'warn' : '')
    + kpi('Orders paid', money(counts.paid_orders), '')
    + kpi('Live listings', money(counts.live_listings), '')
    + kpi('Open quotations', money(counts.open_quotes), '')
    + kpi('Staff', money(counts.staff), '')
    + '</div>';

  var revenue = data.revenue || [];
  var max = 1;
  for (var i = 0; i < revenue.length; i++) max = Math.max(max, revenue[i].total);
  var bars = '';
  for (var b = 0; b < revenue.length; b++) {
    var pct = Math.max(2, Math.round((revenue[b].total / max) * 100));
    bars += '<div style="height:' + pct + '%" title="' + esc(revenue[b].day + ' · ' + money(revenue[b].total) + ' TZS') + '"><span>' + esc(String(revenue[b].day).slice(5)) + '</span></div>';
  }
  html += '<div class="card"><h2>Settled value, last 7 days</h2>'
    + (bars ? '<div class="bars">' + bars + '</div><div style="height:18px"></div>' : '<div class="empty">No ledger activity in the window.</div>')
    + '</div>';

  var ledgerRows = (data.ledger || []).map(function (row) {
    return [esc(row.type), money(row.n), money(row.total) + ' TZS'];
  });
  html += '<div class="split">'
    + '<div class="card"><h2>Ledger by type</h2>' + tableOf(['Type', 'Entries', 'Total'], ledgerRows, 'No transactions yet.') + '</div>'
    + '<div class="card"><h2>Latest audit events</h2>' + tableOf(['#', 'Event', 'Who', 'When'], (data.recent_events || []).map(function (e) {
        return [esc(e.event_id), '<span class="mono">' + esc(e.event_type) + '</span>',
          esc(e.admin_username || e.actor_user_id || 'system'), '<span class="mono">' + esc(e.created_at) + '</span>'];
      }), 'Nothing recorded yet.') + '</div>'
    + '</div>';
  return html;
};

loaders.customers = async function () {
  var query = encodeURIComponent(state.userQuery);
  var data = await callApi('/api/admin/users?q=' + query + '&limit=60');
  var rows = data.users.map(function (u) {
    var name = u.full_name || '—';
    var handle = u.username ? '@' + u.username : '';
    return [
      '<b>' + esc(name) + '</b><div class="mono">' + esc(handle) + '</div>',
      '<span class="mono">' + esc(u.phone_number) + '</span>',
      money(u.balance) + ' TZS',
      u.active ? pill('live', 'on') : pill('suspended', 'bad'),
      money(u.tx_count) + ' · ' + money(u.listings_count),
      '<div class="row">' + actionButton('openUser', 'Open', u.id)
        + actionButton('credit', 'Credit', u.id)
        + actionButton('debit', 'Debit', u.id)
        + (u.active ? actionButton('suspend', 'Suspend', u.id, '', true) : actionButton('reinstate', 'Reinstate', u.id))
        + '</div>',
    ];
  });
  var html = '<div class="card"><div class="row">'
    + '<input id="user-q" class="grow" placeholder="name, @username, phone or id" value="' + esc(state.userQuery) + '">'
    + '<button class="go" data-action="searchUsers">Search</button>'
    + '<button class="act" data-action="clearUserQuery">Clear</button>'
    + '</div><div class="hint" style="margin-top:10px">' + money(data.users.length) + ' customers shown. Credit and debit need an Idempotency-Key, generated per click, so a double click cannot pay twice.</div>'
    + tableOf(['Customer', 'Number', 'Wallet', 'State', 'Tx · Listings', 'Actions'], rows, 'No customer matches that search.')
    + '</div>';

  if (state.focusUser) {
    html += '<div id="user-detail">' + await customerDetail(state.focusUser) + '</div>';
  }
  return html;
};

async function customerDetail(id) {
  var data = await callApi('/api/admin/users/' + encodeURIComponent(id));
  var u = data.user;
  var html = '<div class="card"><h2>' + esc(u.full_name || 'Customer') + ' · ' + esc(u.phone_number) + '</h2>';
  html += '<div class="row" style="margin-bottom:12px">'
    + '<span class="mono">' + esc(u.id) + '</span>'
    + (u.username ? pill('@' + u.username, 'coin') : '')
    + (u.active ? pill('account live', 'on') : pill('suspended', 'bad'))
    + pill('wallet ' + money(u.balance) + ' TZS', 'on')
    + '</div>';

  html += '<div class="row" style="margin-bottom:14px">'
    + '<label class="stack">TZS<input id="detail-amount" type="number" min="1" step="1" placeholder="amount"></label>'
    + '<label class="stack">Note<input id="detail-note" placeholder="why, for the audit trail"></label>'
    + actionButton('creditDetail', 'Credit wallet', u.id)
    + actionButton('debitDetail', 'Correct wallet', u.id, '', true)
    + actionButton('openUser', 'Refresh', u.id)
    + '</div>';

  var tx = data.transactions.map(function (t) {
    return ['<span class="mono">' + esc(t.created_at) + '</span>', esc(t.type), money(t.amount) + ' TZS', statusPill(t.status), '<span class="mono">' + esc(t.reference_id || '') + '</span>'];
  });
  html += '<h2 style="font-size:13px;margin:16px 0 8px">Ledger</h2>' + tableOf(['When', 'Type', 'Amount', 'Status', 'Reference'], tx, 'No wallet movement yet.');

  var passes = data.access_sessions.map(function (s) {
    return ['<span class="mono">' + esc(s.mac_address) + '</span>', '<span class="mono">' + esc(s.token) + '</span>', money(s.duration_hours) + ' h', statusPill(s.status), '<span class="mono">' + esc(s.expires_at) + '</span>',
      s.status === 'active' ? actionButton('revokeSession', 'Revoke', s.id, '', true) : ''];
  });
  html += '<h2 style="font-size:13px;margin:16px 0 8px">Hotspot passes</h2>' + tableOf(['Device', 'RADIUS token', 'Hours', 'State', 'Expires', ''], passes, 'This customer has never bought a pass.');

  var listings = data.listings.map(function (l) {
    return ['<span class="mono">' + esc(l.created_at) + '</span>', esc(l.title), esc(l.kind), money(l.price) + ' TZS', statusPill(l.status),
      (l.status === 'active' || l.status === 'draft') ? actionButton('takedown', 'Take down', l.id, '', true) : ''];
  });
  html += '<h2 style="font-size:13px;margin:16px 0 8px">Listings</h2>' + tableOf(['Created', 'Title', 'Kind', 'Price', 'State', ''], listings, 'Sells nothing on the mesh.');

  var logins = data.auth_sessions.map(function (s) {
    return ['<span class="mono">' + esc(s.created_at) + '</span>', '<span class="mono">' + esc(s.expires_at) + '</span>', s.revoked_at ? pill('revoked', 'bad') : pill('signed in', 'on')];
  });
  html += '<h2 style="font-size:13px;margin:16px 0 8px">Portal sign-ins</h2>' + tableOf(['Started', 'Expires', 'State'], logins, 'No live portal sessions.');

  var events = data.events.map(function (e) {
    return [esc(e.event_id), '<span class="mono">' + esc(e.event_type) + '</span>', esc(e.admin_username || e.actor_user_id || 'system'),
      '<span class="mono">' + esc(e.created_at) + '</span>', '<span class="mono">' + esc(JSON.stringify(e.details)) + '</span>'];
  });
  html += '<h2 style="font-size:13px;margin:16px 0 8px">Audit trail</h2>' + tableOf(['#', 'Event', 'Actor', 'When', 'Details'], events, 'Nothing recorded for this account.');

  if (BOOT.admin.role === 'super_admin') {
    html += '<div class="row" style="margin-top:16px">'
      + '<label class="stack">New portal password (12+)<input id="reset-password" type="text" placeholder="temporary password"></label>'
      + actionButton('resetUserPassword', 'Reset password & sign out', u.id, '', true)
      + '</div>';
  }
  return html + '</div>';
}

function currentTab() {
  var tab = String(location.hash || '').replace('#', '');
  return TABS.indexOf(tab) >= 0 ? tab : 'overview';
}

async function refresh() {
  await renderTab(currentTab());
}

// ---------- panels that write ----------

loaders.tiers = async function () {
  var data = await callApi('/api/admin/tiers');
  var rows = data.tiers.map(function (t) {
    return [
      '<b>' + esc(t.name) + '</b><div class="mono">' + esc(t.id) + '</div>',
      money(t.duration_hours) + ' h',
      '<input id="tier-price-' + esc(t.id) + '" type="number" min="1" step="1" value="' + money0(t.price) + '" style="width:110px">',
      '<label class="stack">Hours<input id="tier-hours-' + esc(t.id) + '" type="number" min="1" max="8760" value="' + money0(t.duration_hours) + '" style="width:80px"></label>',
      t.active ? pill('on sale', 'on') : pill('archived', 'off'),
      '<div class="row">' + actionButton('saveTier', 'Save', t.id)
        + (t.active ? actionButton('hideTier', 'Hide from portal', t.id, '', true) : actionButton('showTier', 'Put back on portal', t.id))
        + '</div>',
    ];
  });
  return '<div class="card"><h2>New tier</h2><div class="hint">Saving this changes the Plans tab of the portal for every customer, immediately.</div>'
    + '<div class="row">'
    + '<label class="stack">Name<input id="tier-name" placeholder="e.g. Night owl 12h"></label>'
    + '<label class="stack">Hours<input id="tier-hours" type="number" min="1" max="8760" value="12" style="width:90px"></label>'
    + '<label class="stack">Price TZS<input id="tier-price" type="number" min="1" step="1" value="1500" style="width:120px"></label>'
    + '<button class="go" data-action="createTier">Create tier</button>'
    + '</div></div>'
    + '<div class="card"><h2>All tiers</h2>' + tableOf(['Tier', 'Duration', 'Price', 'Duration hours', 'Portal', 'Actions'], rows, 'No tiers configured.') + '</div>';
};

loaders.orders = async function () {
  var data = await callApi('/api/admin/orders?status=' + encodeURIComponent(state.orderStatus) + '&limit=60');
  var rows = data.orders.map(function (o) {
    return [
      '<span class="mono">' + esc(o.created_at) + '</span>',
      '<b>' + esc(o.username ? '@' + o.username : o.phone_number) + '</b><div class="mono">' + esc(o.package_name) + '</div>',
      money(o.expected_amount) + ' TZS',
      statusPill(o.status),
      '<span class="mono">' + esc(o.provider_state || '') + '</span>',
      '<div class="row">' + (o.status === 'pending' ? actionButton('settle', 'Settle by hand', o.merchant_id) : '')
        + '<button class="act" data-action="openUser" data-id="' + esc(o.user_id) + '">Customer</button></div>',
    ];
  });
  return '<div class="card"><div class="row">'
    + '<label class="stack">Status<select id="order-status"><option value="">all</option><option value="pending">pending</option><option value="paid">paid</option><option value="failed">failed</option><option value="cancelled">cancelled</option></select></label>'
    + '<button class="go" data-action="filterOrders">Apply</button>'
    + '<label class="stack" style="justify-content:flex-end"><span>&nbsp;</span><button class="act" data-action="refresh">Reload</button></label>'
    + '</div>'
    + '<div class="hint" style="margin-top:10px">Settling marks the order paid, credits the wallet with an audited DEPOSIT_MANUAL entry and locks the order forward. Use it for cash taken at a shop.</div>'
    + tableOf(['Created', 'Customer · tier', 'Amount', 'Status', 'Provider', 'Actions'], rows, 'No orders in this state.')
    + '</div>';
};

loaders.hotspot = async function () {
  var data = await callApi('/api/admin/sessions?status=' + encodeURIComponent(state.sessionStatus) + '&limit=80');
  var tiers = await callApi('/api/admin/tiers');
  var options = tiers.tiers.map(function (t) {
    return '<option value="' + esc(t.id) + '">' + esc(t.name) + ' · ' + money(t.price) + ' TZS · ' + money0(t.duration_hours) + ' h</option>';
  }).join('');
  var rows = data.sessions.map(function (s) {
    return [
      '<b>' + esc(s.full_name || '—') + '</b><div class="mono">' + esc(s.username ? '@' + s.username : s.phone_number) + '</div>',
      '<span class="mono">' + esc(s.mac_address) + '</span>',
      '<span class="mono">' + esc(s.token) + '</span>',
      money(s.duration_hours) + ' h',
      statusPill(s.status),
      '<span class="mono">' + esc(s.expires_at) + '</span>',
      s.status === 'active' ? actionButton('revokeSession', 'Revoke', s.id, '', true) : '',
    ];
  });
  return '<div class="card"><h2>Issue a pass (walk-in sale)</h2>'
    + '<div class="hint">Creates a RADIUS session bound to the device. Charging the wallet pulls the tier price from the customer balance.</div>'
    + '<div class="row">'
    + '<label class="stack">Customer<input id="pass-user" placeholder="@username, phone or id"></label>'
    + '<label class="stack">Tier<select id="pass-tier"><option value="">select…</option>' + options + '</select></label>'
    + '<label class="stack">Device MAC<input id="pass-mac" placeholder="AA:BB:CC:DD:EE:FF"></label>'
    + '<label class="stack">Pay from wallet<select id="pass-charge"><option value="1">yes, debit the wallet</option><option value="0">no, grant it</option></select></label>'
    + '<button class="go" data-action="issuePass">Issue pass</button>'
    + '</div></div>'
    + '<div class="card"><div class="row">'
    + '<label class="stack">Status<select id="session-status"><option value="">all</option><option value="active">active</option><option value="expired">expired</option><option value="revoked">revoked</option></select></label>'
    + '<button class="go" data-action="filterSessions">Apply</button></div>'
    + tableOf(['Customer', 'Device', 'Token', 'Hours', 'State', 'Expires', 'Actions'], rows, 'No hotspot sessions yet.')
    + '</div>';
};

loaders.ledger = async function () {
  var data = await callApi('/api/admin/ledger?limit=120&type=' + encodeURIComponent(state.ledgerType));
  var rows = data.transactions.map(function (t) {
    return [
      '<span class="mono">' + esc(t.created_at) + '</span>',
      '<b>' + esc(t.username ? '@' + t.username : t.phone_number) + '</b>',
      esc(t.type),
      money(t.amount) + ' TZS',
      statusPill(t.status),
      '<span class="mono">' + esc(t.reference_id || '') + '</span>',
      '<button class="act" data-action="openUser" data-id="' + esc(t.user_id) + '">Customer</button>',
    ];
  });
  return '<div class="card"><div class="row">'
    + '<label class="stack">Type<input id="ledger-type" placeholder="ADMIN_CREDIT, MARKETPLACE_BUY…" value="' + esc(state.ledgerType) + '"></label>'
    + '<button class="go" data-action="filterLedger">Filter</button>'
    + '<button class="act" data-action="clearLedger">Clear</button></div>'
    + '<div class="hint" style="margin-top:10px">' + money(rows.length) + ' entries. Amounts are whole TZS; the database refuses fractions and negatives.</div>'
    + tableOf(['When', 'Customer', 'Type', 'Amount', 'Status', 'Reference', ''], rows, 'Nothing in the ledger for that filter.')
    + '</div>';
};

loaders.marketplace = async function () {
  var data = await callApi('/api/admin/marketplace?status=' + encodeURIComponent(state.itemStatus) + '&limit=80');
  var rows = data.items.map(function (i) {
    var file = i.asset_id
      ? (i.purpose === 'image' ? '🖼 ' : '📄 ') + esc(i.file_name) + '<div class="mono">' + esc(String(i.size_bytes)) + ' B · ' + esc(String(i.sha256).slice(0, 12)) + '</div>'
      : '<span class="mono">no file</span>';
    return [
      '<span class="mono">' + esc(i.created_at) + '</span>',
      '<b>' + esc(i.title) + '</b><div class="mono">' + esc(i.kind) + ' · ' + esc(i.seller_username ? '@' + i.seller_username : i.seller_id) + '</div>',
      money(i.price) + ' TZS',
      file,
      (i.pay_wallet ? pill('wallet', 'on') : '') + ' ' + (i.pay_mobile_money ? pill('mobile money', 'coin') : ''),
      statusPill(i.status),
      (i.status === 'active' || i.status === 'draft') ? actionButton('takedown', 'Take down', i.id, '', true) : '',
    ];
  });
  var quotes = data.quotes.map(function (q) {
    return [
      '<span class="mono">' + esc(q.created_at) + '</span>',
      esc(q.item_title),
      '<b>@' + esc(q.buyer_username || '') + '</b> → <b>@' + esc(q.seller_username || '') + '</b>',
      money(q.requested_price) + ' TZS' + (q.accepted_price ? '<div class="mono">agreed ' + money(q.accepted_price) + '</div>' : ''),
      statusPill(q.status),
      '<span class="mono">' + esc(q.message || '') + '</span>',
      (q.status === 'pending' || q.status === 'accepted') ? actionButton('expireQuote', 'Close', q.id, '', true) : '',
    ];
  });
  return '<div class="card"><div class="row">'
    + '<label class="stack">Listing state<select id="item-status"><option value="">all</option><option value="draft">draft</option><option value="active">active</option><option value="sold">sold</option><option value="cancelled">cancelled</option></select></label>'
    + '<button class="go" data-action="filterItems">Apply</button></div>'
    + '<div class="hint" style="margin-top:10px">Taking a listing down cancels it. Sold and cancelled rows are frozen by database triggers, so a takedown can never rewrite settled trade.</div>'
    + tableOf(['Created', 'Listing', 'Price', 'File', 'Pays', 'State', 'Actions'], rows, 'No listings in that state.')
    + '</div><div class="card"><h2>Quotations</h2>'
    + tableOf(['Created', 'Item', 'Buyer → Seller', 'Offer', 'State', 'Message', 'Actions'], quotes, 'Nobody has asked for a quotation yet.')
    + '</div>';
};

loaders.staff = async function () {
  if (BOOT.admin.role === 'viewer') {
    return '<div class="notice blue">Staff accounts are managed by a super admin. Your role is read-only.</div>';
  }
  var data = await callApi('/api/admin/staff');
  var rows = data.staff.map(function (s) {
    return [
      '<b>' + esc(s.username) + '</b><div class="mono">' + esc(s.full_name || '') + '</div>',
      pill(s.role, s.role === 'super_admin' ? 'coin' : 'off'),
      s.active ? pill('enabled', 'on') : pill('disabled', 'bad'),
      s.must_change_password ? pill('default password', 'warn') : pill('rotated', 'on'),
      '<span class="mono">' + esc(s.last_login_at || 'never') + '</span>',
      money(s.live_sessions) + ' live',
      '<div class="row">'
        + '<input id="staff-pw-' + esc(s.id) + '" type="text" placeholder="reset password" style="width:150px">'
        + actionButton('resetStaffPassword', 'Set', s.id)
        + (s.id === BOOT.admin.id ? '' : (s.active ? actionButton('disableStaff', 'Disable', s.id, '', true) : actionButton('enableStaff', 'Enable', s.id)))
        + '</div>',
    ];
  });
  var sessions = data.sessions.map(function (s) {
    return ['<b>@' + esc(s.username) + '</b>', '<span class="mono">' + esc(s.created_at) + '</span>', '<span class="mono">' + esc(s.expires_at) + '</span>',
      s.revoked_at ? pill('revoked', 'bad') : pill('signed in', 'on'), '<span class="mono">' + esc(s.user_agent || '') + '</span>'];
  });
  return '<div class="card"><h2>Add a staff account</h2>'
    + '<div class="hint">viewers read, operators act on customers and money, super admins also manage staff and tiers.</div>'
    + '<div class="row">'
    + '<label class="stack">Username<input id="staff-username" placeholder="lowercase, 1-30"></label>'
    + '<label class="stack">Full name<input id="staff-name"></label>'
    + '<label class="stack">Role<select id="staff-role"><option value="operator">operator</option><option value="viewer">viewer</option><option value="super_admin">super_admin</option></select></label>'
    + '<label class="stack">Password<input id="staff-password" type="text" placeholder="8+ characters"></label>'
    + '<button class="go" data-action="createStaff">Create account</button>'
    + '</div></div>'
    + '<div class="card"><h2>Accounts</h2>' + tableOf(['Who', 'Role', 'State', 'Password', 'Last sign-in', 'Sessions', 'Actions'], rows, 'No staff accounts.') + '</div>'
    + '<div class="card"><h2>Console sessions</h2>' + tableOf(['Account', 'Started', 'Expires', 'State', 'Agent'], sessions, 'No sessions recorded.') + '</div>';
};

loaders.audit = async function () {
  var data = await callApi('/api/admin/audit/events?after_id=0&limit=200&event_type=' + encodeURIComponent(state.auditFilter || ''));
  state.auditEvents = data.events;
  var rows = data.events.slice().reverse().map(function (e) {
    var actor = e.admin_username ? '@' + e.admin_username + ' (staff)' : (e.actor_user_id || 'system');
    return [
      esc(e.event_id),
      '<span class="mono">' + esc(e.event_type) + '</span>',
      esc(actor),
      '<span class="mono">' + esc(e.target_id || '') + '</span>',
      '<span class="mono">' + esc(e.created_at) + '</span>',
      '<div class="mono" style="max-width:460px;overflow-wrap:anywhere">' + esc(JSON.stringify(e.details)) + '</div>',
    ];
  });
  return '<div class="card"><div class="row">'
    + '<label class="stack">Event type<input id="audit-filter" placeholder="admin.wallet_credit, user.login…" value="' + esc(state.auditFilter || '') + '"></label>'
    + '<button class="go" data-action="filterAudit">Filter</button>'
    + '<button class="act" data-action="refresh">Reload</button></div>'
    + '<div class="hint" style="margin-top:10px">' + money(rows.length) + ' newest events, highest id last. Rows in this table cannot be updated or deleted in the database, and scripts/sync_audit.py mirrors them into a hash-chained copy.</div>'
    + tableOf(['#', 'Event', 'Actor', 'Target', 'When', 'Details'], rows, 'No events for that filter.')
    + '</div>';
};

loaders.settings = async function () {
  var a = BOOT.admin;
  return '<div class="card"><h2>Current session</h2>'
    + '<div class="row"><span class="mono">id ' + esc(a.id) + '</span>' + pill('@' + a.username, 'coin') + pill(a.role, 'off')
    + (a.must_change_password ? pill('still using the seeded password', 'warn') : pill('password rotated', 'on')) + '</div>'
    + '<div class="hint" style="margin-top:8px">The session cookie is HttpOnly, SameSite=Strict and expires with the staff session row, which can be revoked but never deleted.</div></div>'
    + '<div class="split">'
    + '<div class="card"><h2>Change password</h2><div class="hint">At least 8 characters, not the username, and not the seeded default. Other machines are signed out.</div>'
    + '<label class="stack">Current password<input id="pw-current" type="password" autocomplete="current-password"></label>'
    + '<label class="stack" style="margin-top:8px">New password<input id="pw-next" type="password" autocomplete="new-password"></label>'
    + '<div style="margin-top:12px"><button class="go" data-action="savePassword">Update password</button></div></div>'
    + '<div class="card"><h2>Change sign-in name</h2><div class="hint">1-30 letters, digits or underscore. Needs your password.</div>'
    + '<label class="stack">New username<input id="new-username" autocomplete="off"></label>'
    + '<label class="stack" style="margin-top:8px">Password<input id="username-password" type="password" autocomplete="current-password"></label>'
    + '<div style="margin-top:12px"><button class="go" data-action="saveUsername">Update username</button></div></div>'
    + '</div>'
    + '<div class="card"><h2>Open the customer portal</h2><div class="row">'
    + '<a class="act" style="border:1px solid #334155;border-radius:10px;padding:7px 11px;font-size:12px" href="/landing">Portal</a>'
    + '<a class="act" style="border:1px solid #334155;border-radius:10px;padding:7px 11px;font-size:12px" href="/account">Sign-in page</a>'
    + '<a class="act" style="border:1px solid #334155;border-radius:10px;padding:7px 11px;font-size:12px" href="/api/meta/catalog">API catalog</a>'
    + '</div></div>';
};

function money0(value) { return String(Number(value || 0)); }

// ---------- actions ----------

var actions = {
  refresh: function () { return refresh(); },

  searchUsers: function () { state.userQuery = val('user-q'); state.focusUser = ''; return refresh(); },
  clearUserQuery: function () { state.userQuery = ''; state.focusUser = ''; return refresh(); },
  openUser: function (id) { state.focusUser = id; return refresh(); },

  credit: function (id) { state.focusUser = id; return refresh(); },
  debit: function (id) { state.focusUser = id; return refresh(); },

  creditDetail: async function (id) {
    var amount = num('detail-amount');
    if (!amount || amount < 1) throw new Error('Enter a whole TZS amount first');
    var result = await callApi('/api/admin/wallet/credit', {
      method: 'POST',
      key: newKey('credit'),
      body: { user: id, amount: amount, note: val('detail-note') },
    });
    toast('✓ Credited ' + money(result.credit.amount) + ' TZS · wallet now ' + money(result.credit.balance), true);
    state.focusUser = id;
    return refresh();
  },

  debitDetail: async function (id) {
    var amount = num('detail-amount');
    if (!amount || amount < 1) throw new Error('Enter a whole TZS amount first');
    var result = await callApi('/api/admin/wallet/debit', {
      method: 'POST',
      key: newKey('debit'),
      body: { user: id, amount: amount, note: val('detail-note') },
    });
    toast('✓ Corrected ' + money(result.debit.amount) + ' TZS · wallet now ' + money(result.debit.balance), true);
    state.focusUser = id;
    return refresh();
  },

  suspend: async function (id) {
    await callApi('/api/admin/users/' + encodeURIComponent(id) + '/status', {
      method: 'POST', body: { active: false, reason: 'suspended from the customers table' },
    });
    toast('✓ Customer suspended and signed out of the portal', true);
    state.focusUser = id;
    return refresh();
  },

  reinstate: async function (id) {
    await callApi('/api/admin/users/' + encodeURIComponent(id) + '/status', {
      method: 'POST', body: { active: true, reason: 'reinstated from the customers table' },
    });
    toast('✓ Customer reinstated', true);
    return refresh();
  },

  resetUserPassword: async function (id) {
    var password = val('reset-password');
    if (password.length < 12) throw new Error('Temporary passwords need at least 12 characters');
    var result = await callApi('/api/admin/users/' + encodeURIComponent(id) + '/password', {
      method: 'POST', body: { password: password },
    });
    toast('✓ Password set, ' + money(result.revoked_logins) + ' portal session(s) revoked', true);
    return refresh();
  },

  revokeSession: async function (id) {
    await callApi('/api/admin/sessions/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: {} });
    toast('✓ Hotspot pass revoked', true);
    return refresh();
  },

  issuePass: async function () {
    var user = val('pass-user');
    var mac = val('pass-mac');
    var tier = val('pass-tier');
    if (!user || !mac || !tier) throw new Error('Customer, tier and device MAC are all required');
    var result = await callApi('/api/admin/passes/issue', {
      method: 'POST',
      key: newKey('pass'),
      body: { user: user, package_id: tier, mac_address: mac, charge_wallet: val('pass-charge') === '1' },
    });
    toast('✓ Pass issued · token ' + result.session.radius_token.slice(0, 10) + '…', true);
    return refresh();
  },

  createTier: async function () {
    var price = num('tier-price');
    var hours = num('tier-hours');
    await callApi('/api/admin/tiers', {
      method: 'POST', body: { name: val('tier-name'), duration_hours: hours, price: price },
    });
    toast('✓ Tier created and on sale in the portal', true);
    return refresh();
  },

  saveTier: async function (id) {
    await callApi('/api/admin/tiers/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: { price: num('tier-price-' + id), duration_hours: num('tier-hours-' + id) },
    });
    toast('✓ Tier updated', true);
    return refresh();
  },

  hideTier: async function (id) {
    await callApi('/api/admin/tiers/' + encodeURIComponent(id), { method: 'PATCH', body: { active: false } });
    toast('✓ Hidden from the portal Plans tab', true);
    return refresh();
  },

  showTier: async function (id) {
    await callApi('/api/admin/tiers/' + encodeURIComponent(id), { method: 'PATCH', body: { active: true } });
    toast('✓ Back on sale in the portal', true);
    return refresh();
  },

  settle: async function (id) {
    await callApi('/api/admin/orders/' + encodeURIComponent(id) + '/settle', {
      method: 'POST',
      key: newKey('settle'),
      body: { reference: 'staff console · ' + BOOT.admin.username, credit_wallet: true },
    });
    toast('✓ Order settled and wallet credited', true);
    return refresh();
  },

  filterOrders: function () { state.orderStatus = val('order-status'); return refresh(); },
  filterSessions: function () { state.sessionStatus = val('session-status'); return refresh(); },
  filterItems: function () { state.itemStatus = val('item-status'); return refresh(); },
  filterLedger: function () { state.ledgerType = val('ledger-type'); return refresh(); },
  clearLedger: function () { state.ledgerType = ''; return refresh(); },
  filterAudit: function () { state.auditFilter = val('audit-filter'); return refresh(); },

  takedown: async function (id) {
    await callApi('/api/admin/marketplace/items/' + encodeURIComponent(id) + '/takedown', {
      method: 'POST', body: { reason: 'removed by ' + BOOT.admin.username },
    });
    toast('✓ Listing taken down', true);
    return refresh();
  },

  expireQuote: async function (id) {
    await callApi('/api/admin/marketplace/quotes/' + encodeURIComponent(id) + '/expire', {
      method: 'POST', body: { reason: 'closed by ' + BOOT.admin.username },
    });
    toast('✓ Quotation closed', true);
    return refresh();
  },

  createStaff: async function () {
    await callApi('/api/admin/staff', {
      method: 'POST',
      body: {
        username: val('staff-username'),
        full_name: val('staff-name'),
        role: val('staff-role'),
        password: val('staff-password'),
      },
    });
    toast('✓ Staff account created', true);
    return refresh();
  },

  resetStaffPassword: async function (id) {
    var password = val('staff-pw-' + id);
    await callApi('/api/admin/staff/' + encodeURIComponent(id) + '/password', {
      method: 'POST', body: { password: password },
    });
    toast('✓ Password set, that account signed out everywhere', true);
    return refresh();
  },

  disableStaff: async function (id) {
    await callApi('/api/admin/staff/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { active: false } });
    toast('✓ Staff account disabled', true);
    return refresh();
  },

  enableStaff: async function (id) {
    await callApi('/api/admin/staff/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { active: true } });
    toast('✓ Staff account enabled', true);
    return refresh();
  },

  savePassword: async function () {
    await callApi('/api/admin/settings/password', {
      method: 'POST', body: { current_password: val('pw-current'), new_password: val('pw-next') },
    });
    toast('✓ Password changed. Sign in again on other machines.', true);
    window.location.href = '/admin/login';
  },

  saveUsername: async function () {
    var result = await callApi('/api/admin/settings/username', {
      method: 'POST', body: { username: val('new-username'), password: val('username-password') },
    });
    BOOT.admin.username = result.username;
    BOOT.admin.must_change_password = false;
    el('who-name').textContent = '@' + result.username;
    toast('✓ You now sign in as @' + result.username, true);
    return refresh();
  },

  signOut: async function () {
    await callApi('/api/admin/auth/logout', { method: 'POST', body: {} });
    window.location.href = '/admin/login';
  },
};

document.addEventListener('click', function (event) {
  var trigger = event.target.closest ? event.target.closest('button[data-action], a[data-action]') : null;
  if (!trigger) return;
  var handler = actions[trigger.getAttribute('data-action')];
  if (!handler) return;
  event.preventDefault();
  run(function () {
    return handler(trigger.getAttribute('data-id'), trigger.getAttribute('data-extra'));
  });
});

window.addEventListener('hashchange', function () { renderTab(currentTab()); });

document.addEventListener('DOMContentLoaded', function () {
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function (event) {
      setTab(event.currentTarget.getAttribute('data-tab'));
    });
  }
  el('who-name').textContent = '@' + (BOOT.admin.username || 'staff');
  el('who-role').textContent = BOOT.admin.role || '';
  renderTab(currentTab());
});
`

