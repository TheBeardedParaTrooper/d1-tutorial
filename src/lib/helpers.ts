export function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null
  const compact = raw.trim().replace(/[^0-9A-Fa-f]/g, '')
  if (compact.length !== 12) return null
  const pairs = compact.match(/.{2}/g)
  if (!pairs) return null
  return pairs.join(':').toUpperCase()
}

export function randomHex(bytes = 16): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function configuredSecret(value: string | undefined): value is string {
  return Boolean(value && new TextEncoder().encode(value).length >= 32)
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; status: 400 | 401 | 403 | 404 | 409 | 500 | 503 }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail(
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 500 | 503 = 400,
): Result<never> {
  return { ok: false, code, message, status }
}
