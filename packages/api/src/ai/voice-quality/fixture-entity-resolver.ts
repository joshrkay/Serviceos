/**
 * The voice-quality harnesses' fixture-backed entity resolver.
 *
 * Production wires `PgEntityResolver` (app.ts), which needs Postgres. The
 * harnesses run on the SHIPPED in-memory repositories, so this resolver
 * reimplements `PgEntityResolver`'s CONTRACT (τ_ent semantics: one match →
 * resolved, two+ → ambiguous with candidates, none → not_found) over the same
 * seeded rows. ONE implementation for every harness (#1540 §1):
 *   - inapp-50 builds it over its seeded `World`;
 *   - the Layer 2 voice-quality harness builds it over the runner's
 *     `RepoBundle` (`fixtureEntityResolverForBundle`), so appointment
 *     references ("my appointment on Tuesday", "the customer on the 10am")
 *     resolve the way they do in production instead of staying free text.
 *
 * The clock is a seam (`now`): a harness that pins its world (the corpus is
 * authored on Friday 2026-05-01) must resolve "Tuesday" against that world,
 * not the wall clock.
 */
import { DateTime } from 'luxon';

import type { AppointmentRepository } from '../../appointments/appointment';
import type { CustomerRepository } from '../../customers/customer';
import type { EstimateRepository } from '../../estimates/estimate';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { Job, JobRepository } from '../../jobs/job';
import type { LeadRepository } from '../../leads/lead';
import type { UserRepository } from '../../users/user';
import { resolveDateTime } from '../scheduling/resolve-datetime';
import {
  TAU_ENT,
  type EntityCandidate,
  type EntityKind,
  type EntityResolver,
  type EntityResolverResult,
} from '../resolution/entity-resolver';
import {
  ANCHORED_ESTIMATE_OPEN_STATUSES,
  ANCHORED_INVOICE_OPEN_STATUSES,
  ANCHORED_INVOICE_REFUNDABLE_STATUSES,
  CLOCK_TIME_TOLERANCE_MS,
  hasClockTime,
} from '../resolution/pg-entity-resolver';
import type { RepoBundle } from './runner';

/** The seeded rows (and identity) a fixture resolver scores against. */
export interface FixtureResolverWorld {
  tenantId: string;
  /** The tenant's IANA zone — day phrases are tenant-local calendar days. */
  timezone: string;
  customerRepo: CustomerRepository;
  jobRepo: JobRepository;
  invoiceRepo: InvoiceRepository;
  estimateRepo: EstimateRepository;
  appointmentRepo: AppointmentRepository;
  leadRepo: LeadRepository;
  /** Technician references resolve only when a user repository is seeded. */
  userRepo?: UserRepository;
  /** The world's clock. Defaults to the wall clock. */
  now?: () => Date;
}

function nowOf(w: FixtureResolverWorld): Date {
  return w.now?.() ?? new Date();
}

/** A customer's jobs (archived included), with or without `findByCustomer`. */
async function jobsOfCustomer(w: FixtureResolverWorld, customerId: string): Promise<Job[]> {
  if (w.jobRepo.findByCustomer) {
    return w.jobRepo.findByCustomer(w.tenantId, customerId, { includeArchived: true });
  }
  return (await w.jobRepo.findByTenant(w.tenantId)).filter((j) => j.customerId === customerId);
}

/**
 * #1540 §1 — the resolver over a voice-quality runner `RepoBundle` (the
 * bundle the runner seeds from a script's fixtures and the driver reads).
 */
