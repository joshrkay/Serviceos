/**
 * B5.5 — "on my way" by voice: speaker-scoped appointment resolution +
 * the router-facing glue that turns a classified `en_route` utterance into
 * the SAME audited direct status act the app button executes
 * (`triggerEnRoute`, dispatch/routes.ts). Part F decision F-3: this is the
 * human acting directly, not an AI proposal, so there is no draft/approve
 * step here — resolve, then act (or ask, or say honestly that there's
 * nothing to act on).
 *
 * Two responsibilities, kept separate so each is unit-testable on its own:
 *
 *   - `resolveEnRouteAppointment` — AC-2/AC-3: given the ACTING technician's
 *     own assignments (never a tenant-wide or another-technician query),
 *     find the one appointment "on my way" refers to.
 *   - `handleEnRouteVoiceIntent` — the router-facing orchestrator: resolves
 *     the memo creator's canonical technician id, calls the resolver above,
 *     and either fires `triggerEnRoute`, asks for clarification, or returns
 *     an explicit "no upcoming appointment" answer — never a silent no-op.
 */
import type { AssignmentRepository, AppointmentAssignment } from '../appointments/assignment';
import type { Appointment, AppointmentRepository, AppointmentStatus } from '../appointments/appointment';
import type { Job, JobRepository } from '../jobs/job';
import type { Customer, CustomerRepository } from '../customers/customer';
import type { User, UserRepository } from '../users/user';
import type { VoiceRepository } from '../voice/voice-service';
import type { SettingsRepository } from '../settings/settings';
import type { AuditRepository } from '../audit/audit';
import type { EntityCandidate } from '../ai/resolution/entity-resolver';
import type { VoiceLookupAnswer } from '@ai-service-os/shared';
import { isRuntimeTimezone, localDateKey } from '../shared/timezone';
import { getDayBoundaries } from './board-query';
import { triggerEnRoute, resolveTechnicianName, EnRouteEnqueuer } from './routes';

// ---------------------------------------------------------------------------
// Resolution (AC-2, AC-3)
// ---------------------------------------------------------------------------

/** Assignment statuses still eligible for an "on my way" notice. */
const EN_ROUTE_ELIGIBLE_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
  'scheduled',
  'confirmed',
  'in_progress',
]);

export interface EnRouteResolutionDeps {
  assignmentRepo: Pick<AssignmentRepository, 'findByTechnician'>;
  appointmentRepo: Pick<AppointmentRepository, 'findById'>;
  /** Optional: without it a named-job reference cannot be matched (fails closed to not_found rather than guessing). */
  jobRepo?: Pick<JobRepository, 'findById'>;
  /**
   * Optional: resolves an assigned job's LINKED CUSTOMER, which is the only
   * real path from a spoken PERSON'S NAME to a job. "On my way to the Garcia
   * job" names the customer, not the work — `jobs.summary` is operator-
   * authored free text ("AC repair") that usually does NOT contain the
   * customer's name, and `Job` carries `customerId` separately. Optional by
   * the same convention as `jobRepo` above (and `SendEstimateNudgeTaskDeps`):
   * absent — or a repo hiccup — degrades to summary-only matching, exactly
   * today's behavior, and never throws.
   */
  customerRepo?: Pick<CustomerRepository, 'findById'>;
}

export interface EnRouteResolutionInput {
  tenantId: string;
  /** The ACTING technician's canonical users.id — never another technician's. */
  technicianId: string;
  /** Free-text job reference from the transcript ("the Garcia job"), when named. */
  jobReference?: string;
  now?: Date;
  /** Tenant-local "today" window, used only for the bare (unnamed) case. */
  dayBoundary?: { start: Date; end: Date };
}

export interface EnRouteCandidate {
  appointmentId: string;
  jobId: string;
  jobTitle?: string;
  scheduledStart: Date;
}

export type EnRouteResolution =
  | { kind: 'resolved'; appointmentId: string; jobId: string; scheduledStart: Date }
  | { kind: 'ambiguous'; candidates: EnRouteCandidate[] }
  // Zero matches — the "no upcoming appointment" outcome (AC-3). Never
  // returned silently; the caller must surface it.
  | { kind: 'not_found' };

/** Strip filler words so "the Garcia job" / "Garcia" both reduce to the same needle. */
function normalizeJobPhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(the|a|an|job|appointment|please|for|to|my|next|one|now|visit)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `needle` is already normalized by `normalizeJobPhrase` and non-empty. */
function referenceMatchesText(text: string | undefined, needle: string): boolean {
  const haystack = (text ?? '').toLowerCase().trim();
  if (!haystack) return false;
  return haystack.includes(needle) || needle.includes(haystack);
}

