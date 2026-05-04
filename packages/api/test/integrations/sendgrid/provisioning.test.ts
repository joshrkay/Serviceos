import { describe, expect, it, vi } from 'vitest';

import { provisionSendgridApiKey, redactSensitiveFields } from '../../../src/integrations/sendgrid/provisioning';

describe('provisionSendgridApiKey', () => {
  it('success payload only returns apiKeyId and secretRef', async () => {
    const encryptApiKey = vi.fn(async () => ({ ciphertext: 'enc', keyId: 'k1' }));
    const storeSecret = vi.fn(async () => ({ secretRef: 'secrets/sendgrid/abc' }));

    const result = await provisionSendgridApiKey('sg-key-id', 'SG.real.raw.key', {
      encryptApiKey,
      storeSecret,
    });

    expect(result).toEqual({
      ok: true,
      apiKeyId: 'sg-key-id',
      secretRef: 'secrets/sendgrid/abc',
    });
    expect(Object.keys(result)).toEqual(['ok', 'apiKeyId', 'secretRef']);
  });

  it('redacts raw key when encryption fails', async () => {
    const rawApiKey = 'SG.super.secret';
    const result = await provisionSendgridApiKey('sg-key-id', rawApiKey, {
      encryptApiKey: vi.fn(async () => {
        throw new Error('kms unavailable');
      }),
      storeSecret: vi.fn(async () => ({ secretRef: 'never' })),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('SENDGRID_ENCRYPTION_FAILED');
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(rawApiKey);
    expect(result.error.details?.rawApiKey).toBe('[REDACTED]');
  });

  it('redacts raw key when storage fails', async () => {
    const rawApiKey = 'SG.super.secret.2';
    const result = await provisionSendgridApiKey('sg-key-id', rawApiKey, {
      encryptApiKey: vi.fn(async () => ({ ciphertext: 'enc', keyId: 'k1' })),
      storeSecret: vi.fn(async () => {
        throw new Error('vault write failed');
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('SENDGRID_STORAGE_FAILED');
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(rawApiKey);
    expect(result.error.details?.rawApiKey).toBe('[REDACTED]');
  });
});

describe('redactSensitiveFields', () => {
  it('redacts known sensitive fields only', () => {
    expect(redactSensitiveFields({ rawApiKey: 'x', apiKeyId: 'id1', token: 'abc' })).toEqual({
      rawApiKey: '[REDACTED]',
      apiKeyId: 'id1',
      token: '[REDACTED]',
    });
  });
});
