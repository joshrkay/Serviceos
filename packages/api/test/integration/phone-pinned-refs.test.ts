/**
 * #1416 — the phone's lookups planned after a customer pick still run, at
 * REAL Postgres.
 *
 * "Invoice Jamie Rivera for the water heater replacement job" on an owner line plans a
 * customer lookup and then a job lookup. Two "Jamie Rivera" rows make the
 * customer ambiguous, so the phone asks (#1118). Before #1416 the caller's
 * pick went straight to the readback — the job lookup never ran, the
 * draft_invoice had no jobId, and the executor opened a placeholder job.
 *
 * Proven through `TwilioGatherAdapter.handleGather` (the exact method the
 * signed /api/telephony/gather route calls) over real Pg repositories and
 * the production `PgEntityResolver`:
 *   1. pick → the Oak Street customer's water-heater job is resolved, and the
 *      persisted draft_invoice proposal row carries that jobId;
 *   2. a job that does not exist is said honestly after the pick, and no
 *      proposal row is written.
 *
 * Deterministic without a model: the scripted gateway answers the classifier
 * with a fixed create_invoice extraction and confirmIntent with "yes"; the
 * ambiguity and the job match come from pg_trgm in PgEntityResolver.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL=… npx vitest run \
 *     --config vitest.integration.config.mts test/integration/phone-pinned-refs.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgUserRepository } from '../../src/users/pg-user';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

const RUN = crypto.randomInt(100000, 999999);
const DID = `+1512${RUN}3`;
const OWNER_PHONE = `+1512${RUN}9`;
const FIRST = 'Jamie';
const LAST = 'Rivera';
const FOLLOW_UP = 'The one on 12 Oak Street';
const ASK_FOR_ADDRESS = 'more than one record under that name';

describe('#1416 — phone: a customer pick does not skip the job lookup (real Postgres)', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let tenantId: string;
  let userId: string;
  let oakCustomer: string;
  let oakWaterHeaterJob: string;

  async function seedCustomer(phone: string, street1: string): Promise<{ customerId: string; locationId: string }> {
    const customerId = crypto.randomUUID();
    const locationId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: FIRST,
      lastName: LAST,
      displayName: `${FIRST} ${LAST}`,
      primaryPhone: phone,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1,
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
    return { customerId, locationId };
  }

  /** The classifier answers `jobReference`'s create_invoice; confirmIntent answers yes. */
  function invoiceGateway(jobReference: string): LLMGateway {
    const invoice = JSON.stringify({
      intentType: 'create_invoice',
      confidence: 0.93,
      extractedEntities: {
        customerName: `${FIRST} ${LAST}`,
        jobReference,
        amount: 35000,
        lineItemDescriptions: ['completed repair'],
      },
    });
    return {
      complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
        const skill = (req.metadata as { skill?: string } | undefined)?.skill;
        const asksToInvoice = JSON.stringify(req.messages ?? req).toLowerCase().includes('invoice jamie');
        return {
          content:
            skill === 'confirm_intent'
              ? JSON.stringify({ answer: 'yes', reasoning: 'clear affirmative' })
              : asksToInvoice
                ? invoice
                : JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
          model: 'stub',
          provider: 'stub',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        };
      }),
    } as unknown as LLMGateway;
  }

  function buildAdapter(store: VoiceSessionStore, jobReference: string): TwilioGatherAdapter {
    return new TwilioGatherAdapter({
      store,
      gateway: invoiceGateway(jobReference),
      businessName: '1416 Pinned Refs Shop',
      publicBaseUrl: 'https://example.com',
      pool,
      settingsRepo: new PgSettingsRepository(pool),
      userRepo: new PgUserRepository(pool),
      customerRepo,
      proposalRepo: new PgProposalRepository(pool),
      auditRepo: new PgAuditRepository(pool),
      entityResolver: new PgEntityResolver(pool),
      locationRepo,
    });
  }

  async function ownerCall(
    adapter: TwilioGatherAdapter,
    store: VoiceSessionStore,
    utterances: string[],
  ): Promise<{ twimls: string[]; session: NonNullable<ReturnType<VoiceSessionStore['get']>> }> {
    const callSid = `CA-1416-${crypto.randomUUID().slice(0, 8)}`;
    await adapter.handleInbound({
      callSid,
      from: OWNER_PHONE,
      to: DID,
      tenantId,
      stirVerstat: 'TN-Validation-Passed-A',
    });
    const session = store.findByCallSid(callSid)!;
    const twimls: string[] = [];
    for (const speechResult of utterances) {
      twimls.push(
        await adapter.handleGather({ sessionId: session.id, callSid, speechResult, confidence: 0.95, tenantId }),
      );
    }
    return { twimls, session };
  }

  async function proposalRows(): Promise<Array<{ proposal_type: string; payload: Record<string, unknown> }>> {
    const { rows } = await pool.query<{ proposal_type: string; payload: Record<string, unknown> }>(
      `SELECT proposal_type, payload FROM proposals WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    tenantId = crypto.randomUUID();
    userId = crypto.randomUUID();
    const email = `owner+${tenantId.slice(0, 8)}@example.com`;
    await pool.query(
      `INSERT INTO tenants (id, owner_id, owner_email, name, subscription_status)
       VALUES ($1, $2, $3, '1416 Pinned Refs Shop', 'active')`,
      [tenantId, userId, email],
    );
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'owner', 'Dev', 'Owner')`,
      [userId, tenantId, userId, email],
    );
    await pool.query(
      `INSERT INTO tenant_settings
         (id, tenant_id, business_name, timezone, region, voice_agent_live_at, owner_phone, e1_reviewed_script)
       VALUES ($1, $2, '1416 Pinned Refs Shop', 'America/Chicago', 'TX', NOW(), $3,
               'If this is an emergency, hang up and call 911.')`,
      [crypto.randomUUID(), tenantId, OWNER_PHONE],
    );
    const oak = await seedCustomer('+15125550131', '12 Oak Street');
    await seedCustomer('+15125550177', '48 Pine Avenue');
    oakCustomer = oak.customerId;
    oakWaterHeaterJob = crypto.randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, 'Water heater replacement', $6)`,
      [oakWaterHeaterJob, tenantId, oakCustomer, oak.locationId, `JOB-${RUN}`, userId],
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('pick → the named job resolves → "yes": the persisted draft_invoice carries the picked customer AND the named job', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = buildAdapter(store, 'water heater replacement job');
    const { twimls, session } = await ownerCall(adapter, store, [
      'This is the owner calling',
      'Invoice Jamie Rivera for the water heater replacement job, 350 dollars',
    ]);
    expect(twimls[1]).toContain(ASK_FOR_ADDRESS);

    await adapter.handleGather({
      sessionId: session.id,
      callSid: session.callSid!,
      speechResult: FOLLOW_UP,
      confidence: 0.95,
      tenantId,
    });
    expect(session.machine.currentState).toBe('intent_confirm');

    await adapter.handleGather({
      sessionId: session.id,
      callSid: session.callSid!,
      speechResult: 'yes',
      confidence: 0.95,
      tenantId,
    });
    const rows = await proposalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposal_type).toBe('draft_invoice');
    expect(rows[0]!.payload.customerId).toBe(oakCustomer);
    expect(rows[0]!.payload.jobId).toBe(oakWaterHeaterJob);
  });

  it('pick → a named job that does not exist is said honestly, and no proposal row is written', async () => {
    const before = (await proposalRows()).length;
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = buildAdapter(store, 'the sprinkler job');
    const { twimls, session } = await ownerCall(adapter, store, [
      'This is the owner calling',
      'Invoice Jamie Rivera for the sprinkler job, 350 dollars',
    ]);
    expect(twimls[1]).toContain(ASK_FOR_ADDRESS);

    const afterPick = await adapter.handleGather({
      sessionId: session.id,
      callSid: session.callSid!,
      speechResult: FOLLOW_UP,
      confidence: 0.95,
      tenantId,
    });
    expect(afterPick).toMatch(/wasn(&apos;|')t able to find the record/);
    expect(afterPick).not.toContain('Is that right?');
    expect(session.machine.currentState).not.toBe('intent_confirm');
    expect((await proposalRows()).length).toBe(before);
  });
});
