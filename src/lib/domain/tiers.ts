import type { Bindings } from '../../env'
import { ok, fail, Result } from '../helpers'

export type Tier = { id: string; name: string; duration_hours: number; price: number; active: number }

function validPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2_000_000_000
}
function validDuration(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 8760
}

export async function listActive(env: Bindings): Promise<Array<Omit<Tier, 'active'>>> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, duration_hours, price FROM packages WHERE active = 1 ORDER BY price ASC`,
  ).all<{ id: string; name: string; duration_hours: number; price: number }>()
  return (results || []).filter(
    (p) => Number.isSafeInteger(p.price) && p.price > 0 &&
           Number.isSafeInteger(p.duration_hours) && p.duration_hours > 0,
  )
}

export async function listAll(env: Bindings): Promise<Tier[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, duration_hours, price, active FROM packages ORDER BY price ASC`,
  ).all<Tier>()
  return results || []
}

export async function createTier(
  env: Bindings,
  input: { name: string; durationHours: number; price: number },
): Promise<Result<Tier>> {
  const name = input.name.trim()
  if (!name || name.length > 100) return fail('bad_name', 'Invalid name')
  if (!validDuration(input.durationHours)) return fail('bad_duration', 'Duration must be 1..8760 hours')
  if (!validPrice(input.price)) return fail('bad_price', 'Price must be a positive integer TZS')
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tier'
  const id = `${slug}-${crypto.randomUUID().slice(0, 8)}`
  try {
    await env.DB.prepare(
      `INSERT INTO packages (id, name, duration_hours, price, active) VALUES (?, ?, ?, ?, 1)`,
    ).bind(id, name, input.durationHours, input.price).run()
  } catch {
    return fail('insert_failed', 'Could not create tier', 500)
  }
  return ok({ id, name, duration_hours: input.durationHours, price: input.price, active: 1 })
}

export async function updateTier(
  env: Bindings,
  id: string,
  patch: { name?: string; durationHours?: number; price?: number; active?: boolean },
): Promise<Result<Tier>> {
  const existing = await env.DB.prepare(
    `SELECT id, name, duration_hours, price, active FROM packages WHERE id = ?`,
  ).bind(id).first<Tier>()
  if (!existing) return fail('not_found', 'Tier not found', 404)

  const name = patch.name !== undefined ? patch.name.trim() : existing.name
  const duration = patch.durationHours !== undefined ? patch.durationHours : existing.duration_hours
  const price = patch.price !== undefined ? patch.price : existing.price
  const active = patch.active !== undefined ? (patch.active ? 1 : 0) : existing.active
  if (!name || name.length > 100) return fail('bad_name', 'Invalid name')
  if (!validDuration(duration)) return fail('bad_duration', 'Duration must be 1..8760 hours')
  if (!validPrice(price)) return fail('bad_price', 'Price must be a positive integer TZS')
  try {
    await env.DB.prepare(
      `UPDATE packages SET name = ?, duration_hours = ?, price = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(name, duration, price, active, id).run()
  } catch {
    return fail('update_failed', 'Could not update tier', 500)
  }
  return ok({ id, name, duration_hours: duration, price, active })
}

export async function deactivateTier(env: Bindings, id: string): Promise<Result<{ id: string }>> {
  const r = await env.DB.prepare(
    `UPDATE packages SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1`,
  ).bind(id).run()
  if (!r.meta.changes || r.meta.changes !== 1) return fail('not_found', 'Active tier not found', 404)
  return ok({ id })
}
