export interface Env {
    DB: D1Database;
}

const HTML_UI = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flat Coin ISP | Enterprise Node</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        darker: '#060913',
                        cardbg: '#0b1120',
                    }
                }
            }
        }
    </script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen antialiased selection:bg-indigo-500 selection:text-white pb-24">
    <!-- Top Nav -->
    <header class="border-b border-slate-800/80 bg-slate-900/40 backdrop-blur-xl sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 h-16 flex justify-between items-center">
            <div class="flex items-center space-x-3">
                <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 via-violet-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                    <span class="text-lg font-black text-white">⚡</span>
                </div>
                <div>
                    <h1 class="font-bold text-base tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">Flat Coin ISP</h1>
                    <p class="text-[10px] tracking-wider uppercase font-semibold text-indigo-400">Core Network Ledger</p>
                </div>
            </div>
            <div class="flex items-center space-x-3">
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm shadow-emerald-500/10">
                    <span class="w-2 h-2 rounded-full bg-emerald-400 mr-2 animate-pulse"></span> Gateway Active
                </span>
            </div>
        </div>
    </header>

    <!-- Toast Notification Banner -->
    <div id="toast" class="fixed bottom-6 right-6 z-50 transform translate-y-24 opacity-0 transition-all duration-300 max-w-sm w-full bg-slate-900/90 border border-slate-700/80 p-4 rounded-2xl shadow-2xl backdrop-blur-xl flex items-start space-x-3">
        <div id="toastIcon" class="text-xl">✅</div>
        <div class="flex-1">
            <h4 id="toastTitle" class="text-xs font-semibold text-slate-200 uppercase tracking-wider">Success</h4>
            <p id="toastMsg" class="text-xs text-slate-400 mt-0.5"></p>
        </div>
    </div>

    <!-- Main Workspace -->
    <main class="max-w-7xl mx-auto px-6 mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

        <!-- 1. Register User -->
        <div class="bg-slate-900/60 border border-slate-800/80 p-6 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col justify-between hover:border-slate-700 transition duration-300">
            <div>
                <div class="flex items-center justify-between mb-5">
                    <h2 class="font-semibold text-slate-200 text-sm flex items-center gap-2">👤 Register User</h2>
                    <span class="text-[10px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 font-mono">POST /api/register</span>
                </div>
                <div class="space-y-3">
                    <input type="text" id="regId" placeholder="User ID (e.g. usr_101)" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-indigo-500 transition font-mono">
                    <input type="text" id="regPhone" placeholder="Phone (+2557...)" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-indigo-500 transition font-mono">
                    <input type="text" id="regName" placeholder="Full Name" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-indigo-500 transition">
                </div>
            </div>
            <div class="mt-6">
                <button onclick="executeAction('/api/register', {id: g('regId'), phone_number: g('regPhone'), full_name: g('regName')}, 'User registered successfully!')" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-indigo-600/25 transition active:scale-[0.98]">Initialize Account</button>
            </div>
        </div>

        <!-- 2. Wallet Balance -->
        <div class="bg-slate-900/60 border border-slate-800/80 p-6 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col justify-between hover:border-slate-700 transition duration-300">
            <div>
                <div class="flex items-center justify-between mb-5">
                    <h2 class="font-semibold text-slate-200 text-sm flex items-center gap-2">💰 Check Wallet</h2>
                    <span class="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 font-mono">GET /api/wallet/:id</span>
                </div>
                <div class="space-y-3">
                    <input type="text" id="walletId" placeholder="User ID" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-cyan-500 transition font-mono">
                    <div id="walletDisplay" class="bg-slate-950/40 border border-slate-800/50 rounded-2xl p-4 text-center hidden">
                        <span class="text-xs text-slate-400 uppercase tracking-widest">Available Balance</span>
                        <div id="walletAmount" class="text-2xl font-black text-cyan-400 mt-1 font-mono">0.00 COINS</div>
                    </div>
                </div>
            </div>
            <div class="mt-6">
                <button onclick="fetchWallet()" class="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-cyan-600/25 transition active:scale-[0.98]">Query Balance</button>
            </div>
        </div>

        <!-- 3. AzamPay Webhook Receiver -->
        <div class="bg-slate-900/60 border border-slate-800/80 p-6 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col justify-between hover:border-slate-700 transition duration-300">
            <div>
                <div class="flex items-center justify-between mb-5">
                    <h2 class="font-semibold text-slate-200 text-sm flex items-center gap-2">📥 AzamPay Webhook</h2>
                    <span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono">POST /api/webhook/azampay</span>
                </div>
                <div class="space-y-3">
                    <input type="text" id="webhookRef" placeholder="Reference ID" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 font-mono">
                    <input type="text" id="webhookMsisdn" placeholder="MSISDN (+255...)" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 font-mono">
                    <div class="grid grid-cols-2 gap-2">
                        <input type="number" id="webhookAmount" placeholder="Amount" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 font-mono">
                        <select id="webhookStatus" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 text-slate-300 font-mono">
                            <option value="success">success</option>
                            <option value="failed">failed</option>
                        </select>
                    </div>
                </div>
            </div>
            <div class="mt-6">
                <button onclick="executeAction('/api/webhook/azampay', {referenceId: g('webhookRef'), msisdn: g('webhookMsisdn'), amount: Number(g('webhookAmount')), status: g('webhookStatus')}, 'Webhook processed successfully!')" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-emerald-600/25 transition active:scale-[0.98]">Post Webhook Payload</button>
            </div>
        </div>

        <!-- 4. Buy Time Pass -->
        <div class="bg-slate-900/60 border border-slate-800/80 p-6 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col justify-between hover:border-slate-700 transition duration-300">
            <div>
                <div class="flex items-center justify-between mb-5">
                    <h2 class="font-semibold text-slate-200 text-sm flex items-center gap-2">⏱️ Buy Time Pass</h2>
                    <span class="text-[10px] px-2 py-0.5 rounded bg-violet-500/10 text-violet-400 font-mono">POST /api/session/buy</span>
                </div>
                <div class="space-y-3">
                    <input type="text" id="passUser" placeholder="User ID" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-500 font-mono">
                    <div class="grid grid-cols-2 gap-2">
                        <input type="number" id="passHours" placeholder="Hours" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-500 font-mono">
                        <input type="number" id="passCost" placeholder="Cost" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-500 font-mono">
                    </div>
                    <input type="text" id="passMac" placeholder="MAC Address (AA:BB:...)" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-500 font-mono">
                </div>
            </div>
            <div class="mt-6">
                <button onclick="executeAction('/api/session/buy', {user_id: g('passUser'), duration_hours: Number(g('passHours')), cost: Number(g('passCost')), mac_address: g('passMac')}, 'Time pass session activated!')" class="w-full bg-violet-600 hover:bg-violet-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-violet-600/25 transition active:scale-[0.98]">Provision Session</button>
            </div>
        </div>

        <!-- 5. P2P Coin Transfer -->
        <div class="bg-slate-900/60 border border-slate-800/80 p-6 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col justify-between hover:border-slate-700 transition duration-300">
            <div>
                <div class="flex items-center justify-between mb-5">
                    <h2 class="font-semibold text-slate-200 text-sm flex items-center gap-2">🔄 P2P Transfer</h2>
                    <span class="text-[10px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono">POST /api/transfer</span>
                </div>
                <div class="space-y-3">
                    <div class="grid grid-cols-2 gap-2">
                        <input type="text" id="txSender" placeholder="Sender ID" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-blue-500 font-mono">
                        <input type="text" id="txRecipient" placeholder="Recipient ID" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-blue-500 font-mono">
                    </div>
                    <input type="number" id="txAmount" placeholder="Transfer Amount" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-blue-500 font-mono">
                </div>
            </div>
            <div class="mt-6">
                <button onclick="executeAction('/api/transfer', {sender_id: g('txSender'), recipient_id: g('txRecipient'), amount: Number(g('txAmount'))}, 'Transfer completed successfully!')" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-blue-600/25 transition active:scale-[0.98]">Execute Transfer</button>
            </div>
        </div>

        <!-- 6. Cash-Out -->
        <div class="bg-slate-900/60 border border-slate-800/80 p-6 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col justify-between hover:border-slate-700 transition duration-300">
            <div>
                <div class="flex items-center justify-between mb-5">
                    <h2 class="font-semibold text-slate-200 text-sm flex items-center gap-2">💸 AzamPay Cashout</h2>
                    <span class="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 font-mono">POST /api/cashout</span>
                </div>
                <div class="space-y-3">
                    <input type="text" id="coUser" placeholder="User ID" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-amber-500 font-mono">
                    <input type="text" id="coPhone" placeholder="Phone (+255...)" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-amber-500 font-mono">
                    <input type="number" id="coAmount" placeholder="Amount" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-amber-500 font-mono">
                </div>
            </div>
            <div class="mt-6">
                <button onclick="executeAction('/api/cashout', {user_id: g('coUser'), phone_number: g('coPhone'), amount: Number(g('coAmount'))}, 'Cashout disbursement requested!')" class="w-full bg-amber-600 hover:bg-amber-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-amber-600/25 transition active:scale-[0.98]">Request Disbursement</button>
            </div>
        </div>

    </main>

    <script>
        function g(id) { return document.getElementById(id).value; }

        function showToast(title, msg, isError = false) {
            const toast = document.getElementById('toast');
            document.getElementById('toastTitle').innerText = title;
            document.getElementById('toastMsg').innerText = msg;
            document.getElementById('toastIcon').innerText = isError ? '❌' : '✅';
            toast.classList.remove('translate-y-24', 'opacity-0');
            setTimeout(() => {
                toast.classList.add('translate-y-24', 'opacity-0');
            }, 4000);
        }

        async function executeAction(url, payload, successTitle) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Server error occurred');
                showToast(successTitle, data.message || 'Operation executed successfully.');
            } catch (err) {
                showToast('Request Failed', err.message, true);
            }
        }

        async function fetchWallet() {
            const uid = g('walletId');
            if (!uid) {
                showToast('Validation Error', 'Please enter a User ID', true);
                return;
            }
            try {
                const res = await fetch('/api/wallet/' + uid);
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Wallet not found');
                
                document.getElementById('walletDisplay').classList.remove('hidden');
                document.getElementById('walletAmount').innerText = Number(data.wallet.balance).toFixed(2) + ' COINS';
                showToast('Wallet Synced', 'Balance retrieved successfully.');
            } catch (err) {
                showToast('Fetch Failed', err.message, true);
            }
        }
    </script>
