import type { Bindings } from '../../env'

export function creditWalletStmt(db: D1Database, userId: string, amount: number): D1PreparedStatement {
  return db.prepare(
    `UPDATE wallets SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND changes() = 1`,
  ).bind(amount, userId)
}

export function debitWalletStmt(db: D1Database, userId: string, amount: number): D1PreparedStatement {
  return db.prepare(
    `UPDATE wallets SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND balance >= ? AND changes() = 1`,
  ).bind(amount, userId, amount)
}

export function insertTxStmt(
  db: D1Database,
  tx: {
    id: string
    userId: string
    type: 'DEPOSIT_AZAMPAY' | 'SPEND_TIME_PASS' | 'TRANSFER_IN' | 'TRANSFER_OUT' |
          'MARKETPLACE_BUY' | 'MARKETPLACE_SELL' | 'ADMIN_CREDIT' | 'ADMIN_REFUND'
    amount: number
    referenceId: string
  },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO transactions (id, user_id, type, amount, status, reference_id)
     SELECT ?, ?, ?, ?, 'success', ? WHERE changes() = 1`,
  ).bind(tx.id, tx.userId, tx.type, tx.amount, tx.referenceId)
}

export async function getWallet(env: Bindings, userId: string) {
  return env.DB.prepare(`SELECT user_id, balance, updated_at FROM wallets WHERE user_id = ?`)
    .bind(userId).first<{ user_id: string; balance: number; updated_at: string }>() ?? null
}

export async function listTransactions(env: Bindings, userId: string, limit = 50) {
  const { results } = await env.DB.prepare(
    `SELECT id, type, amount, status, reference_id, created_at
     FROM transactions WHERE user_id = ?
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(userId, limit).all<{
    id: string; type: string; amount: number; status: string;
    reference_id: string | null; created_at: string
  }>()
  return results || []
}
