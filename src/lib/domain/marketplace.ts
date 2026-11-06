import type { Bindings } from '../../env'
import { ok, fail, type Result } from '../helpers'
import { debitWalletStmt, creditWalletStmt, insertTxStmt } from './transactions'
import { assetLabel } from './assets'

export type ItemRow = {
  id: string; seller_id: string; kind: 'product' | 'file'; title: string; description: string
  price: number; currency: string; status: string; negotiable: number; pay_wallet: number
  pay_mobile_money: number; payment_notes: string; item_condition: string | null
  location: string | null; contact_phone: string | null; asset_id: string | null
  asset_purpose: string | null; asset_file_name: string | null; asset_content_type: string | null
  asset_size_bytes: number | null; created_at: string; updated_at: string
  published_at: string | null; sold_at: string | null
  seller_username: string | null; seller_name: string | null
}

const ITEM_SELECT = `
  SELECT i.id, i.seller_id, i.kind, i.title, i.description, i.price, i.currency, i.status,
         i.negotiable, i.pay_wallet, i.pay_mobile_money, i.payment_notes, i.item_condition,
         i.location, i.contact_phone, i.asset_id, i.created_at, i.updated_at, i.published_at, i.sold_at,
         a.purpose AS asset_purpose, a.file_name AS asset_file_name,
         a.content_type AS asset_content_type, a.size_bytes AS asset_size_bytes,
         u.username AS seller_username, u.full_name AS seller_name
  FROM marketplace_items i
  JOIN users u ON u.id = i.seller_id
  LEFT JOIN marketplace_assets a ON a.id = i.asset_id`

/** Wire shape: URLs the browser can use, plus the icon label for non-image files. */
export function shapeItem(row: ItemRow & { quote_status?: string | null }): Record<string, unknown> {
  const hasAsset = Boolean(row.asset_id)
  const isImage = hasAsset && row.asset_purpose === 'image'
  const isFile = hasAsset && row.asset_purpose === 'file'
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    price: row.price,
    currency: row.currency,
    status: row.status,
    negotiable: row.negotiable === 1,
    payment_methods: [
      ...(row.pay_wallet === 1 ? ['wallet'] : []),
      ...(row.pay_mobile_money === 1 ? ['mobile_money'] : []),
    ],
    payment_notes: row.payment_notes,
    condition: row.item_condition,
    location: row.location,
    contact_phone: row.contact_phone,
    seller: { id: row.seller_id, username: row.seller_username, name: row.seller_name },
    asset: hasAsset
      ? {
          id: row.asset_id,
          purpose: row.asset_purpose,
          file_name: row.asset_file_name,
          content_type: row.asset_content_type,
          size_bytes: row.asset_size_bytes,
          icon_label: isImage ? null : assetLabel(row.asset_content_type, row.asset_file_name),
          url: `/api/marketplace/items/${row.id}/asset`,
        }
      : null,
    image_url: isImage ? `/api/marketplace/items/${row.id}/asset` : null,
    file_url: isFile ? `/api/marketplace/items/${row.id}/asset` : null,
    created_at: row.created_at,
    published_at: row.published_at,
    sold_at: row.sold_at,
    quote_status: row.quote_status ?? null,
  }
}

export async function listActive(env: Bindings, limit = 50, search = ''): Promise<ItemRow[]> {
  const capped = Math.min(100, Math.max(1, limit))
  const term = search.trim().replace(/[%_*]/g, '')
  if (term) {
    const { results } = await env.DB
      .prepare(`${ITEM_SELECT} WHERE i.status = 'active' AND (i.title LIKE ? OR i.description LIKE ? OR u.username LIKE ?) ORDER BY i.published_at DESC LIMIT ?`)
      .bind(`%${term}%`, `%${term}%`, `%${term}%`, capped).all<ItemRow>()
    return results || []
  }
  const { results } = await env.DB
    .prepare(`${ITEM_SELECT} WHERE i.status = 'active' ORDER BY i.published_at DESC LIMIT ?`)
    .bind(capped).all<ItemRow>()
  return results || []
}

