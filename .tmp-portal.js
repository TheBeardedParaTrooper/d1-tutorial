function portalApp(){ {
            return {
                // ---------- UI state ----------
                activeTab: 'plans',
                omniQuery: '',
                macAddress: '',
                toast: { show: false, message: '', icon: '⚡' },
                modals: { deposit: false, withdraw: false, listing: false, quote: false },
                loading: { plans: false },
                busy: { buy: false, deposit: false, withdraw: false, p2p: false, listing: false, market: false, quote: false },
                apiErrors: { packages: '', wallet: '', ledger: '' },
                backendOk: false,

                // ---------- server-backed state ----------
                auth: { checked: false, user: null },
                wallet: { balance: 0, updated_at: '' },
                transactions: [],
                packages: [],
                marketplace: { state: 'loading', headline: 'Contacting /api/marketplace/items…', note: '', items: [] },
                activeSession: null,
                pendingOrder: null,
                highlightedTx: '',
                p2pForm: { recipient: '', amount: '' },
                depositForm: { packageId: '', phone: '' },
                withdrawForm: { phone: '', amount: '' },
                // ---------- marketplace seller / buyer state ----------
                myListings: [],
                incomingQuotes: [],
                myQuotes: [],
                quoteReply: {},
                dragging: false,
                listingSteps: [],
                maxUploadBytes: 5 * 1024 * 1024,
                newListing: {
                    kind: 'product', title: '', description: '', price: '', condition: '', location: '',
                    payWallet: true, payMobileMoney: false, negotiable: true, paymentNotes: '', contactPhone: '',
                    fileName: '', fileSize: 0, fileType: '', iconLabel: '', previewUrl: '', blob: null,
                },
                quoteForm: { item: null, price: '', message: '' },

                // ---------- lifecycle ----------
                async boot() {
                    const params = new URLSearchParams(window.location.search);
                    this.macAddress =
                        this.normalizeMac(params.get('mac')) ||
                        this.normalizeMac(localStorage.getItem('flatcoin.mac'));
                    this.saveMacSilently();
                    await Promise.all([this.checkSession(), this.loadPackages()]);
                    await this.loadWalletData();
                    await Promise.all([this.loadMarketplace(), this.loadSellerPanels()]);
                },

                // ---------- transport ----------
                async parseResponse(res) {
                    const text = await res.text();
                    let data = null;
                    try { data = text ? JSON.parse(text) : null; } catch { data = { error: 'Malformed response from ' + res.url }; }
                    if (!res.ok) {
                        const err = new Error((data && (data.error || data.purpose)) || 'HTTP ' + res.status);
                        err.status = res.status;
                        err.payload = data;
                        throw err;
                    }
                    return data || {};
                },

                async api(path, options = {}) {
                    let res;
                    try {
                        res = await fetch(path, {
                            credentials: 'same-origin',
                            ...options,
                            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
                        });
                        this.backendOk = true;
                    } catch {
                        this.backendOk = false;
                        const err = new Error('Network error — the worker did not answer');
                        err.status = 0;
                        throw err;
                    }
                    return this.parseResponse(res);
                },

                // Raw bytes go up as the File itself: no base64, no multipart parser.
                async uploadAsset(itemId, blob, meta) {
                    let res;
                    try {
                        res = await fetch('/api/marketplace/items/' + encodeURIComponent(itemId) + '/asset', {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers: {
                                'Content-Type': meta.type,
                                'X-File-Name': meta.name,
                            },
                            body: blob,
                        });
                        this.backendOk = true;
                    } catch {
                        this.backendOk = false;
                        const err = new Error('Network error — the upload did not reach the server');
                        err.status = 0;
                        throw err;
                    }
                    return this.parseResponse(res);
                },

                describeError(err) {
                    const p = err && err.payload;
                    if (p && p.error === 'not_hooked') {
                        return 'The server has not wired ' + (p.path || 'this endpoint') + ' yet' +
                            (p.implement_in ? ' (implement in ' + p.implement_in + ')' : '');
                    }
                    if (err && err.status === 401) return 'Sign in first.';
                    if (err && err.status === 403) return 'Rejected by the server: PORTAL_ORIGIN must match this site’s origin.';
                    if (err && err.status === 409) return (p && p.error) || 'Duplicate request — try again.';
                    if (err && err.status === 503) return 'Server secrets are not configured yet.';
                    return (err && err.message) || 'Request failed.';
                },

                idemKey() {
                    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
                    return 'portal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
                },

                // ---------- session ----------
                async checkSession() {
                    try {
                        const data = await this.api('/api/auth/me');
                        this.auth.user = data.user || null;
                        if (this.auth.user && this.auth.user.phone_number && !this.depositForm.phone) {
                            this.depositForm.phone = this.auth.user.phone_number;
                        }
                    } catch (err) {
                        this.auth.user = null;
                        if (err.status !== 401) this.apiErrors.wallet = this.describeError(err);
                    } finally {
                        this.auth.checked = true;
                    }
                },

                requireAuth() {
                    if (this.auth.user) return true;
                    this.showToast('Sign in to use the wallet and buy passes.', '🔐');
                    return false;
                },

                // Protected actions send the visitor to the right pane instead of
                // leaving them on a form they cannot use yet.
                goToAuth(mode) {
                    window.location.href = '/account?mode=' + mode + '&next=%2Flanding';
                },

                needAuth(mode) {
                    if (this.auth.user) return false;
                    this.showToast(mode === 'register'
                        ? 'Create an account first — then you can sell.'
                        : 'Sign in first — then you can buy or ask for a quotation.', '🔐');
                    setTimeout(() => this.goToAuth(mode), 900);
                    return true;
                },

                async signOut() {
                    try {
                        await this.api('/api/auth/logout', { method: 'POST' });
                        this.auth.user = null;
                        this.wallet = { balance: 0, updated_at: '' };
                        this.transactions = [];
                        this.pendingOrder = null;
                        this.activeSession = null;
                        this.myListings = [];
                        this.incomingQuotes = [];
                        this.myQuotes = [];
                        this.showToast('Signed out — your session was revoked server-side.', '👋');
                    } catch (err) {
                        this.showToast(this.describeError(err), '⚠️');
                    }
                },

                // ---------- device / MAC ----------
                normalizeMac(raw) {
                    const compact = String(raw || '').trim().replace(/[^0-9A-Fa-f]/g, '');
                    if (compact.length !== 12) return '';
                    return (compact.match(/.{2}/g) || []).join(':').toUpperCase();
                },

                macValid() { return Boolean(this.normalizeMac(this.macAddress)); },

                saveMacSilently() {
                    if (this.macAddress) localStorage.setItem('flatcoin.mac', this.macAddress);
                },

                saveMac() {
                    const normalized = this.normalizeMac(this.macAddress);
                    if (!normalized) {
                        this.showToast('That is not a 12-hex-digit MAC address.', '⚠️');
                        return;
                    }
                    this.macAddress = normalized;
                    localStorage.setItem('flatcoin.mac', normalized);
                    this.showToast('Node address saved: ' + normalized, '📡');
                },

                // ---------- packages ----------
                durationLabel(hours) {
                    const h = Number(hours) || 0;
                    if (h < 24) return h + (h === 1 ? ' HOUR' : ' HOURS');
                    const days = Math.round(h / 24);
                    return days + (days === 1 ? ' DAY' : ' DAYS');
                },

                async loadPackages() {
                    this.loading.plans = true;
                    this.apiErrors.packages = '';
                    try {
                        const data = await this.api('/api/packages');
                        const rows = Array.isArray(data.packages) ? data.packages : [];
                        this.packages = rows.map((pkg) => ({
                            ...pkg,
                            duration_label: this.durationLabel(pkg.duration_hours),
                            description: pkg.duration_hours + ' hours of full-speed access, provisioned to this node over RADIUS.',
                        }));
                    } catch (err) {
                        this.apiErrors.packages = this.describeError(err);
                        this.packages = [];
                    } finally {
                        this.loading.plans = false;
                    }
                },

                async purchasePlan(plan) {
                    if (this.needAuth('login')) return;
                    const mac = this.normalizeMac(this.macAddress);
                    if (!mac) {
                        this.showToast('Enter the device MAC address before buying a pass.', '📡');
                        this.activeTab = 'plans';
                        return;
                    }
                    this.macAddress = mac;
                    if (!window.confirm('Debit ' + this.formatMoney(plan.price) + ' TZS from your wallet for "' + plan.name + '"?')) return;

                    this.busy.buy = true;
                    try {
                        const data = await this.api('/api/session/buy', {
                            method: 'POST',
                            headers: { 'Idempotency-Key': this.idemKey() },
                            body: JSON.stringify({ package_id: plan.id, mac_address: mac }),
                        });
                        this.activeSession = data.session || null;
                        this.showToast('Pass active until ' + this.formatDate(data.session && data.session.expires_at), '📶');
                        await this.loadWalletData();
                    } catch (err) {
                        this.showToast(this.describeError(err), '⚠️');
                        if (err.status === 401) this.auth.user = null;
                    } finally {
                        this.busy.buy = false;
                    }
                },

                // ---------- wallet & ledger ----------
                isCredit(type) {
                    return /DEPOSIT|TRANSFER_IN|SELL|CREDIT|REFUND/.test(String(type || '').toUpperCase());
                },

                prettyType(type) {
                    return String(type || 'UNKNOWN').replace(/_/g, ' ').toLowerCase().replace(/^\w| \w/g, (c) => c.toUpperCase());
                },

                async loadWalletData() {
                    this.apiErrors.wallet = '';
                    this.apiErrors.ledger = '';
                    if (!this.auth.user) return;
                    const id = encodeURIComponent(this.auth.user.id);
                    const [balance, ledger] = await Promise.allSettled([
                        this.api('/api/wallet/' + id),
                        this.api('/api/transactions/' + id),
                    ]);
                    if (balance.status === 'fulfilled') {
                        this.wallet = balance.value.wallet || { balance: 0, updated_at: '' };
                    } else {
                        this.apiErrors.wallet = this.describeError(balance.reason);
                        if (balance.reason.status === 401) this.auth.user = null;
                    }
                    if (ledger.status === 'fulfilled') {
                        this.transactions = Array.isArray(ledger.value.transactions) ? ledger.value.transactions : [];
                    } else {
                        this.apiErrors.ledger = this.describeError(ledger.reason);
                    }
                },

                // ---------- AzamPay orders ----------
                openDeposit(plan) {
                    if (this.needAuth('login')) return;
                    if (plan && plan.id) this.depositForm.packageId = plan.id;
                    if (this.auth.user && this.auth.user.phone_number && !this.depositForm.phone) {
                        this.depositForm.phone = this.auth.user.phone_number;
                    }
                    this.modals.deposit = true;
                },

                async triggerAzamDeposit() {
                    if (!this.requireAuth()) return;
                    const packageId = String(this.depositForm.packageId || '').trim();
                    const phone = String(this.depositForm.phone || '').trim();
                    if (!packageId || !phone) {
                        this.showToast('Pick a package and enter the mobile number.', '⚠️');
                        return;
                    }
                    this.busy.deposit = true;
                    try {
                        const mac = this.normalizeMac(this.macAddress);
                        const data = await this.api('/api/payments/orders', {
                            method: 'POST',
                            headers: { 'Idempotency-Key': this.idemKey() },
                            body: JSON.stringify({ package_id: packageId, phone_number: phone, ...(mac ? { mac_address: mac } : {}) }),
                        });
                        this.pendingOrder = data.order || null;
                        this.modals.deposit = false;
                        this.activeTab = 'wallet';
                        this.showToast('Order created — waiting for the provider webhook.', '💳');
                        this.scheduleOrderPolls();
                    } catch (err) {
                        this.showToast(this.describeError(err), '⚠️');
                        if (err.status === 401) this.auth.user = null;
                    } finally {
                        this.busy.deposit = false;
                    }
                },

                scheduleOrderPolls() {
                    let tries = 0;
                    const tick = setInterval(async () => {
                        tries += 1;
                        await this.pollOrder();
                        if (tries >= 6 || (this.pendingOrder && this.pendingOrder.status !== 'pending')) clearInterval(tick);
                    }, 5000);
                },

                async pollOrder() {
                    if (!this.pendingOrder || !this.pendingOrder.merchant_id) return;
                    try {
                        const data = await this.api('/api/payments/orders/' + encodeURIComponent(this.pendingOrder.merchant_id));
                        const before = this.pendingOrder.status;
                        this.pendingOrder = data.order || this.pendingOrder;
                        if (this.pendingOrder.status !== before) {
                            this.showToast('Order is now ' + this.pendingOrder.status + '.', this.pendingOrder.status === 'completed' ? '✅' : '💳');
                            await this.loadWalletData();
                        }
                    } catch (err) {
                        this.showToast(this.describeError(err), '⚠️');
                    }
                },

                async triggerWithdrawal() {
                    if (!this.requireAuth()) return;
                    const amount = Number(this.withdrawForm.amount);
                    if (!this.withdrawForm.phone || !Number.isInteger(amount) || amount <= 0) {
                        this.showToast('Enter a mobile number and a whole-number amount.', '⚠️');
                        return;
                    }
                    this.busy.withdraw = true;
                    try {
                        await this.api('/api/wallet/withdraw', {
                            method: 'POST',
                            headers: { 'Idempotency-Key': this.idemKey() },
                            body: JSON.stringify({ phone_number: this.withdrawForm.phone, amount }),
                        });
                        this.modals.withdraw = false;
                        this.showToast('Withdrawal accepted.', '🏦');
                        await this.loadWalletData();
                    } catch (err) {
                        this.showToast(this.describeError(err), '🏦');
                    } finally {
                        this.busy.withdraw = false;
                    }
                },

                async executeP2P() {
                    if (!this.requireAuth()) return;
                    const recipient = String(this.p2pForm.recipient || '').trim();
                    const amount = Number(this.p2pForm.amount);
                    if (!recipient || !Number.isInteger(amount) || amount <= 0) {
                        this.showToast('Recipient account id and a whole-number amount are required.', '⚠️');
                        return;
                    }
                    this.busy.p2p = true;
                    try {
                        const data = await this.api('/api/transfer', {
                            method: 'POST',
                            headers: { 'Idempotency-Key': this.idemKey() },
                            body: JSON.stringify({ recipient_id: recipient, amount }),
                        });
                        this.p2pForm.recipient = '';
                        this.p2pForm.amount = '';
                        this.showToast('Sent ' + this.formatMoney((data.transfer && data.transfer.amount) || amount) + ' TZS.', '💸');
                        await this.loadWalletData();
                    } catch (err) {
                        this.showToast(this.describeError(err), '⚠️');
                    } finally {
                        this.busy.p2p = false;
                    }
                },

                // ---------- marketplace ----------
                // Mirrors ACCEPTED in src/lib/domain/assets.ts, so the browser refuses
                // exactly the bytes the server would refuse.
                acceptedTypes: {
                    'image/jpeg': { label: 'JPG', image: true },
                    'image/png': { label: 'PNG', image: true },
                    'image/webp': { label: 'WEBP', image: true },
                    'image/gif': { label: 'GIF', image: true },
                    'application/pdf': { label: 'PDF', image: false },
                    'text/plain': { label: 'TXT', image: false },
                    'text/csv': { label: 'CSV', image: false },
                    'application/zip': { label: 'ZIP', image: false },
                    'application/msword': { label: 'DOC', image: false },
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { label: 'DOCX', image: false },
                    'application/vnd.ms-excel': { label: 'XLS', image: false },
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { label: 'XLSX', image: false },
                },
                extensionTypes: {
                    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
                    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
                    doc: 'application/msword',
                    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    xls: 'application/vnd.ms-excel',
                    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                },

                fileMimeType(file) {
                    const type = String(file && file.type || '').split(';')[0].trim();
                    if (type) return type;
                    const ext = String((file && file.name || '').split('.').pop() || '').toLowerCase();
                    return this.extensionTypes[ext] || '';
                },

                formatBytes(value) {
                    const n = Number(value) || 0;
                    if (n < 1024) return n + ' B';
                    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
                    return (n / 1024 / 1024).toFixed(1) + ' MB';
                },

                downloadLabel(item) {
                    const asset = item.asset || {};
                    return '↓ ' + (asset.icon_label || 'FILE') + ' ' + (asset.file_name || 'download') +
                        ' (' + this.formatBytes(asset.size_bytes) + ')';
                },

                step(line) {
                    this.listingSteps = [...this.listingSteps, line].slice(-6);
                },

                resetListingForm() {
                    this.clearFile();
                    this.newListing = {
                        kind: 'product', title: '', description: '', price: '', condition: '', location: '',
                        payWallet: true, payMobileMoney: false, negotiable: true, paymentNotes: '', contactPhone: '',
                        fileName: '', fileSize: 0, fileType: '', iconLabel: '', previewUrl: '', blob: null,
                    };
                    this.listingSteps = [];
                },

                openListingModal() {
                    if (this.needAuth('register')) return;
                    if (!this.newListing.contactPhone && this.auth.user.phone_number) {
                        this.newListing.contactPhone = this.auth.user.phone_number;
                    }
                    this.modals.listing = true;
                },

                setListingKind(kind) {
                    if (this.newListing.kind === kind) return;
                    this.newListing.kind = kind;
                    // A photo picked for a product is not a deliverable file, and a
                    // datasheet is not a product picture — so the choice is dropped.
                    if (this.newListing.blob) {
                        const info = this.acceptedTypes[this.newListing.fileType];
                        if (!info || info.image !== (kind === 'product')) this.clearFile();
                    }
                },

                clearFile() {
                    if (this.newListing.previewUrl) URL.revokeObjectURL(this.newListing.previewUrl);
                    this.newListing.blob = null;
                    this.newListing.previewUrl = '';
                    this.newListing.fileName = '';
                    this.newListing.fileSize = 0;
                    this.newListing.fileType = '';
                    this.newListing.iconLabel = '';
                },

                onFilePick(event) {
                    const file = event && event.target && event.target.files && event.target.files[0];
                    this.acceptFile(file);
                    if (event.target) event.target.value = '';
                },

                onFileDrop(event) {
                    const file = event && event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
                    this.acceptFile(file);
                },

                async acceptFile(file) {
                    if (!file) return;
                    const name = String(file.name || 'upload').slice(0, 140);
                    const type = this.fileMimeType(file);
                    const info = this.acceptedTypes[type];
                    if (!info) {
                        this.showToast('Unsupported file type. Photos: JPG/PNG/WEBP/GIF. Files: PDF/CSV/TXT/ZIP/DOC(X)/XLS(X).', '⚠️');
                        return;
                    }
                    if (this.newListing.kind === 'product' && !info.image) {
                        this.showToast('A product card shows a photo. Switch to a "File / digital" listing to sell the document itself.', '⚠️');
                        return;
                    }
                    if (this.newListing.kind === 'file' && info.image) {
                        this.showToast('A file listing delivers the document buyers download, not a picture.', '⚠️');
                        return;
                    }
                    if (Number(file.size) > this.maxUploadBytes) {
                        this.showToast('That file is ' + this.formatBytes(file.size) + ' — the cap is 5 MB.', '⚠️');
                        return;
                    }
                    this.clearFile();
                    let blob = file;
                    if (info.image) blob = await this.shrinkImage(file);
                    this.newListing.blob = blob;
                    this.newListing.fileName = name;
                    this.newListing.fileSize = Number(blob.size) || 0;
                    this.newListing.fileType = String(blob.type || type).split(';')[0];
                    this.newListing.iconLabel = info.label;
                    if (info.image) this.newListing.previewUrl = URL.createObjectURL(blob);
                },

                // Photos are scaled down on the device before any byte leaves it.
                async shrinkImage(file) {
                    if (file.type === 'image/gif' || file.size < 1200000) return file;
                    try {
                        const bitmap = await createImageBitmap(file);
                        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                        if (bitmap.close) bitmap.close();
                        const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
                        return out && out.size < file.size ? out : file;
                    } catch {
                        return file;
                    }
                },

                async loadMarketplace(refreshPanels) {
                    try {
                        const data = await this.api('/api/marketplace/items');
                        const items = Array.isArray(data.items) ? data.items : (Array.isArray(data.listings) ? data.listings : []);
                        this.marketplace.items = items;
                        this.marketplace.state = 'live';
                        this.marketplace.headline = items.length
                            ? items.length + ' live listing' + (items.length === 1 ? '' : 's') + ' on this mesh'
                            : 'Marketplace is online — no active listings yet';
                        this.marketplace.note = 'Sourced from /api/marketplace/items.';
                    } catch (err) {
                        this.marketplace.items = [];
                        const p = err.payload;
                        this.marketplace.state = err.status === 501 ? 'not_hooked' : 'error';
                        this.marketplace.headline = err.status === 501
                            ? 'Marketplace API is declared but not wired to D1 yet (HTTP 501)'
                            : this.describeError(err);
                        this.marketplace.note = p && p.purpose
                            ? p.purpose + ' — planned in ' + p.implement_in + '. Purchases stay disabled until then, so nothing here is faked.'
                            : 'Listings cannot be bought or posted right now.';
                    }
                    if (refreshPanels) await this.loadSellerPanels();
                },

                async loadSellerPanels() {
                    this.myListings = [];
                    this.incomingQuotes = [];
                    this.myQuotes = [];
                    if (!this.auth.user) return;
                    const [mine, incoming, asked] = await Promise.allSettled([
                        this.api('/api/marketplace/items/mine'),
                        this.api('/api/marketplace/quotes/incoming'),
                        this.api('/api/marketplace/quotes/mine'),
                    ]);
                    if (mine.status === 'fulfilled') this.myListings = Array.isArray(mine.value.items) ? mine.value.items : [];
                    if (incoming.status === 'fulfilled') this.incomingQuotes = Array.isArray(incoming.value.quotes) ? incoming.value.quotes : [];
                    if (asked.status === 'fulfilled') this.myQuotes = Array.isArray(asked.value.quotes) ? asked.value.quotes : [];
                },

                async submitListing() {
                    if (this.needAuth('register')) return;
                    const title = String(this.newListing.title || '').trim();
                    const price = Number(String(this.newListing.price ?? '').replace(/[^0-9]/g, ''));
                    if (title.length < 3 || title.length > 100) {
                        this.showToast('Give the listing a title of 3-100 characters.', '⚠️');
                        return;
                    }
                    if (!Number.isSafeInteger(price) || price <= 0) {
                        this.showToast('Price must be a whole number of TZS above 0.', '⚠️');
                        return;
                    }
                    if (!this.newListing.payWallet && !this.newListing.payMobileMoney) {
                        this.showToast('Pick at least one way for buyers to pay.', '⚠️');
                        return;
                    }
                    this.busy.listing = true;
                    this.listingSteps = [];
                    const publishedTitle = title;
                    let draftId = '';
                    try {
                        this.step('1/3 creating the ' + this.newListing.kind + ' draft…');
                        const created = await this.api('/api/marketplace/items', {
                            method: 'POST',
                            body: JSON.stringify({
                                kind: this.newListing.kind,
                                title,
                                description: String(this.newListing.description || '').trim(),
                                price,
                                negotiable: Boolean(this.newListing.negotiable),
                                pay_wallet: Boolean(this.newListing.payWallet),
                                pay_mobile_money: Boolean(this.newListing.payMobileMoney),
                                payment_notes: String(this.newListing.paymentNotes || '').trim(),
                                condition: this.newListing.condition || null,
                                location: String(this.newListing.location || '').trim() || null,
                                contact_phone: String(this.newListing.contactPhone || '').trim() || null,
                            }),
                        });
                        const item = created.item;
                        if (!item || !item.id) throw new Error('The server did not confirm the new listing');
                        draftId = String(item.id);
                        this.step('1/3 draft ' + draftId.slice(0, 8) + ' created');

                        if (this.newListing.blob) {
                            this.step('2/3 uploading ' + this.newListing.fileName + ' · ' + this.formatBytes(this.newListing.fileSize) + '…');
                            const uploaded = await this.uploadAsset(item.id, this.newListing.blob, {
                                type: this.newListing.fileType,
                                name: this.newListing.fileName,
                            });
                            const sha = uploaded.asset && uploaded.asset.sha256 ? String(uploaded.asset.sha256).slice(0, 12) : '';
                            this.step('2/3 stored, sha256 ' + sha + '…');
                        } else {
                            this.step('2/3 no file attached — listed without a picture');
                        }

                        this.step('3/3 publishing…');
                        await this.api('/api/marketplace/items/' + encodeURIComponent(item.id) + '/publish', { method: 'POST' });
                        this.step('3/3 live on the mesh');
                        this.modals.listing = false;
                        this.resetListingForm();
                        this.showToast('Published "' + publishedTitle + '".', '🛍️');
                        await Promise.all([this.loadMarketplace(), this.loadSellerPanels()]);
                    } catch (err) {
                        const message = this.describeError(err);
                        this.step('✗ ' + message);
                        if (draftId) this.step('draft ' + draftId.slice(0, 8) + ' is in "My listings" — attach another file, Publish it, or Withdraw it');
                        this.showToast(message, '🛍️');
                        if (err.status === 401) this.auth.user = null;
                        await this.loadSellerPanels();
                    } finally {
                        this.busy.listing = false;
                    }
                },

                async publishListing(item) {
                    this.busy.listing = true;
                    try {
                        await this.api('/api/marketplace/items/' + encodeURIComponent(item.id) + '/publish', { method: 'POST' });
                        this.showToast('"' + item.title + '" is live.', '🛍️');
                        await Promise.all([this.loadMarketplace(), this.loadSellerPanels()]);
                    } catch (err) {
                        this.showToast(this.describeError(err), '⚠️');
                    } finally {
                        this.busy.listing = false;
                    }
                },

                async cancelListing(item) {
                    if (!window.confirm('Withdraw "' + item.title + '" from the marketplace?')) return;
                    this.busy.listing = true;
                    try {
                        await this.api('/api/marketplace/items/' + encodeURIComponent(item.id) + '/cancel', { method: 'POST' });
                        this.showToast('Listing withdrawn.', '🛍️');
                        await Promise.all([this.loadMarketplace(), this.loadSellerPanels()]);
                    } catch (err) {
                        this.showToast(this.describeError(err), '⚠️');
                    } finally {
                        this.busy.listing = false;
                    }
                },

                async buyMarketplaceItem(item) {
                    if (this.needAuth('login')) return;
                    if (!item.payment_methods || item.payment_methods.indexOf('wallet') === -1) {
                        this.showToast('This listing does not accept wallet payment.', '⚠️');
                        return;
                    }
                    if (!window.confirm('Pay ' + this.formatMoney(item.price) + ' TZS from your wallet for "' + item.title + '"?')) return;
                    this.busy.market = true;
                    try {
                        const data = await this.api('/api/marketplace/buy', {
                            method: 'POST',
                            headers: { 'Idempotency-Key': this.idemKey() },
                            body: JSON.stringify({ item_id: item.id }),
                        });
                        const paid = data && data.paid ? data.paid : item.price;
                        this.showToast('Paid ' + this.formatMoney(paid) + ' TZS — ' + (item.seller && item.seller.username ? '@' + item.seller.username + ' was credited.' : 'seller credited.'), '🛍️');
                        await Promise.all([this.loadWalletData(), this.loadMarketplace(), this.loadSellerPanels()]);
                    } catch (err) {
                        this.showToast(this.describeError(err), '🛍️');
                        if (err.status === 401) this.auth.user = null;
                    } finally {
                        this.busy.market = false;
                    }
                },

                // ---------- quotations ----------
                openQuoteModal(item) {
                    if (this.needAuth('login')) return;
                    if (!item.negotiable) {
                        this.showToast('This seller is not accepting offers.', '⚠️');
                        return;
                    }
                    this.quoteForm = { item, price: '', message: '' };
                    this.modals.quote = true;
                },

                async submitQuoteRequest() {
                    if (this.needAuth('login')) return;
                    const item = this.quoteForm.item;
                    if (!item) return;
                    const offered = Number(String(this.quoteForm.price ?? '').replace(/[^0-9]/g, ''));
                    if (!Number.isSafeInteger(offered) || offered <= 0) {
                        this.showToast('Enter your offer as a whole number of TZS.', '⚠️');
                        return;
                    }
                    this.busy.quote = true;
                    try {
                        await this.api('/api/marketplace/items/' + encodeURIComponent(item.id) + '/quotes', {
                            method: 'POST',
                            body: JSON.stringify({ offered_price: offered, message: String(this.quoteForm.message || '').trim() }),
                        });
                        this.modals.quote = false;
                        this.showToast('Quotation sent — the seller can accept, counter or decline.', '📝');
                        await this.loadSellerPanels();
                    } catch (err) {
                        this.showToast(this.describeError(err), '📝');
                        if (err.status === 401) this.auth.user = null;
                    } finally {
                        this.busy.quote = false;
                    }
                },

                async respondToQuote(quote, decision) {
                    this.busy.quote = true;
                    const raw = this.quoteReply[quote.id];
                    const counter = Number(String(raw ?? '').replace(/[^0-9]/g, ''));
                    const payload = { decision };
                    if (decision === 'accept' && Number.isSafeInteger(counter) && counter > 0) payload.counter_price = counter;
                    try {
                        await this.api('/api/marketplace/quotes/' + encodeURIComponent(quote.id) + '/respond', {
                            method: 'POST',
                            body: JSON.stringify(payload),
                        });
                        const label = decision === 'accept'
                            ? 'accepted' + (payload.counter_price ? ' at ' + this.formatMoney(payload.counter_price) + ' TZS' : '')
                            : 'declined';
                        this.showToast('Quotation from @' + (quote.counterparty.username || '?') + ' ' + label + '.', '📝');
                        delete this.quoteReply[quote.id];
                        await this.loadSellerPanels();
                    } catch (err) {
                        this.showToast(this.describeError(err), '📝');
                    } finally {
                        this.busy.quote = false;
                    }
                },

                async payQuote(quote) {
                    if (this.needAuth('login')) return;
                    const amount = Number(quote.payable_price || quote.accepted_price);
                    if (!Number.isSafeInteger(amount) || amount <= 0) {
                        this.showToast('This quotation has no agreed price.', '⚠️');
                        return;
                    }
                    if (!window.confirm('Pay ' + this.formatMoney(amount) + ' TZS from your wallet for "' + quote.item.title + '"?')) return;
                    this.busy.quote = true;
                    try {
                        const data = await this.api('/api/marketplace/quotes/' + encodeURIComponent(quote.id) + '/pay', {
                            method: 'POST',
                            headers: { 'Idempotency-Key': this.idemKey() },
                            body: '{}',
                        });
                        this.showToast('Paid ' + this.formatMoney(data.paid || amount) + ' TZS — both ledgers updated.', '✅');
                        await Promise.all([this.loadWalletData(), this.loadMarketplace(), this.loadSellerPanels()]);
                    } catch (err) {
                        this.showToast(this.describeError(err), '⚠️');
                        if (err.status === 401) this.auth.user = null;
                    } finally {
                        this.busy.quote = false;
                    }
                },

                // ---------- omni search ----------
                handleOmniSearch() {
                    const query = String(this.omniQuery || '').trim();
                    this.omniQuery = '';
                    if (!query) return;

                    const mac = this.normalizeMac(query);
                    if (mac) {
                        this.macAddress = mac;
                        this.saveMac();
                        return;
                    }

                    const tx = this.transactions.find((row) => (row.reference_id || row.id).toLowerCase().includes(query.toLowerCase()));
                    if (tx) {
                        this.highlightedTx = tx.reference_id || tx.id;
                        this.activeTab = 'wallet';
                        this.showToast('Ledger match: ' + this.prettyType(tx.type) + ' ' + this.formatMoney(tx.amount) + ' TZS', '💳');
                        return;
                    }

                    const pkg = this.packages.find((row) => String(row.id).toLowerCase() === query.toLowerCase() || String(row.name).toLowerCase().includes(query.toLowerCase()));
                    if (pkg) {
                        this.activeTab = 'plans';
                        this.showToast('Package match: ' + pkg.name + ' — ' + this.formatMoney(pkg.price) + ' TZS', '📶');
                        return;
                    }

                    this.showToast('No ledger, package, or node match for "' + query.slice(0, 24) + '".', '🛠️');
                },

                // ---------- formatting & misc ----------
                formatMoney(value) {
                    const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
                    return Number.isFinite(n) ? n.toLocaleString('en-US') : '0';
                },

                parseDate(value) {
                    if (!value) return null;
                    const iso = /[T ]/.test(value) && !/Z|[+-]\d{2}:?\d{2}$/.test(value)
                        ? String(value).replace(' ', 'T') + 'Z'
                        : String(value);
                    const d = new Date(iso);
                    return Number.isNaN(d.getTime()) ? null : d;
                },

                formatDate(value) {
                    const d = this.parseDate(value);
                    return d ? d.toLocaleString() : '—';
                },

                async copy(text) {
                    try {
                        await navigator.clipboard.writeText(text);
                        this.showToast('Copied to clipboard.', '📋');
                    } catch {
                        this.showToast('Clipboard blocked by the browser — copy manually.', '⚠️');
                    }
                },

                showToast(message, icon = '⚡') {
                    this.toast.message = message;
                    this.toast.icon = icon;
                    this.toast.show = true;
                    clearTimeout(this._toastTimer);
                    this._toastTimer = setTimeout(() => { this.toast.show = false; }, 4000);
                },

                generatePDFReceipt(tx) {
                    if (!window.jspdf || !window.jspdf.jsPDF) {
                        this.showToast('The PDF library did not load (offline?).', '⚠️');
                        return;
                    }
                    const { jsPDF } = window.jspdf;
                    const doc = new jsPDF();
                    doc.setFillColor(15, 23, 42);
                    doc.rect(0, 0, 210, 297, 'F');
                    doc.setTextColor(255, 255, 255);
                    doc.setFontSize(22);
                    doc.text('FLAT COIN ISP - OFFICIAL RECEIPT', 20, 30);
                    doc.setFontSize(12);
                    doc.setTextColor(148, 163, 184);
                    doc.text('Secure Ledger Transaction Statement', 20, 40);

                    doc.setDrawColor(51, 65, 85);
                    doc.line(20, 50, 190, 50);

                    doc.setTextColor(255, 255, 255);
                    doc.text('Transaction Reference ID: ' + (tx.reference_id || tx.id), 20, 70);
                    doc.text('Type: ' + String(tx.type || ''), 20, 80);
                    doc.text('Amount: ' + (this.isCredit(tx.type) ? '+' : '-') + this.formatMoney(tx.amount) + ' TZS', 20, 90);
                    doc.text('Status: ' + String(tx.status || ''), 20, 100);
                    doc.text('Date Recorded: ' + this.formatDate(tx.created_at), 20, 110);
                    doc.text('Device MAC Node: ' + (this.macAddress || 'not supplied'), 20, 120);
                    doc.text('Issued: ' + new Date().toISOString(), 20, 140);

                    doc.save('receipt-' + (tx.reference_id || tx.id) + '.pdf');
                    this.showToast('PDF Receipt downloaded to device.', '📄');
                }
            };
        }
    }