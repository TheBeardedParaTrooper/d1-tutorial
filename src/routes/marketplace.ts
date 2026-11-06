import type { Hono } from 'hono'
import type { Bindings } from '../env'
import { configuredSecret } from '../lib/helpers'
import { normalizeTzPhone } from '../lib/phone'
import { authenticatedUser, mutationOriginAllowed, readLimitedJson, jsonError } from './auth'
import {
  buy, cancel, create, getItem, getQuote, listActive, listMine, listQuotesForBuyer, listQuotesForSeller,
  myOpenQuote, payQuote, publish, requestQuote, respondQuote, shapeItem, attachAsset,
} from '../lib/domain/marketplace'
import {
  MAX_UPLOAD_BYTES, assetLabel, deleteAsset, getAssetMeta, isAcceptedType, putAsset, purposeFor,
  readAssetBytes, safeDisposition,
} from '../lib/domain/assets'

function text(body: any, key: string, max = 300): string | null {
  const v = body?.[key]
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  if (s.length > max) return null
  return s || null
}

function num(body: any, key: string): number {
  const raw = body?.[key]
  if (typeof raw === 'number') return Math.trunc(raw)
  const parsed = Number(String(raw ?? '').replace(/[,\s]/g, ''))
  return Number.isFinite(parsed) ? Math.trunc(parsed) : NaN
}

function idOk(id: string | undefined): id is string {
  return Boolean(id && id.length >= 6 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id))
}

