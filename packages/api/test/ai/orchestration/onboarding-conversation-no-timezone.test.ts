import { describe, it, expect, beforeEach } from 'vitest';
import { OnboardingConversationOrchestrator } from '../../../src/ai/orchestration/onboarding-conversation';
import { InMemoryOnboardingSessionRepository } from '../../../src/db/onboarding-session-repository';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository, missingFieldsFor } from '../../../src/proposals/proposal';
import { approveProposal, editProposal } from '../../../src/proposals/actions';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { InMemoryPackActivationRepository } from '../../../src/settings/pack-activation';
import { OnboardingTenantSettingsExecutionHandler } from '../../../src/proposals/execution/onboarding-handlers';
import { deriveOnboardingStatus, type OnboardingFacts } from '../../../src/onboarding/derive-status';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-no-tz-1';
const USER = 'user-no-tz-1';
const NOW = new Date('2026-07-29T15:00:00Z');
/**
 * The operator's OWN zone — reported by their browser on the turn, chosen
 * earlier in settings, or typed on the review card when neither is available.
 * Never derived by this server.
 */
const CHOSEN_TZ = 'America/Phoenix';

/**
 * The third member of the gate family covered by the sibling
 * `onboarding-conversation-unsupported-trade.test.ts` (`verticalPacks`) and
 * `onboarding-conversation-no-hourly-rate.test.ts` (`hourlyRateCents`), and the
 * one whose downstream damage is loudest.
 *
 * A tenant configured only through "Talk it through" has NO capture channel for
 * a timezone: no onboarding extractor emits one, and the schedule proposal does
 * not populate it either. Before this gate the settings card was approvable, the
 * handler omitted the key, `tenant_settings.timezone` stayed NULL — and
 * `deriveOnboardingStatus`'s `isIdentityDone` did not ask for it, so the
 * conversation reported a finished identity step and UNLOCKED onboarding while
 * `CreateAppointmentTaskHandler` (ai/tasks/create-appointment-task.ts) converted
 * EVERY spoken booking into a `voice_clarification`, deterministically. An
 * approvable card that cannot succeed, with no error anywhere to see it by.
 *
 * The fix is CAPTURE first, GATE as the fallback, and never a default. The
 * wizard's owner does not type a zone either — their CLIENT sends the
 * browser-detected one (`BusinessIdentityInputSchema.timezone`: "the client
 * sends browser-detected tz"; IdentityStep pre-fills
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`). So the conversational
 * turn carries the same value (`TurnRequest.clientTimezone`) and onboarding
 * completes with no extra question. Only when no zone can be obtained at all
 * — a non-browser client, or one reporting a zone `Intl` does not know — does
 * the settings proposal gate and ask.
 *
 * What is never allowed is a value the SERVER made up. `PUT /identity` refuses
 * to default a zone because a wrong one silently misbooks appointments (the
 * Phoenix mis-booking postmortem; migration 263 dropped the column's
 * `DEFAULT 'America/New_York'`), and there is no safe fallback: not the
 * locale, not the area code, and not the city and state the profile extractor
 * DID capture — the fixture below is in Mesa, Arizona precisely because that
 * is the counterexample that named the postmortem. `jobBufferMinutes` may
 * default to 30 only because that is genuine parity with the wizard's own
 * pre-filled value; a zone has no equivalent.
 */
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

