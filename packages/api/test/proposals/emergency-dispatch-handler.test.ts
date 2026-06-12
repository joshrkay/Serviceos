import { describe, it, expect, vi } from 'vitest';
import {
  EmergencyDispatchExecutionHandler,
  extractEmergencyFields,
  composeEmergencyPageSms,
} from '../../src/proposals/execution/emergency-dispatch-handler';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { validateProposalPayload } from '../../src/proposals/contracts';
import type { Proposal } from '../../src/proposals/proposal';
import type { SettingsRepository } from '../../src/settings/settings';

const TENANT = 't1';
const CUSTOMER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ctx = { tenantId: TENANT, executedBy: 'owner-1' };

function makeProposal(payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'prop-em-1',
    tenantId: TENANT,
    proposalType: 'emergency_dispatch',
    status: 'approved',
    payload,
    summary: 'Emergency dispatch',
    createdBy: 'calling-agent',
    createdAt: now,
    updatedAt: now,
  };
}

function settingsStub(overrides: Record<string, unknown> = {}): SettingsRepository {
  return {
    findByTenant: vi.fn(async () => ({
      ownerPhone: '+15125550999',
      businessName: 'Acme Plumbing',
      ...overrides,
    })),
  } as unknown as SettingsRepository;
}

async function seedCustomerLocation(locationRepo: InMemoryLocationRepository) {
  await locationRepo.create({
    id: 'loc-1',
    tenantId: TENANT,
    customerId: CUSTOMER,
    street1: '1 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'US',
    isPrimary: true,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('RV-141 — EmergencyDispatchExecutionHandler', () => {
  it('is registered in the execution registry for emergency_dispatch', () => {
    const registry = createExecutionHandlerRegistry();
    expect(registry.get('emergency_dispatch')).toBeInstanceOf(
      EmergencyDispatchExecutionHandler,
    );
  });

  it('contract payload still validates (no contract change)', () => {
    expect(
      validateProposalPayload('emergency_dispatch', {
        emergencyDescription: 'gas leak in the basement',
        detectedKeywords: ['gas leak'],
        callerPhone: '+15125550111',
      }).valid,
    ).toBe(true);
  });

  it('creates an urgent job AND pages the owner for an identified caller', async () => {
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = new InMemoryLocationRepository();
    await seedCustomerLocation(locationRepo);
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));
    const handler = new EmergencyDispatchExecutionHandler(
      jobRepo,
      locationRepo,
      settingsStub(),
      { sendSms },
      auditRepo,
    );

    const result = await handler.execute(
      makeProposal({
        intent: 'emergency_dispatch',
        entities: {
          emergencyDescription: 'gas leak in the basement',
          detectedKeywords: ['gas leak'],
          customerId: CUSTOMER,
          callerPhone: '+15125550111',
        },
        sessionId: 's1',
      }),
      ctx,
    );

    expect(result.success).toBe(true);
    const jobs = await jobRepo.findByTenant(TENANT);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].priority).toBe('urgent');
    expect(jobs[0].summary).toContain('gas leak');
    expect(result.resultEntityId).toBe(jobs[0].id);

    expect(sendSms).toHaveBeenCalledTimes(1);
    const sms = sendSms.mock.calls[0][0];
    expect(sms.to).toBe('+15125550999');
    expect(sms.body).toContain('EMERGENCY');
    expect(sms.body).toContain('+15125550111');

    const audits = auditRepo.getAll().filter(
      (e) => e.eventType === 'emergency_dispatch.executed',
    );
    expect(audits).toHaveLength(1);
  });

  it('also reads the contract-shaped top-level payload fields', async () => {
    const fields = extractEmergencyFields({
      emergencyDescription: 'burst pipe',
      detectedKeywords: ['burst pipe'],
      callerPhone: '+15125550112',
    });
    expect(fields.emergencyDescription).toBe('burst pipe');
    expect(fields.detectedKeywords).toEqual(['burst pipe']);
    expect(fields.callerPhone).toBe('+15125550112');
  });

  it('anonymous caller: no job, but the page still goes out (success)', async () => {
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = new InMemoryLocationRepository();
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));
    const handler = new EmergencyDispatchExecutionHandler(
      jobRepo,
      locationRepo,
      settingsStub(),
      { sendSms },
    );

    const result = await handler.execute(
      makeProposal({
        intent: 'emergency_dispatch',
        entities: { emergencyDescription: 'carbon monoxide alarm' },
      }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(await jobRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0][0].body).toContain(
      'No customer match',
    );
  });

  it('falls back to transfer_number when no owner phone is configured', async () => {
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));
    const handler = new EmergencyDispatchExecutionHandler(
      undefined,
      undefined,
      settingsStub({ ownerPhone: null, transferNumber: '+15125550777' }),
      { sendSms },
    );
    const result = await handler.execute(
      makeProposal({ emergencyDescription: 'flooding' }),
      ctx,
    );
    expect(result.success).toBe(true);
    expect(sendSms.mock.calls[0][0].to).toBe('+15125550777');
  });

  it('fails (retryable) when neither a job nor a page could land', async () => {
    const sendSms = vi.fn(async () => {
      throw new Error('provider down');
    });
    const auditRepo = new InMemoryAuditRepository();
    const handler = new EmergencyDispatchExecutionHandler(
      undefined,
      undefined,
      settingsStub(),
      { sendSms },
      auditRepo,
    );
    const result = await handler.execute(
      makeProposal({ emergencyDescription: 'sparking outlet' }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('provider down');
    expect(
      auditRepo.getAll().some((e) => e.eventType === 'emergency_dispatch.failed'),
    ).toBe(true);
  });

  it('is idempotent on resultEntityId (re-run never double-pages)', async () => {
    const sendSms = vi.fn(async () => ({}));
    const handler = new EmergencyDispatchExecutionHandler(
      undefined,
      undefined,
      settingsStub(),
      { sendSms },
    );
    const proposal = makeProposal({ emergencyDescription: 'flooded basement' });
    (proposal as { resultEntityId?: string }).resultEntityId = 'job-prior';
    const result = await handler.execute(proposal, ctx);
    expect(result).toEqual({ success: true, resultEntityId: 'job-prior' });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('page-only success (no job) is idempotent via the durable audit marker', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));
    const handler = new EmergencyDispatchExecutionHandler(
      undefined,
      undefined,
      settingsStub(),
      { sendSms },
      auditRepo,
    );
    // Anonymous caller -> no job lands -> no resultEntityId is ever stamped,
    // so only the emergency_dispatch.executed audit event can guard re-runs.
    const proposal = makeProposal({
      intent: 'emergency_dispatch',
      entities: { emergencyDescription: 'smell gas in the hallway', detectedKeywords: ['smell gas'] },
    });

    const first = await handler.execute(proposal, ctx);
    expect(first.success).toBe(true);
    expect(first.resultEntityId).toBeUndefined();
    expect(sendSms).toHaveBeenCalledTimes(1);

    // Re-execution (executor retry / double-approve race): NO second page.
    const second = await handler.execute(proposal, ctx);
    expect(second.success).toBe(true);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(
      auditRepo.getAll().filter((e) => e.eventType === 'emergency_dispatch.executed'),
    ).toHaveLength(1);
  });

  it('audit re-run guard returns the prior jobId when the first run created one', async () => {
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = new InMemoryLocationRepository();
    await seedCustomerLocation(locationRepo);
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));
    const handler = new EmergencyDispatchExecutionHandler(
      jobRepo,
      locationRepo,
      settingsStub(),
      { sendSms },
      auditRepo,
    );
    const proposal = makeProposal({
      intent: 'emergency_dispatch',
      entities: {
        emergencyDescription: 'gas leak',
        detectedKeywords: ['gas leak'],
        customerId: CUSTOMER,
      },
    });
    const first = await handler.execute(proposal, ctx);
    expect(first.resultEntityId).toBeTruthy();
    // Simulate the executor failing to stamp resultEntityId back onto the
    // proposal row -- the audit marker still resolves the prior job.
    const second = await handler.execute(proposal, ctx);
    expect(second.success).toBe(true);
    expect(second.resultEntityId).toBe(first.resultEntityId);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(await jobRepo.findByTenant(TENANT)).toHaveLength(1);
  });

  it('degrades to passthrough with no deps (in-memory test convention)', async () => {
    const handler = new EmergencyDispatchExecutionHandler();
    const result = await handler.execute(
      makeProposal({ emergencyDescription: 'x' }),
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
  });
});

describe('composeEmergencyPageSms', () => {
  it('caps the body at 320 chars', () => {
    const body = composeEmergencyPageSms({
      businessName: 'Acme',
      emergencyDescription: 'x'.repeat(400),
      jobCreated: true,
    });
    expect(body.length).toBeLessThanOrEqual(320);
  });
});
