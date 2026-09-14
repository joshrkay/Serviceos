/**
 * #1155 (row 2.12) — on the classic <Gather>/PSTN transport a property-manager
 * caller's call must be OBSERVABLY different from a residential caller's:
 * prompt, priority, and proposal context. At real Postgres, T3.
 *
 * `twilio-adapter.ts` assembles `session.b2bAccountContext` at caller
 * identification for both transports, but until #1155 only the media-streams
 * turn (`create-voice-turn-processor.ts` speechTurn) forwarded it to
 * `classifyIntent`; `_handleGatherLocked`'s own classify call never did, and
 * no proposal recorded the account context on either transport. So on the
 * default transport a PM caller and a residential caller produced the
 * identical classify prompt and the identical proposal.
 *
 * Drives the production Gather seam end-to-end for each caller —
 * `handleInbound` (real caller-ID → PgCustomerRepository) → `handleGather`
 * (the utterance: classify) → `handleGather` ("yes": confirm → the real
 * `create_proposal` side effect → PgProposalRepository) — with only the LLM
 * gateway scripted. Observed:
 *   - prompt: the system messages the classify call actually sent (the
 *     gateway's recorded requests);
 *   - priority + proposal context: `proposals.source_context.accountContext`
 *     on the proposal row the call minted, read back from Postgres.
 *
 * T3 — tenant A's property manager, tenant A's residential customer, and
 * tenant B (no B2B account configured at all) in one run; only the property
 * manager's call carries account context, and nothing leaks across tenants.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

const TURN = 'the unit at 4B has no hot water, can someone come out today';

/**
 * Scripted gateway that records every request. One canned JSON answers both
 * the classifier (`intentType`) and the yes/no confirm skill (`answer`).
 */
function recordingGateway(): { gateway: LLMGateway; requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  const response: LLMResponse = {
    content: JSON.stringify({
      intentType: 'draft_estimate',
      confidence: 0.95,
      reasoning: 'caller wants a visit quoted',
      extractedEntities: { summary: 'No hot water at unit 4B' },
      answer: 'yes',
    }),
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  const gateway = {
    complete: vi.fn(async (req: LLMRequest) => {
      requests.push(req);
      return response;
    }),
  } as unknown as LLMGateway;
  return { gateway, requests };
}

describe('Postgres integration — Gather transport: a property-manager call differs in prompt, priority and proposal context (#1155, T3)', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedCustomer(
    tenant: TestTenant,
    phone: string,
    displayName: string,
    extra: { accountType?: 'residential' | 'b2b' | 'property_manager'; parentAccountId?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await customerRepo.create({
      id,
      tenantId: tenant.tenantId,
      firstName: displayName.split(' ')[0],
      lastName: displayName.split(' ').slice(1).join(' ') || 'Account',
      displayName,
      ...(phone ? { primaryPhone: phone } : {}),
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    });
    return id;
  }

  /** One real Gather call: identify → utterance → "yes". */
  async function gatherCall(tenant: TestTenant, from: string) {
    const store = new VoiceSessionStore({ startInterval: false });
    const { gateway, requests } = recordingGateway();
    const adapter = new TwilioGatherAdapter({
      store,
      gateway,
      pool,
      customerRepo,
      proposalRepo,
      auditRepo,
      settingsRepo,
      businessName: 'Gather B2B Co',
      publicBaseUrl: 'https://example.com',
    } as never);
    const callSid = `CA-1155-${crypto.randomUUID().slice(0, 8)}`;
    await adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId: tenant.tenantId });
    const session = store.findByCallSid(callSid)!;
    expect(session, 'handleInbound must establish a session').toBeDefined();

    await adapter.handleGather({
      sessionId: session.id,
      callSid,
      speechResult: TURN,
      confidence: 0.95,
      tenantId: tenant.tenantId,
    });
    const stateAfterUtterance = session.machine.currentState;
    await adapter.handleGather({
      sessionId: session.id,
      callSid,
      speechResult: 'yes',
      confidence: 0.95,
      tenantId: tenant.tenantId,
    });

    // prompt — the system messages the Gather classify call actually sent.
    const classifyPrompts = requests
      .filter((r) => r.messages.some((m) => m.role === 'system'))
      .map((r) =>
        r.messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n'),
      );
    expect(classifyPrompts.length, 'the utterance must have been classified').toBeGreaterThanOrEqual(1);

    // proposal context — the row this call minted, read back from Postgres.
    const { rows } = await pool.query(
      `SELECT proposal_type, source_context FROM proposals
        WHERE tenant_id = $1 AND source_context->>'sessionId' = $2
        ORDER BY created_at`,
      [tenant.tenantId, session.id],
    );

    return {
      stateAfterUtterance,
      promptCarriesAccountContext: classifyPrompts.some((p) => /Caller account context/.test(p)),
      promptMarksPriority: classifyPrompts.some((p) => /PRIORITY/.test(p)),
      promptNamesManagedProperty: classifyPrompts.some((p) => /Maple Court Apartments/.test(p)),
      proposalCount: rows.length,
      proposalAccountContext: rows.map((r) => r.source_context?.accountContext ?? null),
    };
  }

  it('T3: only the property-manager caller\'s Gather call carries account context in the prompt AND on the proposal row', async () => {
    const pmId = await seedCustomer(tenantA, '+15125551551', 'Portfolio Property Management', {
      accountType: 'property_manager',
    });
    await seedCustomer(tenantA, '', 'Maple Court Apartments', {
      accountType: 'property_manager',
      parentAccountId: pmId,
    });
    await seedCustomer(tenantA, '+15125551552', 'Rita Residential');
    await seedCustomer(tenantB, '+15125551553', 'Bea Neighbour');

    const pm = await gatherCall(tenantA, '+15125551551');
    const residential = await gatherCall(tenantA, '+15125551552');
    const neighbour = await gatherCall(tenantB, '+15125551553');

    // Each call really classified, confirmed and minted exactly one proposal.
    for (const call of [pm, residential, neighbour]) {
      expect(call.stateAfterUtterance).toBe('intent_confirm');
      expect(call.proposalCount).toBe(1);
    }

    expect({
      pm: {
        prompt: pm.promptCarriesAccountContext,
        priority: pm.promptMarksPriority,
        managedProperty: pm.promptNamesManagedProperty,
        proposalAccountContext: pm.proposalAccountContext,
      },
      residential: {
        prompt: residential.promptCarriesAccountContext,
        priority: residential.promptMarksPriority,
        proposalAccountContext: residential.proposalAccountContext,
      },
      neighbour: {
        prompt: neighbour.promptCarriesAccountContext,
        priority: neighbour.promptMarksPriority,
        proposalAccountContext: neighbour.proposalAccountContext,
      },
    }).toEqual({
      pm: {
        prompt: true,
        priority: true,
        managedProperty: true,
        proposalAccountContext: [
          { accountType: 'property_manager', priority: true, managedPropertyCount: 1 },
        ],
      },
      residential: { prompt: false, priority: false, proposalAccountContext: [null] },
      neighbour: { prompt: false, priority: false, proposalAccountContext: [null] },
    });
  });
});