const SCRIPTS = {
  extract_business_profile: {
    business_name: 'Reliable Plumbing',
    // Arizona: the state whose mis-booking postmortem is the reason no code
    // path may derive a zone from a city/state pair.
    city: 'Mesa',
    state: 'AZ',
    verticals: [{ type: 'plumbing', confidence: 0.95, source_text: 'plumbing' }],
    service_descriptions: ['drain cleaning'],
    confidence_score: 0.9,
  },
  extract_categories: {
    categories: [
      { vertical_type: 'plumbing', category_id: 'repair', name: 'Repair', confidence: 0.9, source_text: 'repair' },
    ],
    confidence_score: 0.9,
  },
  // Carries an hourly rate so the INDEPENDENT hourlyRateCents gate is out of
  // the way and any gate observed below is the timezone one.
  extract_pricing: {
    prices: [
      { service_ref: 'labor', amount_cents: 12000, price_type: 'hourly_rate', confidence: 0.9, source_text: '$120 an hour' },
    ],
    confidence_score: 0.9,
  },
  extract_team: {
    members: [{ name: 'Dana', inferred_role: 'owner', confidence: 0.95, source_text: 'Dana' }],
    confidence_score: 0.9,
  },
  extract_schedule: {
    working_hours: [{ days: ['monday', 'tuesday'], start_time: '08:00', end_time: '17:00' }],
    confidence_score: 0.9,
  },
  extract_tools: {
    tools: [{ name: 'paper', confidence: 0.9, source_text: 'paper' }],
    confidence_score: 0.9,
  },
};

