/**
 * The hermetic fixture world the in-app 50-case harness drives.
 *
 * Every repository is the SHIPPED in-memory implementation (the same classes
 * `app.ts` selects when no Pool is configured), seeded from
 * `fixtures/voice/operator-voice-fixture-catalog.json` plus the register's
 * `harnessSeeds`. Nothing is stubbed except the LLM (in `runner.ts`) and the
 * entity resolver — production's `PgEntityResolver` needs Postgres, so
 * `FixtureEntityResolver` reimplements its CONTRACT (τ_ent semantics:
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
import { resolveDateTime } from '../../scheduling/resolve-datetime';
import type { AssistantLookupDeps } from '../../orchestration/lookup-dispatch';
import {
  TAU_ENT,
  type EntityCandidate,
  type EntityKind,
  type EntityResolver,
  type EntityResolverResult,
} from '../../resolution/entity-resolver';
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

// ── Text normalization shared by every resolver kind ────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'on', 'at', 'my', 'our', 'his', 'her', 'their',
  'job', 'jobs', 'appointment', 'appointments', 'visit', 'invoice', 'invoices',
  'estimate', 'estimates', 'quote', 'quotes', 'account', 'customer', 'client',
  'upcoming', 'next', 'open', 'overdue', 'pending', 'that', 'this', 'is', 'and',
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0);
}

/** Content tokens — stopwords stripped, so "Garcia's invoice" → ["garcia"]. */
function contentTokens(value: string): string[] {
  return tokenize(value).filter((t) => !STOPWORDS.has(t));
}

/**
 * The tenant-local calendar date a spoken day phrase names, or undefined when
 * the reference is not a day phrase at all ("the Garcia job", "").
 */
function referenceDayIso(reference: string, timezone: string): string | undefined {
  // Only the DAY token is handed to the parser. Chrono will not parse
  // "Tuesday appointment" / "Tuesday visit" as a whole (the trailing noun
  // defeats it) and a failed parse would silently demote a day phrase to a
  // name match, which is how "Garcia's Tuesday appointment" would stop
  // resolving at all. The clock half of the phrase is deliberately dropped:
  // this function answers WHICH DAY, never which minute.
  const match = reference.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/i,
  );
  if (!match) return undefined;
  // Noon anchor. `resolveDateTime` is a BOOKING resolver: a bare weekday is
  // `ambiguous_no_time` because it must never invent an hour to book at. We
  // only want the CALENDAR DAY, and midday cannot shift a date in any zone,
  // so the anchor makes the phrase resolvable without changing what it names.
  const resolved = resolveDateTime(`${match[0]} at 12:00 pm`, { timezone });
  if (!resolved.ok) return undefined;
  return DateTime.fromISO(resolved.startUtc, { zone: timezone }).toISODate() ?? undefined;
}

const INV_NUMBER_RE = /\bINV-\d+\b/i;
const EST_NUMBER_RE = /\bEST-\d+\b/i;

function resolvedResult(candidate: EntityCandidate): EntityResolverResult {
  return { kind: 'resolved', candidate };
}

function foldCandidates(
  candidates: EntityCandidate[],
  reference: string,
): EntityResolverResult {
  const above = candidates.filter((c) => c.score >= TAU_ENT);
  if (above.length === 1) return resolvedResult(above[0]);
  if (above.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: [...above].sort((a, b) => b.score - a.score),
    };
  }
  return { kind: 'not_found', reference };
}

/**
 * Tenant-scoped resolver over the seeded world.
 *
 * Deliberately NOT a `vi.fn()` stub returning canned answers per case: it
 * scores real seeded rows, so a case that "resolves" only because the fixture
 * said so cannot exist. The scoring model is coarse (token overlap) but the
 * CONTRACT is production's: exactly one match above τ_ent resolves, two or
 * more ask, none is an honest not_found.
 */
export class FixtureEntityResolver implements EntityResolver {
  constructor(private readonly world: () => World) {}

