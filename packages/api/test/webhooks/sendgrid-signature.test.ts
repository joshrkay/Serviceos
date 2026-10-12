/**
 * Unit tests for verifySendGridSignature.
 *
 * SendGrid's Event Webhook signs `timestamp + payload` with ECDSA (prime256v1)
 * and sends the signature base64-encoded. We generate a throwaway EC keypair to
 * exercise the real crypto path, plus the early-return and catch branches.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  verifySendGridSignature,
  SENDGRID_SIGNATURE_TOLERANCE_SECONDS,
} from '../../src/webhooks/sendgrid-signature';

let publicKeyPem: string;
let privateKey: crypto.KeyObject;

function sign(timestamp: string, payload: string | Buffer): string {
  const signer = crypto.createSign('sha256');
  signer.update(timestamp);
  signer.update(payload);
  signer.end();
  return signer.sign(privateKey).toString('base64');
}

beforeAll(() => {
  // Fixture timestamps are 1716422400; pin "now" inside the replay window.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1716422400 * 1000);
  const { publicKey, privateKey: priv } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  privateKey = priv;
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

afterAll(() => {
  vi.useRealTimers();
});

describe('verifySendGridSignature — valid signatures', () => {
  it('verifies a correctly signed timestamp + payload', () => {
    const timestamp = '1716422400';
    const payload = JSON.stringify([{ event: 'delivered', sg_event_id: 'abc' }]);
    expect(
      verifySendGridSignature({
        publicKeyPem,
        payload,
        signatureBase64: sign(timestamp, payload),
        timestamp,
      })
    ).toBe(true);
  });

  it('treats a Buffer payload the same as the equivalent string', () => {
    const timestamp = '1716422400';
    const payloadStr = '{"x":1}';
    const signature = sign(timestamp, payloadStr);
    expect(
      verifySendGridSignature({ publicKeyPem, payload: payloadStr, signatureBase64: signature, timestamp })
    ).toBe(true);
    expect(
      verifySendGridSignature({
        publicKeyPem,
        payload: Buffer.from(payloadStr),
        signatureBase64: signature,
        timestamp,
      })
    ).toBe(true);
  });

  it('verifies an empty payload', () => {
    const timestamp = '1716422400';
    const signature = sign(timestamp, Buffer.alloc(0));
    expect(
      verifySendGridSignature({
        publicKeyPem,
        payload: Buffer.alloc(0),
        signatureBase64: signature,
        timestamp,
      })
    ).toBe(true);
  });
});

describe('verifySendGridSignature — early returns', () => {
  const timestamp = '1716422400';
  const payload = '{}';

  it('returns false when signatureBase64 is undefined', () => {
    expect(
      verifySendGridSignature({ publicKeyPem, payload, signatureBase64: undefined, timestamp })
    ).toBe(false);
  });

  it('returns false when timestamp is undefined', () => {
    expect(
      verifySendGridSignature({ publicKeyPem, payload, signatureBase64: sign(timestamp, payload), timestamp: undefined })
    ).toBe(false);
  });

  it('returns false when publicKeyPem is empty', () => {
    expect(
      verifySendGridSignature({ publicKeyPem: '', payload, signatureBase64: sign(timestamp, payload), timestamp })
    ).toBe(false);
  });
});

describe('verifySendGridSignature — rejection paths', () => {
  const timestamp = '1716422400';
  const payload = '{"event":"open"}';

  it('rejects a tampered payload (replay/forgery guard binds the payload)', () => {
    const signature = sign(timestamp, payload);
    expect(
      verifySendGridSignature({
        publicKeyPem,
        payload: '{"event":"click"}',
        signatureBase64: signature,
        timestamp,
      })
    ).toBe(false);
  });

  it('rejects when the timestamp differs from the one signed (replay guard)', () => {
    const signature = sign(timestamp, payload);
    expect(
      verifySendGridSignature({
        publicKeyPem,
        payload,
        signatureBase64: signature,
        timestamp: '1716422401',
      })
    ).toBe(false);
  });

  it('returns false (does not throw) on a malformed base64 signature', () => {
    expect(
      verifySendGridSignature({
        publicKeyPem,
        payload,
        signatureBase64: 'not-valid-base64!!!',
        timestamp,
      })
    ).toBe(false);
  });

  it('returns false (does not throw) on a non-PEM public key', () => {
    expect(
      verifySendGridSignature({
        publicKeyPem: 'GARBAGE KEY',
        payload,
        signatureBase64: sign(timestamp, payload),
        timestamp,
      })
    ).toBe(false);
  });

  it('rejects a signature produced by a different key', () => {
    const { privateKey: otherPriv } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const signer = crypto.createSign('sha256');
    signer.update(timestamp);
    signer.update(payload);
    signer.end();
    const foreignSig = signer.sign(otherPriv).toString('base64');
    expect(
      verifySendGridSignature({ publicKeyPem, payload, signatureBase64: foreignSig, timestamp })
    ).toBe(false);
  });
});

describe('verifySendGridSignature — replay window', () => {
  const payload = '{"event":"open"}';
  const signedAt = 1716422400;

  it('rejects a correctly signed delivery older than the tolerance', () => {
    const timestamp = String(signedAt);
    expect(
      verifySendGridSignature({
        publicKeyPem,
        payload,
        signatureBase64: sign(timestamp, payload),
        timestamp,
        nowMs: (signedAt + SENDGRID_SIGNATURE_TOLERANCE_SECONDS + 1) * 1000,
      })
    ).toBe(false);
  });

  it('rejects a correctly signed delivery too far in the future', () => {
    const timestamp = String(signedAt);
    expect(
      verifySendGridSignature({
        publicKeyPem,
        payload,
        signatureBase64: sign(timestamp, payload),
        timestamp,
        nowMs: (signedAt - SENDGRID_SIGNATURE_TOLERANCE_SECONDS - 1) * 1000,
      })
    ).toBe(false);
  });

  it('accepts a delivery at the edge of the tolerance', () => {
    const timestamp = String(signedAt);
    expect(
      verifySendGridSignature({
        publicKeyPem,
        payload,
        signatureBase64: sign(timestamp, payload),
        timestamp,
        nowMs: (signedAt + SENDGRID_SIGNATURE_TOLERANCE_SECONDS) * 1000,
      })
    ).toBe(true);
  });

  it('rejects a non-numeric timestamp even when it was signed', () => {
    const timestamp = 'not-a-number';
    expect(
      verifySendGridSignature({ publicKeyPem, payload, signatureBase64: sign(timestamp, payload), timestamp })
    ).toBe(false);
  });
});
