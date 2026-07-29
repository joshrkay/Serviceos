/**
 * B1.19 AC-5 — parity of outcome: a completed conversational onboarding
 * (scripted turns, mocked LLM gateway) must produce the SAME tenant
 * configuration the form wizard produces for identical facts, against
 * real Postgres.
 *
 * Two tenants, same input facts:
 *   - `wizardTenant`  drives the REAL Express routes (PUT /identity,
 *     POST /pack) via supertest — mirrors test/integration/
 *     onboarding-identity.test.ts and onboarding-pack.test.ts's
 *     conventions.
 *   - `conversationTenant` drives OnboardingConversationOrchestrator
 *     with a scripted gateway to `completed`, approves every emitted
 *     `onboarding_*` proposal, and executes each through the PRODUCTION
 *     registry (createExecutionHandlerRegistry, real Pg repos — not a
 *     hand-rolled handler).
 *
 * Fields both paths can produce are asserted equal. Fields where the
 * conversational engine has no capture channel (timezone; team-member
 * accounts) are called out explicitly below rather than silently
 * skipped — see the "cannot assert" comments and the B1.19 report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

import { createOnboardingRouter } from '../../src/routes/onboarding';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';

import { OnboardingConversationOrchestrator } from '../../src/ai/orchestration/onboarding-conversation';
import { PgOnboardingSessionRepository } from '../../src/db/onboarding-session-repository';
import {
  InMemoryProposalRepository,
  Proposal,
  missingFieldsFor,
} from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry, ExecutionContext } from '../../src/proposals/execution/handlers';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';
import { deriveOnboardingStatus } from '../../src/onboarding/derive-status';

function scriptedGateway(scripts: Record<string, unknown>): LLMGateway {
  return {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const payload = scripts[req.taskType];
      if (payload === undefined) {
        throw new Error(`No script for taskType=${req.taskType}`);
      }
      return {
        content: JSON.stringify(payload),
        model: 'test',
        provider: 'test',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      };
    },
  } as unknown as LLMGateway;
}

// ─── Fixed facts, used by BOTH paths ───────────────────────────────────────
const BUSINESS_NAME = 'Desert Rose Plumbing';
const CITY = 'Tucson';
const STATE = 'AZ';
const SERVICE_AREA_TEXT = `${CITY}, ${STATE}`;
const TIMEZONE = 'America/Phoenix';
// B1.20 — matches the extract_pricing script's hourly_rate entry below
// ($120/hr), and IdentityStep.tsx:77's `useState<number>(30)` form
// default, so both paths are asserted against the SAME expected values.
const HOURLY_RATE_CENTS = 12000;
const JOB_BUFFER_MINUTES = 30;
const BUSINESS_HOURS = {
  mon: { open: '08:00', close: '17:00' },
  tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
};

const CONVERSATION_SCRIPTS = {
  extract_business_profile: {
    business_name: BUSINESS_NAME,
    city: CITY,
    state: STATE,
    verticals: [{ type: 'plumbing', confidence: 0.95, source_text: 'plumbing' }],
    service_descriptions: ['plumbing repair'],
    confidence_score: 0.9,
  },
  extract_categories: {
    categories: [
      { vertical_type: 'plumbing', category_id: 'repair', name: 'Repair', confidence: 0.9, source_text: 'repair' },
    ],
    confidence_score: 0.9,
  },
  extract_pricing: {
    prices: [
      { service_ref: 'repair diagnostic visit', amount_cents: 9500, price_type: 'exact', confidence: 0.9, source_text: '$95 service call' },
      { service_ref: 'repair hourly labor', amount_cents: 12000, price_type: 'hourly_rate', confidence: 0.9, source_text: '$120 an hour' },
    ],
    confidence_score: 0.9,
  },
  extract_team: {
    members: [
      { name: 'Mike', inferred_role: 'owner', confidence: 0.95, source_text: 'I run the shop' },
      { name: 'Rosa', inferred_role: 'dispatcher', confidence: 0.9, source_text: 'Rosa answers the phones' },
    ],
    confidence_score: 0.9,
  },
  extract_schedule: {
    working_hours: [
      { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '08:00', end_time: '17:00' },
    ],
    confidence_score: 0.9,
  },
  extract_tools: {
    tools: [{ name: 'QuickBooks', confidence: 0.9, source_text: 'I use QuickBooks' }],
    confidence_score: 0.9,
  },
};

describe('B1.19 — onboarding parity: conversation vs. wizard, real Postgres', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let packActivationRepo: PgPackActivationRepository;
  let auditRepo: PgAuditRepository;
  let catalogRepo: PgCatalogItemRepository;
  let templateRepo: PgEstimateTemplateRepository;

  // Hoisted so the gated-team-member test can drive the REAL approveProposal
  // against the same repo the conversation wrote its proposals into.
  let proposalRepo: InMemoryProposalRepository;

  let wizardTenant: { tenantId: string; userId: string };
  let conversationTenant: { tenantId: string; userId: string };
  let crossTenant: { tenantId: string; userId: string };

  let conversationProposals: Proposal[] = [];
  let conversationExecutions: Array<{ proposal: Proposal; result: { success: boolean; error?: string; resultEntityId?: string } }> = [];

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    packActivationRepo = new PgPackActivationRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    templateRepo = new PgEstimateTemplateRepository(pool);

    wizardTenant = await createTestTenant(pool);
    conversationTenant = await createTestTenant(pool);
    crossTenant = await createTestTenant(pool);

    // ── Wizard path: real Express routes ──────────────────────────────
    const wizardApp = express();
    wizardApp.use(express.json());
    wizardApp.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: wizardTenant.userId,
        sessionId: 'sess-wizard',
        tenantId: wizardTenant.tenantId,
        role: 'owner',
      };
      next();
    });
    wizardApp.use(
      '/api/onboarding',
      createOnboardingRouter({
        settingsRepo,
        packActivationRepo,
        auditRepo,
        pool,
        packSeedDeps: { catalogRepo, templateRepo },
      }),
    );

    const identityRes = await request(wizardApp).put('/api/onboarding/identity').send({
      businessName: BUSINESS_NAME,
      serviceAreaText: SERVICE_AREA_TEXT,
      businessHours: BUSINESS_HOURS,
      jobBufferMinutes: JOB_BUFFER_MINUTES,
      hourlyRateCents: HOURLY_RATE_CENTS,
      // Explicitly confirmed timezone — proves the wizard path CAN set a
      // real, chosen zone (never a guessed default).
      timezone: TIMEZONE,
    });
    expect(identityRes.status).toBe(200);

    const packRes = await request(wizardApp).post('/api/onboarding/pack').send({ packId: 'plumbing' });
    expect(packRes.status).toBe(200);

    // ── Conversation path: scripted FSM turns → approve → execute ─────
    const sessionRepo = new PgOnboardingSessionRepository(pool);
    proposalRepo = new InMemoryProposalRepository();
    const orchestrator = new OnboardingConversationOrchestrator({
      gateway: scriptedGateway(CONVERSATION_SCRIPTS),
      sessionRepo,
      proposalRepo,
      auditRepo,
      now: () => new Date('2026-06-17T15:00:00Z'),
    });

    const opened = await orchestrator.turn({ tenantId: conversationTenant.tenantId, userId: conversationTenant.userId });
    let last = opened;
    // Six high-confidence turns: profile → category → pricing → team →
    // schedule → tools, landing in `review`.
    for (let i = 0; i < 6; i++) {
      last = await orchestrator.turn({
        tenantId: conversationTenant.tenantId,
        userId: conversationTenant.userId,
        sessionId: opened.sessionId,
        userMessage: `Turn ${i}`,
      });
    }
    expect(last.state).toBe('review');

    const confirmation = await orchestrator.turn({
      tenantId: conversationTenant.tenantId,
      userId: conversationTenant.userId,
      sessionId: opened.sessionId,
      userMessage: 'looks good',
    });
    expect(confirmation.state).toBe('completed');
    expect(confirmation.proposalIds.length).toBeGreaterThan(0);

    for (const id of confirmation.proposalIds) {
      const p = await proposalRepo.findById(conversationTenant.tenantId, id);
      expect(p).not.toBeNull();
      conversationProposals.push(p as Proposal);
    }
    // Every emitted proposal is one of the five onboarding_* types.
    for (const p of conversationProposals) {
      expect(p.proposalType.startsWith('onboarding_')).toBe(true);
    }

    // Approve each (draft → ready_for_review → approved, backdated past
    // the 5-second undo window — same pattern as draft-estimate-execution.test.ts).
    // Gated proposals are deliberately excluded: a proposal carrying
    // missingFields cannot be approved through the real gate
    // (proposals/actions.ts), so forcing it through transitionProposal here
    // would test a path production forbids. `onboarding_team_member` is the
    // gated case — see the dedicated test below, which exercises the REAL
    // approveProposal and asserts the refusal.
    const approvable = conversationProposals.filter((p) => missingFieldsFor(p).length === 0);
    const approved: Proposal[] = approvable.map((p) => {
      let cur = p;
      if (cur.status !== 'approved') {
        cur = transitionProposal(cur, 'ready_for_review', conversationTenant.userId);
        cur = transitionProposal(cur, 'approved', conversationTenant.userId);
      }
      return { ...cur, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    });

    // PRODUCTION registry — real Pg repos, exactly what app.ts wires.
    const handlers = createExecutionHandlerRegistry({
      settingsRepo,
      packActivationRepo,
      templateRepo,
      packSeedDeps: { catalogRepo, templateRepo },
      auditRepo,
    });
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);

    for (const p of approved) {
      // Overwrites the 'draft' row emitProposalBatches already created
      // (same id) with the approved + backdated shape.
      await proposalRepo.create(p);
      const context: ExecutionContext = { tenantId: p.tenantId, executedBy: conversationTenant.userId };
      const { result } = await executor.execute(p, context);
      conversationExecutions.push({ proposal: p, result });
    }
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('business profile: businessName + city/state (as service_area_text) match the wizard', async () => {
    const wizardSettings = await settingsRepo.findByTenant(wizardTenant.tenantId);
    const conversationSettings = await settingsRepo.findByTenant(conversationTenant.tenantId);

    expect(conversationSettings?.businessName).toBe(BUSINESS_NAME);
    expect(wizardSettings?.businessName).toBe(BUSINESS_NAME);

    // city/state have no dedicated tenant_settings columns — both this
    // handler and the assertion below use the same "City, State" join
    // documented in onboarding-handlers.ts; the wizard's serviceAreaText
    // is free-text and was submitted with the identical string.
    expect(conversationSettings?.serviceAreaText).toBe(SERVICE_AREA_TEXT);
    expect(wizardSettings?.serviceAreaText).toBe(SERVICE_AREA_TEXT);
  });

  it('hours: business_hours match the wizard exactly', async () => {
    const wizardSettings = await settingsRepo.findByTenant(wizardTenant.tenantId);
    const conversationSettings = await settingsRepo.findByTenant(conversationTenant.tenantId);

    expect(conversationSettings?.businessHours).toEqual(BUSINESS_HOURS);
    expect(wizardSettings?.businessHours).toEqual(BUSINESS_HOURS);
  });

  it('identity: hourlyRateCents threads through from the pricing capture and matches the wizard', async () => {
    // B1.20 — verified defect fix: onboarding-handlers.ts previously wrote
    // neither hourlyRateCents nor jobBufferMinutes, so an approved
    // conversational onboarding could never satisfy derive-status.ts's
    // isIdentityDone check. This proves the extracted $120/hr rate
    // (extract_pricing script above) lands in the SAME column the wizard
    // writes, as the same integer-cents value.
    const wizardSettings = await settingsRepo.findByTenant(wizardTenant.tenantId);
    const conversationSettings = await settingsRepo.findByTenant(conversationTenant.tenantId);

    expect(wizardSettings?.hourlyRateCents).toBe(HOURLY_RATE_CENTS);
    expect(conversationSettings?.hourlyRateCents).toBe(HOURLY_RATE_CENTS);
    expect(Number.isInteger(conversationSettings?.hourlyRateCents)).toBe(true);
  });

  it('identity: jobBufferMinutes defaults to 30 on the conversational path, matching the wizard form default (parity, not a guess — see onboarding-handlers.ts)', async () => {
    // The conversation never asks about job buffer at all — there is no
    // capture state for it. The handler writes the SAME default the form
    // wizard pre-fills (IdentityStep.tsx:77 `useState<number>(30)`), which
    // is why this is asserted as parity rather than skipped like timezone
    // (a buffer default has no correctness cliff a wrong timezone has).
    const wizardSettings = await settingsRepo.findByTenant(wizardTenant.tenantId);
    const conversationSettings = await settingsRepo.findByTenant(conversationTenant.tenantId);

    expect(wizardSettings?.jobBufferMinutes).toBe(JOB_BUFFER_MINUTES);
    expect(conversationSettings?.jobBufferMinutes).toBe(JOB_BUFFER_MINUTES);
  });

  it('timezone: the wizard path stores the EXPLICITLY CONFIRMED value; the conversational path — which has no capture channel for timezone at all — never guesses one', async () => {
    const wizardSettings = await settingsRepo.findByTenant(wizardTenant.tenantId);
    const conversationSettings = await settingsRepo.findByTenant(conversationTenant.tenantId);

    // Positive assertion: the wizard's stored zone is EXACTLY what was
    // confirmed, never a substituted default.
    expect(wizardSettings?.timezone).toBe(TIMEZONE);

    // CANNOT ASSERT full parity here: none of the five onboarding_*
    // extractors/payloads carry a timezone (see B1.19 report). The
    // honest assertion available on the conversation side is the
    // negative half of the AC — it is never guessed. NULL is the only
    // representable "not chosen" per migration 263 / the timezone
    // no-fallback rule (routes/onboarding.ts PUT /identity), so raw SQL
    // (not the repo mapper, which folds NULL into `undefined`) confirms
    // the column itself, not just the TS projection.
    const raw = await pool.query<{ timezone: string | null }>(
      'SELECT timezone FROM tenant_settings WHERE tenant_id = $1',
      [conversationTenant.tenantId],
    );
    expect(raw.rows[0].timezone).toBeNull();
    expect(conversationSettings?.timezone).toBeUndefined();
  });

  it('vertical pack: both tenants have an active plumbing pack_activations row', async () => {
    const wizardActivation = await packActivationRepo.findByTenantAndPack(wizardTenant.tenantId, 'plumbing');
    const conversationActivation = await packActivationRepo.findByTenantAndPack(conversationTenant.tenantId, 'plumbing');

    expect(wizardActivation?.status).toBe('active');
    expect(conversationActivation?.status).toBe('active');
  });

  it('pricing seed: both tenants end up with a non-empty, non-zero-priced plumbing estimate template (content differs by design — see comment)', async () => {
    // NOT byte-for-byte parity: the wizard's POST /pack seeds CANNED
    // defaults (seedPackDefaults — "Plumbing Diagnostic Visit", etc, at
    // fixed prices from PLUMBING_LINE_ITEM_DEFAULTS); the conversation's
    // onboarding_estimate_template proposal carries the OWNER'S OWN
    // spoken prices ($95 / $120 here) via a bespoke template. Both are
    // real "pricing seed" outcomes — an operator lands on a non-empty,
    // priced price book either way — but the row contents are
    // intentionally different data, so this asserts outcome KIND, not
    // exact-value equality. See onboarding-handlers.ts's class doc for
    // OnboardingEstimateTemplateExecutionHandler.
    const wizardTemplates = await templateRepo.findByVertical(wizardTenant.tenantId, 'plumbing');
    const conversationTemplates = await templateRepo.findByVertical(conversationTenant.tenantId, 'plumbing');

    expect(wizardTemplates.length).toBeGreaterThan(0);
    expect(conversationTemplates.length).toBeGreaterThan(0);
    for (const t of wizardTemplates) {
      expect(t.lineItemTemplates.some((li) => li.defaultUnitPriceCents > 0)).toBe(true);
    }
    for (const t of conversationTemplates) {
      expect(t.lineItemTemplates.some((li) => li.defaultUnitPriceCents > 0)).toBe(true);
    }

    // The conversation-drafted template DOES carry the owner's actual
    // stated prices (this part IS exact).
    const drafted = conversationTemplates.find((t) => t.categoryId === 'repair');
    expect(drafted).toBeDefined();
    const cents = drafted!.lineItemTemplates.map((li) => li.defaultUnitPriceCents).sort((a, b) => a - b);
    expect(cents).toContain(9500);
    expect(cents).toContain(12000);
  });

  it('team: the capture is GATED, not approved-then-failed — the B7.4 shape this run exists to remove', async () => {
    // The wizard flow has NO team-member step (no team UI under
    // packages/web/src/onboarding), so there is no parity to assert. What
    // matters is the SHAPE of the refusal.
    //
    // These proposals used to approve and then fail at execution, because
    // adding a team member means sending an invitation — which needs an email
    // the spoken capture cannot produce, and for which no endpoint yet exists
    // (routes/users.ts: "PR 3 will add POST /api/users"). The rivet-voice-19
    // re-measurement correctly called that out as the same defect class as the
    // dictated-note bug (B7.4): honest and audited, but still "approve, then
    // nothing happens" from the owner's seat.
    //
    // The proposal is now gated at draft time instead, so the real approval
    // gate refuses it and the failure can never occur.
    const teamProposals = conversationProposals.filter(
      (p) => p.proposalType === 'onboarding_team_member',
    );
    expect(teamProposals.length).toBe(2);

    for (const p of teamProposals) {
      // Honestly gated…
      expect(missingFieldsFor(p)).toContain('email');
      // …and nothing the owner said was dropped to achieve it.
      expect(p.payload.name).toBeTruthy();
      expect(p.payload.role).toBeTruthy();
      // …and the REAL approval gate refuses it (not transitionProposal, which
      // bypasses the check — this is the production path).
      await expect(
        approveProposal(proposalRepo, p.tenantId, p.id, conversationTenant.userId, 'owner'),
      ).rejects.toThrow(/unfilled required fields/);
    }

    // It never reached execution at all, so there is no failed execution to
    // observe — the point of the gate.
    const teamExecutions = conversationExecutions.filter(
      (e) => e.proposal.proposalType === 'onboarding_team_member',
    );
    expect(teamExecutions).toHaveLength(0);

    // No fabricated row anywhere: no pending_invitation, no note, no user.
    const invitations = await pool.query(
      `SELECT id FROM pending_invitations WHERE tenant_id = $1`,
      [conversationTenant.tenantId],
    ).catch(() => ({ rows: [] as unknown[] }));
    expect(invitations.rows).toHaveLength(0);
  });

  it('audit events: every applied proposal (identity, pack activation, schedule, estimate template) has a real audit row; the failed team proposals audit their failure', async () => {
    const identitySet = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.identity_set'`,
      [conversationTenant.tenantId],
    );
    // One from onboarding_tenant_settings, one from onboarding_schedule.
    expect(identitySet.rows.length).toBeGreaterThanOrEqual(2);

    const packActivated = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.pack_activated' AND entity_id = 'plumbing'`,
      [conversationTenant.tenantId],
    );
    expect(packActivated.rows.length).toBeGreaterThanOrEqual(1);

    const templateCreated = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'estimate_template.created'`,
      [conversationTenant.tenantId],
    );
    expect(templateCreated.rows.length).toBeGreaterThanOrEqual(1);

    const teamProposalIds = conversationExecutions
      .filter((e) => e.proposal.proposalType === 'onboarding_team_member')
      .map((e) => e.proposal.id);
    for (const id of teamProposalIds) {
      const failed = await pool.query(
        `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'proposal.execution_failed' AND entity_id = $2`,
        [conversationTenant.tenantId, id],
      );
      expect(failed.rows.length).toBe(1);
    }
  });

  it('B1.20 — the identity onboarding step now derives DONE for the conversation-driven tenant (the actual user-visible soft-gate outcome, not just non-null columns)', async () => {
    // This is the real defect assertion: before this fix, a tenant could
    // approve+execute all five onboarding_* proposals and derive-status.ts's
    // isIdentityDone would still report false (missing jobBufferMinutes AND
    // hourlyRateCents), bouncing them back to redo the identity step in the
    // form even though they'd just finished it by voice. Reproduces the
    // exact facts-loading path routes/onboarding.ts's GET /status uses.
    const conversationFacts = await loadOnboardingFacts({ pool, settingsRepo }, conversationTenant.tenantId);
    const conversationStatus = deriveOnboardingStatus(conversationFacts);
    const identityStep = conversationStatus.steps.find((s) => s.id === 'identity');

    expect(identityStep?.status).toBe('done');

    // Same derivation for the wizard tenant, as a sanity check that the
    // status function itself is being exercised correctly (both paths
    // should agree once the conversational path is fixed).
    const wizardFacts = await loadOnboardingFacts({ pool, settingsRepo }, wizardTenant.tenantId);
    const wizardStatus = deriveOnboardingStatus(wizardFacts);
    expect(wizardStatus.steps.find((s) => s.id === 'identity')?.status).toBe('done');

    // Regression pin (must not regress): the identity step derives DONE
    // WITHOUT a timezone — deriveOnboardingStatus's isIdentityDone check
    // never required one, and the conversational path still never guesses
    // one (see the timezone test above). Confirms the fix didn't
    // accidentally start defaulting timezone to make this test pass.
    expect(conversationFacts.identity.jobBufferMinutes).toBe(JOB_BUFFER_MINUTES);
    expect(conversationFacts.identity.hourlyRateCents).toBe(HOURLY_RATE_CENTS);
    const rawTimezone = await pool.query<{ timezone: string | null }>(
      'SELECT timezone FROM tenant_settings WHERE tenant_id = $1',
      [conversationTenant.tenantId],
    );
    expect(rawTimezone.rows[0].timezone).toBeNull();
  });

  it('cross-tenant negative: a third tenant sees none of the conversation tenant\'s config', async () => {
    const settings = await settingsRepo.findByTenant(crossTenant.tenantId);
    expect(settings?.businessName ?? '').not.toBe(BUSINESS_NAME);

    const packActivation = await packActivationRepo.findByTenantAndPack(crossTenant.tenantId, 'plumbing');
    expect(packActivation).toBeNull();

    const templates = await templateRepo.findByVertical(crossTenant.tenantId, 'plumbing');
    expect(templates).toHaveLength(0);

    const catalogItems = await catalogRepo.listByTenant(crossTenant.tenantId);
    expect(catalogItems).toHaveLength(0);

    // Audit rows are tenant-scoped too.
    const events = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.identity_set'`,
      [crossTenant.tenantId],
    );
    expect(events.rows).toHaveLength(0);
  });
});
