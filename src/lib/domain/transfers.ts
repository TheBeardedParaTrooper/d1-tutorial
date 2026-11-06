import type { Bindings } from '../../env'
import { ok, fail, Result } from '../helpers'
import { debitWalletStmt, creditWalletStmt, insertTxStmt } from './transactions'

export async function p2p(
  env: Bindings,
  input: { senderId: string; recipientId: string; amount: number; idempotencyKey: string },
): Promise<Result<{ recipientId: string; amount: number }>> {
  if (input.senderId === input.recipientId) return fail('self', 'Cannot transfer to yourself')
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 2_000_000_000) {
    return fail('bad_amount', 'Amount must be a positive integer TZS')
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) return fail('bad_key', 'Invalid Idempotency-Key')

  const recipient = await env.DB.prepare(
    `SELECT u.id FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.id = ?`,
  ).bind(input.recipientId).first<{ id: string }>()
  if (!recipient) return fail('no_recipient', 'Recipient does not exist', 404)

  const txOut = crypto.randomUUID()
  const txIn = crypto.randomUUID()
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (user_id, idempotency_key, operation) VALUES (?, ?, 'transfer')`,
    ).bind(input.senderId, input.idempotencyKey),
    debitWalletStmt(env.DB, input.senderId, input.amount),
    creditWalletStmt(env.DB, input.recipientId, input.amount),
    insertTxStmt(env.DB, { id: txOut, userId: input.senderId, type: 'TRANSFER_OUT', amount: input.amount, referenceId: `transfer:${input.idempotencyKey}:out` }),
    insertTxStmt(env.DB, { id: txIn, userId: input.recipientId, type: 'TRANSFER_IN', amount: input.amount, referenceId: `transfer:${input.idempotencyKey}:in` }),
    env.DB.prepare(
      `INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json)
       SELECT ?, 'wallet.transfer', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`,
    ).bind(input.senderId, txOut, JSON.stringify({ recipient_user_id: input.recipientId, outgoing_transaction_id: txOut, incoming_transaction_id: txIn, amount: input.amount, currency: 'TZS' })),
  ])
  if (results[0].meta.changes !== 1) return fail('idem_used', 'Idempotency key already used', 409)
  if (results[1].meta.changes !== 1) return fail('insufficient', 'Insufficient balance', 400)
  if (results.slice(2).some((r) => r.meta.changes !== 1)) return fail('internal', 'Transfer failed', 500)
  return ok({ recipientId: input.recipientId, amount: input.amount })
}