export function registerMarketplaceRoutes(app: Hono<{ Bindings: Bindings }>) {
  // ---- listings -----------------------------------------------------------
  app.get('/api/marketplace/items', async (c) => {
    const rows = await listActive(c.env, Number(c.req.query('limit')) || 50, c.req.query('q') || '')
    return c.json({ currency: 'TZS', count: rows.length, items: rows.map((row) => shapeItem(row)) })
  })

  app.get('/api/marketplace/items/mine', async (c) => {
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const rows = await listMine(c.env, user.id)
    return c.json({ items: rows.map((row) => shapeItem(row)) })
  })

  app.get('/api/marketplace/items/:id', async (c) => {
    const id = c.req.param('id')
    if (!idOk(id)) return jsonError(c, 'Invalid id')
    const row = await getItem(c.env, id)
    if (!row) return jsonError(c, 'Not found', 404)
    const viewer = await authenticatedUser(c)
    const quote = viewer && viewer.id !== row.seller_id ? await myOpenQuote(c.env, viewer.id, id) : null
    return c.json({ item: shapeItem({ ...row, quote_status: (quote?.status as string) ?? null }) })
  })

  app.post('/api/marketplace/items', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const body: any = await readLimitedJson(c, 8192)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(c, 'Invalid body')

    const kind = body.kind === 'file' ? 'file' : 'product'
    const result = await create(c.env, {
      sellerId: user.id,
      kind,
      title: text(body, 'title', 100) || '',
      description: text(body, 'description', 2000) || '',
      price: num(body, 'price'),
      negotiable: body.negotiable !== false,
      payWallet: body.pay_wallet !== false,
      payMobileMoney: body.pay_mobile_money === true,
      paymentNotes: text(body, 'payment_notes', 300) || '',
      condition: text(body, 'condition', 20),
      location: text(body, 'location', 80),
      contactPhone: text(body, 'contact_phone', 20) ? normalizeTzPhone(String(body.contact_phone)) || String(body.contact_phone).trim() : null,
    })
    if (!result.ok) return jsonError(c, result.message, result.status)

    const item = await getItem(c.env, result.value.id)
    return c.json({ item: item ? shapeItem(item) : null, upload_url: `/api/marketplace/items/${result.value.id}/asset` }, 201)
  })

  // Raw bytes: the browser posts the File itself, no base64, no multipart parser.
  app.post('/api/marketplace/items/:id/asset', async (c) => {
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const id = c.req.param('id')
    if (!idOk(id)) return jsonError(c, 'Invalid id')

    const item = await getItem(c.env, id)
    if (!item) return jsonError(c, 'Listing not found', 404)
    if (item.seller_id !== user.id) return jsonError(c, 'Only the seller can upload to this listing', 403)
    if (item.status !== 'draft' && item.status !== 'active') return jsonError(c, 'Listing is closed', 409)

    const length = Number(c.req.header('Content-Length') || '0')
    if (length > MAX_UPLOAD_BYTES) return jsonError(c, `Uploads are capped at ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`)

    const bytes = await c.req.arrayBuffer()
    const contentType = (c.req.header('Content-Type') || 'application/octet-stream').split(';')[0].trim()
    const fileName = (c.req.header('X-File-Name') || 'upload').trim().slice(0, 140)
    // Checked before anything is destroyed: a rejected upload must never wipe
    // the file a seller already attached.
    if (!isAcceptedType(contentType)) return jsonError(c, 'Unsupported file type')
    const purpose = purposeFor(contentType)
    if (item.kind === 'file' && purpose !== 'file') return jsonError(c, 'This listing delivers a file, so the upload must be a document')
    if (item.asset_purpose === 'image' && purpose !== 'image') return jsonError(c, 'This product already has a photo; replace it with another image')

    const previousAssetId = item.asset_id
    const result = await putAsset(c.env, {
      itemId: id, uploaderId: user.id, fileName, contentType,
      expectedSize: length || undefined, bytes,
    })
    if (!result.ok) return jsonError(c, result.message, result.status)

    const attached = await attachAsset(c.env, { itemId: id, sellerId: user.id, assetId: result.value.id })
    if (!attached.ok) {
      await deleteAsset(c.env, result.value.id)
      return jsonError(c, attached.message, attached.status)
    }
    if (previousAssetId) await deleteAsset(c.env, previousAssetId)
    const fresh = await getItem(c.env, id)
    return c.json({
      item: fresh ? shapeItem(fresh) : null,
      asset: {
        id: result.value.id, purpose: result.value.purpose, file_name: result.value.file_name,
        content_type: result.value.content_type, size_bytes: result.value.size_bytes,
        sha256: result.value.sha256, icon_label: assetLabel(result.value.content_type, result.value.file_name),
      },
    }, 201)
  })

  app.post('/api/marketplace/items/:id/publish', async (c) => {
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const id = c.req.param('id')
    if (!idOk(id)) return jsonError(c, 'Invalid id')
    const result = await publish(c.env, id, user.id)
    if (!result.ok) return jsonError(c, result.message, result.status)
    const item = await getItem(c.env, id)
    return c.json({ item: item ? shapeItem(item) : null })
  })

  app.post('/api/marketplace/items/:id/cancel', async (c) => {
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const id = c.req.param('id')
    if (!idOk(id)) return jsonError(c, 'Invalid id')
    const result = await cancel(c.env, id, user.id)
    if (!result.ok) return jsonError(c, result.message, result.status)
    return c.json({ success: true, id })
  })

  // ---- served uploads ----------------------------------------------------
  app.get('/api/marketplace/items/:id/asset', async (c) => {
    const id = c.req.param('id')
    if (!idOk(id)) return jsonError(c, 'Invalid id')
    const item = await getItem(c.env, id)
    if (!item || !item.asset_id) return jsonError(c, 'No file on this listing', 404)
    // Draft uploads stay private to the seller until published.
    if (item.status === 'draft' && (await authenticatedUser(c))?.id !== item.seller_id) {
      return jsonError(c, 'No file on this listing', 404)
    }

    const meta = await getAssetMeta(c.env, item.asset_id)
    if (!meta) return jsonError(c, 'No file on this listing', 404)
    const bytes = await readAssetBytes(c.env, meta.id)
    if (!bytes) return jsonError(c, 'Stored file failed its integrity check', 500)

    return new Response(bytes.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': meta.content_type,
        'Content-Length': String(meta.size_bytes),
        'Content-Disposition': safeDisposition(meta.content_type, meta.file_name),
        'X-Content-Type-Options': 'nosniff',
        // Uploaded bytes must never run scripts on this origin.
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
        'Cache-Control': 'private, max-age=300',
        'ETag': `"${meta.sha256}"`,
      },
    })
  })

  // ---- wallet settlement -------------------------------------------------
  app.post('/api/marketplace/buy', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const idempotencyKey = c.req.header('Idempotency-Key') || ''
    const body: any = await readLimitedJson(c, 4096)
    const itemId = text(body, 'item_id', 64) || ''
    if (!idOk(itemId)) return jsonError(c, 'Invalid item_id')

    const result = await buy(c.env, { buyerId: user.id, itemId, idempotencyKey })
    if (!result.ok) return jsonError(c, result.message, result.status)
    return c.json({ success: true, item_id: result.value.itemId, paid: result.value.paid, currency: 'TZS', credited_to: result.value.sellerId }, 201)
  })

  // ---- quotations --------------------------------------------------------
  app.post('/api/marketplace/items/:id/quotes', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const itemId = c.req.param('id')
    if (!idOk(itemId)) return jsonError(c, 'Invalid id')
    const body: any = await readLimitedJson(c, 8192)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(c, 'Invalid body')

    const result = await requestQuote(c.env, {
      buyerId: user.id,
      itemId,
      offeredPrice: num(body, 'offered_price'),
      message: text(body, 'message', 500) || '',
    })
    if (!result.ok) return jsonError(c, result.message, result.status)

    const quote = await getItem(c.env, itemId)
    return c.json({
      quote: { id: result.value.id, item_id: itemId, status: 'pending', seller: quote?.seller_id },
      settle_url: `/api/marketplace/quotes/${result.value.id}/pay`,
    }, 201)
  })

  app.get('/api/marketplace/quotes/mine', async (c) => {
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const quotes = await listQuotesForBuyer(c.env, user.id)
    return c.json({ quotes: quotes.map((q) => shapeQuote(q, 'buyer')) })
  })

  app.get('/api/marketplace/quotes/incoming', async (c) => {
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const quotes = await listQuotesForSeller(c.env, user.id)
    return c.json({ quotes: quotes.map((q) => shapeQuote(q, 'seller')) })
  })

  app.post('/api/marketplace/quotes/:id/respond', async (c) => {
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const quoteId = c.req.param('id')
    if (!idOk(quoteId)) return jsonError(c, 'Invalid id')
    const body: any = await readLimitedJson(c, 4096)
    const decision = String(body?.decision || '').toLowerCase()
    if (decision !== 'accept' && decision !== 'decline') return jsonError(c, "decision must be 'accept' or 'decline'")

    const price = body?.counter_price === undefined || body?.counter_price === null || body?.counter_price === ''
      ? undefined
      : num(body, 'counter_price')
    const result = await respondQuote(c.env, {
      sellerId: user.id, quoteId, accept: decision === 'accept', price, note: text(body, 'note', 300) || '',
    })
    if (!result.ok) return jsonError(c, result.message, result.status)
    return c.json({ quote: await quoteSnapshot(c.env, result.value.id) })
  })

  app.post('/api/marketplace/quotes/:id/pay', async (c) => {
    if (!configuredSecret(c.env.AUTH_SECRET)) return jsonError(c, 'Auth not configured', 503)
    if (!mutationOriginAllowed(c)) return jsonError(c, 'Invalid Origin', 403)
    const user = await authenticatedUser(c)
    if (!user) return jsonError(c, 'Auth required', 401)
    const quoteId = c.req.param('id')
    if (!idOk(quoteId)) return jsonError(c, 'Invalid id')
    const idempotencyKey = c.req.header('Idempotency-Key') || ''

    const result = await payQuote(c.env, { buyerId: user.id, quoteId, idempotencyKey })
    if (!result.ok) return jsonError(c, result.message, result.status)
    return c.json({
      success: true, quote_id: result.value.quoteId, item_id: result.value.itemId,
      paid: result.value.paid, currency: 'TZS', seller_id: result.value.sellerId, method: 'wallet',
      quote: await quoteSnapshot(c.env, result.value.quoteId),
    }, 201)
  })
}