/**
 * The names a technician could legitimately use for this customer out loud.
 * `displayName` is what the tenant sees everywhere; `companyName` covers
 * commercial accounts whose display name is a person; the first/last pair
 * covers a display name that is a nickname or has been re-formatted.
 */
function customerNames(customer: Customer): string[] {
  return [
    customer.displayName,
    customer.companyName,
    [customer.firstName, customer.lastName].filter(Boolean).join(' '),
  ].filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
}

/**
 * Per-resolution memo for the job/customer reads the named-reference path
 * needs. The match loop and `toCandidates` both walk the same appointments,
 * so without this a two-candidate ambiguity issued four job reads for two
 * jobs. Customer reads are additionally fail-safe: this dep is optional, so a
 * missing repo or a repo hiccup yields `null` (summary-only matching) rather
 * than failing the whole "on my way".
 */
interface EnRouteEntityLoader {
  job(jobId: string): Promise<Job | null>;
  customer(customerId: string): Promise<Customer | null>;
}

function createEntityLoader(deps: EnRouteResolutionDeps, tenantId: string): EnRouteEntityLoader {
  const jobs = new Map<string, Promise<Job | null>>();
  const customers = new Map<string, Promise<Customer | null>>();
  return {
    job(jobId: string): Promise<Job | null> {
      let pending = jobs.get(jobId);
      if (!pending) {
        pending = deps.jobRepo ? deps.jobRepo.findById(tenantId, jobId) : Promise.resolve(null);
        jobs.set(jobId, pending);
      }
      return pending;
    },
    customer(customerId: string): Promise<Customer | null> {
      let pending = customers.get(customerId);
      if (!pending) {
        pending = deps.customerRepo
          ? deps.customerRepo.findById(tenantId, customerId).catch(() => null)
          : Promise.resolve(null);
        customers.set(customerId, pending);
      }
      return pending;
    },
  };
}

/**
 * Does the spoken reference name THIS appointment's job? Two ways, both real:
 * the job's own summary ("the AC repair job"), or — the reason B5.5's first
 * cut was wrong — the job's LINKED CUSTOMER ("the Garcia job", where the
 * summary is "AC repair" and Garcia is `jobs.customer_id → customers`).
 */
async function appointmentMatchesReference(
  loader: EnRouteEntityLoader,
  appt: Appointment,
  needle: string,
): Promise<boolean> {
  const job = await loader.job(appt.jobId);
  if (!job) return false;
  if (referenceMatchesText(job.summary, needle)) return true;
  if (!job.customerId) return false;
  const customer = await loader.customer(job.customerId);
  if (!customer) return false;
  return customerNames(customer).some((name) => referenceMatchesText(name, needle));
}

async function hydrateEligibleAppointments(
  deps: EnRouteResolutionDeps,
  tenantId: string,
  assignments: AppointmentAssignment[],
  now: Date,
  dayBoundary?: { start: Date; end: Date },
): Promise<Appointment[]> {
  const lowerBound = dayBoundary ? dayBoundary.start : now;
  const hydrated = await Promise.all(
    assignments.map((a) => deps.appointmentRepo.findById(tenantId, a.appointmentId)),
  );
  return hydrated.filter(
    (appt): appt is Appointment =>
      appt !== null &&
      EN_ROUTE_ELIGIBLE_STATUSES.has(appt.status) &&
      appt.scheduledStart.getTime() >= lowerBound.getTime(),
  );
}

async function toCandidates(
  loader: EnRouteEntityLoader,
  appts: Appointment[],
): Promise<EnRouteCandidate[]> {
  return Promise.all(
    appts.map(async (appt) => {
      const job = await loader.job(appt.jobId);
      return {
        appointmentId: appt.id,
        jobId: appt.jobId,
        ...(job?.summary ? { jobTitle: job.summary } : {}),
        scheduledStart: appt.scheduledStart,
      };
    }),
  );
}

/**
 * Resolve "on my way" to a single appointment, scoped ENTIRELY to the acting
 * technician's own assignments. `assignmentRepo.findByTechnician` is the
 * only entity query this function issues to find candidates — it is called
 * with (tenantId, input.technicianId) and nothing else, so a technician's
 * "on my way" can never resolve to a different technician's appointment
 * (AC-2). The resolver never falls back to a tenant-wide scan.
 */
