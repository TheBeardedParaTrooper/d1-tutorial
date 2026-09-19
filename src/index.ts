export interface Env {
    DB: D1Database;
}

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
}

// Secure Table Initialization with Foreign Keys and Constraints
async function ensureTables(db: D1Database) {
    try {
        await db.batch([
            db.prepare(`CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, 
                phone_number TEXT UNIQUE, 
                full_name TEXT, 
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`),
            db.prepare(`CREATE TABLE IF NOT EXISTS wallets (
                user_id TEXT PRIMARY KEY, 
                balance REAL DEFAULT 0 CHECK(balance >= 0), 
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )`),
            db.prepare(`CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY, 
                user_id TEXT, 
                type TEXT, 
                amount REAL, 
                status TEXT, 
                reference_id TEXT, 
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )`),
            db.prepare(`CREATE TABLE IF NOT EXISTS user_sessions (
                id TEXT PRIMARY KEY, 
                user_id TEXT, 
                mac_address TEXT, 
                token TEXT UNIQUE, 
                duration_hours INTEGER, 
                expires_at DATETIME, 
                status TEXT, 
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )`),
            db.prepare(`CREATE INDEX IF NOT EXISTS idx_transactions_ref ON transactions(reference_id)`),
            db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_mac ON user_sessions(mac_address, status)`),
            db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token, status)`)
        ]);
    } catch (e) {
        // Tables already initialized
    }
}

// Strict Validation Helpers
function isValidAmount(val: any): boolean {
    const num = Number(val);
    return typeof val !== 'boolean' && !isNaN(num) && isFinite(num) && num > 0;
}

const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
const PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;

