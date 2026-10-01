/**
 * The hermetic fixture world the in-app 50-case harness drives.
 *
 * Every repository is the SHIPPED in-memory implementation (the same classes
 * `app.ts` selects when no Pool is configured), seeded from
 * `fixtures/voice/operator-voice-fixture-catalog.json` plus the register's
 * `harnessSeeds`. Nothing is stubbed except the LLM (in `runner.ts`) and the
 * entity resolver — production's `PgEntityResolver` needs Postgres, so
 * the shared `FixtureEntityResolver` (../fixture-entity-resolver.ts, #1540)
 * reimplements its CONTRACT (τ_ent semantics:
 * one match → resolved, two+ → ambiguous with candidates, none → not_found)
 * over the same seeded rows.
 *
 * Every seeded id is a real UUID: the shipped lookup dispatch and several
 * payload contracts parse ids as uuids, and a `cust-1`-style fixture id would
 * make the harness test its own fixtures instead of the code.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';

import { InMemoryAppointmentRepository } from '../../../appointments/in-memory-appointment';
import { InMemoryAssignmentRepository } from '../../../appointments/assignment';
import { createAppointment } from '../../../appointments/appointment';
import { InMemoryAuditRepository } from '../../../audit/audit';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
  type CatalogCategory,
} from '../../../catalog/catalog-item';
import { InMemoryCustomerRepository, type Customer } from '../../../customers/customer';
import { InMemoryEstimateRepository, createEstimate } from '../../../estimates/estimate';
import { InMemoryInvoiceRepository, createInvoice } from '../../../invoices/invoice';
import { InMemoryJobRepository, createJob } from '../../../jobs/job';
import { InMemoryLeadRepository } from '../../../leads/in-memory-lead';
import type { Lead } from '../../../leads/lead';
import { InMemoryLocationRepository, createLocation } from '../../../locations/location';
import { InMemoryOnCallRepository, type OnCallEntry } from '../../../oncall/rotation';
import { InMemoryProposalRepository } from '../../../proposals/proposal';
import { InMemoryMoneyDashboardRepository } from '../../../reports/money-dashboard';
import { InMemorySettingsRepository, createSettings } from '../../../settings/settings';
import type { LineItem, LineItemCategory } from '../../../shared/billing-engine';
import { InMemoryUserRepository } from '../../../users/user';
import type { AssistantLookupDeps } from '../../orchestration/lookup-dispatch';
import { FixtureEntityResolver } from '../fixture-entity-resolver';
import { buildOperatorVoiceFixturePlan } from '../../../seed/operator-voice-fixture-plan';
import type { OperatorVoiceFixtureCatalog } from '../../../seed/operator-voice-fixture-plan';
import { FIXTURE_CATALOG_PATH, type Register } from './register';

/** Stable per-run tenant/actor identities (real UUIDs — see the module note). */
export interface WorldIdentity {
  tenantId: string;
  /** The signed-in operator: owner role, the authz subject for lookups. */
  ownerUserId: string;
  timezone: string;
}

export interface World extends WorldIdentity {
  customerRepo: InMemoryCustomerRepository;
  locationRepo: InMemoryLocationRepository;
  jobRepo: InMemoryJobRepository;
  estimateRepo: InMemoryEstimateRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  appointmentRepo: InMemoryAppointmentRepository;
  userRepo: InMemoryUserRepository;
  leadRepo: InMemoryLeadRepository;
  catalogRepo: InMemoryCatalogItemRepository;
  settingsRepo: InMemorySettingsRepository;
  proposalRepo: InMemoryProposalRepository;
  auditRepo: InMemoryAuditRepository;
  onCallRepo: InMemoryOnCallRepository;
  moneyDashboardRepo: InMemoryMoneyDashboardRepository;
  assignmentRepo: InMemoryAssignmentRepository;
  /**
   * En-route notices this world captured. The production coordinator enqueues
   * a branded ETA SMS; there is no in-memory implementation to borrow, so the
   * harness records the enqueue instead of sending it — the ONE seam besides
   * the LLM and the entity resolver.
   */
  enRouteNotices: Array<{ appointmentId: string; technicianName?: string }>;
  /** fixture key ("customer.garcia") → seeded uuid. */
  fixtureIds: Record<string, string>;
  entityResolver: FixtureEntityResolver;
  /** Shaped exactly like `AssistantLookupDeps` for the shared lookup dispatch. */
  lookups: AssistantLookupDeps;
  /** The seeded appointment's UTC start (next Tuesday 14:00 tenant-local). */
  appointmentStart: Date;
}

