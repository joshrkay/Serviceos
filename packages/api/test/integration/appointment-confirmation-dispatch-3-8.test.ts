/**
 * Docker-gated integration test — PRD v5 §8.3 row 3.8, "customer confirmation
 * on approval", at real Postgres.
 *
 * ROW CRITERION: "Given an approved `create_appointment`, when it executes,
 * then an `appointment_confirmation` dispatch row is written."
 *
 * WHAT THE G1 AUDIT SAID: "the only live instantiation is a no-op notifier;
 * `AppointmentConfirmationNotifier` is never constructed."
 *
 * WHAT THE CODE ACTUALLY SAYS (read 2026-09-12, and pinned below):
 *  - `AppointmentConfirmationNotifier`
 *    (src/notifications/appointment-confirmation-notifier.ts:37) is indeed
 *    dead: `grep -rn AppointmentConfirmationNotifier packages/api/src` has
 *    exactly one hit, its own definition. Nothing in `src/` constructs it.
 *  - But it is NOT the only implementation of `SchedulingConfirmationNotifier`.
 *    `TransactionalCommsService`
 *    (src/notifications/transactional-comms-service.ts:95) implements the same
 *    interface, its `enqueue()` (line 98) writes the
 *    `appointment_confirmation` dispatch row, and app.ts:1910 wires it into
 *    the execution registry as `schedulingNotifier`.
 *  - The no-op (`NoopSchedulingConfirmationNotifier`,
 *    src/proposals/execution/scheduling-notifications.ts:18) is the
 *    CreateAppointmentExecutionHandler constructor DEFAULT
 *    (src/proposals/execution/handlers.ts:381). It takes effect only when
 *    `deps.schedulingNotifier` is undefined — which happens only when
 *    `messageDelivery` is null (app.ts:1770), i.e. delivery mode `'none'`:
 *    prod/staging with no Twilio and no SendGrid credentials
 *    (src/notifications/delivery-provider-factory.ts:163-176).
 *
 * So the row's failure is real but narrower than "always a no-op": it is
 * conditional on the boot-time delivery wiring, and nothing records the
 * omission when it happens. These tests pin BOTH wirings at real Postgres and
 * leave the one desired-state assertion as the single `it.fails`.
 *
 * Table under test: `message_dispatches` (src/notifications/dispatch-repository.ts:188),
 * written through `PgDispatchRepository` (same file, line 178).
 *
 * Run: cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *   --config vitest.integration.config.ts --reporter=verbose \
 *   test/integration/appointment-confirmation-dispatch-3-8.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import {
  InMemoryDeliveryProvider,
  type MessageDeliveryProvider,
} from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgConsentEventRepository } from '../../src/compliance/consent-events';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';
import { AppointmentConfirmationNotifier } from '../../src/notifications/appointment-confirmation-notifier';
import type { SchedulingConfirmationNotifier } from '../../src/proposals/execution/scheduling-notifications';
import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

interface SeededTenant {
  tenant: TestTenant;
  customerId: string;
  jobId: string;
  phone: string;
  email: string;
}

describe('Postgres integration — §8.3 row 3.8 customer confirmation on approval', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let dispatchRepo: PgDispatchRepository;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  async function seedTenant(
    label: string,
    contact: { phone?: boolean; email?: boolean } = { phone: true, email: true },
  ): Promise<SeededTenant> {
    const tenant = await createTestTenant(pool);
    const customerId = crypto.randomUUID();
    const phone = `+1602555${Math.floor(1000 + Math.random() * 8999)}`;
    const email = `${label.toLowerCase()}-${customerId.slice(0, 8)}@example.com`;
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: label,
      lastName: 'Customer',
      displayName: `${label} Customer`,
      ...(contact.phone === false ? {} : { primaryPhone: phone }),
      ...(contact.email === false ? {} : { email }),
      preferredChannel: 'sms',
      // The GatedMessageDelivery consent gate IS in play (see gatedDelivery()
      // below — the tests wrap the provider exactly as app.ts:1328 does, in the
      // strictest 'block' mode), and it reads this stored flag. A consenting
      // customer is the case these rows are about; the gate's own suppression
      // behaviour is proven in customer-message-delivery.test.ts.
      smsConsent: true,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Confirmation Way',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
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
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: `${label} furnace tune-up`,
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { tenant, customerId, jobId, phone, email };
  }

  /**
   * Executes an approved `create_appointment` through the PRODUCTION
   * execution registry (`createExecutionHandlerRegistry`) + `ProposalExecutor`,
   * threading `schedulingNotifier` exactly as app.ts:1910 does.
   *
   * `schedulingNotifier: undefined` reproduces app.ts's `messageDelivery === null`
   * boot (delivery mode 'none'), where the handler falls back to its
   * `NoopSchedulingConfirmationNotifier` default.
   */
  async function executeApprovedCreateAppointment(
    seeded: SeededTenant,
    schedulingNotifier: SchedulingConfirmationNotifier | undefined,
  ): Promise<string> {
    const registry = createExecutionHandlerRegistry({
      appointmentRepo,
      jobRepo,
      customerRepo,
      locationRepo,
      settingsRepo,
      auditRepo,
      dispatchRepo,
      schedulingNotifier,
    });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const input: CreateProposalInput = {
      tenantId: seeded.tenant.tenantId,
      proposalType: 'create_appointment',
      payload: {
        jobId: seeded.jobId,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        timezone: 'America/Phoenix',
        summary: 'Furnace tune-up',
      },
      summary: 'Book the furnace tune-up',
      createdBy: seeded.tenant.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', seeded.tenant.userId);
    proposal = transitionProposal(proposal, 'approved', seeded.tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const context: ExecutionContext = {
      tenantId: seeded.tenant.tenantId,
      executedBy: seeded.tenant.userId,
    };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    return result.resultEntityId as string;
  }

  /** Raw read of the confirmation dispatch rows this tenant owns. */
  async function confirmationRows(
    tenantId: string,
    appointmentId?: string,
  ): Promise<
    Array<{ id: string; channel: string; recipient: string; entity_id: string; provider: string }>
  > {
    const { rows } = await pool.query(
      `SELECT id, channel, recipient, entity_id, provider
         FROM message_dispatches
        WHERE tenant_id = $1
          AND entity_type = 'appointment_confirmation'
          ${appointmentId ? 'AND entity_id = $2' : ''}
        ORDER BY channel`,
      appointmentId ? [tenantId, appointmentId] : [tenantId],
    );
    return rows;
  }

  /**
   * The delivery object app.ts actually hands to `TransactionalCommsService`:
   * the selected provider wrapped in `GatedMessageDelivery` (app.ts:1328-1335),
   * with the same five deps — the Pg DNC lookup, the audit repo, the
   * `TCPA_CONSENT_ENFORCEMENT` mode, and the Pg consent ledger. Passing the raw
   * provider would make every send unconditionally succeed, which is not what
   * the production path does: consent, DNC and the kill switches all sit in
   * this wrapper.
   *
   * `enforcement: 'block'` is deliberately the STRICTEST mode — what
   * `shared/config.ts:210-217` resolves to in prod/staging — so these rows are
   * proven against the gate production actually runs, not a permissive one.
   */
  function gatedDelivery(base: MessageDeliveryProvider = new InMemoryDeliveryProvider()): GatedMessageDelivery {
    return new GatedMessageDelivery({
      base,
      dnc: new PgDncRepository(pool),
      auditRepo,
      enforcement: 'block',
      consentLedger: new PgConsentEventRepository(pool),
      // `GatedMessageDeliveryDeps.env` defaults to `process.env`
      // (gated-message-delivery.ts:190), and the kill switches are read per
      // send (`isOutboundChannelEnabled`, line 112). Left to default, a shell
      // or CI job exporting TELEPHONY_ENABLED=false or EMAIL_ENABLED=false
      // would suppress the send and fail the POSITIVE assertions below — the
      // rows would look unwritten for a reason that has nothing to do with
      // this row. Both channels are pinned on explicitly so these cases are
      // about the confirmation path and nothing else. The kill switches'
      // own behaviour is covered in killswitch-production-config.test.ts.
      env: { ...process.env, TELEPHONY_ENABLED: 'true', EMAIL_ENABLED: 'true' },
    });
  }

  function liveTransactionalComms(
    base: MessageDeliveryProvider = new InMemoryDeliveryProvider(),
  ): TransactionalCommsService {
    // The construction app.ts:1771 performs whenever `messageDelivery` is
    // non-null. `invoiceRepo` is only reached by the overdue-reminder path,
    // which this row never touches, so it is stubbed rather than wired.
    return new TransactionalCommsService({
      delivery: gatedDelivery(base),
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoiceRepo: {} as any,
      dispatchRepo,
      pool,
      logger,
    });
  }

  function dormantNotifier(): AppointmentConfirmationNotifier {
    // The construction app.ts would have to perform to make
    // `AppointmentConfirmationNotifier` live — the same six deps its
    // `AppointmentConfirmationNotifierDeps` declares
    // (src/notifications/appointment-confirmation-notifier.ts:12).
    return new AppointmentConfirmationNotifier({
      delivery: gatedDelivery(),
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo,
    });
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
    tenantA = await seedTenant('Alpha');
    tenantB = await seedTenant('Bravo');
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('CURRENT: with no delivery provider (app.ts mode "none"), an approved create_appointment writes the appointment but NO appointment_confirmation dispatch row', async () => {
    const appointmentId = await executeApprovedCreateAppointment(tenantA, undefined);

    const appointment = await appointmentRepo.findById(tenantA.tenant.tenantId, appointmentId);
    expect(appointment).not.toBeNull();

    const rows = await confirmationRows(tenantA.tenant.tenantId, appointmentId);
    expect(rows).toHaveLength(0);

    // …and nothing else records the omission either: no dispatch row of ANY
    // entity type exists for this appointment.
    const { rows: anyDispatch } = await pool.query(
      `SELECT entity_type FROM message_dispatches WHERE tenant_id = $1 AND entity_id = $2`,
      [tenantA.tenant.tenantId, appointmentId],
    );
    expect(anyDispatch).toHaveLength(0);
  });

  it('CURRENT: the SAME execution through the SAME registry DOES write sms+email appointment_confirmation rows once TransactionalCommsService is wired as app.ts:1910 wires it', async () => {
    const appointmentId = await executeApprovedCreateAppointment(
      tenantA,
      liveTransactionalComms(),
    );

    const rows = await confirmationRows(tenantA.tenant.tenantId, appointmentId);
    expect(rows.map((r) => r.channel)).toEqual(['email', 'sms']);
    expect(rows.every((r) => r.entity_id === appointmentId)).toBe(true);
    expect(rows.find((r) => r.channel === 'sms')?.recipient).toBe(tenantA.phone);
    expect(rows.find((r) => r.channel === 'email')?.recipient).toBe(tenantA.email);
  });

  it('CURRENT: the dormant AppointmentConfirmationNotifier, constructed the way app.ts would have to, also writes the confirmation rows — it is a second, unused implementation of the same behaviour', async () => {
    const appointmentId = await executeApprovedCreateAppointment(tenantA, dormantNotifier());

    const rows = await confirmationRows(tenantA.tenant.tenantId, appointmentId);
    expect(rows.map((r) => r.channel)).toEqual(['email', 'sms']);
    expect(rows.find((r) => r.channel === 'sms')?.recipient).toBe(tenantA.phone);
  });

  it('CURRENT (T1): a neighbour tenant booking through the live notifier writes only its OWN confirmation rows, and tenant A keeps exactly the rows it had', async () => {
    const beforeA = await confirmationRows(tenantA.tenant.tenantId);

    const appointmentB = await executeApprovedCreateAppointment(
      tenantB,
      liveTransactionalComms(),
    );

    const rowsB = await confirmationRows(tenantB.tenant.tenantId, appointmentB);
    expect(rowsB.map((r) => r.channel)).toEqual(['email', 'sms']);
    expect(rowsB.find((r) => r.channel === 'sms')?.recipient).toBe(tenantB.phone);
    // Another tenant's write is invisible in tenant A's set — same count, same ids.
    const afterA = await confirmationRows(tenantA.tenant.tenantId);
    expect(afterA.map((r) => r.id).sort()).toEqual(beforeA.map((r) => r.id).sort());
    // …and tenant B's rows never carry tenant A's recipient.
    expect(rowsB.some((r) => r.recipient === tenantA.phone)).toBe(false);
  });

  it('CURRENT: the audit leg reads back through PgAuditRepository.findByEntity — appointment.created is emitted for both tenants, and neither tenant sees the other', async () => {
    const appointmentId = await executeApprovedCreateAppointment(
      tenantA,
      liveTransactionalComms(),
    );

    const eventsA = await auditRepo.findByEntity(
      tenantA.tenant.tenantId,
      'appointment',
      appointmentId,
    );
    expect(eventsA.map((e) => e.eventType)).toContain('appointment.created');
    expect(eventsA.every((e) => e.tenantId === tenantA.tenant.tenantId)).toBe(true);

    // The neighbour tenant cannot read tenant A's audit rows for that entity.
    const crossTenant = await auditRepo.findByEntity(
      tenantB.tenant.tenantId,
      'appointment',
      appointmentId,
    );
    expect(crossTenant).toHaveLength(0);
  });

  /**
   * THE ROW'S GAP, stated as the row states it. The criterion is
   * unconditional — "when it executes, then an `appointment_confirmation`
   * dispatch row is written" — but the write depends on a boot-time wiring the
   * story never mentions, and when that wiring is absent NOTHING is recorded:
   * no dispatch row, no audit event, no log line the owner ever sees.
   *
   * HOW to close it is a product decision (queue a pending/failed dispatch row
   * so the omission is visible? refuse to execute? accept the gap and delete
   * the dead notifier?) — see the drafted issue in the lane report. This test
   * only pins that the criterion does not hold today on that wiring.
   */
  it('CURRENT (T3): a delivery provider is NOT sufficient — a tenant with autoSendAppointmentReminders=false gets no confirmation row, while a differently-configured neighbour in the same run does', async () => {
    // The second silent-skip path, and unlike delivery mode 'none' this one is
    // reachable by the owner from settings. Both live notifier implementations
    // return early on it: transactional-comms-service.ts:355 and the dormant
    // appointment-confirmation-notifier.ts:42.
    const quiet = await seedTenant('Quiet');
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: quiet.tenant.tenantId,
      businessName: 'Quiet Heating',
      timezone: 'America/Phoenix',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      laborRateCentsPerHour: 11500,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The flag goes through `update`, not `create`: PgSettingsRepository.create
    // does not list auto_send_appointment_reminders among its INSERT columns
    // (pg-settings.ts:274-280), so the row lands at the column's TRUE default
    // and only the update path (pg-settings.ts:369) can turn it off — which is
    // also how an owner toggles it.
    await settingsRepo.update(quiet.tenant.tenantId, {
      autoSendAppointmentReminders: false,
    });
    expect(
      (await settingsRepo.findByTenant(quiet.tenant.tenantId))?.autoSendAppointmentReminders,
    ).toBe(false);

    const quietAppointment = await executeApprovedCreateAppointment(
      quiet,
      liveTransactionalComms(),
    );
    expect(await confirmationRows(quiet.tenant.tenantId, quietAppointment)).toHaveLength(0);

    // T3 — the neighbour tenant, differently configured (no settings row, so
    // the flag is unset rather than false), books in the SAME run through the
    // SAME notifier and DOES get its confirmation.
    const loudAppointment = await executeApprovedCreateAppointment(
      tenantB,
      liveTransactionalComms(),
    );
    expect(
      (await settingsRepo.findByTenant(tenantB.tenant.tenantId))?.autoSendAppointmentReminders,
    ).toBeUndefined();
    expect(
      (await confirmationRows(tenantB.tenant.tenantId, loudAppointment)).map((r) => r.channel),
    ).toEqual(['email', 'sms']);

    // The dormant class agrees — it carries the same early return, so
    // promoting it would not close this path either.
    const quietAgain = await executeApprovedCreateAppointment(quiet, dormantNotifier());
    expect(await confirmationRows(quiet.tenant.tenantId, quietAgain)).toHaveLength(0);
  });

  it('CURRENT: a configured provider is still not sufficient — a customer with only ONE contact method gets only that channel`s confirmation', async () => {
    // `sendCustomerMessage` skips a channel whose recipient is missing, so the
    // row's criterion depends on the CUSTOMER too, not just the tenant and the
    // boot. Both of these are ordinary production shapes.
    const emailOnly = await seedTenant('Mailonly', { phone: false });
    const emailAppt = await executeApprovedCreateAppointment(emailOnly, liveTransactionalComms());
    const emailRows = await confirmationRows(emailOnly.tenant.tenantId, emailAppt);
    expect(emailRows.map((r) => r.channel)).toEqual(['email']);
    expect(emailRows[0].recipient).toBe(emailOnly.email);

    const phoneOnly = await seedTenant('Phoneonly', { email: false });
    const phoneAppt = await executeApprovedCreateAppointment(phoneOnly, liveTransactionalComms());
    const phoneRows = await confirmationRows(phoneOnly.tenant.tenantId, phoneAppt);
    expect(phoneRows.map((r) => r.channel)).toEqual(['sms']);
    expect(phoneRows[0].recipient).toBe(phoneOnly.phone);
  });

  it('CURRENT: with only ONE credential leg configured, the working channel still confirms and the unconfigured one writes nothing — and a customer reachable only on the dead leg gets no confirmation at all', async () => {
    // `createMessageDeliveryProvider` keeps the SMS and email credential legs
    // INDEPENDENT (delivery-provider-factory.ts:212-240), so prod/staging with
    // Twilio credentials and no SendGrid gets a NON-NULL provider whose email
    // leg throws at send time. `sendCustomerMessage` swallows that per channel.
    // Modelled here by a base whose sendEmail throws, which is what
    // TwilioDeliveryProvider does on an unconfigured leg.
    const smsOnlyProvider: MessageDeliveryProvider = {
      sendSms: async () => ({
        providerMessageId: 'sms-leg-1',
        provider: 'twilio',
        channel: 'sms' as const,
      }),
      sendEmail: async () => {
        throw new Error('email channel is not configured');
      },
    };

    // A customer with both contact methods still gets the SMS confirmation.
    const both = await executeApprovedCreateAppointment(
      tenantA,
      liveTransactionalComms(smsOnlyProvider),
    );
    const bothRows = await confirmationRows(tenantA.tenant.tenantId, both);
    expect(bothRows.map((r) => r.channel)).toEqual(['sms']);
    // The provider recorded on the row is the real one the send returned, not
    // a placeholder — so the row reflects an actual dispatch attempt.
    expect(bothRows[0].provider).toBeTruthy();

    // A customer reachable ONLY by email, on that same boot, gets nothing —
    // approved booking, non-null provider, reminders enabled, and no row.
    const emailOnly = await seedTenant('Deadleg', { phone: false });
    const stranded = await executeApprovedCreateAppointment(
      emailOnly,
      liveTransactionalComms(smsOnlyProvider),
    );
    expect(await confirmationRows(emailOnly.tenant.tenantId, stranded)).toHaveLength(0);
  });

  it.fails(
    'DESIRED (row 3.8): an approved create_appointment writes an appointment_confirmation dispatch row even when app.ts resolves NO delivery provider, so a booked customer is never silently left unconfirmed',
    async () => {
      const appointmentId = await executeApprovedCreateAppointment(tenantA, undefined);
      const rows = await confirmationRows(tenantA.tenant.tenantId, appointmentId);
      expect(rows.length).toBeGreaterThan(0);
    },
  );
});