function shapeQuote(q: Record<string, unknown>, role: 'buyer' | 'seller') {
  const itemId = String(q.item_id)
  const assetPurpose = q.asset_purpose as string | null
  const assetId = q.asset_id as string | null
  return {
    id: q.id,
    item: {
      id: itemId,
      title: q.item_title,
      price: q.item_price,
      kind: q.item_kind,
      status: q.item_status,
      image_url: assetId && assetPurpose === 'image' ? `/api/marketplace/items/${itemId}/asset` : null,
      file_url: assetId && assetPurpose === 'file' ? `/api/marketplace/items/${itemId}/asset` : null,
      icon_label: assetId && assetPurpose === 'file'
        ? assetLabel(q.asset_content_type as string, q.asset_file_name as string)
        : null,
    },
    requested_price: q.requested_price,
    accepted_price: q.accepted_price,
    payable_price: q.status === 'accepted' ? q.accepted_price : null,
    message: q.message,
    seller_note: q.seller_note,
    status: q.status,
    created_at: q.created_at,
    responded_at: q.responded_at,
    paid_at: q.paid_at,
    expires_at: q.expires_at,
    counterparty: role === 'buyer'
      ? { role: 'seller', id: q.seller_id, username: q.seller_username, name: q.seller_name }
      : { role: 'buyer', id: q.buyer_id, username: q.buyer_username, name: q.buyer_name, wallet_balance: q.buyer_balance ?? null },
  }
}

async function quoteSnapshot(env: Bindings, quoteId: string) {
  const quote = await getQuote(env, quoteId)
  if (!quote) return null
  const item = await getItem(env, String(quote.item_id))
  return { ...quote, item: item ? shapeItem(item) : null }
}
