/**
 * #1395 — a caller's lookup on the MEDIA STREAMS transport, proven against
 * real Postgres at the production media-streams seam.
 *
 * Drives exactly what app.ts wires for a Media Streams call:
 *   /voice webhook   → TwilioGatherAdapter.handleInboundForStream (Phase A:
 *                      session + caller-ID → customer / actor)
 *   WS `start`       → initializeStreamSession (Phase B bootstrap)
 *   Deepgram final   → processCallerUtterance → processor.speechTurn
 *                      (the mediastream adapter's `speechTurn` hook)
 * with real Pg repositories and a production-shaped `lookups` bundle — the
 * same shared dispatch (phone-lookup-surface → workers/voice-lookup-answer)
 * the Gather path uses. Only the LLM gateway is stubbed (it classifies the
 * utterance as the lookup under test).
 *
 * Scoping proven: the caller hears ONLY their own records in the tenant
 * they called — not another customer in the same tenant, and not a customer
 * in another tenant who shares their phone number.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { TTS_COPY } from '../../src/ai/agents/customer-calling/tts-copy';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { SideEffect } from '../../src/ai/agents/customer-calling/types';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { createAuthorizationLoader } from '../../src/auth/authorization-loader';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import type { PhoneLookupDeps } from '../../src/ai/voice-turn/phone-lookup-surface';

const TZ = 'America/Chicago';
const CALLER_PHONE = '+15125559911';
const OTHER_CUSTOMER_PHONE = '+15125559922';

function gatewayReturning(intentType: string): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({
      intentType,
      confidence: 0.96,
      reasoning: 'media-streams lookup integration',
      extractedEntities: {},
    }),
    model: 'stub',
    provider: 'stub',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  } as unknown as LLMResponse;
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

const spoken = (fx: SideEffect[]): string =>
  fx
    .filter((f) => f.type === 'tts_play')
    .map((f) => String((f.payload as { text?: string }).text ?? ''))
    .join(' | ');

describe('#1395 — caller lookups on the media-streams transport (real Postgres)', () => {
  let pool: Pool;
  let userRepo: PgUserRepository;
  let settingsRepo: PgSettingsRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let proposalRepo: PgProposalRepository;
  let lookups: PhoneLookupDeps;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    userRepo = new PgUserRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    const membership = createAuthorizationLoader(pool);
    lookups = {
      // Production-shaped: mirrors app.ts's phoneLookupDeps.
      answers: {
        invoiceRepo: new PgInvoiceRepository(pool),
        estimateRepo: new PgEstimateRepository(pool),
        settingsRepo,
        resolveMemberRole: async (tenantId, userId) => {
          const m = await membership(userId, tenantId);
          if (!m || m.deleted || m.status !== 'active') return null;
          return m.role;
        },
      },
      shared: { jobRepo, appointmentRepo, customerRepo, proposalRepo, userRepo },
      entityResolver: new PgEntityResolver(pool),
      tenantTimezoneResolver: async () => TZ,
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** A tenant with one customer (given phone) and one job with the given summary. */
  async function seedTenantCustomerJob(
    phone: string,
    jobSummary: string,
    existingTenant?: { tenantId: string; userId: string },
  ): Promise<{ tenantId: string; userId: string; customerId: string }> {
    const t = existingTenant ?? (await createTestTenant(pool));
    if (!existingTenant) {
      await pool.query(
        `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region)
         VALUES ($1, $2, 'Stream Lookup Shop', $3, 'TX')`,
        [crypto.randomUUID(), t.tenantId, TZ],
      );
    }
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Dana',
      lastName: 'Miller',
      displayName: 'Dana Miller',
      primaryPhone: phone,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '12 Oak Street',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-MS-${jobId.slice(0, 8)}`,
      summary: jobSummary,
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { tenantId: t.tenantId, userId: t.userId, customerId };
  }

  /**
   * One Media Streams call from `from` into `tenantId`, then one caller
   * utterance through the transport's speechTurn hook.
   */
  async function streamCallAndAsk(
    tenantId: string,
    from: string,
    intent: string,
  ): Promise<{ fx: SideEffect[]; state: string; customerId?: string }> {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: gatewayReturning(intent),
      businessName: 'Stream Lookup Shop',
      publicBaseUrl: 'https://example.com',
      // `pool` is what identifyCaller uses to match the caller-ID to a customer.
      pool,
      settingsRepo,
      userRepo,
      customerRepo,
      jobRepo,
      appointmentRepo,
      proposalRepo,
      lookups,
    });
    const callSid = `CA-ms-${intent}-${crypto.randomUUID().slice(0, 8)}`;
    await adapter.handleInboundForStream({ callSid, from, tenantId });
    await adapter.initializeStreamSession({ callSid, tenantId });
    const session = store.findByCallSid(callSid)!;
    const fx = await adapter.processCallerUtterance({
      sessionId: session.id,
      callSid,
      speechResult: "what's going on with my job",
      tenantId,
    });
    return { fx, state: session.machine.currentState, customerId: session.customerId };
  }

  it('lookup_jobs: the identified caller hears their OWN job in the tenant they called — never another customer or another tenant', async () => {
    const mine = await seedTenantCustomerJob(CALLER_PHONE, 'Miller water heater replacement');
    // Same tenant, different customer.
    await seedTenantCustomerJob(OTHER_CUSTOMER_PHONE, 'Neighbour sprinkler repair', {
      tenantId: mine.tenantId,
      userId: mine.userId,
    });
    // Another tenant, a customer sharing the caller's phone number.
    await seedTenantCustomerJob(CALLER_PHONE, 'Foreign tenant furnace tune-up');

    const { fx, state, customerId } = await streamCallAndAsk(mine.tenantId, CALLER_PHONE, 'lookup_jobs');

    expect(customerId).toBe(mine.customerId);
    const line = spoken(fx);
    expect(line).toContain('Miller water heater replacement');
    expect(line).not.toContain('Neighbour sprinkler repair');
    expect(line).not.toContain('Foreign tenant furnace tune-up');
    expect(line).toContain(TTS_COPY.anything_else.en);
    // Out-of-FSM: the caller can ask the next question.
    expect(state).toBe('intent_capture');
  });

  it('lookup_jobs: the same phone calling the OTHER tenant hears that tenant\'s job only', async () => {
    await seedTenantCustomerJob(CALLER_PHONE, 'Tenant A drain clearing');
    const b = await seedTenantCustomerJob(CALLER_PHONE, 'Tenant B boiler service');

    const { fx } = await streamCallAndAsk(b.tenantId, CALLER_PHONE, 'lookup_jobs');

    const line = spoken(fx);
    expect(line).toContain('Tenant B boiler service');
    expect(line).not.toContain('Tenant A drain clearing');
  });
});
