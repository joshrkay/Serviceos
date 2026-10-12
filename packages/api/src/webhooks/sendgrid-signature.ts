import crypto from 'node:crypto';

// Same window as the Stripe/Clerk verifiers: a captured signed delivery
// must not verify forever.
export const SENDGRID_SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifySendGridSignature(params: {
  publicKeyPem: string;
  payload: string | Buffer;
  signatureBase64: string | undefined;
  timestamp: string | undefined;
  nowMs?: number;
}): boolean {
  const { publicKeyPem, payload, signatureBase64, timestamp, nowMs = Date.now() } = params;
  if (!publicKeyPem || !signatureBase64 || !timestamp) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  const ageSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
  if (ageSeconds > SENDGRID_SIGNATURE_TOLERANCE_SECONDS) return false;
  try {
    const verifier = crypto.createVerify('sha256');
    verifier.update(timestamp);
    verifier.update(payload);
    verifier.end();
    return verifier.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
