# Payments and local audit copy

## Current safe behavior

Cloudflare D1 is authoritative for accounts, wallet ledger, pending payment orders, and the append-only audit outbox. `POST /api/payments/orders` creates a pending order from a server-selected package price. It does not call AzamPay, mark an order paid, charge a wallet, or grant hotspot access. The order stays pending until the provider's merchant-specific checkout and authenticated confirmation contract is verified and implemented. Never accept a browser redirect or caller-supplied success status as proof of payment.

The `/api/webhook/azampay` endpoint intentionally remains disabled (503). Obtain the current AzamPay merchant contract for the exact API version, checkout request and response, callback signature/header algorithm, canonicalization, replay/timestamp rules, retry/acknowledgement behavior, and status inquiry fields before enabling fulfillment. Store provider secrets as Cloudflare Worker secrets, not in source or browser code.

## D1 outbox to local SQLite

The Worker cannot safely connect to a developer's or operator's `localhost` database: it runs remotely. Therefore the local copy is an **eventually consistent pull replica**, not a synchronous dual-write. D1 writes operational state and an audit event in the same D1 transaction. A trusted operator machine periodically pulls pages from `GET /api/admin/audit/events` over HTTPS and appends them to a local SQLite file. D1 remains authoritative; local outages do not affect payments. The local receiver never sends an acknowledgement that deletes cloud events.

The sync client is [scripts/sync_audit.py](../scripts/sync_audit.py). It uses only Python's standard library, requires TLS for non-loopback URLs, rejects redirects, bounds the response size, and reads the admin secret from the environment. It uses SQLite transactions, unique source event IDs, append-only triggers, and a SHA-256 hash chain. The chain detects accidental or unauthorized modification of the local copy; it is not a signature and cannot protect against an attacker with full OS/database administrator access who can replace the file and recompute the chain. Restrict filesystem and backup access and retain independent backups for stronger tamper resistance.

Configure these environment variables in the **trusted sync process**, not in browser JavaScript:

- `AUDIT_API_URL`: canonical HTTPS Worker origin, without a path.
- `AUDIT_ADMIN_SECRET`: same high-entropy value configured as the Worker `ADMIN_SECRET`; keep it in a secrets manager or protected service environment.
- `AUDIT_DB_PATH`: optional local SQLite path (default `./audit/audit.sqlite3`).

Run `python3 scripts/sync_audit.py` periodically from a secured host. Schedule with the host's systemd timer, cron, or an equivalent process supervisor; do not expose the SQLite receiver to the public internet. Verify the local chain with `python3 scripts/sync_audit.py --verify-only`. The utility only reports counts and event IDs; it does not print the secret or event payloads.

## Rollout checklist

1. Back up the configured D1 database.
2. Review and apply migrations in order to the intended database. Existing local state is not reset by these additive migrations.
3. Configure high-entropy `AUTH_SECRET`, `ADMIN_SECRET`, `RADIUS_SHARED_SECRET`, and exact canonical `PORTAL_ORIGIN` as Worker secrets/vars where appropriate.
4. Configure the local sync process separately with the same admin secret through a host secrets manager.
5. Test sync against a non-production Worker/database first; verify pagination, replay safety, chain verification, and restore procedures.
6. Restrict the local SQLite file, its parent directory, and backups. Decide retention and independent backup policy.
7. Do not announce real mobile-money payment or automatic router access until AzamPay verification and the MikroTik provisioning path are separately tested.

## Scope of the current audit log

Current event coverage includes account creation/login/logout, pending payment-order creation, wallet-funded session purchase, transfers, and admin session revocation. Secrets, password hashes, auth tokens, RADIUS tokens, and full payment bodies must not be copied into audit event details. Extend the event list whenever another financially material state transition is added. The current payment path has no paid event because no trusted payment confirmation is configured.
