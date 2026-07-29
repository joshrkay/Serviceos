import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OnboardingTeamMemberExecutionHandler,
  OnboardingScheduleExecutionHandler,
  OnboardingTenantSettingsExecutionHandler,
  OnboardingServiceCategoryExecutionHandler,
  OnboardingEstimateTemplateExecutionHandler,
} from '../../src/proposals/execution/onboarding-handlers';
import { activatePackWithSeed } from '../../src/onboarding/activate-pack-with-seed';
import { createTemplate } from '../../src/templates/estimate-template';
import type { ExecutionContext } from '../../src/proposals/execution/handlers';
import type { Proposal, ProposalType } from '../../src/proposals/proposal';

// These two are the shared write paths the form wizard's own routes call.
// Mocking them is the point: the property under test is that the spoken path
// REACHES them, rather than growing a parallel implementation beside them.
vi.mock('../../src/onboarding/activate-pack-with-seed', () => ({
  activatePackWithSeed: vi.fn().mockResolvedValue({ status: 'activated' }),
}));
vi.mock('../../src/templates/estimate-template', () => ({
  createTemplate: vi.fn().mockResolvedValue({ id: 'tpl_1' }),
}));

const TENANT = '11111111-1111-1111-1111-111111111111';

// The two module mocks above are shared across every case, so call history has
// to be dropped between them or a "never called" assertion passes on stale
// calls from an earlier test.
beforeEach(() => {
  vi.clearAllMocks();
});

const context: ExecutionContext = {
  tenantId: TENANT,
  executedBy: 'user_owner',
  executedByRole: 'owner',
};

function auditRepoStub() {
  return { create: vi.fn().mockResolvedValue(undefined) } as never;
}

function proposalOf(proposalType: ProposalType, payload: Record<string, unknown>): Proposal {
  return {
    id: 'prop_1',
    tenantId: TENANT,
    proposalType,
    status: 'approved',
    payload,
    summary: 'test proposal',
  } as Proposal;
}

describe('OnboardingTeamMemberExecutionHandler', () => {
  const invitation = {
    id: 'inv_1',
    tenantId: TENANT,
    email: 'carlos@example.com',
    role: 'technician' as const,
    invitedBy: 'user_owner',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-15T00:00:00Z'),
  };
  let invitationRepo: { create: ReturnType<typeof vi.fn> };
  let auditRepo: { create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    invitationRepo = { create: vi.fn().mockResolvedValue(invitation) };
    auditRepo = { create: vi.fn().mockResolvedValue(undefined) };
  });

  const payload = { name: 'Carlos', role: 'technician', email: 'carlos@example.com' };

  it('sends the Clerk invitation, not just a local row', async () => {
    const clerkFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'clerk_inv_9' }),
    });
    const handler = new OnboardingTeamMemberExecutionHandler(
      invitationRepo as never,
      auditRepo as never,
      { clerkSecretKey: 'sk_test', clerkFetch: clerkFetch as never, appBaseUrl: 'https://app.test' },
    );

    const result = await handler.execute(proposalOf('onboarding_team_member', payload), context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('inv_1');
    expect(clerkFetch).toHaveBeenCalledTimes(1);
    const [url, init] = clerkFetch.mock.calls[0];
    expect(url).toBe('https://api.clerk.com/v1/invitations');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.email_address).toBe('carlos@example.com');
    // The webhook joins the accepted sign-up back to the local row by this id.
    expect(body.public_metadata).toMatchObject({
      invitation_id: 'inv_1',
      tenant_id: TENANT,
      role: 'technician',
    });
    expect(body.redirect_url).toContain('https://app.test/accept-invitation');
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'user.invitation_created',
        metadata: expect.objectContaining({ clerkInvitationId: 'clerk_inv_9' }),
      }),
    );
  });

  it('keeps the local row and reports an unsent invitation when Clerk fails', async () => {
    const clerkFetch = vi.fn().mockRejectedValue(new Error('clerk unreachable'));
    const handler = new OnboardingTeamMemberExecutionHandler(
      invitationRepo as never,
      auditRepo as never,
      { clerkSecretKey: 'sk_test', clerkFetch: clerkFetch as never },
    );

    const result = await handler.execute(proposalOf('onboarding_team_member', payload), context);

    expect(result.success).toBe(true);
    expect(invitationRepo.create).toHaveBeenCalledTimes(1);
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ clerkInvitationId: null }),
      }),
    );
  });

  // Raised in PR review: issuing the invitation made this handler perform
  // synchronous network I/O, so it must declare it. Otherwise the executor
  // takes its DB-only path and holds the advisory lock and a pooled
  // connection across the Clerk round-trip — and a later rollback erases the
  // local row while Clerk has already sent the email.
  it('declares external I/O so the executor runs it outside the transaction', () => {
    const handler = new OnboardingTeamMemberExecutionHandler(
      invitationRepo as never,
      auditRepo as never,
    );

    expect(handler.performsExternalIo).toBe(true);
  });

  it('refuses without an email rather than inventing an address', async () => {
    const handler = new OnboardingTeamMemberExecutionHandler(
      invitationRepo as never,
      auditRepo as never,
    );

    const result = await handler.execute(
      proposalOf('onboarding_team_member', { name: 'Carlos', role: 'technician' }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('email');
    expect(invitationRepo.create).not.toHaveBeenCalled();
  });
});