</body>
</html>`;

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === 'GET' && url.pathname === '/') {
            return new Response(HTML_UI, {
                headers: { 'Content-Type': 'text/html;charset=UTF-8' }
            });
        }

        if (request.method === 'POST' && url.pathname === '/api/register') {
            try {
                const body: any = await request.json();
                const { id, phone_number, full_name } = body;
                if (!id || !phone_number) return Response.json({ error: 'Missing id or phone_number' }, { status: 400 });

                await env.DB.prepare(`INSERT INTO users (id, phone_number, full_name) VALUES (?, ?, ?)`).bind(id, phone_number, full_name || '').run();
                await env.DB.prepare(`INSERT INTO wallets (user_id, balance) VALUES (?, 0)`).bind(id).run();

                return Response.json({ success: true, message: 'User registered and wallet initialized' }, { status: 201 });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        if (request.method === 'POST' && url.pathname === '/api/webhook/azampay') {
            try {
                const payload: any = await request.json();
                const { referenceId, msisdn, amount, status } = payload;

                if (status && status.toLowerCase() === 'success') {
                    const user: any = await env.DB.prepare(`SELECT id FROM users WHERE phone_number = ?`).bind(msisdn).first();
                    if (!user) return Response.json({ error: 'User not found for phone number' }, { status: 404 });

                    const numericAmount = Number(amount) || 0;
                    await env.DB.batch([
                        env.DB.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(numericAmount, user.id),
                        env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES (?, ?, 'DEPOSIT_AZAMPAY', ?, 'success', ?)`).bind(`txn_${Date.now()}`, user.id, numericAmount, referenceId || 'AZAM_REF')
                    ]);
                    return Response.json({ success: true, message: 'Wallet credited via webhook' });
                }
                return Response.json({ success: false, message: 'Payment status not success' }, { status: 400 });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        if (request.method === 'POST' && url.pathname === '/api/session/buy') {
            try {
                const body: any = await request.json();
                const { user_id, duration_hours, cost, mac_address } = body;
                if (!user_id || !duration_hours || !cost) return Response.json({ error: 'Missing parameters' }, { status: 400 });

                const wallet: any = await env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(user_id).first();
                if (!wallet || wallet.balance < cost) return Response.json({ error: 'Insufficient balance' }, { status: 400 });

                const sessionId = `ses_${Date.now()}`;
                const expiresAt = new Date(Date.now() + duration_hours * 3600 * 1000).toISOString();

                await env.DB.batch([
                    env.DB.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(cost, user_id),
                    env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status) VALUES (?, ?, 'SPEND_TIME_PASS', ?, 'success')`).bind(`txn_${Date.now()}`, user_id, cost),
                    env.DB.prepare(`INSERT INTO user_sessions (id, user_id, mac_address, duration_hours, expires_at, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(sessionId, user_id, mac_address || '00:00:00:00:00:00', duration_hours, expiresAt)
                ]);

                return Response.json({ success: true, message: 'Time pass activated', session_id: sessionId });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        if (request.method === 'POST' && url.pathname === '/api/transfer') {
            try {
                const body: any = await request.json();
                const { sender_id, recipient_id, amount } = body;
                if (!sender_id || !recipient_id || !amount || amount <= 0) return Response.json({ error: 'Invalid parameters' }, { status: 400 });
                if (sender_id === recipient_id) return Response.json({ error: 'Cannot transfer to self' }, { status: 400 });

                const senderWallet: any = await env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(sender_id).first();
                if (!senderWallet || senderWallet.balance < amount) return Response.json({ error: 'Insufficient balance' }, { status: 400 });

                const recipientWallet: any = await env.DB.prepare(`SELECT user_id FROM wallets WHERE user_id = ?`).bind(recipient_id).first();
                if (!recipientWallet) return Response.json({ error: 'Recipient not found' }, { status: 404 });

                const timestamp = Date.now();
                await env.DB.batch([
                    env.DB.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(amount, sender_id),
                    env.DB.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(amount, recipient_id),
                    env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status) VALUES (?, ?, 'TRANSFER_OUT', ?, 'success')`).bind(`txn_out_${timestamp}`, sender_id, amount),
                    env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status) VALUES (?, ?, 'TRANSFER_IN', ?, 'success')`).bind(`txn_in_${timestamp}`, recipient_id, amount)
                ]);

                return Response.json({ success: true, message: 'Transfer successful' });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        if (request.method === 'POST' && url.pathname === '/api/cashout') {
            try {
                const body: any = await request.json();
                const { user_id, amount, phone_number } = body;
                if (!user_id || !amount || !phone_number || amount <= 0) return Response.json({ error: 'Invalid parameters' }, { status: 400 });

                const wallet: any = await env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(user_id).first();
                if (!wallet || wallet.balance < amount) return Response.json({ error: 'Insufficient balance' }, { status: 400 });

                const timestamp = Date.now();
                await env.DB.batch([
                    env.DB.prepare(`UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(amount, user_id),
                    env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES (?, ?, 'CASHOUT_AZAMPAY', ?, 'success', ?)`).bind(`txn_co_${timestamp}`, user_id, amount, `cashout_${timestamp}`)
                ]);

                return Response.json({ success: true, message: 'Cashout processed' });
            } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500 });
            }
        }

        if (request.method === 'GET' && url.pathname.startsWith('/api/wallet/')) {
            const userId = url.pathname.split('/').pop();
            const wallet = await env.DB.prepare(`SELECT * FROM wallets WHERE user_id = ?`).bind(userId).first();
            if (!wallet) return Response.json({ error: 'Wallet not found' }, { status: 404 });
            return Response.json({ success: true, wallet });
        }

        return new Response('Not Found', { status: 404 });
    },
};
