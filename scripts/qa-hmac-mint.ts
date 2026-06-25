import * as crypto from 'node:crypto';

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

/** Mint an HMAC-SHA256 JWT accepted by the API dev path (CLERK_DEV_HMAC_TOKENS=true). */
export function mintHmacJwt(
  secret: string,
  tenantId: string,
  label: string,
  role = 'owner',
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: `qa-runbook-user-${label}`,
    sid: `qa-runbook-session-${label}-${Date.now()}`,
    tenant_id: tenantId,
    role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
    iat: Math.floor(Date.now() / 1000),
  };
  const input = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}