export async function listMine(env: Bindings, sellerId: string): Promise<ItemRow[]> {
  const { results } = await env.DB
    .prepare(`${ITEM_SELECT} WHERE i.seller_id = ? ORDER BY i.created_at DESC`)
    .bind(sellerId).all<ItemRow>()
  return results || []
}

export async function getItem(env: Bindings, itemId: string): Promise<ItemRow | null> {
  if (!itemId || itemId.length > 64) return null
  return env.DB.prepare(`${ITEM_SELECT} WHERE i.id = ?`).bind(itemId).first<ItemRow>() ?? null
}

/** What the signed-in buyer already asked for on this item, if anything. */
export async function myOpenQuote(env: Bindings, buyerId: string, itemId: string) {
  return env.DB.prepare(
    `SELECT id, status, requested_price, accepted_price, created_at, responded_at, expires_at
     FROM marketplace_quotes WHERE buyer_id = ? AND item_id = ? AND status IN ('pending', 'accepted')`,
  ).bind(buyerId, itemId).first<Record<string, unknown>>() ?? null
}

export type CreateInput = {
  sellerId: string; kind: 'product' | 'file'; title: string; description: string; price: number
  negotiable: boolean; payWallet: boolean; payMobileMoney: boolean; paymentNotes: string
  condition: string | null; location: string | null; contactPhone: string | null
}

export async function create(env: Bindings, input: CreateInput): Promise<Result<{ id: string }>> {
  const title = input.title.trim()
  const description = input.description.trim()
  if (!title || title.length < 3 || title.length > 100) return fail('bad_title', 'Title must be 3-100 characters')
  if (description.length > 2000) return fail('bad_desc', 'Description too long (max 2000)')
  if (!Number.isSafeInteger(input.price) || input.price <= 0 || input.price > 2_000_000_000) {
    return fail('bad_price', 'Price must be a whole number of TZS above 0')
  }
  if (input.kind !== 'product' && input.kind !== 'file') return fail('bad_kind', 'kind must be product or file')
  if (!input.payWallet && !input.payMobileMoney) return fail('bad_payment', 'Pick at least one payment method')
  if (input.paymentNotes.length > 300) return fail('bad_payment', 'Payment notes too long (max 300)')
  if (input.condition && !['new', 'used', 'refurbished'].includes(input.condition)) return fail('bad_condition', 'Unknown condition')
  if (input.contactPhone && !/^\+?[1-9]\d{6,14}$/.test(input.contactPhone.replace(/[\s-]/g, ''))) {
    return fail('bad_contact', 'Contact phone must be a valid MSISDN')
  }

  try {
    await env.DB.prepare(
      `INSERT INTO marketplace_items
        (id, seller_id, kind, title, description, price, negotiable, pay_wallet, pay_mobile_money,
         payment_notes, item_condition, location, contact_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), input.sellerId, input.kind, title, description, input.price,
      input.negotiable ? 1 : 0, input.payWallet ? 1 : 0, input.payMobileMoney ? 1 : 0,
      input.paymentNotes.trim(), input.condition, input.location?.trim() || null, input.contactPhone?.trim() || null,
    ).run()
  } catch {
    return fail('insert_failed', 'Could not create the listing', 500)
  }

  const row = await env.DB.prepare(
    `SELECT id FROM marketplace_items WHERE seller_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).bind(input.sellerId).first<{ id: string }>()
  if (!row) return fail('insert_failed', 'Could not confirm the new listing', 500)
  return ok({ id: row.id })
}

export async function attachAsset(
  env: Bindings,
  input: { itemId: string; sellerId: string; assetId: string },
): Promise<Result<{ id: string; asset_id: string }>> {
  const r = await env.DB.prepare(
    `UPDATE marketplace_items
     SET asset_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND seller_id = ? AND status IN ('draft', 'active') AND changes() = 1`,
  ).bind(input.assetId, input.itemId, input.sellerId).run()
  if (!r.meta.changes || r.meta.changes !== 1) return fail('not_owner', 'Listing not editable', 404)
  return ok({ id: input.itemId, asset_id: input.assetId })
}

export async function publish(env: Bindings, itemId: string, sellerId: string): Promise<Result<{ id: string }>> {
  const r = await env.DB.prepare(
    `UPDATE marketplace_items
     SET status = 'active', published_at = COALESCE(published_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND seller_id = ? AND status = 'draft' AND changes() = 1`,
  ).bind(itemId, sellerId).run()
  if (!r.meta.changes || r.meta.changes !== 1) return fail('cannot_publish', 'Draft listing not found', 404)
  await env.DB.prepare(
    `INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (?, 'marketplace.published', ?, ?)`,
  ).bind(sellerId, itemId, JSON.stringify({ action: 'publish' })).run().catch(() => {})
  return ok({ id: itemId })
}

export async function cancel(env: Bindings, itemId: string, sellerId: string): Promise<Result<{ id: string }>> {
  const r = await env.DB.prepare(
    `UPDATE marketplace_items SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND seller_id = ? AND status IN ('draft', 'active') AND changes() = 1`,
  ).bind(itemId, sellerId).run()
  if (!r.meta.changes || r.meta.changes !== 1) return fail('not_found', 'Editable listing not found', 404)
  await env.DB.prepare(
    `UPDATE marketplace_quotes SET status = 'expired', responded_at = CURRENT_TIMESTAMP
     WHERE item_id = ? AND status IN ('pending', 'accepted')`,
  ).bind(itemId).run().catch(() => {})
  return ok({ id: itemId })
}

async function walletBalance(env: Bindings, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).bind(userId).first<{ balance: number }>()
  return Number(row?.balance ?? 0)
}

