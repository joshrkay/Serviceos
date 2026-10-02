/**
 * #1564 — the async worker that advances a tenant's A2P 10DLC registration
 * and polls Twilio until it is approved or rejected (P0-009 worker pattern).
 *
 * Seams: the registration service (submit / view — what Settings → Phone
 * reads) and the worker's handle(). Twilio is the in-memory fake (external
 * boundary); the queue is the in-memory queue with its sends recorded so the
 * test can deliver each delayed poll itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { FakeTwilioA2p } from '../integrations/a2p-10dlc/fake-twilio-a2p';
import { createA2pRegistrationWorker } from '../../src/workers/a2p-10dlc-registration';
import {
  createA2pRegistrationService,
  A2P_REGISTRATION_JOB_TYPE,
  type A2pRegistrationJobPayload,
} from '../../src/integrations/twilio/a2p-10dlc/service';
import { InMemoryA2pRegistrationStore } from '../../src/integrations/twilio/a2p-10dlc/store';
import type { A2pBusinessDetails } from '../../src/integrations/twilio/a2p-10dlc/registration';
import { InMemoryQueue, type QueueMessage } from '../../src/queues/queue';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Logger } from '../../src/logging/logger';
import { TwilioApiError } from '../../src/integrations/twilio/a2p-10dlc/twilio-a2p-client';

const KEY = 'b'.repeat(64);
const TENANT = '00000000-0000-4000-8000-000000001564';
const EIN = '987654321';

const details: A2pBusinessDetails = {
  legalBusinessName: 'Bright Electric Co',
  ein: EIN,
  businessType: 'Corporation',
  businessIndustry: 'CONSTRUCTION',
  websiteUrl: null,
  address: { street: '9 Elm St', street2: null, city: 'Phoenix', region: 'AZ', postalCode: '85001' },
  contact: { firstName: 'Sam', lastName: 'Sparks', email: 'sam@example.com', phone: '+16025550100', title: 'Owner', jobPosition: 'CEO' },
};

function recordingLogger() {
  const lines: string[] = [];
  const log = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    lines.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
  };
  const logger: Logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: () => logger,
  };
  return { logger, lines };
}

function harness() {
  const twilio = new FakeTwilioA2p();
  const store = new InMemoryA2pRegistrationStore();
  const queue = new InMemoryQueue();
  const sends: Array<{ type: string; payload: A2pRegistrationJobPayload; key?: string; delaySeconds?: number }> = [];
  const realSend = queue.send.bind(queue);
  vi.spyOn(queue, 'send').mockImplementation(async (type, payload, key, options) => {
    sends.push({ type, payload: payload as A2pRegistrationJobPayload, key, delaySeconds: options?.delaySeconds });
    return realSend(type, payload, key, options);
  });
  const service = createA2pRegistrationService({ store, queue, auditRepo: new InMemoryAuditRepository(), encryptionKey: KEY });
  const worker = createA2pRegistrationWorker({
    store,
    queue,
    client: twilio,
    encryptionKey: KEY,
    isv: { primaryProfileSid: 'BUprimary0000000000000000000000000', notificationEmail: 'compliance@example.com' },
    resolveTenantMessaging: async () => ({
      creds: { accountSid: 'ACtenantsub', authToken: 'subtoken' },
      messagingServiceSid: 'MGtenant',
    }),
    pollDelaySeconds: 3600,
  });
  const { logger, lines } = recordingLogger();
  const deliverLatest = async () => {
    const last = sends[sends.length - 1];
    const message: QueueMessage<A2pRegistrationJobPayload> = {
      id: `m-${sends.length}`,
      type: last.type,
      payload: last.payload,
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: last.key ?? '',
      createdAt: new Date().toISOString(),
    };
    await worker.handle(message, logger);
  };
  return { twilio, service, worker, sends, deliverLatest, lines };
}

describe('A2P 10DLC registration worker', () => {
  it('takes a submitted registration through profile → brand → campaign → approved, polling in between', async () => {
    const h = harness();
    await h.service.submit(TENANT, { userId: 'owner-1', role: 'owner' }, details);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].type).toBe(A2P_REGISTRATION_JOB_TYPE);

    await h.deliverLatest();
    expect((await h.service.view(TENANT)).status).toBe('brand_pending');
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1].delaySeconds).toBe(3600);
    expect(h.sends[1].key).not.toBe(h.sends[0].key);
    // The business-information EndUser carried the decrypted EIN to Twilio.
    expect(h.twilio.endUsers[0].attributes.business_registration_number).toBe(EIN);

    h.twilio.brandStatus = 'APPROVED';
    await h.deliverLatest();
    expect((await h.service.view(TENANT)).status).toBe('campaign_pending');
    expect(h.twilio.campaigns[0].messagingServiceSid).toBe('MGtenant');

    h.twilio.campaignStatus = 'VERIFIED';
    await h.deliverLatest();
    const done = await h.service.view(TENANT);
    expect(done.status).toBe('approved');
    expect(done.readiness).toBe('full_readiness');
    expect(h.sends).toHaveLength(3); // submit + two polls; none after approval
  });

  it('fails the registration with Twilio\'s reason when Twilio refuses a request outright (4xx) — no retry loop', async () => {
    const h = harness();
    await h.service.submit(TENANT, { userId: 'owner-1', role: 'owner' }, details);
    h.twilio.failNext = {
      method: 'createAddress',
      error: new TwilioApiError(400, 21615, 'Twilio POST /2010-04-01/Accounts/ACtenantsub/Addresses.json → 400 (21615): Invalid postal code', 'Invalid postal code'),
    };

    await h.deliverLatest();

    const view = await h.service.view(TENANT);
    expect(view.status).toBe('failed');
    expect(view.failureReasons).toEqual(['Invalid postal code']);
    expect(h.sends).toHaveLength(1);
    expect(h.twilio.brands).toHaveLength(0);
  });

  it('rethrows a transient Twilio outage so the queue retries, keeping the progress made so far', async () => {
    const h = harness();
    await h.service.submit(TENANT, { userId: 'owner-1', role: 'owner' }, details);
    h.twilio.failNext = {
      method: 'createBrandRegistration',
      error: new TwilioApiError(503, undefined, 'Twilio POST /v1/a2p/BrandRegistrations → 503: ', ''),
    };

    await expect(h.deliverLatest()).rejects.toThrow('503');
    expect((await h.service.view(TENANT)).status).toBe('submitted');

    await h.deliverLatest(); // the queue's retry of the same message
    expect((await h.service.view(TENANT)).status).toBe('brand_pending');
    expect(h.twilio.brands).toHaveLength(1);
    expect(h.twilio.submittedProfiles).toHaveLength(1);
  });

  it('never writes the EIN to a log line on any path', async () => {
    const h = harness();
    await h.service.submit(TENANT, { userId: 'owner-1', role: 'owner' }, details);
    h.twilio.failNext = {
      method: 'createAddress',
      error: new TwilioApiError(400, 21615, 'Twilio POST → 400 (21615): Invalid postal code', 'Invalid postal code'),
    };
    await h.deliverLatest();
    await h.service.submit(TENANT, { userId: 'owner-1', role: 'owner' }, details);
    await h.deliverLatest();
    h.twilio.brandStatus = 'APPROVED';
    await h.deliverLatest();

    expect(h.lines.length).toBeGreaterThan(0);
    for (const line of h.lines) expect(line).not.toContain(EIN);
  });
});