/** Map the fixture catalog's line-item category onto the catalog enum. */
const CATALOG_CATEGORY: Record<string, CatalogCategory> = {
  labor: 'Labor',
  equipment: 'Parts',
  material: 'Materials',
  other: 'Materials',
};

function loadCatalog(path: string = FIXTURE_CATALOG_PATH): OperatorVoiceFixtureCatalog {
  return buildOperatorVoiceFixturePlan(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * The next Tuesday at 14:00 in the tenant's zone, strictly in the future.
 *
 * The adapter resolves spoken times against the WALL CLOCK (there is no clock
 * seam on `InAppVoiceAdapter`), so the seeded appointment has to be anchored
 * to the same clock or "Tuesday" in an utterance and "Tuesday" on the calendar
 * would drift apart. Anchoring forward also keeps `createAppointment`'s
 * past-date validation quiet and makes "next appointment" lookups hit it.
 */
export function nextTuesdayAt14(timezone: string, now: Date = new Date()): Date {
  let dt = DateTime.fromJSDate(now, { zone: timezone }).set({
    hour: 14,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  // luxon weekday: 1=Mon … 7=Sun; Tuesday is 2. Always 1..7 days AHEAD —
  // never today — so the seeded world has the same shape whatever day the
  // harness runs on (a "today" appointment would change what the day-overview
  // and en-route surfaces see, and a harness that behaves differently on
  // Tuesdays is not a baseline).
  const daysAhead = (2 - dt.weekday + 7) % 7 || 7;
  return dt.plus({ days: daysAhead }).toJSDate();
}

/**
 * `hoursFromNow` from now, in the tenant's zone — clamped to stay inside the
 * tenant-local calendar day.
 *
 * The clamp is load-bearing: the en-route core bounds resolution to the
 * tenant's SERVICE DAY, so a naive `now + 3h` would silently spill into
 * tomorrow for any run in the last three hours of a Phoenix day and the
 * `en_route` case would start failing at 21:00 for reasons that have nothing
 * to do with the code under test.
 */
export function sameDayStart(timezone: string, now: Date, hoursFromNow: number): Date {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  const wanted = local.plus({ hours: hoursFromNow });
  const latest = local.endOf('day').minus({ minutes: 30 });
  return (wanted > latest ? latest : wanted).toJSDate();
}

/** Catalog line item → a persisted `LineItem` (integer cents, never floats). */
function seedLineItem(
  li: {
    description: string;
    category: LineItemCategory;
    quantity: number;
    unitPriceCents: number;
    taxable: boolean;
  },
  index: number,
): LineItem {
  return {
    id: randomUUID(),
    description: li.description,
    category: li.category,
    quantity: li.quantity,
    unitPriceCents: li.unitPriceCents,
    totalCents: li.quantity * li.unitPriceCents,
    sortOrder: index,
    taxable: li.taxable,
  };
}

/**
 * Build a fresh, fully seeded world. One per case — a case must never see a
 * proposal, audit row or appointment another case created.
 */
export async function buildWorld(register: Register, now: Date = new Date()): Promise<World> {
  const catalog = loadCatalog();
  const timezone = register.harnessSeeds.tenantTimezone;
  const tenantId = randomUUID();
  const ownerUserId = randomUUID();

  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = new InMemoryLocationRepository();
  const jobRepo = new InMemoryJobRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const userRepo = new InMemoryUserRepository();
  const leadRepo = new InMemoryLeadRepository();
  const catalogRepo = new InMemoryCatalogItemRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const moneyDashboardRepo = new InMemoryMoneyDashboardRepository();
  const assignmentRepo = new InMemoryAssignmentRepository();
  const enRouteNotices: Array<{ appointmentId: string; technicianName?: string }> = [];

  const fixtureIds: Record<string, string> = {};

  // ── Settings (tenant zone is what makes "Tuesday at 2 pm" resolvable) ────
  await createSettings(
    {
      tenantId,
      businessName: 'QA Operator Voice HVAC',
      businessPhone: '+14805550100',
      businessEmail: 'ops@qa-operator-voice.example.com',
      timezone,
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
    },
    settingsRepo,
  );

  // ── Team: the signed-in owner + technician Carlos ───────────────────────
  await userRepo.create({
    id: ownerUserId,
    tenantId,
    clerkUserId: `user_${ownerUserId}`,
    email: 'owner@qa-operator-voice.example.com',
    role: 'owner',
    firstName: 'Dana',
    lastName: 'Owner',
    canFieldServe: true,
  });
  for (const tech of catalog.technicians) {
    const id = randomUUID();
    fixtureIds[tech.key] = id;
    await userRepo.create({
      id,
      tenantId,
      clerkUserId: `user_${id}`,
      email: `${tech.firstName.toLowerCase()}.qa@example.com`,
      role: tech.role,
      firstName: tech.firstName,
      lastName: tech.lastName,
      canFieldServe: true,
    });
  }

  // ── Customers + their service locations ─────────────────────────────────
  for (const c of catalog.customers) {
    const id = randomUUID();
    fixtureIds[c.key] = id;
    const customer: Customer = {
      id,
      tenantId,
      firstName: c.firstName,
      lastName: c.lastName,
      displayName: c.displayName,
      primaryPhone: c.primaryPhone,
      email: c.email,
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: ownerUserId,
      createdAt: now,
      updatedAt: now,
    };
    await customerRepo.create(customer);
  }
  for (const loc of catalog.locations) {
    const created = await createLocation(
      {
        tenantId,
        customerId: fixtureIds[loc.customerKey],
        street1: loc.street1,
        city: loc.city,
        state: loc.state,
        postalCode: loc.postalCode,
        country: 'US',
        isPrimary: true,
      },
      locationRepo,
    );
    fixtureIds[loc.key] = created.id;
  }

  // ── Jobs ────────────────────────────────────────────────────────────────
  for (const job of catalog.jobs) {
    const created = await createJob(
      {
        tenantId,
        customerId: fixtureIds[job.customerKey],
        locationId: fixtureIds[job.locationKey],
        summary: job.summary,
        createdBy: ownerUserId,
      },
      jobRepo,
    );
    fixtureIds[job.key] = created.id;
  }

  // ── Estimates (sent, i.e. awaiting the customer's acceptance) ───────────
  for (const est of catalog.estimates) {
    const created = await createEstimate(
      {
        tenantId,
        jobId: fixtureIds[est.jobKey],
        estimateNumber: est.estimateNumber,
        lineItems: est.lineItems.map((li, index) => seedLineItem(li, index)),
        taxRateBps: est.taxRateBps,
        validUntil: new Date(est.validUntil),
        createdBy: ownerUserId,
      },
      estimateRepo,
    );
    await estimateRepo.update(tenantId, created.id, { status: 'sent' });
    fixtureIds[est.key] = created.id;
  }

  // ── Invoices, ISSUED so a balance actually exists to look up ────────────
  for (const inv of catalog.invoices) {
    const created = await createInvoice(
      {
        tenantId,
        jobId: fixtureIds[inv.jobKey],
        ...(inv.estimateKey ? { estimateId: fixtureIds[inv.estimateKey] } : {}),
        invoiceNumber: inv.invoiceNumber,
        lineItems: inv.lineItems.map((li, index) => seedLineItem(li, index)),
        taxRateBps: inv.taxRateBps,
        createdBy: ownerUserId,
      },
      invoiceRepo,
    );
    await invoiceRepo.update(tenantId, created.id, {
      status: 'open',
      issuedAt: now,
      dueDate: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      amountDueCents: created.totals.totalCents,
    });
    fixtureIds[inv.key] = created.id;
  }

  // ── The catalog appointment: next Tuesday 14:00 tenant-local ────────────
  const appointmentStart = nextTuesdayAt14(timezone, now);
  let firstAppointment: Date = appointmentStart;
  for (const appt of catalog.appointments) {
    const created = await createAppointment(
      {
        tenantId,
        jobId: fixtureIds[appt.jobKey],
        scheduledStart: appointmentStart,
        scheduledEnd: new Date(appointmentStart.getTime() + 60 * 60 * 1000),
        timezone,
        notes: appt.notes,
        createdBy: ownerUserId,
      },
      appointmentRepo,
    );
    fixtureIds[appt.key] = created.id;
    firstAppointment = created.scheduledStart;
  }

  // ── The SAME-DAY appointment, assigned to the speaking operator ─────────
  // "On my way" is a statement about right now: the shared en-route core
  // scopes resolution to the ACTING technician's own assignments inside the
  // tenant-local service day. Without both halves — an appointment today AND
  // an assignment naming the speaker — the act can only answer "nothing
  // today", and `dispatch-03` would be measuring the fixture, not the code.
  const todaySeed = register.harnessSeeds.todayAppointment;
  if (todaySeed) {
    const todayStart = sameDayStart(timezone, now, todaySeed.hoursFromNow);
    const todayAppointment = await createAppointment(
      {
        tenantId,
        jobId: fixtureIds[todaySeed.jobKey],
        scheduledStart: todayStart,
        scheduledEnd: new Date(todayStart.getTime() + todaySeed.durationMinutes * 60 * 1000),
        timezone,
        notes: todaySeed.notes,
        createdBy: ownerUserId,
      },
      appointmentRepo,
    );
    fixtureIds[todaySeed.key] = todayAppointment.id;
    await assignmentRepo.create({
      id: randomUUID(),
      tenantId,
      appointmentId: todayAppointment.id,
      // `assignedTo: 'owner'` — the session subject, which is what
      // `answerInAppEnRoute` resolves to a canonical user before delegating.
      technicianId: ownerUserId,
      isPrimary: true,
      assignedBy: ownerUserId,
      assignedAt: now,
      scheduledStart: todayAppointment.scheduledStart,
      scheduledEnd: todayAppointment.scheduledEnd,
    });
  }

  // ── Leads ───────────────────────────────────────────────────────────────
  for (const seed of catalog.leads) {
    const id = randomUUID();
    fixtureIds[seed.key] = id;
    const lead: Lead = {
      id,
      tenantId,
      firstName: seed.firstName,
      lastName: seed.lastName,
      companyName: seed.companyName,
      primaryPhone: seed.primaryPhone,
      email: seed.email,
      source: seed.source,
      stage: 'qualified',
      estimatedValueCents: seed.estimatedValueCents,
      street1: seed.street1,
      city: seed.city,
      state: seed.state,
      postalCode: seed.postalCode,
      country: seed.country,
      createdBy: ownerUserId,
      createdAt: now,
      updatedAt: now,
    };
    await leadRepo.create(lead);
  }

  // ── Price book (grounds AI-drafted line items — CLAUDE.md invariant) ────
  for (const item of register.harnessSeeds.catalogItems) {
    const created = createCatalogItem({
      tenantId,
      name: item.name,
      category: CATALOG_CATEGORY[item.category] ?? 'Materials',
      unit: 'each',
      unitPriceCents: item.unitPriceCents,
    });
    await catalogRepo.create(created);
    fixtureIds[item.key] = created.id;
  }

  // ── On-call rotation (so an emergency escalation has someone to page) ───
  const onCallRepo = new InMemoryOnCallRepository(
    new Map<string, OnCallEntry[]>([
      [tenantId, [{ id: randomUUID(), userId: ownerUserId, orderIndex: 0 }]],
    ]),
  );

  // Owner-grade revenue reads a dashboard aggregate; the in-memory repo takes
  // a canned summary, so derive it from the invoices we actually seeded rather
  // than inventing a number.
  const seededInvoices = await invoiceRepo.findByTenant(tenantId);
  const outstandingCents = seededInvoices.reduce((sum, i) => sum + i.amountDueCents, 0);
  moneyDashboardRepo.setSummary({
    month: DateTime.fromJSDate(now, { zone: timezone }).toFormat('yyyy-MM'),
    revenueCents: 0,
    grossRevenueCents: 0,
    refundsCents: 0,
    priorMonthRevenueCents: 0,
    revenueTrendCents: 0,
    expensesCents: 0,
    outstandingCents,
    overdueCents: 0,
  });

  const world: World = {
    tenantId,
    ownerUserId,
    timezone,
    customerRepo,
    locationRepo,
    jobRepo,
    estimateRepo,
    invoiceRepo,
    appointmentRepo,
    userRepo,
    leadRepo,
    catalogRepo,
    settingsRepo,
    proposalRepo,
    auditRepo,
    onCallRepo,
    moneyDashboardRepo,
    assignmentRepo,
    enRouteNotices,
    fixtureIds,
    entityResolver: undefined as unknown as FixtureEntityResolver,
    lookups: undefined as unknown as AssistantLookupDeps,
    appointmentStart: firstAppointment,
  };

  world.entityResolver = new FixtureEntityResolver(() => world);
  world.lookups = {
    // Mirrors app.ts's `lookupAnswerDeps` — the same object shape chat, the
    // memo worker and the phone are wired with, narrowed to the repos that
    // have an in-memory implementation. A lookup whose repo is absent reports
    // `unsupported`, which is a REAL finding, not a harness gap.
    answers: {
      invoiceRepo,
      estimateRepo,
      settingsRepo,
      catalogRepo,
      leadRepo,
      moneyDashboardRepo,
      resolveMemberRole: async (t: string, userId: string) => {
        const users = await userRepo.findByTenant(t);
        const user = users.find((u) => u.clerkUserId === userId || u.id === userId);
        return user?.role ?? null;
      },
    },
    // Mirrors app.ts's `sharedLookupRepos`.
    shared: {
      jobRepo,
      appointmentRepo,
      customerRepo,
      proposalRepo,
      userRepo,
    },
    entityResolver: world.entityResolver,
    tenantTimezoneResolver: async () => timezone,
  };

  return world;
}