describe('OnboardingConversationOrchestrator — a tenant with no chosen timezone must draft GATED', () => {
  let sessionRepo: InMemoryOnboardingSessionRepository;
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    sessionRepo = new InMemoryOnboardingSessionRepository();
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  /**
   * `tenantSettings` is the tenant's EXISTING settings row, i.e. what the
   * orchestrator reads to discover an already-chosen zone. `clientTimezone`
   * is what the browser reports on each turn. Both omitted = the no-zone-
   * available case, which is the one that must gate.
   */
  async function runToCompletion(
    opts: { tenantSettings?: InMemorySettingsRepository; clientTimezone?: string } = {},
  ): Promise<string[]> {
    const orch = new OnboardingConversationOrchestrator({
      gateway: scriptedGateway(SCRIPTS),
      sessionRepo,
      proposalRepo,
      auditRepo,
      ...(opts.tenantSettings ? { settingsRepo: opts.tenantSettings } : {}),
      now: () => NOW,
    });
    const turn = (extra: { sessionId?: string; userMessage?: string }) =>
      orch.turn({
        tenantId: TENANT,
        userId: USER,
        ...(opts.clientTimezone ? { clientTimezone: opts.clientTimezone } : {}),
        ...extra,
      });
    const opened = await turn({});
    let last = opened;
    for (let i = 0; i < 14 && !last.completed; i++) {
      last = await turn({
        sessionId: opened.sessionId,
        userMessage: last.state === 'review' ? 'looks good' : `Turn ${i}`,
      });
    }
    expect(last.completed).toBe(true);
    return last.proposalIds;
  }

  async function tenantSettingsProposal(ids: string[]) {
    const proposals = await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id)));
    const settings = proposals.find((p) => p?.proposalType === 'onboarding_tenant_settings');
    expect(settings).toBeTruthy();
    return settings!;
  }

  it('a client that supplies NO zone drafts a GATED (non-approvable) tenant-settings proposal', async () => {
    const settings = await tenantSettingsProposal(await runToCompletion());

    // Everything the owner DID say is still on the card…
    expect(settings.payload.businessName).toBe('Reliable Plumbing');
    expect(settings.payload.verticalPacks).toEqual(['plumbing']);
    expect(settings.payload.hourlyRateCents).toBe(12000);
    // …and no zone is invented from "Mesa, AZ".
    expect(settings.payload.timezone).toBeUndefined();

    expect(missingFieldsFor(settings)).toEqual(['timezone']);
    await expect(
      approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner'),
    ).rejects.toThrow(/unfilled required fields/i);
  });

  it('the card ASKS for the zone rather than implying it is ready', async () => {
    const settings = await tenantSettingsProposal(await runToCompletion());
    expect(settings.summary.toLowerCase()).toContain('timezone');
  });

  it('positive control — the browser-detected zone completes onboarding with NO extra question (parity with the wizard)', async () => {
    // The normal path. The wizard's owner never types a zone either; their
    // client sends `detectBrowserTimezone()`. This is the same value, on the
    // same turn the proposals are emitted from.
    const settings = await tenantSettingsProposal(
      await runToCompletion({ clientTimezone: CHOSEN_TZ }),
    );

    expect(settings.payload.timezone).toBe(CHOSEN_TZ);
    expect(missingFieldsFor(settings)).toEqual([]);
    expect(settings.summary.toLowerCase()).not.toContain('timezone');
    const approved = await approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner');
    expect(approved.status).toBe('approved');
  });

  it('positive control — a tenant who already chose a zone is NOT gated either', async () => {
    const existing = new InMemorySettingsRepository();
    await existing.upsertIdentityFields(TENANT, { timezone: CHOSEN_TZ, bootstrapAiModel: 'test-model' });

    const settings = await tenantSettingsProposal(
      await runToCompletion({ tenantSettings: existing }),
    );

    expect(settings.payload.timezone).toBe(CHOSEN_TZ);
    expect(missingFieldsFor(settings)).toEqual([]);
    const approved = await approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner');
    expect(approved.status).toBe('approved');
  });

  it('a zone the tenant ALREADY chose beats the browser (same precedence as IdentityStep)', async () => {
    // IdentityStep hydrates its select from stored settings before falling
    // back to detection — a traveling owner’s laptop must not silently
    // re-home the business.
    const existing = new InMemorySettingsRepository();
    await existing.upsertIdentityFields(TENANT, { timezone: 'America/Phoenix', bootstrapAiModel: 'test-model' });

    const settings = await tenantSettingsProposal(
      await runToCompletion({ tenantSettings: existing, clientTimezone: 'Europe/Berlin' }),
    );

    expect(settings.payload.timezone).toBe('America/Phoenix');
  });

  it.each([
    ['a zone Intl does not know', 'Foo/Bar'],
    ['a US state name', 'Arizona'],
    ['whitespace only', '   '],
  ])('a client reporting %s is not trusted — the proposal gates and asks', async (_label, reported) => {
    const settings = await tenantSettingsProposal(
      await runToCompletion({ clientTimezone: reported }),
    );

    expect(settings.payload.timezone).toBeUndefined();
    expect(missingFieldsFor(settings)).toEqual(['timezone']);
  });

  it('a malformed zone is REFUSED at edit time — it cannot clear the gate', async () => {
    const settings = await tenantSettingsProposal(await runToCompletion());

    // `editProposal` re-validates the merged payload against
    // onboardingTenantSettingsPayloadSchema BEFORE clearing anything, and that
    // schema refines with `isRuntimeTimezone` — the SAME predicate
    // CreateAppointmentTaskHandler gates bookings on. So a zone that clears
    // this gate cannot then fail the booking gate one layer down.
    for (const bogus of ['Foo/Bar', 'Arizona', 'PHOENIX', '']) {
      await expect(
        editProposal(proposalRepo, TENANT, settings.id, USER, 'owner', { timezone: bogus }),
      ).rejects.toThrow(/Invalid payload after edit/i);
    }

    const refetched = await proposalRepo.findById(TENANT, settings.id);
    expect(missingFieldsFor(refetched!)).toEqual(['timezone']);
    await expect(
      approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner'),
    ).rejects.toThrow(/unfilled required fields/i);
  });

  it('the gate is fillable end to end: edit → gate clears → approve → execute → identity derives as DONE', async () => {
    const settings = await tenantSettingsProposal(await runToCompletion());
    expect(missingFieldsFor(settings)).toEqual(['timezone']);

    // `timezone` is a REAL flat key of the payload AND of
    // onboardingTenantSettingsPayloadSchema, which is what makes it fillable:
    // clearSatisfiedMissingFields drops a gate only when that exact flat key
    // was edited to a non-empty value. A synthetic key (`identity.timezone`)
    // would be permanently unfillable.
    await editProposal(proposalRepo, TENANT, settings.id, USER, 'owner', {
      timezone: CHOSEN_TZ,
    });

    const refetched = await proposalRepo.findById(TENANT, settings.id);
    expect(missingFieldsFor(refetched!)).toEqual([]);
    const approved = await approveProposal(proposalRepo, TENANT, settings.id, USER, 'owner');
    expect(approved.status).toBe('approved');

    const settingsRepo = new InMemorySettingsRepository();
    const handler = new OnboardingTenantSettingsExecutionHandler(
      settingsRepo,
      new InMemoryPackActivationRepository(),
      auditRepo,
    );
    const result = await handler.execute(approved, {
      tenantId: TENANT,
      executedBy: USER,
      executedByRole: 'owner',
    });
    expect(result.success).toBe(true);

    // The operator's zone reached the column, unchanged.
    const written = await settingsRepo.findByTenant(TENANT);
    expect(written?.timezone).toBe(CHOSEN_TZ);

    // …and the USER-VISIBLE outcome: the identity step closes. Asserting the
    // derived status, not merely a non-null column — column-level assertions
    // are what let the original P-6 defect through.
    const status = deriveOnboardingStatus(factsFrom({
      businessName: written?.businessName ?? null,
      businessHours: { monday: { start: '08:00', end: '17:00' } },
      jobBufferMinutes: written?.jobBufferMinutes ?? null,
      hourlyRateCents: written?.hourlyRateCents ?? null,
      timezone: written?.timezone ?? null,
    }));
    expect(status.steps.find((s) => s.id === 'identity')?.status).toBe('done');
    expect(status.currentStep).not.toBe('identity');
  });

  it('counterfactual — an ungated proposal would leave the tenant identity-INCOMPLETE and unable to book', async () => {
    // The silent failure the gate exists to prevent, spelled out: execute the
    // gated payload directly (bypassing approval) and observe BOTH halves.
    const settings = await tenantSettingsProposal(await runToCompletion());

    const settingsRepo = new InMemorySettingsRepository();
    const handler = new OnboardingTenantSettingsExecutionHandler(
      settingsRepo,
      new InMemoryPackActivationRepository(),
      auditRepo,
    );
    const result = await handler.execute(settings, {
      tenantId: TENANT,
      executedBy: USER,
      executedByRole: 'owner',
    });
    // Half one: the handler refuses loudly rather than writing a partial
    // identity, because it requires the same field the gate requires.
    expect(result.success).toBe(false);
    expect(result.error).toContain('timezone');
    expect(await settingsRepo.findByTenant(TENANT)).toBeNull();

    // Half two: even a tenant whose OTHER identity columns were somehow
    // written does not derive identity-done without a zone — so the
    // conversation can no longer unlock onboarding onto a product that
    // deterministically refuses every spoken booking.
    const status = deriveOnboardingStatus(factsFrom({
      businessName: 'Reliable Plumbing',
      businessHours: { monday: { start: '08:00', end: '17:00' } },
      jobBufferMinutes: 30,
      hourlyRateCents: 12000,
      timezone: null,
    }));
    expect(status.currentStep).toBe('identity');
    expect(status.steps.find((s) => s.id === 'identity')?.status).toBe('current');
  });
});

/** Minimal facts with everything except identity already satisfied. */
function factsFrom(identity: OnboardingFacts['identity']): OnboardingFacts {
  return {
    tenantId: TENANT,
    tenantExists: true,
    identity,
    packActivated: true,
    twilioStatus: 'full_readiness',
    subscription: { stripeSubscriptionId: 'sub_1', status: 'active' },
    inboundCallCount: 1,
    testCallSkippedAt: null,
    voiceAgentLiveAt: NOW,
    activatedAt: NOW,
    aiConfigPresent: true,
    aiVerificationStatus: 'passed',
  };
}
