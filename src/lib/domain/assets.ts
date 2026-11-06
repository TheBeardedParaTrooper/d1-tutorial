import type { Bindings } from '../../env'
import { ok, fail, type Result } from '../helpers'

/**
 * Upload storage for marketplace listings.
 *
 * Bytes live in D1 (base64, 64 KiB chunks) because this Cloudflare account has
 * R2 disabled in the dashboard. Everything the rest of the app touches is
 * putAsset()/readAsset(), so flipping to R2 is a change in this file only.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
const CHUNK_RAW_BYTES = 64 * 1024
const CHUNKS_PER_BATCH = 4

export type AssetPurpose = 'image' | 'file'

const ACCEPTED: Record<string, { label: string; purpose: AssetPurpose }> = {
  'image/jpeg': { label: 'JPG', purpose: 'image' },
  'image/png': { label: 'PNG', purpose: 'image' },
  'image/webp': { label: 'WEBP', purpose: 'image' },
  'image/gif': { label: 'GIF', purpose: 'image' },
  'application/pdf': { label: 'PDF', purpose: 'file' },
  'text/plain': { label: 'TXT', purpose: 'file' },
  'text/csv': { label: 'CSV', purpose: 'file' },
  'application/zip': { label: 'ZIP', purpose: 'file' },
  'application/msword': { label: 'DOC', purpose: 'file' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { label: 'DOCX', purpose: 'file' },
  'application/vnd.ms-excel': { label: 'XLS', purpose: 'file' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { label: 'XLSX', purpose: 'file' },
}

export type AssetMeta = {
  id: string; item_id: string; purpose: AssetPurpose; file_name: string
  content_type: string; size_bytes: number; sha256: string; chunk_count: number; created_at: string
}

export function assetLabel(contentType: string | null | undefined, fileName: string | null | undefined): string {
  const hit = contentType ? ACCEPTED[contentType] : undefined
  if (hit) return hit.label
  const ext = (fileName || '').split('.').pop() || ''
  return ext.slice(0, 4).toUpperCase() || 'FILE'
}

export function purposeFor(contentType: string): AssetPurpose | null {
  const hit = ACCEPTED[contentType]
  return hit ? hit.purpose : null
}

export function isAcceptedType(contentType: string | null | undefined): boolean {
  return Boolean(contentType && ACCEPTED[contentType])
}

function b64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

function b64Decode(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function sanitizeName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() || 'file'
  const clean = base.replace(/[^A-Za-z0-9 ._()-]/g, '').replace(/^\.+/, '').slice(0, 140)
  return clean || 'file'
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function putAsset(
  env: Bindings,
  input: {
    itemId: string; uploaderId: string; fileName: string; contentType: string;
    expectedSize?: number; bytes: ArrayBuffer | Uint8Array
  },
): Promise<Result<AssetMeta>> {
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes)
  if (!bytes.byteLength) return fail('empty_file', 'The upload was empty')
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return fail('too_large', `Uploads are capped at ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`)
  }
  if (input.expectedSize && input.expectedSize !== bytes.byteLength) {
    return fail('size_mismatch', 'Upload size did not match the declared Content-Length')
  }
  if (!isAcceptedType(input.contentType)) return fail('bad_type', 'Unsupported file type')

  const purpose = purposeFor(input.contentType)!
  const assetId = crypto.randomUUID()
  const fileName = sanitizeName(input.fileName)
  const digest = await sha256Hex(bytes)

  const inserts: ReturnType<D1Database['prepare']>[] = [
    env.DB.prepare(
      `INSERT INTO marketplace_assets (id, item_id, uploader_id, purpose, file_name, content_type, size_bytes, sha256, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(assetId, input.itemId, input.uploaderId, purpose, fileName, input.contentType, bytes.byteLength, digest, Math.ceil(bytes.byteLength / CHUNK_RAW_BYTES)),
  ]
  const total = Math.ceil(bytes.byteLength / CHUNK_RAW_BYTES)
  for (let seq = 0; seq < total; seq++) {
    inserts.push(
      env.DB.prepare(`INSERT INTO marketplace_asset_chunks (asset_id, seq, data_b64) VALUES (?, ?, ?)`)
        .bind(assetId, seq, b64Encode(bytes.subarray(seq * CHUNK_RAW_BYTES, (seq + 1) * CHUNK_RAW_BYTES))),
    )
  }

  try {
    for (let i = 0; i < inserts.length; i += CHUNKS_PER_BATCH) {
      await env.DB.batch(inserts.slice(i, i + CHUNKS_PER_BATCH))
    }
  } catch {
    await env.DB.prepare(`DELETE FROM marketplace_assets WHERE id = ?`).bind(assetId).run().catch(() => {})
    return fail('store_failed', 'Could not store the file', 500)
  }

  const meta = await getAssetMeta(env, assetId)
  if (!meta) return fail('store_failed', 'Could not confirm the stored file', 500)
  return ok(meta)
}

export async function getAssetMeta(env: Bindings, assetId: string): Promise<AssetMeta | null> {
  return env.DB.prepare(
    `SELECT id, item_id, purpose, file_name, content_type, size_bytes, sha256, chunk_count, created_at
     FROM marketplace_assets WHERE id = ?`,
  ).bind(assetId).first<AssetMeta>() ?? null
}

export async function readAssetBytes(env: Bindings, assetId: string): Promise<Uint8Array | null> {
  const meta = await getAssetMeta(env, assetId)
  if (!meta) return null
  const { results } = await env.DB.prepare(
    `SELECT seq, data_b64 FROM marketplace_asset_chunks WHERE asset_id = ? ORDER BY seq ASC`,
  ).bind(assetId).all<{ seq: number; data_b64: string }>()
  if (!results || results.length !== meta.chunk_count) return null

  const parts = results.map((row) => b64Decode(row.data_b64))
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.byteLength }

  // Integrity guard: a chunk tampered with in-table would change the digest.
  if ((await sha256Hex(out)) !== meta.sha256) return null
  return out
}

export async function deleteAsset(env: Bindings, assetId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM marketplace_asset_chunks WHERE asset_id = ?`).bind(assetId),
    env.DB.prepare(`DELETE FROM marketplace_assets WHERE id = ?`).bind(assetId),
  ]).catch(() => {})
}

export function safeDisposition(contentType: string, fileName: string): string {
  const inline = contentType.startsWith('image/') || contentType === 'application/pdf'
  const safe = fileName.replace(/["\\]/g, '')
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"`
}
