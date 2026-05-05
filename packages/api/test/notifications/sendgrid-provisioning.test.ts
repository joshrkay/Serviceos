import { describe, expect, it, vi } from 'vitest';
import {
  createSendgridProvisioningAdapter,
  createSendgridSubuser,
  deleteSendgridSubuser,
  type SendgridProvisioningClient,
} from '../../src/notifications/sendgrid-provisioning';
import type { ProvisioningRequestContext } from '../../src/notifications/provisioning-context';

describe('sendgrid provisioning', () => {
  it('passes request context through exported helpers unchanged', async () => {
    const client: SendgridProvisioningClient = {
      createSubuser: vi.fn(async () => ({ subuserId: 'sg-1' })),
      deleteSubuser: vi.fn(async () => undefined),
    };
    const context: ProvisioningRequestContext = { timeoutMs: 2500, requestId: 'req-1' };

    await createSendgridSubuser(client, { tenantId: 't1', username: 'u1', email: 'a@example.com' }, context);
    await deleteSendgridSubuser(client, { tenantId: 't1', username: 'u1' }, context);

    expect(client.createSubuser).toHaveBeenCalledWith(
      { tenantId: 't1', username: 'u1', email: 'a@example.com' },
      context,
    );
    expect(client.deleteSubuser).toHaveBeenCalledWith(
      { tenantId: 't1', username: 'u1' },
      context,
    );
  });

  it('maps request context to SDK request options', async () => {
    const create = vi.fn(async () => ({ id: 'sg-2' }));
    const remove = vi.fn(async () => undefined);
    const adapter = createSendgridProvisioningAdapter({ create, delete: remove });
    const controller = new AbortController();

    await adapter.createSubuser(
      { tenantId: 't2', username: 'u2', email: 'b@example.com' },
      { signal: controller.signal, timeoutMs: 1200, requestId: 'req-2' },
    );
    expect(create).toHaveBeenCalledWith(
      { tenantId: 't2', username: 'u2', email: 'b@example.com' },
      { signal: controller.signal, timeout: 1200, requestId: 'req-2' },
    );

    await adapter.deleteSubuser(
      { tenantId: 't2', username: 'u2' },
      { signal: controller.signal, timeoutMs: 800, requestId: 'req-3' },
    );
    expect(remove).toHaveBeenCalledWith(
      { tenantId: 't2', username: 'u2' },
      { signal: controller.signal, timeout: 800, requestId: 'req-3' },
    );
  });
});
