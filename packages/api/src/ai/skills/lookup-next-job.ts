/**
 * #1604 — `lookup_next_job`: "read me the next job".
 *
 * The ONE lookup that reads a job the way the truck needs it: the scheduled
 * time, the customer, the service address, the gate / access notes on that
 * address and the job's latest note, in that spoken order. The schedule
 * lookups (`lookup-my-day.ts`) list a DAY; this reads ONE visit in full.
 *
 * ── Scope: whose job ─────────────────────────────────────────────────────
 *
 * Exactly `lookup-my-day.ts`'s contract — the CALLER decides, explicitly:
 *   - `technicianId` — the speaker's own assignments only. For a technician
 *     this self-scoping IS the access control (no permission entry), so the
 *     caller resolves the speaker BEFORE this runs and fails the turn when it
 *     can't. A named job that is not theirs is refused honestly, never read.
 *   - `wholeTenant: true` — the business's next visit, for an actor whose
 *     DB-authoritative role holds `dispatch:view` (owner, dispatcher).
 *
 * ── Which visit ──────────────────────────────────────────────────────────
 *
 * "Next" is the earliest live visit (not canceled / no-show / completed)
 * that has not ended yet, from the start of today through the next two weeks
 * in the tenant's zone — an in-progress visit is still "the next job" until
 * it ends. With `jobId` (a resolver-verified named job) it is that job's
 * next visit instead.
 *
 * ── Copy ─────────────────────────────────────────────────────────────────
 *
 * Every spoken fragment is a `TTS_COPY` entry rendered by id in the session
 * language (#1601 step 1) — nothing is composed from inline English here. The
 * customer's phone follows the `lookup_customer` rule: masked (`maskPhone`)
 * on the answer data, never spoken.
 */
import type { Appointment, AppointmentRepository } from '../../appointments/appointment';
import type { JobRepository } from '../../jobs/job';
import type { CustomerRepository } from '../../customers/customer';
import type { LocationRepository } from '../../locations/location';
import type { NoteRepository } from '../../notes/note';
import type { UserRepository } from '../../users/user';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { resolveDayWindow } from '../../reports/money-dashboard';
import { localDateString, nextDateString } from '../../digest/digest-service';
import { maskPhone } from '../../telephony/twilio-call-control';
import { ttsCopy, type SessionLanguage } from '../agents/customer-calling/tts-copy';
import { technicianDisplayName } from './spoken-format';

export type LookupNextJobInput = {
  tenantId: string;
  sessionId?: string;
  timezone?: string;
  now?: Date;
  /** Session language — the readback renders in it. Defaults to English. */
  language?: SessionLanguage;
  /**
   * A NAMED job (resolver-verified id): read that job's next visit instead of
   * the earliest one. Under technician scope a job that is not theirs is
   * refused — the name alone never widens what they hear.
   */
  jobId?: string;
} & (
  | {
      /** The SPEAKER's own canonical technician id, already resolved by the caller. */
      technicianId: string;
      wholeTenant?: never;
    }
  | { wholeTenant: true; technicianId?: never }
);

export interface LookupNextJobDeps {
  appointmentRepo: Pick<AppointmentRepository, 'findByDateRange'>;
  jobRepo: Pick<JobRepository, 'findByIds'>;
  customerRepo: Pick<CustomerRepository, 'findById'>;
  locationRepo: Pick<LocationRepository, 'findById'>;
  /** Optional — the job's latest internal note. */
  noteRepo?: Pick<NoteRepository, 'findByEntity'>;
  /** Optional — the assigned technician's name on a whole-tenant readback. Decorative. */
  userRepo?: Pick<UserRepository, 'findByTenant'>;
  lookupEvents?: LookupEventService;
}

export interface NextJobData {
  appointmentId: string;
  jobId: string;
  jobSummary: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  customerName?: string;
  /** Masked (`maskPhone`) — the full number never leaves the skill. */
  customerPhoneMasked?: string;
  address?: { street1: string; street2?: string; city: string; state: string; postalCode: string };
  accessNotes?: string;
  latestNote?: string;
  /** Whole-tenant readbacks only — who has the visit. */
  technicianName?: string;
}

export type LookupNextJobResult =
  | { status: 'found'; summary: string; data: NextJobData }
  | { status: 'none'; summary: string; data: Record<string, never> }
  | { status: 'error'; summary: string; data: { error: string } };

const DEFAULT_TIMEZONE = 'America/New_York';
/** How far ahead "next" looks, in days from the start of today. */
const LOOKAHEAD_DAYS = 14;

/** "2 PM" / "9:30 AM" in the tenant zone, in the session language's locale. */
function clockTime(d: Date, timezone: string, lang: SessionLanguage): string {
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
    timeZone: timezone,
  })
    .format(d)
    .replace(':00', '');
}

/** "today at 2 PM" / "tomorrow at 9 AM" / "on Friday, June 12 at 9 AM", localized. */
function whenPhrase(start: Date, today: string, timezone: string, lang: SessionLanguage): string {
  const day = localDateString(start, timezone);
  const time = clockTime(start, timezone, lang);
  if (day === today) return ttsCopy('next_job_when_today', lang, { time });
  if (day === nextDateString(today)) return ttsCopy('next_job_when_tomorrow', lang, { time });
  const dayName = new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(start);
  return ttsCopy('next_job_when_on_day', lang, { day: dayName, time });
}