  async resolve(input: {
    tenantId: string;
    reference: string;
    kind: EntityKind;
    jobId?: string;
    /**
     * Customer anchor for `kind: 'appointment'` — "text Garcia that I'm
     * running late" names the PERSON, not the visit. An empty reference is
     * meaningful with this set (and only here); see the interface's note.
     */
    customerId?: string;
  }): Promise<EntityResolverResult> {
    const w = this.world();
    if (input.tenantId !== w.tenantId) return { kind: 'not_found', reference: input.reference };
    const reference = input.reference.trim();
    const anchoredAppointment = input.kind === 'appointment' && Boolean(input.customerId);
    if (reference.length === 0 && !anchoredAppointment) return { kind: 'skipped' };

    switch (input.kind) {
      case 'customer':
        return this.resolveCustomer(w, reference);
      case 'job':
        return this.resolveJob(w, reference);
      case 'invoice':
        return this.resolveInvoice(w, reference);
      case 'estimate':
        return this.resolveEstimate(w, reference);
      case 'appointment':
        return this.resolveAppointment(w, reference, input.jobId, input.customerId);
      case 'technician':
        return this.resolveTechnician(w, reference);
      case 'lead':
        return this.resolveLead(w, reference);
      default:
        // pending_proposal / catalogItem are out of this register's scope —
        // 'skipped' is the contract's "no resolver for this kind" answer.
        return { kind: 'skipped' };
    }
  }

  private async resolveCustomer(w: World, reference: string): Promise<EntityResolverResult> {
    const tokens = contentTokens(reference);
    if (tokens.length === 0) return { kind: 'not_found', reference };
    const customers = await w.customerRepo.findByTenant(w.tenantId);
    const locations = await w.locationRepo.findByTenant(w.tenantId);
    const candidates: EntityCandidate[] = [];
    for (const c of customers) {
      const hay = new Set(tokenize(`${c.displayName} ${c.firstName} ${c.lastName}`));
      const hits = tokens.filter((t) => hay.has(t)).length;
      if (hits === 0) continue;
      const address = locations.find((l) => l.customerId === c.id);
      // Hint shape mirrors what production hands the disambiguation matcher:
      // PgEntityResolver puts the phone here and the in-app adapter appends
      // "street, city" separated by ' · ' (inapp-adapter.ts#enrichCandidates).
      const hintParts = [
        c.primaryPhone,
        address ? `${address.street1}, ${address.city}` : undefined,
      ].filter((p): p is string => typeof p === 'string' && p.length > 0);
      candidates.push({
        id: c.id,
        kind: 'customer',
        label: c.displayName,
        ...(hintParts.length > 0 ? { hint: hintParts.join(' · ') } : {}),
        score: hits === tokens.length ? 1 : 0.85,
      });
    }
    return foldCandidates(candidates, reference);
  }

  private async resolveJob(w: World, reference: string): Promise<EntityResolverResult> {
    const tokens = contentTokens(reference);
    if (tokens.length === 0) return { kind: 'not_found', reference };
    const jobs = await w.jobRepo.findByTenant(w.tenantId);
    const customers = await w.customerRepo.findByTenant(w.tenantId);
    const nameById = new Map(customers.map((c) => [c.id, c.displayName]));
    const candidates: EntityCandidate[] = [];
    for (const job of jobs) {
      const hay = new Set(
        tokenize(`${job.summary} ${job.jobNumber} ${nameById.get(job.customerId) ?? ''}`),
      );
      const hits = tokens.filter((t) => hay.has(t)).length;
      if (hits === 0) continue;
      candidates.push({
        id: job.id,
        kind: 'job',
        label: job.summary,
        hint: job.status,
        score: hits / tokens.length,
      });
    }
    // Token overlap is a ratio, so a partial match ("water heater job" vs
    // "Johnson water heater replacement") can sit below τ_ent while still
    // being the only plausible job. Promote the strict best match when it is
    // unique and beats every rival — the same "one clear winner" rule τ_ent
    // encodes, expressed against a coarser score.
    return foldWithBestMatch(candidates, reference);
  }

