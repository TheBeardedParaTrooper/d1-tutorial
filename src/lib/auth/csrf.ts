export function validateOrigin(c: {
  req: { header(name: string): string | undefined }
  env: { PORTAL_ORIGIN?: string }
}): boolean {
  const requestOrigin = c.req.header('Origin')
  const configuredOrigin = c.env.PORTAL_ORIGIN
  if (!configuredOrigin || !requestOrigin) return false
  if (requestOrigin !== configuredOrigin) return false
  try {
    const expected = new URL(configuredOrigin)
    if (expected.origin !== configuredOrigin) return false
    if (expected.protocol === 'https:') return true
    if (expected.hostname === 'localhost' || expected.hostname === '127.0.0.1') return true
    return false
  } catch {
    return false
  }
}