/** A note or access text spoken as its own sentence — ends in punctuation exactly once. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function spokenAddress(address: NextJobData['address']): string {
  if (!address) return '';
  const street = [address.street1, address.street2].filter(Boolean).join(' ');
  return `${street}, ${address.city}`;
}

export async function lookupNextJob(
  input: LookupNextJobInput,
  deps: LookupNextJobDeps,
): Promise<LookupNextJobResult> {
  const start = Date.now();
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const now = input.now ?? new Date();
  const lang: SessionLanguage = input.language ?? 'en';

  const record = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        intent: 'lookup_next_job',
        resultStatus,
        resultCount,
        summary,
        latencyMs: Date.now() - start,
      });
    } catch {
      /* swallow — an audit-write failure never breaks the spoken turn */
    }
  };

  try {
    return await readNextJob(input, deps, { timezone, now, lang, record });
  } catch (err) {
    const summary = ttsCopy('next_job_error', lang);
    await record('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function readNextJob(
  input: LookupNextJobInput,
  deps: LookupNextJobDeps,
  ctx: {
    timezone: string;
    now: Date;
    lang: SessionLanguage;
    record: (status: 'found' | 'none', count: number, summary: string) => Promise<void>;
  },
): Promise<LookupNextJobResult> {
  const { timezone, now, lang, record } = ctx;
  const today = localDateString(now, timezone);
  const windowStart = resolveDayWindow(today, timezone).start;
  const windowEnd = new Date(windowStart.getTime() + LOOKAHEAD_DAYS * 24 * 3_600_000);

  const raw = await deps.appointmentRepo.findByDateRange(input.tenantId, windowStart, windowEnd);
  const live = raw.filter(
    (a: Appointment) =>
      a.status !== 'canceled' &&
      a.status !== 'no_show' &&
      a.status !== 'completed' &&
      a.scheduledEnd.getTime() >= now.getTime(),
  );
  const jobIds = Array.from(new Set([...live.map((a) => a.jobId), ...(input.jobId ? [input.jobId] : [])]));
  const jobs = jobIds.length > 0 ? await deps.jobRepo.findByIds(input.tenantId, jobIds) : [];
  const jobById = new Map(jobs.map((j) => [j.id, j] as const));

  const ownsJob = (jobId: string): boolean => {
    const job = jobById.get(jobId);
    if (!job) return false;
    return input.wholeTenant === true || job.assignedTechnicianId === input.technicianId;
  };

  // A named job that is not the technician's: refuse by name, read nothing.
  if (input.jobId && jobById.has(input.jobId) && !ownsJob(input.jobId)) {
    const summary = ttsCopy('next_job_not_yours', lang);
    await record('none', 0, summary);
    return { status: 'none', summary, data: {} };
  }

  // Strictly the technician's own assignments when scoped to one — never a
  // coworker's visit on a job this fetch happened to load.
  const candidates = live
    .filter((a) => (input.jobId ? a.jobId === input.jobId : true) && ownsJob(a.jobId))
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
  const next = candidates[0];
  if (!next) {
    const summary = ttsCopy(input.jobId ? 'next_job_no_visit' : 'next_job_none', lang);
    await record('none', 0, summary);
    return { status: 'none', summary, data: {} };
  }
  const job = jobById.get(next.jobId)!;

  const customer = await deps.customerRepo.findById(input.tenantId, job.customerId);
  const location = await deps.locationRepo.findById(input.tenantId, job.locationId);
  const notes = deps.noteRepo ? await deps.noteRepo.findByEntity(input.tenantId, 'job', job.id) : [];
  const latest = notes.reduce<(typeof notes)[number] | undefined>(
    (best, n) => (!best || n.createdAt.getTime() > best.createdAt.getTime() ? n : best),
    undefined,
  );
  let technicianName: string | undefined;
  if (input.wholeTenant && deps.userRepo && job.assignedTechnicianId) {
    try {
      const users = await deps.userRepo.findByTenant(input.tenantId);
      const tech = users.find((u) => u.id === job.assignedTechnicianId);
      if (tech) technicianName = technicianDisplayName(tech);
    } catch {
      // Names are decorative — never fail the readback over them.
    }
  }

  const data: NextJobData = {
    appointmentId: next.id,
    jobId: job.id,
    jobSummary: job.summary,
    scheduledStart: next.scheduledStart,
    scheduledEnd: next.scheduledEnd,
    ...(customer ? { customerName: customer.displayName } : {}),
    ...(customer?.primaryPhone ? { customerPhoneMasked: maskPhone(customer.primaryPhone) } : {}),
    ...(location
      ? {
          address: {
            street1: location.street1,
            ...(location.street2 ? { street2: location.street2 } : {}),
            city: location.city,
            state: location.state,
            postalCode: location.postalCode,
          },
        }
      : {}),
    ...(location?.accessNotes ? { accessNotes: location.accessNotes } : {}),
    ...(latest ? { latestNote: latest.content } : {}),
    ...(technicianName ? { technicianName } : {}),
  };

  const vars = {
    when: whenPhrase(next.scheduledStart, today, timezone, lang),
    customer: data.customerName ?? '',
    job: job.summary,
    address: spokenAddress(data.address),
  };
  const parts = [
    technicianName
      ? ttsCopy('next_job_readback_with_technician', lang, { ...vars, technician: technicianName })
      : ttsCopy('next_job_readback', lang, vars),
    ...(data.accessNotes
      ? [ttsCopy('next_job_access_notes', lang, { notes: asSentence(data.accessNotes) })]
      : []),
    ...(data.latestNote
      ? [ttsCopy('next_job_latest_note', lang, { note: asSentence(data.latestNote) })]
      : []),
  ];
  const summary = parts.join(' ');
  await record('found', 1, summary);
  return { status: 'found', summary, data };
}