  private async resolveInvoice(w: World, reference: string): Promise<EntityResolverResult> {
    const invoices = await w.invoiceRepo.findByTenant(w.tenantId);
    const docMatch = reference.match(INV_NUMBER_RE);
    if (docMatch) {
      const number = docMatch[0].toUpperCase();
      const hit = invoices.find((i) => i.invoiceNumber.toUpperCase() === number);
      return hit
        ? resolvedResult({ id: hit.id, kind: 'invoice', label: hit.invoiceNumber, hint: hit.status, score: 1 })
        : { kind: 'not_found', reference };
    }
    const byCustomer = await this.docsForCustomerReference(w, reference);
    if (!byCustomer) return { kind: 'not_found', reference };
    const owned = invoices.filter((i) => byCustomer.jobIds.has(i.jobId));
    const candidates = owned.map((i) => ({
      id: i.id,
      kind: 'invoice' as const,
      label: i.invoiceNumber,
      hint: i.status,
      score: 1,
    }));
    return foldCandidates(candidates, reference);
  }

  private async resolveEstimate(w: World, reference: string): Promise<EntityResolverResult> {
    const estimates = await w.estimateRepo.findByTenant(w.tenantId);
    const docMatch = reference.match(EST_NUMBER_RE);
    if (docMatch) {
      const number = docMatch[0].toUpperCase();
      const hit = estimates.find((e) => e.estimateNumber.toUpperCase() === number);
      return hit
        ? resolvedResult({ id: hit.id, kind: 'estimate', label: hit.estimateNumber, hint: hit.status, score: 1 })
        : { kind: 'not_found', reference };
    }
    const byCustomer = await this.docsForCustomerReference(w, reference);
    if (!byCustomer) return { kind: 'not_found', reference };
    const owned = estimates.filter((e) => byCustomer.jobIds.has(e.jobId));
    const candidates = owned.map((e) => ({
      id: e.id,
      kind: 'estimate' as const,
      label: e.estimateNumber,
      hint: e.status,
      score: 1,
    }));
    return foldCandidates(candidates, reference);
  }

  /**
   * "Garcia's invoice" / "the overdue invoice for Johnson" — the document is
   * named by its CUSTOMER. Returns that customer's job ids, or undefined when
   * the reference names no seeded customer.
   */
  private async docsForCustomerReference(
    w: World,
    reference: string,
  ): Promise<{ customerId: string; jobIds: Set<string> } | undefined> {
    const customerResult = await this.resolveCustomer(w, reference);
    if (customerResult.kind !== 'resolved') return undefined;
    const jobs = await w.jobRepo.findByCustomer(w.tenantId, customerResult.candidate.id, {
      includeArchived: true,
    });
    return { customerId: customerResult.candidate.id, jobIds: new Set(jobs.map((j) => j.id)) };
  }

  /**
   * Mirrors `PgEntityResolver.resolveAppointment`'s ORDER, which is what makes
   * a spoken reference land the same way here as in production:
   *
   *   1. The reference parses as a DAY PHRASE ("Tuesday", "Tuesday at 2 pm")
   *      → appointments on that tenant-local calendar day. Narrowed to the
   *      turn's customer when one is anchored (SCH-D2).
   *   2. No day phrase → the customer anchor's own upcoming appointments
   *      (an empty reference is meaningful here, and only here), the sticky
   *      job anchor (SCH-03), or a customer/job name token match.
   *
   * The day phrase is parsed with the SHIPPED `resolveDateTime` in the tenant
   * zone — the same function the payload builder uses — so "Tuesday" can
   * never mean one date to the resolver and another to the booking.
   */
  private async resolveAppointment(
    w: World,
    reference: string,
    jobId?: string,
    customerId?: string,
  ): Promise<EntityResolverResult> {
    const appointments = (
      await w.appointmentRepo.findByDateRange(
        w.tenantId,
        new Date(Date.now() - 365 * 24 * 3600 * 1000),
        new Date(Date.now() + 365 * 24 * 3600 * 1000),
      )
    ).filter((a) => a.status !== 'canceled');
    if (appointments.length === 0) return { kind: 'not_found', reference };

    const jobs = await w.jobRepo.findByTenant(w.tenantId);
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const customers = await w.customerRepo.findByTenant(w.tenantId);
    const nameById = new Map(customers.map((c) => [c.id, c.displayName]));

    const label = (appt: (typeof appointments)[number]): string => {
      const job = jobById.get(appt.jobId);
      const customerName = job ? nameById.get(job.customerId) ?? '' : '';
      const local = DateTime.fromJSDate(appt.scheduledStart, { zone: w.timezone });
      return `${customerName} — ${local.toFormat('cccc h:mm a')}`.trim();
    };

    const dayIso = referenceDayIso(reference, w.timezone);
    const tokens = contentTokens(reference);
    const candidates: EntityCandidate[] = [];
    const now = new Date();

    for (const appt of appointments) {
      const job = jobById.get(appt.jobId);
      const apptCustomerId = job?.customerId;
      // The customer anchor NARROWS, exactly like SCH-D2 — it never widens.
      if (customerId && apptCustomerId !== customerId) continue;

      // Signals are additive (max), not exclusive: "Garcia's Tuesday
      // appointment" names a day AND a person, and both must count — if two
      // appointments each match one signal the fold below ASKS rather than
      // silently preferring whichever signal was checked first.
      let score = 0;
      if (dayIso) {
        const apptDay = DateTime.fromJSDate(appt.scheduledStart, { zone: w.timezone }).toISODate();
        if (apptDay === dayIso) score = 1;
      }
      const customerName = apptCustomerId ? nameById.get(apptCustomerId) ?? '' : '';
      const hay = new Set(tokenize(`${customerName} ${job?.summary ?? ''}`));
      if (tokens.length > 0 && tokens.some((t) => hay.has(t))) score = Math.max(score, 0.95);
      if (jobId && appt.jobId === jobId) score = Math.max(score, 0.9);
      // "Garcia's next appointment, whenever it is" — anchor only.
      if (customerId && appt.scheduledStart >= now) score = Math.max(score, 0.9);
      if (score === 0) continue;
      candidates.push({
        id: appt.id,
        kind: 'appointment',
        label: label(appt),
        hint: appt.status,
        score,
      });
    }
    return foldCandidates(candidates, reference);
  }

