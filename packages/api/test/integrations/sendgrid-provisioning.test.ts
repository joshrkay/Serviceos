import { describe, expect, it, vi } from 'vitest';

import {
  assignOptionalIpPool,
  createAndStoreScopedApiKey,
  createSendgridDomainAuthentication,
  createSendgridSubuser,
  createSendgridVerifiedSender,
  type SendgridProvisioningClient,
} from '../../src/integrations/sendgrid/provisioning';

describe('sendgrid provisioning integration', () => {
  it('returns normalized IDs and supports optional hooks', async () => {
    const client: SendgridProvisioningClient = {
      createSubuser: vi.fn(async () => ({ id: 20, username: 'tenant-a' })),
      createApiKey: vi.fn(async () => ({ apiKeyId: 'key_123', apiKey: 'raw-secret' })),
      storeScopedApiKey: vi.fn(async () => ({ secretRef: 'vault://sg/key_123' })),
      createDomainAuthentication: vi.fn(async () => ({ id: 99, domain: 'example.com', dnsRecords: [{ type: 'cname', host: 's1._domainkey', value: 'x.sendgrid.net' }] })),
      createVerifiedSender: vi.fn(async () => ({ id: 52, fromEmail: 'noreply@example.com', verified: false })),
      assignIpPool: vi.fn(async () => ({ pool: 'warmup-pool' })),
    };

    await expect(createSendgridSubuser(client, { username: 'tenant-a', email: 'ops@example.com' })).resolves.toEqual({ ok: true, value: { subuserId: 20, username: 'tenant-a' } });
    await expect(createAndStoreScopedApiKey(client, { name: 'tx', scopes: ['mail.send'], onBehalfOf: 'tenant-a', subuserId: 20, encrypt: async (v) => `enc:${v}` })).resolves.toEqual({ ok: true, value: { apiKeyId: 'key_123', secretRef: 'vault://sg/key_123' } });
    await expect(createSendgridDomainAuthentication(client, { subuser: 'tenant-a', domain: 'example.com' })).resolves.toEqual({ ok: true, value: { domainAuthId: 99, domain: 'example.com', dnsRecords: [{ type: 'cname', host: 's1._domainkey', value: 'x.sendgrid.net' }] } });
    await expect(createSendgridVerifiedSender(client, { subuser: 'tenant-a', fromEmail: 'noreply@example.com', fromName: 'Tenant A' })).resolves.toEqual({ ok: true, value: { senderId: 52, fromEmail: 'noreply@example.com', verified: false } });
    await expect(assignOptionalIpPool(client, { subuser: 'tenant-a', ipPoolName: 'warmup-pool' })).resolves.toEqual({ ok: true, value: { assigned: true, ipPoolName: 'warmup-pool' } });
  });

  it('returns normalized failure codes for provider errors', async () => {
    const client: SendgridProvisioningClient = {
      createSubuser: vi.fn(async () => {
        throw { status: 401, code: 'unauthorized', message: 'invalid key' };
      }),
      createApiKey: vi.fn(),
      storeScopedApiKey: vi.fn(),
      createDomainAuthentication: vi.fn(),
      createVerifiedSender: vi.fn(),
    };

    const result = await createSendgridSubuser(client, { username: 'tenant-a', email: 'ops@example.com' });
    expect(result).toEqual({
      ok: false,
      failure: { code: 'AUTH', message: 'invalid key', retriable: false, providerCode: 'unauthorized' },
    });
  });
});
