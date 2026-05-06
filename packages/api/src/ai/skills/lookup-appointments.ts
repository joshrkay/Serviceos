/**
 * P11-001 — `lookup_appointments` voice skill.
 *
 * NOTE — lookups bypass the proposals pipeline. They are read-only,
 * caller-facing reads that complete inside `intent_capture` re-entry.
 * The skill returns a TTS-ready `summary` string the adapter pipes
 * straight to <Say>; no draft/approve loop, no FSM transition.
 *
 * Shape mirrors `lookup-availability.ts`. The skill receives a tenantId +
 * customerId, fans out via `jobsRepo.findByCustomer` then
 * `appointmentRepo.findByJob` per job, and returns the next N upcoming
 * appointments + technician name + scheduled time rendered in the
 * customer's tenant timezone.
 */
import type { JobRepository } from '../../jobs/job';
import type { AppointmentRepository, Appointment } from '../../appointments/appointment';
import type {
  LookupEventService,
  RecordLookupEventInput,
} from '../../lookup-events/lookup-event-service';
import { t, type Language } from '../i18n/i18n';

export interface LookupAppointmentsInput {
  tenantId: string;
  customerId: string;
  /** Inclusive lower bound — defaults to now. */
  dateFrom?: Date;
  /** Inclusive upper bound — defaults to no upper bound. */
  dateTo?: Date;
  /** Max appointments returned. Default 3. */
  limit?: number;
  /** IANA timezone for spoken date/time rendering. */
  timezone?: string;
  /** Voice session this lookup is being run for. Used for the audit row. */
  sessionId?: string;
  /** P11-002: spoken-summary language. Defaults to 'en'. */
  language?: Language;
}

export interface LookupAppointmentsItem {
  appointmentId: string;
  jobId: string;
  jobNumber: string;
  jobSummary: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  technicianId?: string;
  status: Appointment['status'];
}

export type LookupAppointmentsResult =
  | {
      status: 'found';
      summary: string;
      data: { appointments: LookupAppointmentsItem[] };
    }
  | { status: 'none'; summary: string; data: { appointments: [] } }
  | { status: 'error'; summary: string; data: { error: string } };

export interface LookupAppointmentsDeps {
  jobRepo: JobRepository;
  appointmentRepo: AppointmentRepository;
  /** Optional — when wired the skill writes a `lookup_events` audit row. */
  lookupEvents?: LookupEventService;
}

/** Render a single Date in the tenant timezone for TTS. Drops trailing :00. */
function formatWhen(d: Date, timezone?: string, language: Language = 'en'): string {
  const locale = language === 'es' ? 'es-US' : 'en-US';
  const day = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(d);
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
    timeZone: timezone,
  }).format(d);
  const sep = language === 'es' ? 'a las' : 'at';
  return `${day} ${sep} ${time.replace(':00', '')}`;
}

export async function lookupAppointments(
  input: LookupAppointmentsInput,
  deps: LookupAppointmentsDeps,
): Promise<LookupAppointmentsResult> {
  const start = Date.now();
  const lang: Language = input.language ?? 'en';
  const limit = input.limit ?? 3;
  const dateFrom = input.dateFrom ?? new Date();

  const recordEvent = async (
    payload: Omit<RecordLookupEventInput, 'tenantId' | 'sessionId' | 'customerId' | 'intent' | 'latencyMs'>,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        customerId: input.customerId,
        intent: 'lookup_appointments',
        sessionId: input.sessionId,
        latencyMs: Date.now() - start,
        ...payload,
      });
    } catch {
      // best-effort: skill must never fail on audit write
    }
  };

  let jobs: Awaited<ReturnType<NonNullable<JobRepository['findByCustomer']>>>;
  try {
    if (!deps.jobRepo.findByCustomer) {
      throw new Error('JobRepository.findByCustomer is required for voice lookups');
    }
    jobs = await deps.jobRepo.findByCustomer(input.tenantId, input.customerId);
  } catch (err) {
    const message = t('lookup.appointments.error', lang);
    await recordEvent({
      resultStatus: 'error',
      resultCount: 0,
      summary: message,
    });
    return {
      status: 'error',
      summary: message,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  // Per-job fan-out in parallel (latency budget).
  const apptLists = await Promise.all(
    jobs.map((j) => deps.appointmentRepo.findByJob(input.tenantId, j.id)),
  );

  const jobById = new Map(jobs.map((j) => [j.id, j] as const));
  const items: LookupAppointmentsItem[] = [];
  for (const list of apptLists) {
    for (const a of list) {
      // Skip canceled / past — only future-facing appointments are
      // useful to a caller asking "when is my next appointment".
      if (a.status === 'canceled' || a.status === 'no_show' || a.status === 'completed') continue;
      if (a.scheduledStart.getTime() < dateFrom.getTime()) continue;
      if (input.dateTo && a.scheduledStart.getTime() > input.dateTo.getTime()) continue;
      const job = jobById.get(a.jobId);
      if (!job) continue;
      items.push({
        appointmentId: a.id,
        jobId: a.jobId,
        jobNumber: job.jobNumber,
        jobSummary: job.summary,
        scheduledStart: a.scheduledStart,
        scheduledEnd: a.scheduledEnd,
        technicianId: job.assignedTechnicianId,
        status: a.status,
      });
    }
  }

  items.sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
  const sliced = items.slice(0, limit);

  if (sliced.length === 0) {
    const summary = t('lookup.appointments.none', lang);
    await recordEvent({
      resultStatus: 'none',
      resultCount: 0,
      summary,
    });
    return { status: 'none', summary, data: { appointments: [] } };
  }

  const head = sliced[0];
  const headWhen = formatWhen(head.scheduledStart, input.timezone, lang);
  let summary: string;
  if (sliced.length === 1) {
    summary = t('lookup.appointments.single', lang, {
      when: headWhen,
      summary: head.jobSummary,
    });
  } else {
    const otherWhens = sliced
      .slice(1)
      .map((s) => formatWhen(s.scheduledStart, input.timezone, lang));
    const sep = lang === 'es' ? ' y ' : ' and ';
    const others = otherWhens.join(sep);
    const tplKey =
      otherWhens.length === 1
        ? 'lookup.appointments.multiple_one_more'
        : 'lookup.appointments.multiple_many';
    summary = t(tplKey, lang, {
      when: headWhen,
      summary: head.jobSummary,
      others,
    });
  }

  await recordEvent({
    resultStatus: 'found',
    resultCount: sliced.length,
    summary,
  });

  return {
    status: 'found',
    summary,
    data: { appointments: sliced },
  };
}
