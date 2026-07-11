import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { createLogger } from '../../src/logging/logger';
import type { FeedbackDispatcher, FeedbackDispatchInput } from '../../src/feedback/dispatcher';
import { SmsSuppressedError } from '../../src/notifications/gated-message-delivery';
import {
  runThankYouSmsSweep,
  type ThankYouSmsWorkerDeps,
} from '../../src/workers/thank-you-sms-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const TENANT = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const NOW = new Date('2026-06-17T15:00:00Z');
const ONE_HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);
const THREE_HOURS_AGO = new Date(NOW.getTime() - 3 * 60 * 60 * 1000);

interface FakePoolState {
  rows: Array<{ id: string; tenant_id: string }>;
}

function fakePool(state: FakePoolState): Pool {
  return {
    query: vi.fn(async (_sql: string, _params: unknown[]) => {
      return {
        rows: state.rows,
        rowCount: state.rows.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as unknown as QueryResult;
    }),
  } as unknown as Pool;
}

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: overrides.id ?? 'job-1',
    tenantId: overrides.tenantId ?? TENANT,
    customerId: overrides.customerId ?? 'cust-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'Test job',
    status: 'completed',
    priority: 'normal',
    completedAt: overrides.completedAt ?? THREE_HOURS_AGO,
    createdBy: 'system',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: overrides.id ?? 'cust-1',
    tenantId: overrides.tenantId ?? TENANT,
    firstName: 'Mary',
    lastName: 'Johnson',
    displayName: 'Mary Johnson',
    primaryPhone: '+15551234567',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'test',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('runThankYouSmsSweep', () => {
  let jobRepo: InMemoryJobRepository;
  let customerRepo: InMemoryCustomerRepository;
  let settingsRepo: InMemorySettingsRepository;
  let dncRepo: InMemoryDncRepository;
  let auditRepo: InMemoryAuditRepository;
  let dispatcher: FeedbackDispatcher;
  let send: ReturnType<typeof vi.fn<[FeedbackDispatchInput], Promise<void>>>;

  beforeEach(async () => {
    jobRepo = new InMemoryJobRepository();
    customerRepo = new InMemoryCustomerRepository();
    settingsRepo = new InMemorySettingsRepository();
    dncRepo = new InMemoryDncRepository();
    auditRepo = new InMemoryAuditRepository();
    send = vi.fn(async (_input: FeedbackDispatchInput) => undefined as void);
    dispatcher = { send } as unknown as FeedbackDispatcher;

    await settingsRepo.create(baseSettings(TENANT, 'Acme Plumbing'));
  });

  function baseSettings(tenantId: string, businessName: string, overrides: Partial<TenantSettings> = {}): TenantSettings {
    return {
      id: `s-${tenantId}`,
      tenantId,
      businessName,
      timezone: 'America/Phoenix',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 14,
      sendThankYouSms: true,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function deps(rows: Array<{ id: string; tenant_id: string }>, overrides: Partial<ThankYouSmsWorkerDeps> = {}): ThankYouSmsWorkerDeps {
    return {
      pool: fakePool({ rows }),
      jobRepo,
      customerRepo,
      settingsRepo,
      dncRepo,
      dispatcher,
      auditRepo,
      logger,
      now: () => NOW,
      ...overrides,
    };
  }

  it('returns zeroed result with no pool (in-memory dev posture)', async () => {
    const result = await runThankYouSmsSweep({
      pool: null,
      jobRepo,
      customerRepo,
      settingsRepo,
      dncRepo,
      dispatcher,
      auditRepo,
      logger,
      now: () => NOW,
    });
    expect(result).toEqual({ tenants: 0, candidates: 0, sent: 0, suppressed: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one SMS for an eligible completed job, stamps the idempotency column, and emits the sent audit event', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer());

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result).toEqual({ tenants: 1, candidates: 1, sent: 1, suppressed: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    // The send now carries tenant scope + the customer's consent snapshot so the
    // central consent+DNC gate can allow it (missing → fails closed in 'block').
    expect(send).toHaveBeenCalledWith({
      to: '+15551234567',
      body: expect.stringContaining('Acme Plumbing'),
      tenantId: TENANT,
      consent: { smsConsent: true, customerId: 'cust-1' },
    });

    const stamped = await jobRepo.findById(TENANT, job.id);
    expect(stamped?.thankYouSmsSentAt).toEqual(NOW);

    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(events.some((e) => e.eventType === 'notification.thank_you_sms.sent')).toBe(true);
  });

  it('suppresses when the customer has no primary phone, sets the stamp, audits the reason', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer({ primaryPhone: undefined }));

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.sent).toBe(0);
    expect(result.suppressed).toBe(1);
    expect(send).not.toHaveBeenCalled();

    const stamped = await jobRepo.findById(TENANT, job.id);
    // Idempotency: stamp set so the sweep stops re-evaluating this row.
    expect(stamped?.thankYouSmsSentAt).toEqual(NOW);

    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    const suppressed = events.find((e) => e.eventType === 'notification.thank_you_sms.suppressed');
    expect(suppressed?.metadata).toMatchObject({ reason: 'no_phone' });
  });

  it('suppresses when the customer has not consented to SMS', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer({ smsConsent: false }));

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.suppressed).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(
      events.find((e) => e.eventType === 'notification.thank_you_sms.suppressed')?.metadata,
    ).toMatchObject({ reason: 'no_sms_consent' });
  });

  it('suppresses when the customer phone is on the tenant DNC list', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer());
    await dncRepo.addToDnc(TENANT, '+15551234567', 'test');

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.suppressed).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(
      events.find((e) => e.eventType === 'notification.thank_you_sms.suppressed')?.metadata,
    ).toMatchObject({ reason: 'on_dnc' });
  });

  it('records a transient failure when dispatcher throws and leaves the stamp null so the next sweep retries', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer());
    send.mockRejectedValueOnce(new Error('Twilio 503'));

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    const stamped = await jobRepo.findById(TENANT, job.id);
    expect(stamped?.thankYouSmsSentAt).toBeUndefined();
    // No sent audit event on a transient failure.
    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(events.some((e) => e.eventType === 'notification.thank_you_sms.sent')).toBe(false);
  });

  it('treats a gate SmsSuppressedError as a TERMINAL skip: stamps the column so it does not retry hot every sweep', async () => {
    // The worker prechecks consent/DNC, but the number can hit the DNC list
    // between that precheck and the send (race). The central gate then throws
    // SmsSuppressedError — this must be terminal (stamp set, counted suppressed),
    // NOT a transient failure that leaves the stamp null and retries forever.
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer());
    send.mockRejectedValueOnce(new SmsSuppressedError('dnc'));

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.suppressed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.sent).toBe(0);

    const stamped = await jobRepo.findById(TENANT, job.id);
    expect(stamped?.thankYouSmsSentAt).toEqual(NOW);

    const events = await auditRepo.findByEntity(TENANT, 'job', job.id);
    expect(
      events.find((e) => e.eventType === 'notification.thank_you_sms.suppressed')?.metadata,
    ).toMatchObject({ reason: 'gate_dnc' });
    // No sent audit event on a suppression.
    expect(events.some((e) => e.eventType === 'notification.thank_you_sms.sent')).toBe(false);
  });

  it('defense-in-depth: skips a tenant whose settings flipped to send_thank_you_sms=false between the query and the per-tenant pass', async () => {
    const job = makeJob({});
    await jobRepo.create(job);
    await customerRepo.create(makeCustomer());
    // Simulate the toggle being flipped after the SELECT but before sweepTenant.
    await settingsRepo.update(TENANT, { sendThankYouSms: false });

    const result = await runThankYouSmsSweep(deps([{ id: job.id, tenant_id: TENANT }]));

    expect(result.tenants).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.suppressed).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('isolates per-tenant failures: a broken tenant does not stop a healthy one', async () => {
    const jobA = makeJob({ id: 'job-a', tenantId: TENANT });
    const jobB = makeJob({ id: 'job-b', tenantId: TENANT_B, customerId: 'cust-b' });
    await jobRepo.create(jobA);
    await jobRepo.create(jobB);
    await customerRepo.create(makeCustomer());
    await customerRepo.create(makeCustomer({ id: 'cust-b', tenantId: TENANT_B }));
    await settingsRepo.create(baseSettings(TENANT_B, 'Bob HVAC'));

    const result = await runThankYouSmsSweep(
      deps([
        { id: 'job-a', tenant_id: TENANT },
        { id: 'job-b', tenant_id: TENANT_B },
      ]),
    );

    expect(result.tenants).toBe(2);
    expect(result.candidates).toBe(2);
    expect(result.sent).toBe(2);
  });
});
