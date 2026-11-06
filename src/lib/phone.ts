import type { Bindings } from '../env'
import { timingSafeEqual } from './security/pq-toolkit'

export type MnoProvider = 'Airtel' | 'Tigo' | 'Halopesa' | 'Azampesa' | 'Mpesa'
export const PROVIDERS: MnoProvider[] = ['Mpesa', 'Airtel', 'Tigo', 'Halopesa', 'Azampesa']

const E164 = /^\+?[1-9]\d{1,14}$/

export function isValidE164(raw: string | null | undefined): boolean {
  return Boolean(raw && E164.test(raw))
}

export function normalizeTzPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  const match = digits.match(/^(?:255|0)?([67]\d{8})$/)
  if (!match) return null
  return `+255${match[1]}`
}

export function toAzampayMsisdn(e164: string): string | null {
  const m = e164.match(/^\+255([67]\d{8})$/)
  return m ? `255${m[1]}` : null
}

export function toE164(msisdn: string): string | null {
  const digits = msisdn.replace(/\D/g, '')
  const m = digits.match(/^(?:255)?([67]\d{8})$/)
  return m ? `+255${m[1]}` : null
}

export function guessProvider(e164: string): MnoProvider | null {
  const m = e164.match(/^\+255(\d{2})/)
  if (!m) return null
  const pfx = m[1]
  if (pfx === '62') return 'Halopesa'
  if (['68', '69', '78', '79'].includes(pfx)) return 'Airtel'
  if (['74', '75', '76'].includes(pfx)) return 'Mpesa'
  if (['65', '67', '71', '77'].includes(pfx)) return 'Tigo'
  if (pfx === '73') return 'Azampesa'
  return null
}

export async function requireSharedSecret(
  provided: string | undefined,
  expected: string | undefined,
): Promise<'ok' | 'unauthorized' | 'unconfigured'> {
  if (!expected) return 'unconfigured'
  if (!provided) return 'unauthorized'
  return (await timingSafeEqual(provided, expected)) ? 'ok' : 'unauthorized'
}

export function azampayConfigured(env: Bindings): boolean {
  return !!(env.AZAMPAY_APP_NAME && env.AZAMPAY_CLIENT_ID && env.AZAMPAY_CLIENT_SECRET)
}