describe('OnboardingScheduleExecutionHandler', () => {
  let settingsRepo: { upsertIdentityFields: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    settingsRepo = { upsertIdentityFields: vi.fn().mockResolvedValue(undefined) };
  });

  function handler() {
    return new OnboardingScheduleExecutionHandler(settingsRepo as never, auditRepoStub());
  }

  it('persists well-formed hours', async () => {
    const result = await handler().execute(
      proposalOf('onboarding_schedule', {
        workingHours: [{ days: ['monday', 'tuesday'], startTime: '08:00', endTime: '17:00' }],
      }),
      context,
    );

    expect(result.success).toBe(true);
    expect(settingsRepo.upsertIdentityFields).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        businessHours: { mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' } },
      }),
    );
  });

  // `dayWindowFor` reads a malformed or open>=close entry as CLOSED, so
  // persisting one silently makes the business unbookable that day.
  it.each([
    ['non-HH:MM start', '9am', '17:00'],
    ['unpadded hour', '8:00', '17:00'],
    ['hour out of range', '25:00', '26:00'],
    ['close before open', '17:00', '08:00'],
    ['close equal to open', '09:00', '09:00'],
  ])('refuses %s instead of persisting a day that reads as closed', async (_label, start, end) => {
    const result = await handler().execute(
      proposalOf('onboarding_schedule', {
        workingHours: [{ days: ['monday'], startTime: start, endTime: end }],
      }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('MALFORMED_HOURS');
    expect(settingsRepo.upsertIdentityFields).not.toHaveBeenCalled();
  });

  it('refuses the whole proposal rather than dropping the bad day', async () => {
    const result = await handler().execute(
      proposalOf('onboarding_schedule', {
        workingHours: [
          { days: ['monday'], startTime: '08:00', endTime: '17:00' },
          { days: ['tuesday'], startTime: 'noon', endTime: '17:00' },
        ],
      }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('tue');
    expect(settingsRepo.upsertIdentityFields).not.toHaveBeenCalled();
  });
});

describe('OnboardingTenantSettingsExecutionHandler', () => {
  let settingsRepo: { upsertIdentityFields: ReturnType<typeof vi.fn> };
  const packRepo = {} as never;

  beforeEach(() => {
    vi.mocked(activatePackWithSeed).mockResolvedValue({ status: 'activated' } as never);
    settingsRepo = { upsertIdentityFields: vi.fn().mockResolvedValue(undefined) };
  });

  function handler(audit = auditRepoStub()) {
    return new OnboardingTenantSettingsExecutionHandler(settingsRepo as never, packRepo, audit);
  }

  // The shape of an APPROVABLE payload: the timezone gate
  // (tenant-settings-proposer.ts) has been filled by the operator, so every
  // proposal that reaches this handler carries one.
  const base = {
    businessName: 'Acme Plumbing',
    verticalPacks: ['plumbing'],
    timezone: 'America/Phoenix',
  };

  it('writes identity fields and activates each spoken pack', async () => {
    const result = await handler().execute(
      proposalOf('onboarding_tenant_settings', {
        ...base,
        city: 'Austin',
        state: 'TX',
        verticalPacks: ['plumbing', 'hvac'],
      }),
      context,
    );

    expect(result.success).toBe(true);
    expect(settingsRepo.upsertIdentityFields).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        businessName: 'Acme Plumbing',
        serviceAreaText: 'Austin, TX',
        // The same default IdentityStep pre-fills, so a silent form user and a
        // silent conversation user land on the identical column value.
        jobBufferMinutes: 30,
        // The operator-supplied zone reaches the SAME column PUT /identity
        // writes. Without it the tenant derives identity-done but every spoken
        // booking gates as a timezone clarification.
        timezone: 'America/Phoenix',
      }),
    );
    expect(activatePackWithSeed).toHaveBeenCalledTimes(2);
  });

  // Still "never writes a timezone it was not told" — the refusal is just
  // LOUD now instead of a silent omission. A silent omission left
  // tenant_settings.timezone NULL while the proposal reported success, and
  // CreateAppointmentTaskHandler then refused every spoken booking. There is
  // no safe fallback zone (Phoenix mis-booking postmortem, migration 263), so
  // the only correct behaviours are "refuse" or "be told" — never "default".
  it('refuses, and writes nothing at all, when it was not told a timezone', async () => {
    const { timezone: _omitted, ...noTimezone } = base;
    const result = await handler().execute(
      proposalOf('onboarding_tenant_settings', noTimezone),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timezone');
    expect(settingsRepo.upsertIdentityFields).not.toHaveBeenCalled();
  });

  it.each([
    ['a bogus zone', 'Foo/Bar'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a non-string', 42],
  ])('refuses %s as a timezone rather than writing it', async (_label, tz) => {
    const result = await handler().execute(
      proposalOf('onboarding_tenant_settings', { ...base, timezone: tz }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timezone');
    expect(settingsRepo.upsertIdentityFields).not.toHaveBeenCalled();
  });

  it('trims a padded zone so the stored value is one isRuntimeTimezone accepts', async () => {
    const result = await handler().execute(
      proposalOf('onboarding_tenant_settings', { ...base, timezone: '  America/Phoenix  ' }),
      context,
    );

    expect(result.success).toBe(true);
    expect(settingsRepo.upsertIdentityFields).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ timezone: 'America/Phoenix' }),
    );
  });

  // A wrong hourly rate is a money defect, so an absent one is left untouched
  // rather than defaulted — unlike jobBufferMinutes.
  it('omits hourlyRateCents when the conversation never captured one', async () => {
    await handler().execute(proposalOf('onboarding_tenant_settings', base), context);

    const [, fields] = settingsRepo.upsertIdentityFields.mock.calls[0];
    expect(fields).not.toHaveProperty('hourlyRateCents');
  });

  it.each([
    ['a float', 12550.5],
    ['a negative', -100],
    ['a string', '12550'],
  ])('refuses %s hourlyRateCents rather than writing it', async (_label, rate) => {
    const result = await handler().execute(
      proposalOf('onboarding_tenant_settings', { ...base, hourlyRateCents: rate }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('hourlyRateCents');
    expect(settingsRepo.upsertIdentityFields).not.toHaveBeenCalled();
  });

  it('passes an integer-cents rate through', async () => {
    const result = await handler().execute(
      proposalOf('onboarding_tenant_settings', { ...base, hourlyRateCents: 12550 }),
      context,
    );

    expect(result.success).toBe(true);
    expect(settingsRepo.upsertIdentityFields).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ hourlyRateCents: 12550 }),
    );
  });

  it.each([
    ['no businessName', { verticalPacks: ['plumbing'] }, 'businessName'],
    ['no packs', { businessName: 'Acme', verticalPacks: [] }, 'verticalPacks'],
    ['an unknown pack', { businessName: 'Acme', verticalPacks: ['underwater-basketweaving'] }, 'verticalPacks'],
  ])('refuses a payload with %s', async (_label, payload, expected) => {
    const result = await handler().execute(
      proposalOf('onboarding_tenant_settings', payload as Record<string, unknown>),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(expected);
    expect(settingsRepo.upsertIdentityFields).not.toHaveBeenCalled();
  });

  it('stamps the approver’s real role on the audit event', async () => {
    const audit = { create: vi.fn().mockResolvedValue(undefined) };
    await new OnboardingTenantSettingsExecutionHandler(
      settingsRepo as never,
      packRepo,
      audit as never,
    ).execute(proposalOf('onboarding_tenant_settings', base), {
      ...context,
      executedByRole: 'dispatcher',
    });

    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'tenant.identity_set', actorRole: 'dispatcher' }),
    );
  });

  it('surfaces a locked pack activation instead of reporting success', async () => {
    vi.mocked(activatePackWithSeed).mockResolvedValue({ status: 'locked' } as never);

    const result = await handler().execute(proposalOf('onboarding_tenant_settings', base), context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('PACK_ACTIVATION_IN_PROGRESS');
  });

  it('refuses rather than half-configuring the tenant when a repo is missing', async () => {
    const unwired = new OnboardingTenantSettingsExecutionHandler(
      undefined,
      packRepo,
      auditRepoStub(),
    );

    expect(unwired.isFullyWired()).toBe(false);
    const result = await unwired.execute(proposalOf('onboarding_tenant_settings', base), context);
    expect(result.success).toBe(false);
    expect(result.error).toBe('handler_not_wired:settingsRepo');
  });
});

