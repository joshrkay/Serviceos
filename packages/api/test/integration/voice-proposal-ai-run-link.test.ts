/**
 * Part A — a voice create_proposal links to a REAL ai_runs row against
 * Postgres.
 *
 * `proposals.ai_run_id` has an FK to `ai_runs(id)`. The original P0 fabricated
 * a random uuid for it; on Postgres the FK rejected the insert and the swallowed
 * error silently dropped EVERY inbound-voice proposal (in-memory repos don't
 * enforce the FK, so unit tests stayed green). This thread threads the REAL run
 * id the gateway persists through classify → FSM intent_classified event →
 * create_proposal side-effect payload → the proposal.
 *
 * This test drives the production voice processor through a real LLMGateway
 * (wired with PgAiRunRepository so it persists an ai_runs row and returns its
 * id) and PgProposalRepository, then proves:
 *   - the persisted proposal carries a non-null ai_run_id (the insert would
 *     have thrown on a fabricated id — this is the P0 reproduction), and
 *   - `findByAiRun` links the proposal back to its run, whose ai_runs row
 *     actually exists (the FK target).
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAiRunRepository } from '../../src/ai/pg-ai-run';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  LLMGateway,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../../src/ai/gateway/gateway';
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';

describe('Postgres integration — voice proposal links to a real ai_runs row (Part A)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    // Clean only our own rows (unique per-run tenant); never reset the DB.
    if (pool && tenant) {
      await pool.query('DELETE FROM proposals WHERE tenant_id = $1', [tenant.tenantId]);
      await pool.query('DELETE FROM ai_runs WHERE tenant_id = $1', [tenant.tenantId]);
      await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [tenant.tenantId]);
      await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenant.tenantId]);
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.tenantId]);
    }
    await closeSharedTestDb();
  });

  /**
   * Real LLMGateway wired with PgAiRunRepository — so a classify call actually
   * writes an ai_runs row and the gateway surfaces its id on the response.
   * The stub provider answers the classifier turn (create_invoice) and the
   * confirmIntent turn (yes), keyed on the prompt so ordering doesn't matter.
   */
  function buildGateway(): LLMGateway {
    const provider: LLMProvider = {
      name: 'stub',
      isAvailable: async () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        const joined = req.messages.map((m) => m.content).join('\n');
        const isConfirmTurn = /YES or NO/.test(joined);
        const content = isConfirmTurn
          ? JSON.stringify({ answer: 'yes', reasoning: 'affirmative' })
          : JSON.stringify({
              intentType: 'create_invoice',
              confidence: 0.95,
              reasoning: 'caller asked for an invoice',
              extractedEntities: { customerName: 'Acme' },
            });
        return {
          content,
          model: 'stub-model',
          provider: 'stub',
          tokenUsage: { input: 10, output: 5, total: 15 },
          latencyMs: 1,
        };
      },
    };
    const aiRunRepo = new PgAiRunRepository(pool);
    return new LLMGateway(
      { defaultProvider: 'stub' },
      new Map([['stub', provider]]),
      undefined,
      aiRunRepo,
    );
  }

  it('persists a voice proposal WITH a real ai_run_id whose ai_runs row exists', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    const proposalRepo = new PgProposalRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    const aiRunRepo = new PgAiRunRepository(pool);
    const gateway = buildGateway();

    // Owner (surface S2) session — create_invoice/draft_invoice is an
    // operator-grade op the P4 S1 allowlist reserves for S2; this FK-linkage
    // regression must exercise the real draft_invoice path.
    const session = store.create(tenant.tenantId, 'telephony', {
      callSid: 'CA-intg',
      ownerSession: true,
    });
    // Drive the FSM straight to intent_capture where speechTurn classifies.
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: 'CA-intg',
      from: '+15125550100',
      to: '+15125550999',
      tenantId: tenant.tenantId,
    });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: 'cust-intg' });
    session.customerId = 'cust-intg';

    const processor = createVoiceTurnProcessor({
      store,
      gateway,
      businessName: 'Acme Plumbing',
      systemActorId: tenant.userId,
      proposalRepo,
      auditRepo,
      voiceSessionRepo: new InMemoryVoiceSessionRepository(),
    });

    // Turn 1 — classify (persists an ai_runs row, surfaces its id).
    await processor.speechTurn({
      session,
      speechResult: 'I need an invoice for Acme',
      callSid: 'CA-intg',
      tenantId: tenant.tenantId,
    });
    expect(session.machine.currentState).toBe('intent_confirm');

    // Turn 2 — caller confirms → the create_proposal side effect persists.
    await processor.speechTurn({
      session,
      speechResult: 'yes that is correct',
      callSid: 'CA-intg',
      tenantId: tenant.tenantId,
    });

    // The proposal persisted on Postgres (a fabricated ai_run_id would have
    // thrown the FK and dropped it — the P0 reproduction).
    const proposals = await proposalRepo.findByTenant(tenant.tenantId);
    expect(proposals.length).toBe(1);
    const proposal = proposals[0]!;
    expect(proposal.proposalType).toBe('draft_invoice');

    // It carries a REAL, non-null ai_run_id…
    expect(proposal.aiRunId).toBeTruthy();

    // …whose ai_runs row actually exists (the FK target)…
    const run = await aiRunRepo.findById(tenant.tenantId, proposal.aiRunId!);
    expect(run).not.toBeNull();
    expect(run!.taskType).toBe('classify_intent');

    // …and findByAiRun links the proposal back to its run.
    const linked = await proposalRepo.findByAiRun(tenant.tenantId, proposal.aiRunId!);
    expect(linked.map((p) => p.id)).toContain(proposal.id);
  });
});