export async function resolveEnRouteAppointment(
  deps: EnRouteResolutionDeps,
  input: EnRouteResolutionInput,
): Promise<EnRouteResolution> {
  const now = input.now ?? new Date();
  const loader = createEntityLoader(deps, input.tenantId);

  const assignments = await deps.assignmentRepo.findByTechnician(input.tenantId, input.technicianId);
  if (assignments.length === 0) return { kind: 'not_found' };

  const eligible = await hydrateEligibleAppointments(deps, input.tenantId, assignments, now, input.dayBoundary);
  if (eligible.length === 0) return { kind: 'not_found' };

  if (input.jobReference && input.jobReference.trim().length > 0) {
    // Named job → that appointment. Without a jobRepo we cannot verify a
    // name match, so we fail closed to not_found rather than guess.
    if (!deps.jobRepo) return { kind: 'not_found' };
    const needle = normalizeJobPhrase(input.jobReference);
    if (!needle) return { kind: 'not_found' };
    const matches: Appointment[] = [];
    for (const appt of eligible) {
      if (await appointmentMatchesReference(loader, appt, needle)) matches.push(appt);
    }
    if (matches.length === 0) return { kind: 'not_found' };
    if (matches.length === 1) {
      const m = matches[0];
      return { kind: 'resolved', appointmentId: m.id, jobId: m.jobId, scheduledStart: m.scheduledStart };
    }
    return { kind: 'ambiguous', candidates: await toCandidates(loader, matches) };
  }

  // Bare "on my way" — the tech's next upcoming appointment TODAY.
  const todays = input.dayBoundary
    ? eligible.filter(
        (appt) =>
          appt.scheduledStart >= input.dayBoundary!.start &&
          appt.scheduledStart < input.dayBoundary!.end,
      )
    : eligible;
  if (todays.length === 0) return { kind: 'not_found' };

  todays.sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
  const earliestMs = todays[0].scheduledStart.getTime();
  const tiedForEarliest = todays.filter((a) => a.scheduledStart.getTime() === earliestMs);
  if (tiedForEarliest.length > 1) {
    return { kind: 'ambiguous', candidates: await toCandidates(loader, tiedForEarliest) };
  }
  const next = todays[0];
  return { kind: 'resolved', appointmentId: next.id, jobId: next.jobId, scheduledStart: next.scheduledStart };
}

// ---------------------------------------------------------------------------
// Router-facing orchestration
// ---------------------------------------------------------------------------

export interface EnRouteVoiceDeps {
  userRepo?: Pick<UserRepository, 'findByTenant'>;
  voiceRepo?: Pick<VoiceRepository, 'findById'>;
  assignmentRepo?: Pick<AssignmentRepository, 'findByTechnician'>;
  appointmentRepo?: Pick<AppointmentRepository, 'findById'>;
  jobRepo?: Pick<JobRepository, 'findById'>;
  /** Lets a spoken "the Garcia job" resolve through the job's customer — see `EnRouteResolutionDeps`. */
  customerRepo?: Pick<CustomerRepository, 'findById'>;
  enRouteCoordinator?: EnRouteEnqueuer;
  auditRepo?: AuditRepository;
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
  now?: () => Date;
}

export interface EnRouteVoiceInput {
  tenantId: string;
  /** The recorded memo this utterance came from — its `createdBy` is the acting technician. */
  recordingId?: string;
  jobReference?: string;
}

export type EnRouteVoiceOutcome =
  | { kind: 'answered'; answer: VoiceLookupAnswer }
  | { kind: 'ambiguous'; reference: string; candidates: EntityCandidate[] }
  // No recording/identity/deps to act on — the caller should treat this
  // exactly like an intent with no answer surface on this path (skip).
  | { kind: 'unavailable' };

/**
 * `voice_recordings.created_by` is stamped with the CLERK subject
 * (`req.auth.userId`), not the canonical `users.id` that
 * `AssignmentRepository`/`AppointmentRepository` key on. Mirrors the same
 * dual-check `app.ts`'s `resolveVoiceMemberRole` already uses for the
 * owner-grade lookup gate, so a memo creator resolves the same way on both
 * paths.
 */
async function resolveCanonicalTechnician(
  userRepo: Pick<UserRepository, 'findByTenant'>,
  tenantId: string,
  rawCreatorId: string,
): Promise<User | null> {
  const users = await userRepo.findByTenant(tenantId);
  return users.find((u) => u.clerkUserId === rawCreatorId || u.id === rawCreatorId) ?? null;
}

