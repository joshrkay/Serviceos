import { describe, expect, it, vi } from 'vitest';
import {
  createTwilioProvisioningAdapter,
  provisionTwilioPhoneNumber,
  releaseTwilioPhoneNumber,
  type TwilioProvisioningClient,
} from '../../src/notifications/twilio-provisioning';
import type { ProvisioningRequestContext } from '../../src/notifications/provisioning-context';

describe('twilio provisioning', () => {
  it('passes request context through exported helpers unchanged', async () => {
    const client: TwilioProvisioningClient = {
      provisionPhoneNumber: vi.fn(async () => ({ phoneNumberSid: 'PN1', e164: '+15551212' })),
      releasePhoneNumber: vi.fn(async () => undefined),
    };
    const context: ProvisioningRequestContext = { timeoutMs: 2500, requestId: 'req-1' };

    await provisionTwilioPhoneNumber(client, { tenantId: 't1', areaCode: '415' }, context);
    await releaseTwilioPhoneNumber(client, { tenantId: 't1', phoneNumberSid: 'PN1' }, context);

    expect(client.provisionPhoneNumber).toHaveBeenCalledWith(
      { tenantId: 't1', areaCode: '415' },
      context,
    );
    expect(client.releasePhoneNumber).toHaveBeenCalledWith(
      { tenantId: 't1', phoneNumberSid: 'PN1' },
      context,
    );
  });

  it('maps request context to SDK request options', async () => {
    const create = vi.fn(async () => ({ sid: 'PN2', phoneNumber: '+14155550100' }));
    const release = vi.fn(async () => undefined);
    const adapter = createTwilioProvisioningAdapter({ create, release });
    const controller = new AbortController();

    await adapter.provisionPhoneNumber(
      { tenantId: 't2', areaCode: '650' },
      { signal: controller.signal, timeoutMs: 1000, requestId: 'req-2' },
    );

    expect(create).toHaveBeenCalledWith(
      { tenantId: 't2', areaCode: '650' },
      { signal: controller.signal, timeout: 1000, idempotencyKey: 'req-2' },
    );

    await adapter.releasePhoneNumber(
      { tenantId: 't2', phoneNumberSid: 'PN2' },
      { signal: controller.signal, timeoutMs: 1500, requestId: 'req-3' },
    );

    expect(release).toHaveBeenCalledWith(
      { tenantId: 't2', phoneNumberSid: 'PN2' },
      { signal: controller.signal, timeout: 1500, idempotencyKey: 'req-3' },
    );
  });
});