export async function buy(
  env: Bindings,
  input: { buyerId: string; itemId: string; idempotencyKey: string },
): Promise<Result<{ itemId: string; paid: number; sellerId: string }>> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) return fail('bad_key', 'Invalid Idempotency-Key')
  const item = await getItem(env, input.itemId)
  if (!item) return fail('not_found', 'Item not found', 404)
  if (item.status !== 'active') return fail('unavailable', 'Item is no longer available', 409)
  if (item.seller_id === input.buyerId) return fail('self', 'You cannot buy your own listing', 403)
  if (item.pay_wallet !== 1) return fail('payment', 'This listing does not accept wallet payment', 400)
  // Answered before the batch so a short balance is a 400, not a rollback error.
  if (await walletBalance(env, input.buyerId) < item.price) return fail('insufficient', 'Insufficient wallet balance', 400)

  const txBuyer = crypto.randomUUID()
  const txSeller = crypto.randomUUID()
  let results: Array<{ meta: { changes: number } }>
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_keys (user_id, idempotency_key, operation) VALUES (?, ?, 'marketplace_buy')`,
      ).bind(input.buyerId, input.idempotencyKey),
      debitWalletStmt(env.DB, input.buyerId, item.price),
      creditWalletStmt(env.DB, item.seller_id, item.price),
      insertTxStmt(env.DB, { id: txBuyer, userId: input.buyerId, type: 'MARKETPLACE_BUY', amount: item.price, referenceId: `quote:direct:${item.id}` }),
      insertTxStmt(env.DB, { id: txSeller, userId: item.seller_id, type: 'MARKETPLACE_SELL', amount: item.price, referenceId: `quote:direct:${item.id}` }),
      env.DB.prepare(
        `UPDATE marketplace_items SET status = 'sold', sold_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'active' AND changes() = 1`,
      ).bind(item.id),
      env.DB.prepare(
        `INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json)
         SELECT ?, 'marketplace.sold', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`,
      ).bind(input.buyerId, item.id, JSON.stringify({ seller_id: item.seller_id, price: item.price, currency: 'TZS', method: 'wallet' })),
    ])
  } catch {
    // The poisoned audit row is the rollback signal: nothing moved.
    return (await walletBalance(env, input.buyerId)) < item.price
      ? fail('insufficient', 'Insufficient wallet balance', 400)
      : fail('internal', 'Purchase failed — nothing was charged', 500)
  }
  if (results[0].meta.changes !== 1) return fail('idem_used', 'That request was already used — start a new one', 409)
  if (results[1].meta.changes !== 1) return fail('insufficient', 'Insufficient wallet balance', 400)
  if (results.slice(2).some((r) => r.meta.changes !== 1)) return fail('internal', 'Purchase failed — nothing was charged', 500)
  return ok({ itemId: item.id, paid: item.price, sellerId: item.seller_id })
}

// ---------------------------------------------------------------- quotations

export async function requestQuote(
  env: Bindings,
  input: { buyerId: string; itemId: string; offeredPrice: number; message: string },
): Promise<Result<{ id: string }>> {
  const item = await getItem(env, input.itemId)
  if (!item) return fail('not_found', 'Item not found', 404)
  if (item.status !== 'active') return fail('unavailable', 'Item is no longer available', 409)
  if (item.seller_id === input.buyerId) return fail('self', 'You cannot request a quote on your own listing', 403)
  if (item.negotiable !== 1) return fail('fixed_price', 'This seller is not accepting offers', 400)
  if (!Number.isSafeInteger(input.offeredPrice) || input.offeredPrice <= 0 || input.offeredPrice > 2_000_000_000) {
    return fail('bad_price', 'Offer must be a whole number of TZS above 0')
  }
  if (input.message.trim().length > 500) return fail('bad_message', 'Message too long (max 500)')

  const id = crypto.randomUUID()
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO marketplace_quotes (id, item_id, buyer_id, seller_id, requested_price, message, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now', '+72 hours'))`,
      ).bind(id, item.id, input.buyerId, item.seller_id, input.offeredPrice, input.message.trim()),
      env.DB.prepare(
        `INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json)
         SELECT ?, 'marketplace.quote_requested', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`,
      ).bind(input.buyerId, id, JSON.stringify({ item_id: item.id, seller_id: item.seller_id, offered_price: input.offeredPrice, currency: 'TZS' })),
    ])
  } catch (e) {
    const text = String(e)
    if (text.includes('UNIQUE')) return fail('quote_open', 'You already have an open quote on this listing', 409)
    return fail('quote_failed', 'Could not record the quotation request', 500)
  }
  return ok({ id })
}