/**
 * Tenant-local "today" window, shared by the voice leg above and the
 * SMS-keyword leg (sms/tech-status/en-route-keyword.ts) so both scope the
 * bare "on my way" case to the SAME calendar day.
 */
export async function resolveTodayBoundary(
  settingsRepo: Pick<SettingsRepository, 'findByTenant'> | undefined,
  tenantId: string,
  now: Date,
): Promise<{ start: Date; end: Date }> {
  const settings = settingsRepo ? await settingsRepo.findByTenant(tenantId).catch(() => null) : null;
  const tz = settings?.timezone && isRuntimeTimezone(settings.timezone) ? settings.timezone : 'UTC';
  return getDayBoundaries(localDateKey(now, tz), tz);
}

function candidateToEntity(c: EnRouteCandidate): EntityCandidate {
  return {
    id: c.appointmentId,
    kind: 'appointment',
    label: c.jobTitle ?? c.scheduledStart.toISOString(),
    hint: c.scheduledStart.toISOString(),
    score: 1,
  };
}

/**
 * Classify → resolve → act, for the recorded-memo `en_route` path. Never
 * silent: every reachable outcome is either a fired act, a clarification
 * (ambiguous), an explicit "no upcoming appointment" answer (not_found), or
 * `unavailable` when this surface simply cannot act (no recording context,
 * e.g. the eval harness / in-app text path) — the same shape the read-only
 * lookup family already uses for "no answer surface here".
 */
export async function handleEnRouteVoiceIntent(
  deps: EnRouteVoiceDeps,
  input: EnRouteVoiceInput,
): Promise<EnRouteVoiceOutcome> {
  if (
    !input.recordingId ||
    !deps.voiceRepo ||
    !deps.userRepo ||
    !deps.assignmentRepo ||
    !deps.appointmentRepo ||
    !deps.enRouteCoordinator
  ) {
    return { kind: 'unavailable' };
  }

  const recording = await deps.voiceRepo.findById(input.tenantId, input.recordingId);
  if (!recording) return { kind: 'unavailable' };

  const technician = await resolveCanonicalTechnician(deps.userRepo, input.tenantId, recording.createdBy);
  if (!technician) return { kind: 'unavailable' };

  const now = deps.now ? deps.now() : new Date();
  const dayBoundary = await resolveTodayBoundary(deps.settingsRepo, input.tenantId, now);

  const resolution = await resolveEnRouteAppointment(
    {
      assignmentRepo: deps.assignmentRepo,
      appointmentRepo: deps.appointmentRepo,
      jobRepo: deps.jobRepo,
      customerRepo: deps.customerRepo,
    },
    {
      tenantId: input.tenantId,
      technicianId: technician.id,
      ...(input.jobReference ? { jobReference: input.jobReference } : {}),
      now,
      dayBoundary,
    },
  );

  if (resolution.kind === 'ambiguous') {
    return {
      kind: 'ambiguous',
      reference: input.jobReference ?? 'on my way',
      candidates: resolution.candidates.map(candidateToEntity),
    };
  }

  if (resolution.kind === 'not_found') {
    return {
      kind: 'answered',
      answer: {
        version: 1,
        intent: 'en_route',
        result: 'none',
        summary: "You don't have an upcoming appointment today to mark en route — nothing was sent.",
        rows: [],
      },
    };
  }

  const technicianName =
    [technician.firstName, technician.lastName].filter(Boolean).join(' ').trim() || technician.email;

  const trigger = await triggerEnRoute(
    { enRouteCoordinator: deps.enRouteCoordinator, auditRepo: deps.auditRepo },
    {
      tenantId: input.tenantId,
      appointmentId: resolution.appointmentId,
      ...(technicianName ? { technicianName } : {}),
      actor: { tenantId: input.tenantId, userId: technician.id, role: 'technician' },
    },
  );

  return {
    kind: 'answered',
    answer: {
      version: 1,
      intent: 'en_route',
      result: 'found',
      summary: trigger.notified
        ? "Sent the customer an on-my-way text."
        : "Marked you en route — no customer text was sent (no reachable contact on file).",
      rows: [],
      entityRef: { kind: 'appointment', id: resolution.appointmentId },
    },
  };
}

// Re-exported so callers of this module never need a second import from
// dispatch/routes.ts just for the technician display-name helper.
export { resolveTechnicianName };
