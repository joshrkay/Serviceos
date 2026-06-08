import { describe, it, expect } from 'vitest';
import { computeVapiHmac, verifyVapiSignature } from '../../../src/integrations/vapi/signature';

const SECRET = 'vapi_whsec_test';
const BODY = JSON.stringify({ message: { type: 'end-of-call-report', call: { id: 'call_1' } } });

describe('verifyVapiSignature', () => {
  it('accepts a valid HMAC signature over the raw body', () => {
    const sig = computeVapiHmac(BODY, SECRET);
    expect(verifyVapiSignature({ rawBody: BODY, secret: SECRET, signatureHeader: sig })).toBe(true);
  });

  it('rejects a tampered body (HMAC mismatch)', () => {
    const sig = computeVapiHmac(BODY, SECRET);
    expect(
      verifyVapiSignature({ rawBody: BODY + 'x', secret: SECRET, signatureHeader: sig }),
    ).toBe(false);
  });

  it('rejects a wrong-secret HMAC', () => {
    const sig = computeVapiHmac(BODY, 'other_secret');
    expect(verifyVapiSignature({ rawBody: BODY, secret: SECRET, signatureHeader: sig })).toBe(false);
  });

  it('accepts the static shared-secret header when it matches', () => {
    expect(
      verifyVapiSignature({ rawBody: BODY, secret: SECRET, sharedSecretHeader: SECRET }),
    ).toBe(true);
  });

  it('rejects a wrong shared secret', () => {
    expect(
      verifyVapiSignature({ rawBody: BODY, secret: SECRET, sharedSecretHeader: 'nope' }),
    ).toBe(false);
  });

  it('fails closed when no secret is configured or no header is present', () => {
    expect(verifyVapiSignature({ rawBody: BODY, secret: '', sharedSecretHeader: 'x' })).toBe(false);
    expect(verifyVapiSignature({ rawBody: BODY, secret: SECRET })).toBe(false);
  });
});
