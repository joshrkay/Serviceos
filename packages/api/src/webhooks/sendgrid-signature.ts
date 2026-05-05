import crypto from 'node:crypto';

export function verifySendGridSignature(params: {
  publicKeyPem: string;
  payload: string | Buffer;
  signatureBase64: string | undefined;
  timestamp: string | undefined;
}): boolean {
  const { publicKeyPem, payload, signatureBase64, timestamp } = params;
  if (!publicKeyPem || !signatureBase64 || !timestamp) return false;
  try {
    const verifier = crypto.createVerify('sha256');
    verifier.update(timestamp);
    verifier.update(typeof payload === 'string' ? payload : payload.toString('utf8'));
    verifier.end();
    return verifier.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