export function fixtureEntityResolverForBundle(
  repos: RepoBundle,
  world: { tenantId: string; timezone: string; now?: () => Date },
): FixtureEntityResolver {
  return new FixtureEntityResolver(() => ({ ...repos, ...world }));
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
export function referenceDayIso(
  reference: string,
  timezone: string,
  now: Date = new Date(),
): string | undefined {
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
  const resolved = resolveDateTime(`${match[0]} at 12:00 pm`, { timezone, now });
  if (!resolved.ok) return undefined;
  const day = DateTime.fromISO(resolved.startUtc, { zone: timezone });
  // A bare WEEKDAY never names today here: the seed it has to meet
  // (`nextTuesdayAt14`) is always 1..7 days ahead, never today, so on a
  // Tuesday morning "Tuesday" must mean next week's — otherwise the register's
  // Tuesday cases fail every Tuesday before noon for reasons that have nothing
  // to do with the code under test. "today" keeps meaning today.
  const isWeekday = !/^(today|tomorrow)$/i.test(match[0]);
  const today = DateTime.fromJSDate(now, { zone: timezone }).toISODate();
  return (isWeekday && day.toISODate() === today ? day.plus({ days: 7 }) : day).toISODate() ?? undefined;
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
  constructor(private readonly world: () => FixtureResolverWorld) {}

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
    /** #1576 — mirrors PgEntityResolver: an anchored refund wants paid invoices. */
    invoiceScope?: 'refundable';
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
        return input.customerId
          ? this.resolveJobForCustomer(w, reference, input.customerId)
          : this.resolveJob(w, reference);
      case 'invoice':
        return this.resolveInvoice(w, reference, input.customerId, input.invoiceScope);
      case 'estimate':
        return this.resolveEstimate(w, reference, input.customerId);
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

  private async resolveCustomer(w: FixtureResolverWorld, reference: string): Promise<EntityResolverResult> {
    const tokens = contentTokens(reference);
    if (tokens.length === 0) return { kind: 'not_found', reference };
    const customers = await w.customerRepo.findByTenant(w.tenantId);
    const candidates: EntityCandidate[] = [];
    for (const c of customers) {
      const hay = new Set(tokenize(`${c.displayName} ${c.firstName} ${c.lastName}`));
      const hits = tokens.filter((t) => hay.has(t)).length;
      if (hits === 0) continue;
      candidates.push({
        id: c.id,
        kind: 'customer',
        label: c.displayName,
        // U4 — PHONE ONLY, exactly like `PgEntityResolver.resolveCustomer`
        // (pg-entity-resolver.ts: `hint: row.primary_phone ?? undefined`).
        //
        // This used to append "street, city" itself, with a comment saying it
        // "mirrors what production hands the matcher" — which was true of the
        // in-app voice adapter's private enrichment and NOT of the chat
        // surface, so `book-03`/`inv-05` could pass here on a hint no chat
        // caller would ever have received. A fixture arranged to pass proves
        // nothing (docs/solutions/test-failures/). The address now comes from
        // the SHIPPED `withCustomerAddressHints` decorator, which both drivers
        // wire over this world's `locationRepo` exactly as app.ts wires it —
        // so a green register is evidence about the product, not the fixture.
        ...(c.primaryPhone ? { hint: c.primaryPhone } : {}),
        score: hits === tokens.length ? 1 : 0.85,
      });
    }
    return foldCandidates(candidates, reference);
  }

  private async resolveJob(w: FixtureResolverWorld, reference: string): Promise<EntityResolverResult> {
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

  /**
   * #1331 — mirrors `PgEntityResolver.resolveJobForCustomer`: with the
   * customer already resolved, their name words no longer tell their jobs
   * apart, so they are dropped and what is left (the JOB words) ranks that
   * customer's jobs. Only the customer named: their one job, or the
   * which-job question. Job words naming none of their jobs: not_found.
   */
  private async resolveJobForCustomer(
    w: FixtureResolverWorld,
    reference: string,
    customerId: string,
  ): Promise<EntityResolverResult> {
    const jobs = await jobsOfCustomer(w, customerId);
    if (jobs.length === 0) return { kind: 'not_found', reference };
    const customer = await w.customerRepo.findById(w.tenantId, customerId);
    const nameWords = new Set(
      tokenize(`${customer?.displayName ?? ''} ${customer?.firstName ?? ''} ${customer?.lastName ?? ''}`),
    );
    const jobWords = contentTokens(reference).filter((t) => !nameWords.has(t));
    if (jobWords.length === 0) {
      if (jobs.length === 1) {
        return resolvedResult({ id: jobs[0].id, kind: 'job', label: jobs[0].summary, hint: jobs[0].status, score: 1 });
      }
      return {
        kind: 'ambiguous',
        candidates: jobs.map((j) => ({ id: j.id, kind: 'job' as const, label: j.summary, hint: j.status, score: 1 })),
      };
    }
    const candidates: EntityCandidate[] = [];
    for (const job of jobs) {
      const hay = new Set(tokenize(`${job.summary} ${job.jobNumber}`));
      const hits = jobWords.filter((t) => hay.has(t)).length;
      if (hits === 0) continue;
      candidates.push({ id: job.id, kind: 'job', label: job.summary, hint: job.status, score: hits / jobWords.length });
    }
    return foldWithBestMatch(candidates, reference);
  }

  private async resolveInvoice(
    w: FixtureResolverWorld,
    reference: string,
    customerId?: string,
    scope?: 'refundable',
  ): Promise<EntityResolverResult> {
    const invoices = await w.invoiceRepo.findByTenant(w.tenantId);
    const anchoredStatuses: readonly string[] =
      scope === 'refundable' ? ANCHORED_INVOICE_REFUNDABLE_STATUSES : ANCHORED_INVOICE_OPEN_STATUSES;
    const docMatch = reference.match(INV_NUMBER_RE);
    if (docMatch) {
      const number = docMatch[0].toUpperCase();
      const hit = invoices.find((i) => i.invoiceNumber.toUpperCase() === number);
      return hit
        ? resolvedResult({ id: hit.id, kind: 'invoice', label: hit.invoiceNumber, hint: hit.status, score: 1 })
        : { kind: 'not_found', reference };
    }
    // Mirrors PgEntityResolver.resolveInvoiceByCustomer: a verified customer
    // anchor IS the scope (its open invoices — or, for a refund, its paid
    // ones), not the spoken name again.
    const byCustomer = customerId
      ? await this.docsForCustomerId(w, customerId)
      : await this.docsForCustomerReference(w, reference);
    if (!byCustomer) return { kind: 'not_found', reference };
    const owned = invoices.filter(
      (i) =>
        byCustomer.jobIds.has(i.jobId) &&
        (!customerId || anchoredStatuses.includes(i.status)),
    );
    const candidates = owned.map((i) => ({
      id: i.id,
      kind: 'invoice' as const,
      label: i.invoiceNumber,
      hint: i.status,
      score: 1,
    }));
    return foldCandidates(candidates, reference);
  }

  private async resolveEstimate(
    w: FixtureResolverWorld,
    reference: string,
    customerId?: string,
  ): Promise<EntityResolverResult> {
    const estimates = await w.estimateRepo.findByTenant(w.tenantId);
    const docMatch = reference.match(EST_NUMBER_RE);
    if (docMatch) {
      const number = docMatch[0].toUpperCase();
      const hit = estimates.find((e) => e.estimateNumber.toUpperCase() === number);
      return hit
        ? resolvedResult({ id: hit.id, kind: 'estimate', label: hit.estimateNumber, hint: hit.status, score: 1 })
        : { kind: 'not_found', reference };
    }
    const byCustomer = customerId
      ? await this.docsForCustomerId(w, customerId)
      : await this.docsForCustomerReference(w, reference);
    if (!byCustomer) return { kind: 'not_found', reference };
    const owned = estimates.filter(
      (e) =>
        byCustomer.jobIds.has(e.jobId) &&
        (!customerId || (ANCHORED_ESTIMATE_OPEN_STATUSES as readonly string[]).includes(e.status)),
    );
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
  private async docsForCustomerId(
    w: FixtureResolverWorld,
    customerId: string,
  ): Promise<{ customerId: string; jobIds: Set<string> }> {
    const jobs = await jobsOfCustomer(w, customerId);
    return { customerId, jobIds: new Set(jobs.map((j) => j.id)) };
  }

  private async docsForCustomerReference(
    w: FixtureResolverWorld,
    reference: string,
  ): Promise<{ customerId: string; jobIds: Set<string> } | undefined> {
    const customerResult = await this.resolveCustomer(w, reference);
    if (customerResult.kind !== 'resolved') return undefined;
    const jobs = await jobsOfCustomer(w, customerResult.candidate.id);
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
    w: FixtureResolverWorld,
    reference: string,
    jobId?: string,
    customerId?: string,
  ): Promise<EntityResolverResult> {
    const appointments = (
      await w.appointmentRepo.findByDateRange(
        w.tenantId,
        new Date(nowOf(w).getTime() - 365 * 24 * 3600 * 1000),
        new Date(nowOf(w).getTime() + 365 * 24 * 3600 * 1000),
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

    const now = nowOf(w);

    // #1540 — a stated CLOCK TIME ("the 10am", "Tuesday at 2pm") answers
    // definitively, exactly like `PgEntityResolver.resolveAppointmentByClockTime`:
    // the visits within ±15 min of that tenant-local instant (narrowed to the
    // job anchor), and an honest not_found when nothing sits there — never a
    // fall-through to some other visit. A phrase that is not an exact time
    // (a bare day, a daypart) falls through to the branches below.
    if (hasClockTime(reference)) {
      const stated = resolveDateTime(reference, { timezone: w.timezone, now });
      if (stated.ok && stated.precision === 'exact') {
        const target = new Date(stated.startUtc).getTime();
        const atTime = appointments.filter(
          (a) =>
            Math.abs(a.scheduledStart.getTime() - target) <= CLOCK_TIME_TOLERANCE_MS &&
            (!jobId || a.jobId === jobId),
        );
        return foldCandidates(
          atTime.map((a) => ({
            id: a.id,
            kind: 'appointment' as const,
            label: label(a),
            hint: a.status,
            score: 1,
          })),
          reference,
        );
      }
    }

    const dayIso = referenceDayIso(reference, w.timezone, now);
    const tokens = contentTokens(reference);
    const candidates: EntityCandidate[] = [];

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

  private async resolveTechnician(w: FixtureResolverWorld, reference: string): Promise<EntityResolverResult> {
    const tokens = contentTokens(reference);
    if (tokens.length === 0) return { kind: 'not_found', reference };
    if (!w.userRepo) return { kind: 'skipped' };
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

  private async resolveLead(w: FixtureResolverWorld, reference: string): Promise<EntityResolverResult> {
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
