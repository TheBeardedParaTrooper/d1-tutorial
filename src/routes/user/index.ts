import type { Hono } from 'hono'
import type { Bindings } from '../../env'
import { registerUserAuthRoutes } from './auth'
import { registerUserWalletRoutes } from './wallet'

export function registerUserRoutes(app: Hono<{ Bindings: Bindings }>) {
  registerUserAuthRoutes(app)
  registerUserWalletRoutes(app)
}