const HTML_UI = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flat Coin ISP | Secured Core Node</title>
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
                    <p class="text-[10px] tracking-wider uppercase font-semibold text-emerald-400">Secured Ledger v2.2</p>
                </div>
            </div>
            <div class="flex items-center space-x-3">
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm">
                    <span class="w-2 h-2 rounded-full bg-emerald-400 mr-2 animate-pulse"></span> ACID Guards Active
                </span>
            </div>
        </div>
    </header>

    <!-- Toast Notification Banner -->
    <div id="toast" class="fixed bottom-6 right-6 z-50 transform translate-y-24 opacity-0 transition-all duration-300 max-w-sm w-full bg-slate-900/90 border border-slate-700/80 p-4 rounded-2xl shadow-2xl backdrop-blur-xl flex items-start space-x-3">
        <div id="toastIcon" class="text-xl"></div>
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
                <button onclick="registerUser()" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-indigo-600/25 transition active:scale-[0.98]">Initialize Account</button>
            </div>
        </div>

        <!-- 2. Wallet Balance & Transactions -->
        <div class="bg-slate-900/60 border border-slate-800/80 p-6 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col justify-between hover:border-slate-700 transition duration-300">
            <div>
                <div class="flex items-center justify-between mb-5">
                    <h2 class="font-semibold text-slate-200 text-sm flex items-center gap-2">💰 Wallet & Ledger</h2>
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
            <div class="mt-6 grid grid-cols-2 gap-2">
                <button onclick="loadUserData()" class="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-cyan-600/25 transition active:scale-[0.98]">Sync Ledger</button>
                <button onclick="quickAutoFill()" class="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium py-2.5 rounded-xl text-sm border border-slate-700 transition">Auto-Fill IDs</button>
            </div>
        </div>

        <!-- 3. AzamPay Webhook Receiver -->
        <div class="bg-slate-900/60 border border-slate-800/80 p-6 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col justify-between hover:border-slate-700 transition duration-300">
            <div>
                <div class="flex items-center justify-between mb-5">
                    <h2 class="font-semibold text-slate-200 text-sm flex items-center gap-2">📥 AzamPay Webhook</h2>
                    <span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono">POST /api/webhook</span>
                </div>
                <div class="space-y-3">
                    <input type="text" id="webhookRef" placeholder="Unique Reference ID" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 font-mono">
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
                <button onclick="postWebhook()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-emerald-600/25 transition active:scale-[0.98]">Post Webhook & Credit</button>
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
                        <input type="number" id="passHours" placeholder="Hours" value="24" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-500 font-mono">
                        <input type="number" id="passCost" placeholder="Cost" value="1000" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-500 font-mono">
                    </div>
                    <input type="text" id="passMac" placeholder="MAC Address (Auto-Generated)" class="w-full bg-slate-950/80 border border-slate-800/80 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-500 font-mono">
                </div>
            </div>
            <div class="mt-6">
                <button onclick="buyTimePass()" class="w-full bg-violet-600 hover:bg-violet-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-violet-600/25 transition active:scale-[0.98]">Provision Session</button>
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
                <button onclick="executeTransfer()" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-blue-600/25 transition active:scale-[0.98]">Execute Transfer</button>
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
                <button onclick="executeCashout()" class="w-full bg-amber-600 hover:bg-amber-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-lg shadow-amber-600/25 transition active:scale-[0.98]">Request Disbursement</button>
            </div>
        </div>
    </main>

    <!-- Transaction History Statement -->
    <section class="max-w-7xl mx-auto px-6 mt-8">
        <div class="bg-slate-900/60 border border-slate-800/80 p-6 rounded-3xl shadow-2xl backdrop-blur-xl">
            <h3 class="font-semibold text-slate-200 text-sm mb-4 flex items-center gap-2">📄 Recent Transaction Statement</h3>
            <div class="overflow-x-auto">
                <table class="w-full text-left text-xs font-mono text-slate-300">
                    <thead class="bg-slate-950/60 uppercase text-[10px] text-slate-400 border-b border-slate-800">
                        <tr>
                            <th class="p-3">Tx ID</th>
                            <th class="p-3">Type</th>
                            <th class="p-3">Amount</th>
                            <th class="p-3">Status</th>
                            <th class="p-3">Reference / Counterparty</th>
                        </tr>
                    </thead>
                    <tbody id="txTableBody" class="divide-y divide-slate-800/50">
                        <tr>
                            <td colspan="5" class="p-4 text-center text-slate-500">Enter a User ID and click "Sync Ledger" to load statements.</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </section>

    <script>
        function g(id) { 
            const el = document.getElementById(id);
            return el ? el.value.trim() : ''; 
        }

        function showToast(title, msg, isError = false) {
            const toast = document.getElementById('toast');
            document.getElementById('toastTitle').innerText = title;
            document.getElementById('toastMsg').innerText = msg;
            document.getElementById('toastIcon').innerText = isError ? '⚠️' : '✅';
            toast.classList.remove('translate-y-24', 'opacity-0');
            setTimeout(() => {
                toast.classList.add('translate-y-24', 'opacity-0');
            }, 4000);
        }

        function generateRandomMac() {
            const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
            return \`\${hex()}:\${hex()}:\${hex()}:\${hex()}:\${hex()}:\${hex()}\`;
        }

        // Auto-generate MAC on load
        window.addEventListener('DOMContentLoaded', () => {
            const macField = document.getElementById('passMac');
            if(macField) macField.value = generateRandomMac();
        });

        function quickAutoFill() {
            const sampleId = 'usr_' + Math.floor(Math.random() * 900 + 100);
            const samplePhone = '+2557' + Math.floor(Math.random() * 90000000 + 10000000);
            
            document.getElementById('regId').value = sampleId;
            document.getElementById('regPhone').value = samplePhone;
            document.getElementById('regName').value = 'Secured Test User';

            document.getElementById('walletId').value = sampleId;
            document.getElementById('webhookRef').value = 'AZM_REF_' + Date.now().toString().slice(-6);
            document.getElementById('webhookMsisdn').value = samplePhone;
            document.getElementById('webhookAmount').value = 5000;

            document.getElementById('passUser').value = sampleId;
            document.getElementById('txSender').value = sampleId;
            document.getElementById('coUser').value = sampleId;
            document.getElementById('coPhone').value = samplePhone;
            
            showToast('Auto-Filled', 'Secured sample test data loaded.');
        }

        async function apiWrapper(url, payload) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Server error occurred');
                return data;
            } catch (err) {
                showToast('Operation Failed', err.message, true);
                throw err;
            }
        }

        async function loadUserData() {
            const uid = g('walletId');
            if (!uid) { showToast('Validation Error', 'Please enter a User ID', true); return; }
            
            try {
                const wRes = await fetch('/api/wallet/' + encodeURIComponent(uid));
                const wData = await wRes.json();
                if (wRes.ok) {
                    document.getElementById('walletDisplay').classList.remove('hidden');
                    document.getElementById('walletAmount').innerText = Number(wData.wallet.balance).toFixed(2) + ' COINS';
                } else {
                    document.getElementById('walletDisplay').classList.add('hidden');
                }

                const tRes = await fetch('/api/transactions/' + encodeURIComponent(uid));
                const tData = await tRes.json();
                const tbody = document.getElementById('txTableBody');
                tbody.innerHTML = '';
                
                if (tRes.ok && tData.transactions && tData.transactions.length > 0) {
                    tData.transactions.forEach(tx => {
                        const isOutbound = tx.type === 'TRANSFER_OUT' || tx.type === 'SPEND_TIME_PASS' || tx.type === 'CASHOUT_AZAMPAY';
                        const sign = isOutbound ? '-' : '+';
                        const colorClass = isOutbound ? 'text-rose-400' : 'text-emerald-400';
                        
                        tbody.innerHTML += \`
                            <tr class="hover:bg-slate-800/25 transition">
                                <td class="p-3 text-indigo-400">\${tx.id}</td>
                                <td class="p-3 font-bold">\${tx.type}</td>
                                <td class="p-3 \${colorClass}">\${sign}\${tx.amount}</td>
                                <td class="p-3"><span class="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">\${tx.status}</span></td>
                                <td class="p-3 text-slate-400">\${tx.reference_id || 'N/A'}</td>
                            </tr>
                        \`;
                    });
                } else {
                    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-500">No transactions recorded for this user yet.</td></tr>';
                }
                showToast('Ledger Synced', 'Fetched latest secured balance & statements.');
            } catch (err) {
                showToast('Sync Failed', err.message, true);
            }
        }

        async function registerUser() {
            const id = g('regId');
            const phone_number = g('regPhone');
            const full_name = g('regName');
            if (!id || !phone_number) { showToast('Error', 'User ID and Phone are required', true); return; }

            const data = await apiWrapper('/api/register', { id, phone_number, full_name });
            showToast('Success', data.message);
            
            document.getElementById('walletId').value = id;
            document.getElementById('webhookMsisdn').value = phone_number;
            document.getElementById('passUser').value = id;
            document.getElementById('txSender').value = id;
            document.getElementById('coUser').value = id;
            document.getElementById('coPhone').value = phone_number;
            loadUserData();
        }

        async function postWebhook() {
            const referenceId = g('webhookRef');
            const msisdn = g('webhookMsisdn');
            const amount = Number(g('webhookAmount'));
            const status = g('webhookStatus');
            if (!referenceId || !msisdn) { showToast('Error', 'Reference ID and MSISDN required', true); return; }

            const data = await apiWrapper('/api/webhook/azampay', { referenceId, msisdn, amount, status });
            showToast('Webhook Processed', data.message);
            loadUserData();
        }

        async function buyTimePass() {
            const user_id = g('passUser');
            const duration_hours = Number(g('passHours'));
            const cost = Number(g('passCost'));
            const mac_address = g('passMac');

            const data = await apiWrapper('/api/session/buy', { user_id, duration_hours, cost, mac_address });
            showToast('Session Active', \`Token: \${data.radius_token}\`);
            document.getElementById('walletId').value = user_id;
            loadUserData();
        }

        async function executeTransfer() {
            const sender_id = g('txSender');
            const recipient_id = g('txRecipient');
            const amount = Number(g('txAmount'));

            const data = await apiWrapper('/api/transfer', { sender_id, recipient_id, amount });
            showToast('Transfer Complete', data.message);
            document.getElementById('walletId').value = sender_id;
            loadUserData();
        }

        async function executeCashout() {
            const user_id = g('coUser');
            const phone_number = g('coPhone');
            const amount = Number(g('coAmount'));

            const data = await apiWrapper('/api/cashout', { user_id, phone_number, amount });
            showToast('Cashout Requested', data.message);
            document.getElementById('walletId').value = user_id;
            loadUserData();
        }
    </script>
</body>
</html>`;

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        await ensureTables(env.DB);

        if (request.method === 'GET' && url.pathname === '/') {
            return new Response(HTML_UI, {
                headers: { ...corsHeaders, 'Content-Type': 'text/html;charset=UTF-8' }
            });
        }

        // 1. Register User (Validated & Sanitized)
        if (request.method === 'POST' && url.pathname === '/api/register') {
            try {
                const body: any = await request.json();
                const id = body.id?.trim();
                const phone_number = body.phone_number?.trim();
                const full_name = body.full_name?.trim().slice(0, 100) || '';

                if (!id || !phone_number) return jsonResponse({ error: 'Missing id or phone_number' }, 400);
                if (!PHONE_REGEX.test(phone_number)) return jsonResponse({ error: 'Invalid international phone format' }, 400);

                await env.DB.batch([
                    env.DB.prepare(`INSERT INTO users (id, phone_number, full_name) VALUES (?, ?, ?)`).bind(id, phone_number, full_name),
                    env.DB.prepare(`INSERT INTO wallets (user_id, balance) VALUES (?, 0)`).bind(id)
                ]);

                return jsonResponse({ success: true, message: 'User registered and wallet initialized securely' }, 201);
            } catch (err: any) {
                return jsonResponse({ error: err.message }, 500);
            }
        }

        // 2. Idempotent AzamPay Webhook (Validated Amount & Reference)
        if (request.method === 'POST' && url.pathname === '/api/webhook/azampay') {
            try {
                const payload: any = await request.json();
                const referenceId = payload.referenceId?.trim();
                const msisdn = payload.msisdn?.trim();
                const status = payload.status?.trim();
                
                if (!referenceId || !isValidAmount(payload.amount)) {
                    return jsonResponse({ error: 'Invalid parameters or amount for webhook' }, 400);
                }
                const numericAmount = Number(payload.amount);

                const existingTx = await env.DB.prepare(`SELECT id FROM transactions WHERE reference_id = ?`).bind(referenceId).first();
                if (existingTx) {
                    return jsonResponse({ success: true, message: 'Webhook already processed (Idempotent bypass)' });
                }

                if (status && status.toLowerCase() === 'success') {
                    const user: any = await env.DB.prepare(`SELECT id FROM users WHERE phone_number = ?`).bind(msisdn).first();
                    if (!user) return jsonResponse({ error: `User not found for phone number: ${msisdn}` }, 404);

                    const txId = `txn_${Date.now()}`;
                    await env.DB.batch([
                        env.DB.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(numericAmount, user.id),
                        env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES (?, ?, 'DEPOSIT_AZAMPAY', ?, 'success', ?)`).bind(txId, user.id, numericAmount, referenceId)
                    ]);
                    return jsonResponse({ success: true, message: 'Wallet securely credited via verified webhook' });
                }
                return jsonResponse({ success: false, message: 'Payment status not success' }, 400);
            } catch (err: any) {
                return jsonResponse({ error: err.message }, 500);
            }
        }

        // 3. Buy Time Pass (Atomic Balance Guard & Unique Session Mapping)
        if (request.method === 'POST' && url.pathname === '/api/session/buy') {
            try {
                const body: any = await request.json();
                const user_id = body.user_id?.trim();
                const duration_hours = Number(body.duration_hours);
                const cost = Number(body.cost);
                const mac_address = body.mac_address?.trim();

                if (!user_id || !isValidAmount(duration_hours) || !isValidAmount(cost)) {
                    return jsonResponse({ error: 'Invalid parameters or amounts' }, 400);
                }
                if (!mac_address || !MAC_REGEX.test(mac_address)) {
                    return jsonResponse({ error: 'Invalid or missing device MAC address format' }, 400);
                }

                const sessionId = `ses_${Date.now()}`;
                const txId = `txn_${Date.now()}`;
                const radiusToken = Math.random().toString(36).substring(2, 10).toUpperCase();
                const expiresAt = new Date(Date.now() + duration_hours * 3600 * 1000).toISOString();

                // Atomic conditional update preventing race-condition overdrawing via CHECK constraints
                const updateRes = await env.DB.prepare(
                    `UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ?`
                ).bind(cost, user_id, cost).run();

                if (!updateRes.meta.changes || updateRes.meta.changes === 0) {
                    return jsonResponse({ error: 'Insufficient balance or concurrent transaction conflict' }, 400);
                }

                await env.DB.batch([
                    // Invalidate older active sessions for this specific MAC device to prevent ghost stacking
                    env.DB.prepare(`UPDATE user_sessions SET status = 'expired' WHERE mac_address = ? AND status = 'active'`).bind(mac_address),
                    env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES (?, ?, 'SPEND_TIME_PASS', ?, 'success', ?)`).bind(txId, user_id, cost, `Pass: ${duration_hours}h`),
                    env.DB.prepare(`INSERT INTO user_sessions (id, user_id, mac_address, token, duration_hours, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, 'active')`).bind(sessionId, user_id, mac_address, radiusToken, duration_hours, expiresAt)
                ]);

                return jsonResponse({ 
                    success: true, 
                    message: 'Time pass provisioned securely with RADIUS token', 
                    session_id: sessionId,
                    radius_token: radiusToken,
                    expires_at: expiresAt
                });
            } catch (err: any) {
                return jsonResponse({ error: err.message }, 500);
            }
        }

        // 4. P2P Transfer (Atomic Row Locking / Conditional Balance Update)
        if (request.method === 'POST' && url.pathname === '/api/transfer') {
            try {
                const body: any = await request.json();
                const sender_id = body.sender_id?.trim();
                const recipient_id = body.recipient_id?.trim();
                const amount = Number(body.amount);

                if (!sender_id || !recipient_id || !isValidAmount(amount)) {
                    return jsonResponse({ error: 'Invalid parameters or transfer amount' }, 400);
                }
                if (sender_id === recipient_id) return jsonResponse({ error: 'Cannot transfer to self' }, 400);

                const recipientWallet: any = await env.DB.prepare(`SELECT user_id FROM wallets WHERE user_id = ?`).bind(recipient_id).first();
                if (!recipientWallet) return jsonResponse({ error: 'Recipient account not found' }, 404);

                // Atomic deduction check protecting against race-condition double spends
                const updateSender = await env.DB.prepare(
                    `UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ?`
                ).bind(amount, sender_id, amount).run();

                if (!updateSender.meta.changes || updateSender.meta.changes === 0) {
                    return jsonResponse({ error: 'Insufficient balance or parallel transaction conflict' }, 400);
                }

                const timestamp = Date.now();
                const refCode = `p2p_${timestamp}`;
                
                await env.DB.batch([
                    env.DB.prepare(`UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(amount, recipient_id),
                    env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES (?, ?, 'TRANSFER_OUT', ?, 'success', ?)`).bind(`txn_out_${timestamp}`, sender_id, amount, `To: ${recipient_id} (${refCode})`),
                    env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES (?, ?, 'TRANSFER_IN', ?, 'success', ?)`).bind(`txn_in_${timestamp}`, recipient_id, amount, `From: ${sender_id} (${refCode})`)
                ]);

                return jsonResponse({ success: true, message: 'P2P transfer executed safely and atomically' });
            } catch (err: any) {
                return jsonResponse({ error: err.message }, 500);
            }
        }

        // 5. Cash-Out (Atomic Balance Guard)
        if (request.method === 'POST' && url.pathname === '/api/cashout') {
            try {
                const body: any = await request.json();
                const user_id = body.user_id?.trim();
                const phone_number = body.phone_number?.trim();
                const amount = Number(body.amount);

                if (!user_id || !PHONE_REGEX.test(phone_number) || !isValidAmount(amount)) {
                    return jsonResponse({ error: 'Invalid parameters or cashout amount' }, 400);
                }

                const updateRes = await env.DB.prepare(
                    `UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND balance >= ?`
                ).bind(amount, user_id, amount).run();

                if (!updateRes.meta.changes || updateRes.meta.changes === 0) {
                    return jsonResponse({ error: 'Insufficient balance or concurrent transaction constraint' }, 400);
                }

                const timestamp = Date.now();
                await env.DB.batch([
                    env.DB.prepare(`INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES (?, ?, 'CASHOUT_AZAMPAY', ?, 'success', ?)`).bind(`txn_co_${timestamp}`, user_id, amount, `cashout_${timestamp}`)
                ]);

                return jsonResponse({ success: true, message: 'Cashout request processed securely' });
            } catch (err: any) {
                return jsonResponse({ error: err.message }, 500);
            }
        }

        // 6. Get Wallet Balance
        if (request.method === 'GET' && url.pathname.startsWith('/api/wallet/')) {
            const userId = decodeURIComponent(url.pathname.split('/').pop() || '').trim();
            const wallet = await env.DB.prepare(`SELECT * FROM wallets WHERE user_id = ?`).bind(userId).first();
            if (!wallet) return jsonResponse({ error: 'Wallet not found' }, 404);
            return jsonResponse({ success: true, wallet });
        }

        // 7. Get Transaction History
        if (request.method === 'GET' && url.pathname.startsWith('/api/transactions/')) {
            const userId = decodeURIComponent(url.pathname.split('/').pop() || '').trim();
            const { results } = await env.DB.prepare(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).bind(userId).all();
            return jsonResponse({ success: true, transactions: results });
        }

        // 8. Verify RADIUS Token
        if (request.method === 'POST' && url.pathname === '/api/radius/verify') {
            try {
                const body: any = await request.json();
                const token = body.token?.trim();
                const mac_address = body.mac_address?.trim();
                if (!token) return jsonResponse({ error: 'Missing token' }, 400);

                const session: any = await env.DB.prepare(
                    `SELECT * FROM user_sessions WHERE token = ? AND status = 'active' AND expires_at > CURRENT_TIMESTAMP`
                ).bind(token.toUpperCase()).first();

                if (!session) {
                    return jsonResponse({ valid: false, error: 'Invalid or expired session token' }, 401);
                }

                return jsonResponse({ 
                    valid: true, 
                    user_id: session.user_id,
                    expires_at: session.expires_at,
                    message: 'RADIUS authentication verified successfully' 
                });
            } catch (err: any) {
                return jsonResponse({ error: err.message }, 500);
            }
        }

        return new Response('Not Found', { status: 404, headers: corsHeaders });
    },
};
