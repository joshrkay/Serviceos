/**
 * END-TO-END: a spoken booking, from `tenant_settings.timezone` to the
 * `appointments` row — and, when the customer cannot be booked at all, to a
 * gate a human can actually close.
 *
 * WHY THIS FILE EXISTS, AND WHY IT LOOKS LIKE THIS
 * -----------------------------------------------
 * Two live defects, one root shape.
 *
 * 1. TIMEZONE. An operator in America/Phoenix said "Thursday at ten" and the
 *    system stored 2026-07-31T02:00:00Z — Thursday 7:00 PM Phoenix. Three
 *    hours off, every booking, and at `confidence: 1` on the autonomous lane
 *    it auto-approved and executed with no human ever seeing it. The zone
 *    came from `tenant_settings.timezone TEXT NOT NULL DEFAULT
 *    'America/New_York'`: a tenant who never chose a zone reads back a
 *    perfectly valid Eastern one, so NOTHING downstream could tell a guess
 *    from a choice.
 *
 * 2. BOOKABILITY. `jobs.location_id` is NOT NULL, so a customer with no
 *    `service_locations` row cannot have a job, therefore cannot have an
 *    appointment. That was discovered at EXECUTION time — "Customer has no
 *    service location — add one before booking a new job" — after the
 *    proposal had already auto-approved. The booking died in a log.
 *
 * Every previous fix on this path shipped green and did nothing live, because
 * each unit test hand-fed the layer under test the very value the layer was
 * dropping. So this file stubs NOTHING between the layers. It starts at the
 * settings repository and runs the real chain:
 *
 *   InMemorySettingsRepository        ← tenant_settings.timezone, the source
 *     → tenantSchedulingResolver()    ← the resolver closure app.ts builds
 *     → buildTaskHandlers()           ← the REAL registry (voice + assistant)
 *     → CreateAppointmentAITaskHandler.handle()
 *     → resolveDateTime()             ← real chrono + real Intl, no fake clock
 *     → createProposal/decideInitialStatus  ← the auto-approve gate
 *     → validateProposalPayload()     ← the contract gate
 *     → proposalSignals()             ← the assistant card allowlist
 *     → approveProposal()             ← the missingFields block
 *     → editProposal()                ← clearSatisfiedMissingFields unblock
 *     → ProposalExecutor + createExecutionHandlerRegistry()
 *     → appointments / jobs / service_locations
 *
 * A field added upstream and forgotten in any one of those layers fails here.
 *
 * ON THE DST CHOICE. The tenant zone is America/Phoenix deliberately: Arizona
 * does not observe daylight saving, so it is UTC-7 in BOTH January and July.
 * A "fix" that hardcodes a fixed UTC offset, or that applies US DST rules
 * blindly, passes in winter and fails in summer. Both months are pinned below,
 * and an Eastern control case asserts the opposite (offset DOES shift), so a
 * fixed-offset implementation cannot make this file green.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildTaskHandlers } from '../../src/ai/orchestration/handler-registry';
import { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { proposalSignals } from '../../src/routes/assistant';
import {
  InMemoryProposalRepository,
  ProposalType,
  createProposal,
} from '../../src/proposals/proposal';
import { approveProposal, editProposal } from '../../src/proposals/actions';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionHandler,
} from '../../src/proposals/execution/handlers';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

/** The model returns only the verbatim phrase; resolveDateTime does the math. */
function gatewayFor(phrase: string, confidence = 1): LLMGateway {
  return {
    complete: vi.fn(
      async () =>
        ({
          content: JSON.stringify({
            dateTimePhrase: phrase,
            summary: 'AC not cooling',
            confidence_score: confidence,
          }),
          model: 'mock-model',
          provider: 'mock',
          tokenUsage: { input: 10, output: 10, total: 20 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

/**
 * The resolver closure app.ts builds around `settingsRepo.findByTenant`, and
 * the ONLY way this file learns a timezone. Nothing hands the handler a zone
 * directly — if `tenant_settings` doesn't carry it, the booking doesn't get
 * it, which is the whole point.
 */
function schedulingResolverFor(settingsRepo: InMemorySettingsRepository) {
  return async (tenantId: string) => {
    const settings = await settingsRepo.findByTenant(tenantId);
    return { timezone: settings?.timezone, businessHours: settings?.businessHours };
  };
}

async function seedTenantTimezone(timezone?: string): Promise<InMemorySettingsRepository> {
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: '44444444-4444-4444-8444-444444444444',
    tenantId: TENANT,
    businessName: 'Kay Mechanical',
    // Omitted entirely when undefined — the "never chose a zone" state that
    // migration 263 made representable.
    ...(timezone ? { timezone } : {}),
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
  } as Parameters<InMemorySettingsRepository['create']>[0]);
  return settingsRepo;
}

interface Wiring {
  proposalRepo: InMemoryProposalRepository;
  customerRepo: InMemoryCustomerRepository;
  locationRepo: InMemoryLocationRepository;
  jobRepo: InMemoryJobRepository;
  appointmentRepo: InMemoryAppointmentRepository;
  auditRepo: InMemoryAuditRepository;
  executor: ProposalExecutor;
}

function wire(): Wiring {
  const proposalRepo = new InMemoryProposalRepository();
  const executionRepo = new InMemoryProposalExecutionRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = new InMemoryLocationRepository();
  const jobRepo = new InMemoryJobRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const auditRepo = new InMemoryAuditRepository();

  const handlers = createExecutionHandlerRegistry({
    customerRepo,
    locationRepo,
    jobRepo,
    appointmentRepo,
    auditRepo,
  }) as Map<ProposalType, ExecutionHandler>;

  const guard = new IdempotencyGuard(executionRepo, proposalRepo);
  const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
  return { proposalRepo, customerRepo, locationRepo, jobRepo, appointmentRepo, auditRepo, executor };
}

/**
 * Draft through the REAL registry — the same `buildTaskHandlers` the voice
 * worker and the assistant route both call. A dependency the registry forgets
 * to thread (which is exactly how the first cut of this fix was dead on
 * arrival) cannot be papered over by constructing the handler directly here.
 */
async function draft(opts: {
  phrase: string;
  settingsRepo: InMemorySettingsRepository;
  w: Wiring;
  customerId?: string;
  now: Date;
  confidence?: number;
}) {
  const handlers = buildTaskHandlers({
    gateway: gatewayFor(opts.phrase, opts.confidence ?? 1),
    locationRepo: opts.w.locationRepo,
    customerRepo: opts.w.customerRepo,
    appointmentRepo: opts.w.appointmentRepo,
    jobRepo: opts.w.jobRepo,
  } as Parameters<typeof buildTaskHandlers>[0]);

  const handler = handlers.get('create_appointment')!;
  const scheduling = await schedulingResolverFor(opts.settingsRepo)(TENANT);

  return handler.handle({
    tenantId: TENANT,
    userId: 'voice_agent',
    message: `Book the AC repair ${opts.phrase}`,
    now: opts.now,
    // Threaded exactly as processSegment does: present only when it resolved.
    ...(scheduling?.timezone ? { timezone: scheduling.timezone } : {}),
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
    // Autonomous + confidence 1 == the auto-approving capture lane. Any gate
    // asserted below must hold against the MOST permissive settings, not a
    // conveniently low-confidence draft.
    sourceTrustTier: 'autonomous',
  } as Parameters<typeof handler.handle>[0]);
}

// Mondays, 12:00 UTC, one in each DST regime.
const JAN_NOW = new Date('2026-01-05T12:00:00.000Z');
const JUL_NOW = new Date('2026-07-27T12:00:00.000Z');
// "tomorrow at 10am" from each, resolved independently via Intl (not by this
// implementation) before being written down here.
const PHOENIX_JAN_UTC = '2026-01-06T17:00:00.000Z'; // 10:00 MST  (UTC-7)
const PHOENIX_JUL_UTC = '2026-07-28T17:00:00.000Z'; // 10:00 MST  (UTC-7, no DST)
const EASTERN_JAN_UTC = '2026-01-06T15:00:00.000Z'; // 10:00 EST  (UTC-5)
const EASTERN_JUL_UTC = '2026-07-28T14:00:00.000Z'; // 10:00 EDT  (UTC-4)

describe('spoken booking: tenant_settings.timezone → appointments (nothing stubbed)', () => {
  it('books a Phoenix tenant at Phoenix wall-clock time in JANUARY', async () => {
    const settingsRepo = await seedTenantTimezone('America/Phoenix');
    const w = wire();
    const customerId = await seedBookableCustomer(w);

    const result = await draft({
      phrase: 'tomorrow at 10am',
      settingsRepo,
      w,
      customerId,
      now: JAN_NOW,
    });

    expect(result.taskType).toBe('create_appointment');
    const payload = result.proposal.payload as Record<string, unknown>;
    // The zone came from tenant_settings and nowhere else.
    expect(payload.timezone).toBe('America/Phoenix');
    expect(payload.scheduledStart).toBe(PHOENIX_JAN_UTC);
    // The old behaviour, pinned so a regression is unmistakable: Eastern would
    // have put this two hours earlier in UTC terms, i.e. 8:00 AM Phoenix.
    expect(payload.scheduledStart).not.toBe(EASTERN_JAN_UTC);
  });

  it('books a Phoenix tenant at Phoenix wall-clock time in JULY (Arizona has no DST)', async () => {
    const settingsRepo = await seedTenantTimezone('America/Phoenix');
    const w = wire();
    const customerId = await seedBookableCustomer(w);

    const result = await draft({
      phrase: 'tomorrow at 10am',
      settingsRepo,
      w,
      customerId,
      now: JUL_NOW,
    });

    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.timezone).toBe('America/Phoenix');
    expect(payload.scheduledStart).toBe(PHOENIX_JUL_UTC);
    // THE DST TRAP. Phoenix is UTC-7 in July exactly as in January, so this
    // must equal the January instant's clock time. An implementation that
    // "fixed" the bug with a fixed -5/-4 US-Eastern offset, or that applied
    // US DST rules to Arizona, passes the January case and dies here.
    expect(payload.scheduledStart!.toString().slice(11)).toBe(
      PHOENIX_JAN_UTC.slice(11),
    );
    expect(payload.scheduledStart).not.toBe(EASTERN_JUL_UTC);
  });

  it('control: an Eastern tenant DOES shift between January and July', async () => {
    // Proves the two assertions above can actually fail — if this harness were
    // insensitive to the zone, Phoenix's stability would be meaningless.
    const settingsRepo = await seedTenantTimezone('America/New_York');

    const jan = await draft({
      phrase: 'tomorrow at 10am',
      settingsRepo,
      w: wire(),
      customerId: undefined,
      now: JAN_NOW,
    });
    const jul = await draft({
      phrase: 'tomorrow at 10am',
      settingsRepo,
      w: wire(),
      customerId: undefined,
      now: JUL_NOW,
    });

    expect((jan.proposal.payload as Record<string, unknown>).scheduledStart).toBe(
      EASTERN_JAN_UTC,
    );
    expect((jul.proposal.payload as Record<string, unknown>).scheduledStart).toBe(
      EASTERN_JUL_UTC,
    );
    // 15:00Z vs 14:00Z — the DST shift Phoenix must NOT have.
    expect(EASTERN_JAN_UTC.slice(11)).not.toBe(EASTERN_JUL_UTC.slice(11));
  });

  it('refuses to book at all when the tenant has never chosen a timezone', async () => {
    const settingsRepo = await seedTenantTimezone(undefined);
    const w = wire();

    const result = await draft({
      phrase: 'tomorrow at 10am',
      settingsRepo,
      w,
      now: JUL_NOW,
    });

    // Not a booking at a guessed zone — a clarification aimed at the operator.
    expect(result.proposal.proposalType).toBe('voice_clarification');
    expect(result.proposal.sourceContext?.reason).toBe('tenant_timezone_unconfigured');
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.scheduledStart).toBeUndefined();
    // Nothing spoken is lost — the transcript rides through verbatim.
    expect(payload.transcript).toBe('Book the AC repair tomorrow at 10am');
    // And it cannot auto-approve, even from the autonomous lane at confidence 1.
    expect(result.proposal.status).toBe('draft');
  });
});

const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';

/** A customer WITH a service location — Mario, who booked successfully. */
async function seedBookableCustomer(w: Wiring): Promise<string> {
  const id = await seedCustomer(w, 'Mario Delingo');
  await w.locationRepo.create({
    id: '66666666-6666-4666-8666-666666666666',
    tenantId: TENANT,
    customerId: id,
    street1: '410 Sunfield Way',
    city: 'Scottsdale',
    state: 'AZ',
    postalCode: '85254',
    country: 'US',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Parameters<InMemoryLocationRepository['create']>[0]);
  return id;
}

/**
 * A customer with NO service_locations row. This is Jimmy Hartlett (approved
 * without completing the address) and Ashia Aksuna (created before the address
 * fix) — the two live failures. The spoken address survives only as a note on
 * `communication_notes`, exactly as CreateCustomerExecutionHandler leaves it.
 */
async function seedUnbookableCustomer(w: Wiring, notes?: string): Promise<string> {
  return seedCustomer(w, 'Jimmy Hartlett', notes);
}

async function seedCustomer(w: Wiring, displayName: string, notes?: string): Promise<string> {
  const [firstName, lastName] = displayName.split(' ');
  const id = displayName.startsWith('Jimmy') ? CUSTOMER_ID : '77777777-7777-4777-8777-777777777777';
  await w.customerRepo.create({
    id,
    tenantId: TENANT,
    firstName,
    lastName,
    displayName,
    preferredChannel: 'phone',
    smsConsent: false,
    ...(notes ? { communicationNotes: notes } : {}),
    isArchived: false,
    createdBy: 'voice_agent',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Parameters<InMemoryCustomerRepository['create']>[0]);
  return id;
}

describe('a customer with no service_locations row (nothing stubbed)', () => {
  // The note CreateCustomerExecutionHandler writes when a spoken address is
  // too incomplete to become a service_location. Matched verbatim against the
  // producer's format so the two stay coupled.
  const PRESERVED_NOTE =
    'Address from voice: "1207 Riverbell Drive". Saved as a note, not a service ' +
    'location — still needs city, state, ZIP.';

  it('gates at DRAFT time instead of auto-approving into an execution failure', async () => {
    const settingsRepo = await seedTenantTimezone('America/Phoenix');
    const w = wire();
    const customerId = await seedUnbookableCustomer(w, PRESERVED_NOTE);

    const result = await draft({
      phrase: 'tomorrow at 10am',
      settingsRepo,
      w,
      customerId,
      now: JUL_NOW,
      confidence: 1,
    });

    // Still a real booking proposal — the time resolved fine, the CUSTOMER is
    // the problem, and the operator is told which.
    expect(result.proposal.proposalType).toBe('create_appointment');
    expect((result.proposal.payload as Record<string, unknown>).scheduledStart).toBe(
      PHOENIX_JUL_UTC,
    );

    // THE GATE. Confidence 1 on the autonomous capture lane is the most
    // auto-approve-favourable input there is; before this fix it produced
    // status 'approved' and a doomed execution.
    expect(result.proposal.status).toBe('draft');
    const missing = (result.proposal.sourceContext as Record<string, unknown>)
      ?.missingFields as string[];
    expect(missing).toEqual(['locationId']);
  });

  it('carries the preserved address through the card serializer so a human can close it', async () => {
    const settingsRepo = await seedTenantTimezone('America/Phoenix');
    const w = wire();
    const customerId = await seedUnbookableCustomer(w, PRESERVED_NOTE);

    const result = await draft({
      phrase: 'tomorrow at 10am',
      settingsRepo,
      w,
      customerId,
      now: JUL_NOW,
    });

    // `proposalSignals` rebuilds its output from an allowlist — the exact
    // shape of layer that silently dropped a field five times on this
    // codebase. A gate whose address does not survive HERE is a dead end:
    // the operator sees "locationId" and has no idea which address was meant.
    const signals = proposalSignals(
      result.proposal.payload as Record<string, unknown>,
      result.proposal.sourceContext as Record<string, unknown>,
    );
    expect(signals.missingFields).toEqual(['locationId']);
    expect(signals.serviceLocationGap).toBeDefined();
    expect(signals.serviceLocationGap!.customerId).toBe(customerId);
    expect(signals.serviceLocationGap!.recoveredAddress).toBe('1207 Riverbell Drive');
    expect(signals.serviceLocationGap!.recoveredFrom).toBe('communication_notes');
    // And it tells the card which boxes still need filling.
    expect(signals.serviceLocationGap!.stillMissing).toEqual(['city', 'state', 'postalCode']);
  });

  it('blocks approval until a location is supplied, then books end-to-end', async () => {
    const settingsRepo = await seedTenantTimezone('America/Phoenix');
    const w = wire();
    const customerId = await seedUnbookableCustomer(w, PRESERVED_NOTE);

    const result = await draft({
      phrase: 'tomorrow at 10am',
      settingsRepo,
      w,
      customerId,
      now: JUL_NOW,
    });
    await w.proposalRepo.create(result.proposal);

    // The contract gate accepts the drafted payload as-is.
    expect(validateProposalPayload('create_appointment', result.proposal.payload).valid).toBe(
      true,
    );

    // Approving now is refused — in front of a human, not in an execution log.
    await expect(
      approveProposal(w.proposalRepo, TENANT, result.proposal.id, APPROVER, 'owner', w.auditRepo),
    ).rejects.toThrow(/locationId/);

    // The operator completes the address the card showed them. This is the
    // real locations repository, the same one the executor reads.
    const created = await w.locationRepo.create({
      id: '88888888-8888-4888-8888-888888888888',
      tenantId: TENANT,
      customerId,
      street1: '1207 Riverbell Drive',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
      country: 'US',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Parameters<InMemoryLocationRepository['create']>[0]);

    // …and picks it on the proposal, through the REAL edit action, which is
    // what lifts the gate (clearSatisfiedMissingFields).
    const { editedFields } = await editProposal(
      w.proposalRepo,
      TENANT,
      result.proposal.id,
      APPROVER,
      'owner',
      { locationId: created.id },
    );
    expect(editedFields).toEqual(['locationId']);

    const unblocked = await w.proposalRepo.findById(TENANT, result.proposal.id);
    expect(
      (unblocked!.sourceContext as Record<string, unknown>)?.missingFields ?? [],
    ).toEqual([]);

    // Approve → execute, for real.
    let approved = transitionProposal(unblocked!, 'ready_for_review', APPROVER);
    approved = transitionProposal(approved, 'approved', APPROVER);
    approved = { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await w.proposalRepo.update(TENANT, result.proposal.id, approved);

    const { result: exec } = await w.executor.execute(approved, {
      tenantId: TENANT,
      executedBy: APPROVER,
    });

    // The customer who could not be booked is now booked — no hand-edited
    // database row anywhere in this test.
    expect(exec.success).toBe(true);
    const appointment = await w.appointmentRepo.findById(TENANT, exec.resultEntityId!);
    expect(appointment).toBeTruthy();
    expect(appointment!.timezone).toBe('America/Phoenix');
    expect(appointment!.scheduledStart.toISOString()).toBe(PHOENIX_JUL_UTC);

    // The auto-opened job is sited at the location the operator supplied.
    const job = await w.jobRepo.findById(TENANT, appointment!.jobId);
    expect(job!.locationId).toBe(created.id);
  });

  it('recovers the address from the transcript when nothing was preserved on the customer', async () => {
    // Ashia's case: created before the address fix, so communication_notes is
    // empty. The utterance booking her now is the last place an address lives.
    const settingsRepo = await seedTenantTimezone('America/Phoenix');
    const w = wire();
    const customerId = await seedUnbookableCustomer(w, undefined);

    const handlers = buildTaskHandlers({
      gateway: gatewayFor('tomorrow at 10am', 1),
      locationRepo: w.locationRepo,
      customerRepo: w.customerRepo,
      appointmentRepo: w.appointmentRepo,
      jobRepo: w.jobRepo,
    } as Parameters<typeof buildTaskHandlers>[0]);
    const scheduling = await schedulingResolverFor(settingsRepo)(TENANT);

    const result = await handlers.get('create_appointment')!.handle({
      tenantId: TENANT,
      userId: 'voice_agent',
      message: "Book Ashia at 1207 Riverbell Drive tomorrow at 10am",
      now: JUL_NOW,
      timezone: scheduling!.timezone!,
      customerId,
      sourceTrustTier: 'autonomous',
    } as never);

    const gap = (result.proposal.sourceContext as Record<string, unknown>)
      ?.serviceLocationGap as Record<string, unknown> | undefined;
    expect(gap).toBeDefined();
    expect(gap!.recoveredFrom).toBe('transcript');
    expect(String(gap!.recoveredAddress)).toContain('1207 Riverbell Drive');
  });
});
