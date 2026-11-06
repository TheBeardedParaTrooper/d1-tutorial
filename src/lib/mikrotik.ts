import type { Bindings } from '../env'

export async function hotspotMacLogin(
  env: Bindings,
  input: { ip?: string | null; mac: string; user: string },
): Promise<{ ok: boolean; applied: boolean; status?: number }> {
  if (!env.MIKROTIK_BASE_URL || !env.MIKROTIK_USER || !env.MIKROTIK_PASSWORD) {
    return { ok: true, applied: false }
  }
  const auth = btoa(`${env.MIKROTIK_USER}:${env.MIKROTIK_PASSWORD}`)
  const base = env.MIKROTIK_BASE_URL.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/rest/ip/hotspot/active/login`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ip: input.ip || undefined,
        'mac-address': input.mac,
        user: input.user,
      }),
    })
    return { ok: res.ok, applied: true, status: res.status }
  } catch {
    return { ok: false, applied: true }
  }
}
