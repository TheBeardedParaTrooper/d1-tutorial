import type { Hono } from 'hono'
import { API_CATALOG, catalogById, publicCatalog } from '../lib/api-catalog'
import type { Bindings } from '../env'
import {
  PQ_SUITE,
  bytesToB64url,
  canonicalJson,
  pqKeysForSecret,
  signMlDsa87,
  utf8,
} from '../lib/security/pq-toolkit'

function configuredSecret(value: string | undefined): value is string {
  return Boolean(value && new TextEncoder().encode(value).length >= 32)
}

function notHooked(c: any, apiId: string) {
  const spec = catalogById(apiId)
  if (!spec) return c.json({ error: 'unknown_api' }, 500)
  return c.json(
    {
      ok: false,
      hooked: false,
      error: 'not_hooked',
      api_id: spec.id,
      method: spec.method,
      path: spec.path,
      purpose: spec.purpose,
      implement_in: spec.implement_in,
      secrets: spec.secrets,
      request: spec.request,
      response: spec.response,
      security: {
        require: spec.auth,
        suite: PQ_SUITE,
        note: 'Implement with src/lib/security/pq-toolkit.ts. Fail closed if secrets are missing.',
      },
    },
    501,
  )
}

export function registerDiscoverableRoutes(
  app: Hono<{ Bindings: Bindings & { ASSETS?: Fetcher } }>,
) {
  app.get('/api/meta/catalog', async (c) => {
    const apis = publicCatalog()
    const payload = {
      service: 'flat-coin-isp',
      generated_at: new Date().toISOString(),
      hook_counts: {
        live: apis.filter((row) => row.status === 'live').length,
        not_hooked: apis.filter((row) => row.status === 'not_hooked').length,
      },
      apis,
      security: PQ_SUITE,
    }
    const secret = c.env.AUTH_SECRET
    if (!configuredSecret(secret)) {
      return c.json({ ...payload, signature: null, dsa_public_key: null, signed: false })
    }
    const keys = await pqKeysForSecret(secret)
    const signature = bytesToB64url(signMlDsa87(keys, utf8(canonicalJson(payload))))
    return c.json({
      ...payload,
      dsa_public_key: bytesToB64url(keys.dsaPublicKey),
      signature,
      signed: true,
    })
  })

  app.get('/api/meta/security', async (c) => {
    const secret = c.env.AUTH_SECRET
    const ready = configuredSecret(secret)
    let dsaPublicKey: string | null = null
    if (ready) dsaPublicKey = bytesToB64url((await pqKeysForSecret(secret)).dsaPublicKey)
    return c.json({
      ready,
      suite: PQ_SUITE,
      dsa_public_key: dsaPublicKey,
      cookie_rule: 'HttpOnly session cookies use HMAC-SHA-384. Do not put ML-DSA signatures in cookies.',
      transport_rule: PQ_SUITE.transport_note,
    })
  })

  // Marketplace is live in src/routes/marketplace.ts; only unwired surfaces stub here.
  app.post('/api/wallet/withdraw', (c) => notHooked(c, 'wallet.withdraw'))
  app.post('/api/device/challenges', (c) => notHooked(c, 'device.challenge_create'))
  app.get('/api/device/challenges/:code', (c) => notHooked(c, 'device.challenge_get'))
  app.post('/api/device/challenges/:code/ussd', (c) => notHooked(c, 'azampay.mno_push'))
  app.post('/api/nas/leases', (c) => notHooked(c, 'nas.lease'))

  void API_CATALOG
}
