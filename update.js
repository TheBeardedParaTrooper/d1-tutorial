const fs = require('fs');
const code = `export interface Env {
    DB: D1Database;
}

const USER_PORTAL = \`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flat Coin ISP | User Portal</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-6">
    <div class="max-w-xl mx-auto space-y-6">
        <header class="flex justify-between items-center border-b border-slate-800 pb-4">
            <h1 class="text-xl font-bold text-emerald-400">⚡ Flat Coin ISP Node</h1>
            <span class="text-xs bg-emerald-950 text-emerald-300 px-2 py-1 rounded-full border border-emerald-800">Online</span>
        </header>

        <!-- Wallet Card -->
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg flex justify-between items-center">
            <div>
                <p class="text-xs text-slate-400 uppercase tracking-wider">Your Balance</p>
                <h2 id="user-balance" class="text-2xl font-black text-emerald-400">0.00 Coins</h2>
            </div>
            <button onclick="loadUserData()" class="bg-slate-800 hover:bg-slate-700 text-xs px-3 py-2 rounded-lg border border-slate-700 transition">Refresh</button>
        </div>

        <!-- Tab 1: Access Tiers -->
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-3">
            <h2 class="text-sm font-semibold text-slate-300 uppercase tracking-wider">1. Internet Access Passes</h2>
            <div class="grid grid-cols-2 gap-3">
                <button onclick="buyTier('tier_1')" class="bg-slate-800 hover:bg-emerald-600 transition p-3 rounded-lg text-left border border-slate-700">
                    <div class="font-bold text-sm">6 Hours</div>
                    <div class="text-xs text-emerald-400">500 Tsh</div>
                </button>
                <button onclick="buyTier('tier_2')" class="bg-slate-800 hover:bg-emerald-600 transition p-3 rounded-lg text-left border border-slate-700">
                    <div class="font-bold text-sm">24 Hours</div>
                    <div class="text-xs text-emerald-400">1,000 Tsh</div>
                </button>
            </div>
        </div>

        <!-- Tab 2: Marketplace -->
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-3">
            <h2 class="text-sm font-semibold text-slate-300 uppercase tracking-wider">2. Marketplace & Digital Files</h2>
            <div id="marketplace-list" class="space-y-2 text-xs text-slate-400">
                <p>Loading active network listings...</p>
            </div>
        </div>
    </div>
    <script>
        async function loadUserData() {
            // Placeholder for fetching user balance and items
            document.getElementById('user-balance').innerText = '1,500.00 Coins';
        }
        async function buyTier(tierId) {
            alert('Buying tier: ' + tierId);
        }
        loadUserData();
    </script>
</body>
</html>\`;

const ADMIN_PANEL = \`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <title>Flat Coin ISP | Admin Panel</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-red-950 text-slate-100 min-h-screen p-8">
    <div class="max-w-4xl mx-auto space-y-6">
        <h1 class="text-2xl font-black text-red-400">🛡️ Admin Control Panel</h1>
        <p class="text-slate-300 text-sm">Full administrative oversight over user wallets, network sessions, and ledger auditing.</p>
        <div class="bg-slate-900 border border-red-900 p-6 rounded-xl">
            <p class="text-xs text-slate-400">System database active and healthy.</p>
        </div>
    </div>
</body>
</html>\`;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // UI Routes
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/portal')) {
            return new Response(USER_PORTAL, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        }
        if (request.method === 'GET' && url.pathname === '/admin') {
            return new Response(ADMIN_PANEL, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
        }

        // --- TAB 1: WALLET & ACCESS APIs ---
        if (request.method === 'GET' && url.pathname.startsWith('/api/wallet/')) {
            const userId = url.pathname.split('/').pop();
            const wallet = await env.DB.prepare('SELECT balance FROM wallets WHERE user_id = ?').bind(userId).first();
            return Response.json({ success: true, balance: wallet ? wallet.balance : 0 });
        }

        if (request.method === 'POST' && url.pathname === '/api/transfer') {
            try {
                const { sender_id, recipient_id, amount } = await request.json();
                await env.DB.batch([
                    env.DB.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').bind(amount, sender_id),
                    env.DB.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').bind(amount, recipient_id),
                    env.DB.prepare('INSERT INTO transactions (id, user_id, type, amount, status) VALUES (?, ?, "P2P_TRANSFER", ?, "success")').bind(\`txn_\${Date.now()}\`, sender_id, amount)
                ]);
                return Response.json({ success: true, message: 'Transfer complete' });
            } catch (err) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        // --- TAB 2: MARKETPLACE APIs ---
        if (request.method === 'GET' && url.pathname === '/api/marketplace/items') {
            const { results } = await env.DB.prepare('SELECT * FROM marketplace_items WHERE status = "active" ORDER BY created_at DESC').all();
            return Response.json({ success: true, items: results });
        }

        return new Response('Not Found', { status: 404 });
    }
};
`;
fs.writeFileSync('src/index.ts', code);
console.log("Successfully restored cumulative backend!");