export async function listQuotesForBuyer(env: Bindings, buyerId: string) {
  const { results } = await env.DB.prepare(
    `SELECT q.id, q.item_id, q.buyer_id, q.seller_id, q.requested_price, q.accepted_price, q.message,
            q.seller_note, q.status, q.created_at, q.responded_at, q.paid_at, q.expires_at,
            i.title AS item_title, i.price AS item_price, i.kind AS item_kind, i.status AS item_status,
            i.asset_id AS asset_id, a.purpose AS asset_purpose, a.content_type AS asset_content_type,
            a.file_name AS asset_file_name, u.username AS seller_username, u.full_name AS seller_name
     FROM marketplace_quotes q
     JOIN marketplace_items i ON i.id = q.item_id
     JOIN users u ON u.id = q.seller_id
     LEFT JOIN marketplace_assets a ON a.id = i.asset_id
     WHERE q.buyer_id = ? ORDER BY q.created_at DESC LIMIT 100`,
  ).bind(buyerId).all<Record<string, unknown>>()
  return results || []
}

export async function listQuotesForSeller(env: Bindings, sellerId: string) {
  const { results } = await env.DB.prepare(
    `SELECT q.id, q.item_id, q.buyer_id, q.requested_price, q.accepted_price, q.message,
            q.seller_note, q.status, q.created_at, q.responded_at, q.paid_at, q.expires_at,
            i.title AS item_title, i.price AS item_price, i.kind AS item_kind, i.status AS item_status,
            i.asset_id AS asset_id, a.purpose AS asset_purpose, a.content_type AS asset_content_type,
            a.file_name AS asset_file_name, u.username AS buyer_username, u.full_name AS buyer_name,
            w.balance AS buyer_balance
     FROM marketplace_quotes q
     JOIN marketplace_items i ON i.id = q.item_id
     JOIN users u ON u.id = q.buyer_id
     LEFT JOIN wallets w ON w.user_id = q.buyer_id
     LEFT JOIN marketplace_assets a ON a.id = i.asset_id
     WHERE q.seller_id = ? ORDER BY q.created_at DESC LIMIT 100`,
  ).bind(sellerId).all<Record<string, unknown>>()
  return results || []
}