describe('OnboardingServiceCategoryExecutionHandler', () => {
  beforeEach(() => {
    vi.mocked(activatePackWithSeed).mockResolvedValue({ status: 'activated' } as never);
  });

  function handler() {
    return new OnboardingServiceCategoryExecutionHandler(
      {} as never,
      {} as never,
      auditRepoStub(),
    );
  }

  const payload = { verticalType: 'plumbing', categoryId: 'drain-cleaning', displayName: 'Drains' };

  it('activates the category’s vertical pack', async () => {
    const result = await handler().execute(
      proposalOf('onboarding_service_category', payload),
      context,
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('plumbing');
    expect(activatePackWithSeed).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, packId: 'plumbing' }),
      expect.anything(),
    );
  });

  it.each([
    ['an unknown verticalType', { ...payload, verticalType: 'nope' }, 'verticalType'],
    ['no categoryId', { verticalType: 'plumbing', displayName: 'Drains' }, 'categoryId'],
  ])('refuses a payload with %s', async (_label, bad, expected) => {
    const result = await handler().execute(
      proposalOf('onboarding_service_category', bad as Record<string, unknown>),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(expected);
    expect(activatePackWithSeed).not.toHaveBeenCalled();
  });
});

describe('OnboardingEstimateTemplateExecutionHandler', () => {
  let templateRepo: Record<string, unknown>;

  beforeEach(() => {
    vi.mocked(createTemplate).mockResolvedValue({ id: 'tpl_1' } as never);
    templateRepo = {};
  });

  function handler(audit = auditRepoStub()) {
    return new OnboardingEstimateTemplateExecutionHandler(templateRepo as never, audit);
  }

  const payload = {
    verticalType: 'plumbing',
    categoryId: 'drain-cleaning',
    templateName: 'Standard drain clear',
    lineItems: [{ description: 'Labor', defaultUnitPriceCents: 15000, category: 'labor' }],
  };

  it('creates the template through the same domain function the templates route uses', async () => {
    const result = await handler().execute(
      proposalOf('onboarding_estimate_template', payload),
      context,
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('tpl_1');
    const [input] = vi.mocked(createTemplate).mock.calls[0];
    expect(input).toMatchObject({
      tenantId: TENANT,
      verticalType: 'plumbing',
      name: 'Standard drain clear',
    });
    expect(input.lineItemTemplates).toEqual([
      expect.objectContaining({ description: 'Labor', defaultUnitPriceCents: 15000, category: 'labor' }),
    ]);
  });

  it('stamps the approver’s real role rather than asserting owner', async () => {
    await handler().execute(proposalOf('onboarding_estimate_template', payload), {
      ...context,
      executedByRole: 'dispatcher',
    });

    expect(vi.mocked(createTemplate).mock.calls[0][3]).toBe('dispatcher');
  });

  it('defaults an unrecognized category to other and quantity to 1', async () => {
    await handler().execute(
      proposalOf('onboarding_estimate_template', {
        ...payload,
        lineItems: [{ description: 'Mystery', defaultUnitPriceCents: 100, category: 'sorcery' }],
      }),
      context,
    );

    expect(vi.mocked(createTemplate).mock.calls[0][0].lineItemTemplates[0]).toMatchObject({
      category: 'other',
      defaultQuantity: 1,
    });
  });

  it.each([
    ['a float price', 150.5],
    ['a negative price', -1],
    ['a string price', '15000'],
  ])('refuses %s rather than persisting it', async (_label, price) => {
    const result = await handler().execute(
      proposalOf('onboarding_estimate_template', {
        ...payload,
        lineItems: [{ description: 'Labor', defaultUnitPriceCents: price }],
      }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('defaultUnitPriceCents');
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it.each([
    ['no line items', { ...payload, lineItems: [] }, 'line item'],
    ['a line item with no description', { ...payload, lineItems: [{ defaultUnitPriceCents: 1 }] }, 'description'],
    ['no templateName', { verticalType: 'plumbing', categoryId: 'c', lineItems: payload.lineItems }, 'templateName'],
  ])('refuses a payload with %s', async (_label, bad, expected) => {
    const result = await handler().execute(
      proposalOf('onboarding_estimate_template', bad as Record<string, unknown>),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(expected);
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it('refuses when the template repo is not wired', async () => {
    const unwired = new OnboardingEstimateTemplateExecutionHandler(undefined, auditRepoStub());

    expect(unwired.isFullyWired()).toBe(false);
    const result = await unwired.execute(
      proposalOf('onboarding_estimate_template', payload),
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('handler_not_wired:templateRepo');
  });
});