  private async resolveTechnician(w: World, reference: string): Promise<EntityResolverResult> {
    const tokens = contentTokens(reference);
    if (tokens.length === 0) return { kind: 'not_found', reference };
    const users = await w.userRepo.findByTenant(w.tenantId);
    const candidates: EntityCandidate[] = [];
    for (const u of users) {
      const hay = new Set(tokenize(`${u.firstName ?? ''} ${u.lastName ?? ''}`));
      const hits = tokens.filter((t) => hay.has(t)).length;
      if (hits === 0) continue;
      candidates.push({
        id: u.id,
        kind: 'technician',
        label: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
        hint: u.role,
        score: hits === tokens.length ? 1 : 0.85,
      });
    }
    return foldCandidates(candidates, reference);
  }

  private async resolveLead(w: World, reference: string): Promise<EntityResolverResult> {
    const tokens = contentTokens(reference);
    if (tokens.length === 0) return { kind: 'not_found', reference };
    const leads = await w.leadRepo.findByTenant(w.tenantId);
    const candidates: EntityCandidate[] = [];
    for (const lead of leads) {
      if (lead.stage === 'won' || lead.stage === 'lost') continue;
      const hay = new Set(
        tokenize(`${lead.companyName ?? ''} ${lead.firstName} ${lead.lastName}`),
      );
      const hits = tokens.filter((t) => hay.has(t)).length;
      if (hits === 0) continue;
      candidates.push({
        id: lead.id,
        kind: 'lead',
        label: lead.companyName || `${lead.firstName} ${lead.lastName}`.trim(),
        hint: lead.stage,
        score: hits === tokens.length ? 1 : 0.9,
      });
    }
    return foldCandidates(candidates, reference);
  }
}

/**
 * τ_ent fold with a "clear unique winner" promotion for ratio-scored kinds.
 * A single candidate strictly above every rival AND above half the reference's
 * tokens is resolved; several tied at the top ask; nothing matches → not_found.
 */
function foldWithBestMatch(
  candidates: EntityCandidate[],
  reference: string,
): EntityResolverResult {
  if (candidates.length === 0) return { kind: 'not_found', reference };
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  const tied = sorted.filter((c) => c.score === top.score);
  if (tied.length === 1 && top.score >= 0.5) return resolvedResult(top);
  if (tied.length > 1 && top.score >= 0.5) return { kind: 'ambiguous', candidates: tied };
  return { kind: 'not_found', reference };
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