export async function getQuote(env: Bindings, quoteId: string) {
  return env.DB.prepare(
    `SELECT id, item_id, buyer_id, seller_id, requested_price, accepted_price, message, seller_note,
            status, created_at, responded_at, paid_at, expires_at
     FROM marketplace_quotes WHERE id = ?`,
  ).bind(quoteId).first<Record<string, unknown>>() ?? null
}

export async function respondQuote(
  env: Bindings,
  input: { sellerId: string; quoteId: string; accept: boolean; price?: number; note?: string },
): Promise<Result<{ id: string; status: string }>> {
  const quote = await getQuote(env, input.quoteId)
  if (!quote) return fail('not_found', 'Quotation not found', 404)
  if (quote.seller_id !== input.sellerId) return fail('not_owner', 'This quotation is not yours to answer', 403)
  if (quote.status !== 'pending') return fail('answered', `Quotation is already ${quote.status}`, 409)

  let acceptedPrice: number | null = null
  if (input.accept) {
    acceptedPrice = Number.isSafeInteger(input.price) && (input.price as number) > 0
      ? input.price as number
      : Number(quote.requested_price)
    if (acceptedPrice <= 0 || acceptedPrice > 2_000_000_000) return fail('bad_price', 'Counter price out of range')
  }
  const note = (input.note || '').trim().slice(0, 300)

  const r = await env.DB.prepare(
    `UPDATE marketplace_quotes
     SET status = ?, accepted_price = ?, seller_note = ?, responded_at = CURRENT_TIMESTAMP,
         expires_at = CASE WHEN ? = 1 THEN datetime('now', '+72 hours') ELSE expires_at END
     WHERE id = ? AND seller_id = ? AND status = 'pending' AND changes() = 1`,
  ).bind(
    input.accept ? 'accepted' : 'declined', acceptedPrice, note, input.accept ? 1 : 0,
    input.quoteId, input.sellerId,
  ).run()
  if (!r.meta.changes || r.meta.changes !== 1) return fail('answered', 'Quotation already answered', 409)

  await env.DB.prepare(
    `INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (?, ?, ?, ?)`,
  ).bind(
    input.sellerId, input.accept ? 'marketplace.quote_accepted' : 'marketplace.quote_declined', input.quoteId,
    JSON.stringify({ item_id: quote.item_id, buyer_id: quote.buyer_id, requested_price: quote.requested_price, accepted_price: acceptedPrice, currency: 'TZS' }),
  ).run().catch(() => {})

  return ok({ id: input.quoteId, status: input.accept ? 'accepted' : 'declined' })
}

/**
 * Settle an accepted quotation: buyer wallet -> seller wallet in one D1 batch.
 * Every statement after the debit is chained on changes() = 1, so a short
 * balance leaves the quotation, the listing and both wallets untouched.
 */
