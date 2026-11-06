export type Bindings = {
  DB: D1Database
  ASSETS?: Fetcher
  AUTH_SECRET?: string
  PORTAL_ORIGIN?: string
  RADIUS_SHARED_SECRET?: string
  AZAMPAY_ENV?: 'sandbox' | 'production'
  AZAMPAY_APP_NAME?: string
  AZAMPAY_CLIENT_ID?: string
  AZAMPAY_CLIENT_SECRET?: string
  AZAMPAY_WEBHOOK_SECRET?: string
  MIKROTIK_BASE_URL?: string
  MIKROTIK_USER?: string
  MIKROTIK_PASSWORD?: string
  ADMIN_SECRET?: string
}
