import type { Bindings } from '../../env'

export async function logUserEvent(
  env: Bindings,
  args: { actorUserId: string | null; eventType: string; targetId: string | null; details: Record<string, unknown> },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES (?, ?, ?, ?)`,
    ).bind(args.actorUserId, args.eventType, args.targetId, JSON.stringify(args.details)).run()
  } catch { /* never fail */ }
}

export async function logAdminAction(
  env: Bindings,
  c: { req: { header(name: string): string | undefined } },
  args: { adminId: string; action: string; targetType: string | null; targetId: string | null; details: Record<string, unknown> },
): Promise<void> {
  try {
    const ip = c.req.header('CF-Connecting-IP') || null
    await env.DB.prepare(
      `INSERT INTO admin_audit (admin_id, action, target_type, target_id, details_json, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(args.adminId, args.action, args.targetType, args.targetId, JSON.stringify(args.details), ip).run()
  } catch { /* never fail */ }
}