export async function payQuote(
  env: Bindings,
  input: { buyerId: string; quoteId: string; idempotencyKey: string },
): Promise<Result<{ quoteId: string; itemId: string; paid: number; sellerId: string }>> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) return fail('bad_key', 'Invalid Idempotency-Key')

  const quote = await getQuote(env, input.quoteId)
  if (!quote) return fail('not_found', 'Quotation not found', 404)
  if (quote.buyer_id !== input.buyerId) return fail('not_owner', 'This quotation belongs to another buyer', 403)
  if (quote.status !== 'accepted') return fail('not_payable', `Quotation is ${quote.status}, not accepted`, 409)
  const amount = Number(quote.accepted_price)
  if (!Number.isSafeInteger(amount) || amount <= 0) return fail('not_payable', 'Quotation has no agreed price', 409)

  if (await walletBalance(env, input.buyerId) < amount) return fail('insufficient', 'Insufficient wallet balance', 400)

  const sellerId = String(quote.seller_id)
  const itemId = String(quote.item_id)
  const txBuyer = crypto.randomUUID()
  const txSeller = crypto.randomUUID()

  let results: Array<{ meta: { changes: number } }>
  try {
  results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (user_id, idempotency_key, operation) VALUES (?, ?, 'marketplace_quote_pay')`,
    ).bind(input.buyerId, input.idempotencyKey),
    env.DB.prepare(
      `UPDATE marketplace_quotes SET status = 'accepted'
       WHERE id = ? AND buyer_id = ? AND status = 'accepted' AND accepted_price = ?
         AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
         AND (SELECT status FROM marketplace_items WHERE id = marketplace_quotes.item_id) = 'active'
         AND changes() = 1`,
    ).bind(input.quoteId, input.buyerId, amount),
    debitWalletStmt(env.DB, input.buyerId, amount),
    creditWalletStmt(env.DB, sellerId, amount),
    insertTxStmt(env.DB, { id: txBuyer, userId: input.buyerId, type: 'MARKETPLACE_BUY', amount, referenceId: `quote:${input.quoteId}` }),
    insertTxStmt(env.DB, { id: txSeller, userId: sellerId, type: 'MARKETPLACE_SELL', amount, referenceId: `quote:${input.quoteId}` }),
    env.DB.prepare(
      `UPDATE marketplace_quotes
       SET status = 'paid', paid_at = CURRENT_TIMESTAMP, buyer_txn_id = ?, seller_txn_id = ?
       WHERE id = ? AND buyer_id = ? AND status = 'accepted' AND changes() = 1`,
    ).bind(txBuyer, txSeller, input.quoteId, input.buyerId),
    env.DB.prepare(
      `UPDATE marketplace_items SET status = 'sold', sold_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'active'
         AND (SELECT status FROM marketplace_quotes WHERE id = ?) = 'paid' AND changes() = 1`,
    ).bind(itemId, input.quoteId),
    env.DB.prepare(
      `INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json)
       SELECT ?, 'marketplace.quote_paid', ?, CASE WHEN changes() = 1 THEN ? ELSE 'invalid-audit-json' END`,
    ).bind(input.buyerId, input.quoteId, JSON.stringify({
      item_id: itemId, seller_id: sellerId, amount, currency: 'TZS', method: 'wallet',
      buyer_txn_id: txBuyer, seller_txn_id: txSeller,
    })),
  ])
  } catch {
    // The poisoned audit row is the rollback signal: nothing was charged.
    return (await walletBalance(env, input.buyerId)) < amount
      ? fail('insufficient', 'Insufficient wallet balance', 400)
      : fail('internal', 'Payment failed — nothing was charged', 500)
  }

  if (results[0].meta.changes !== 1) return fail('idem_used', 'That request was already used — start a new one', 409)
  if (results[1].meta.changes !== 1) return fail('not_payable', 'Quotation is no longer payable (expired, declined or the item was sold)', 409)
  if (results[2].meta.changes !== 1) return fail('insufficient', 'Insufficient wallet balance', 400)
  if (results.slice(3).some((r) => r.meta.changes !== 1)) return fail('internal', 'Payment failed — nothing was charged', 500)

  return ok({ quoteId: input.quoteId, itemId, paid: amount, sellerId })
}
