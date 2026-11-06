import type { Bindings } from '../env'
import type { MnoProvider } from './phone'
import { azampayConfigured } from './phone'
import {
  b64urlToBytes,
  hmacSha384,
  timingSafeEqual,
  utf8,
} from './security/pq-toolkit'

type TokenCache = { token: string; exp: number; fingerprint: string }
let tokenCache: TokenCache | null = null
let negativeCache: { until: number } | null = null

function hosts(env: Bindings) {
  const sandbox = (env.AZAMPAY_ENV || 'sandbox').toLowerCase() !== 'production'
  return {
    auth: sandbox
      ? 'https://authenticator-sandbox.azampay.co.tz'
      : 'https://authenticator.azampay.co.tz',
    checkout: sandbox
      ? 'https://sandbox.azampay.co.tz'
      : 'https://checkout.azampay.co.tz',
  }
}

function fingerprint(env: Bindings): string {
  return `${env.AZAMPAY_CLIENT_ID || ''}|${env.AZAMPAY_CLIENT_SECRET || ''}`
}

async function accessToken(env: Bindings): Promise<string> {
  const fp = fingerprint(env)
  const now = Date.now()
  if (tokenCache && tokenCache.fingerprint === fp && tokenCache.exp > now + 30_000) {
    return tokenCache.token
  }
  if (negativeCache && negativeCache.until > now) throw new Error('azampay_token_cached_failure')

  const { auth } = hosts(env)
  const res = await fetch(`${auth}/AppRegistration/GenerateToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appName: env.AZAMPAY_APP_NAME,
      clientId: env.AZAMPAY_CLIENT_ID,
      clientSecret: env.AZAMPAY_CLIENT_SECRET,
    }),
  })
  if (!res.ok) {
    negativeCache = { until: now + 30_000 }
    throw new Error('azampay_token_failed')
  }
  const data = (await res.json()) as { data?: { accessToken?: string }; accessToken?: string }
  const token = data.data?.accessToken || data.accessToken
  if (!token) {
    negativeCache = { until: now + 30_000 }
    throw new Error('azampay_token_missing')
  }
  tokenCache = { token, exp: now + 50 * 60 * 1000, fingerprint: fp }
  negativeCache = null
  return token
}

export async function mnoCheckout(
  env: Bindings,
  input: { accountNumber: string; amount: number; provider: MnoProvider; externalId: string },
): Promise<{ ok: boolean; raw?: unknown }> {
  if (!azampayConfigured(env)) return { ok: false }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('invalid_amount')
  const token = await accessToken(env)
  const { checkout } = hosts(env)
  const res = await fetch(`${checkout}/azampay/mno/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      accountNumber: input.accountNumber,
      amount: String(input.amount),
      currency: 'TZS',
      externalId: input.externalId,
      provider: input.provider,
    }),
  })
  const raw = await res.json().catch(() => null)
  return { ok: res.ok, raw }
}

export type AzampayWebhookPayload = {
  externalId: string
  amount: number
  msisdn: string
  status: string
  reference?: string
}

export async function verifyAzampayWebhook(
  env: Bindings,
  rawBody: string,
  signatureB64: string | undefined,
): Promise<
  | { ok: true; payload: AzampayWebhookPayload }
  | { ok: false; reason: 'unconfigured' | 'missing_sig' | 'invalid_sig' | 'invalid_json' }
> {
  const secret = env.AZAMPAY_WEBHOOK_SECRET
  if (!secret || secret.length < 16) return { ok: false, reason: 'unconfigured' }
  if (!signatureB64) return { ok: false, reason: 'missing_sig' }

  const expected = await hmacSha384(utf8(secret), utf8(rawBody))
  let provided: Uint8Array
  try {
    provided = b64urlToBytes(signatureB64)
  } catch {
    return { ok: false, reason: 'invalid_sig' }
  }
  if (!(await timingSafeEqual(expected, provided))) {
    return { ok: false, reason: 'invalid_sig' }
  }

  try {
    const payload = JSON.parse(rawBody) as AzampayWebhookPayload
    if (
      typeof payload.externalId !== 'string' ||
      typeof payload.amount !== 'number' ||
      !Number.isSafeInteger(payload.amount) ||
      payload.amount <= 0 ||
      typeof payload.msisdn !== 'string' ||
      typeof payload.status !== 'string'
    ) {
      return { ok: false, reason: 'invalid_json' }
    }
    return { ok: true, payload }
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
}

export function paymentSuccessStatus(status: string | undefined): boolean {
  if (!status) return false
  const s = status.toLowerCase()
  return s === 'success' || s === 'successful' || s === 'completed'
}
