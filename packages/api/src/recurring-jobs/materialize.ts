import { DateTime } from 'luxon';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { AppointmentRepository, createAppointment } from '../appointments/appointment';
import { JobRepository, createJob } from '../jobs/job';
import { LocationRepository } from '../locations/location';
import { RecurrenceRule, computeOccurrences } from './recurrence';
import { RecurringJob, RecurringJobRepository, isValidTimeOfDay } from './recurring-job';

/**
 * R-JOB (Jobber parity) — materialize a recurring series into real jobs +
 * appointments.
 *
 * For each occurrence due within a horizon that hasn't been generated yet, this
 * creates a Job (at the customer's primary service location) and an Appointment
 * at the occurrence's date + the series' time-of-day in the tenant timezone.
 * Generation is idempotent: each occurrence date is claimed in the ledger
 * (UNIQUE per series+date) before its visit is created, so a re-run — or a
 * concurrent worker — never double-books.
 *
 * Only occurrences in [today, today+horizon] are materialized; we don't
 * backfill ancient history off an old anchor.
 */

export interface MaterializeDeps {
  recurringJobRepo: RecurringJobRepository;
  jobRepo: JobRepository;
  appointmentRepo: AppointmentRepository;
  locationRepo: LocationRepository;
  auditRepo?: AuditRepository;
}

export interface MaterializeOptions {
  /** Today's calendar date ('YYYY-MM-DD') in the tenant timezone. */
  today: string;
  /** How many days ahead to generate. Default 30. */
  horizonDays?: number;
  /** Tenant IANA timezone for placing the time-of-day. */
  timezone: string;
  /** Actor id stamped on created jobs/appointments + audit. Default 'system'. */
  actorId?: string;
}

export interface GeneratedVisit {
  occurrenceDate: string;
  jobId: string;
  appointmentId: string;
}

export interface MaterializeResult {
  generated: GeneratedVisit[];
  /** Reason no visits were generated despite due dates, if any. */
  skippedReason?: 'no_location';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Add `days` to a 'YYYY-MM-DD' calendar date (UTC math; pure date arithmetic). */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/**
 * Convert an occurrence date + 'HH:MM' local time in `tz` to a UTC start/end
 * pair `durationMinutes` apart. DST-correct via luxon (e.g. a 9am visit stays
 * 9am local across the spring-forward boundary).
 */
export function visitWindowUtc(
  date: string,
  time: string,
  durationMinutes: number,
  tz: string
): { start: Date; end: Date } {
  if (!DATE_RE.test(date)) throw new Error('date must be YYYY-MM-DD');
  if (!isValidTimeOfDay(time)) throw new Error('time must be HH:MM (24-hour)');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const local = DateTime.fromObject({ year, month, day, hour, minute }, { zone: tz });
  if (!local.isValid) throw new Error(`invalid local datetime for zone ${tz}`);
  const start = local.toUTC().toJSDate();
  const end = local.plus({ minutes: durationMinutes }).toUTC().toJSDate();
  return { start, end };
}

/**
 * Occurrence dates due to be generated: in [today, today+horizon], excluding any
 * already in the ledger. Pure — the caller supplies `today` and the materialized
 * set so this is deterministic and unit-testable.
 */
export function dueOccurrenceDates(
  job: Pick<RecurringJob, 'anchorDate' | 'rule'>,
  opts: { today: string; horizonDays: number; materialized: Iterable<string> }
): string[] {
  const horizonEnd = addDays(opts.today, opts.horizonDays);
  const done = new Set(opts.materialized);
  // Generate from the anchor up to the horizon, then keep only the window we
  // actually materialize (today..horizonEnd) that isn't already done. We must
  // honor the series' own bound (count OR until — never both, which
  // computeOccurrences rejects) rather than overwriting it: for a count rule,
  // count caps the total occurrences and the window filter below trims to
  // [today, horizonEnd]; for an until rule (or none), clamp the upper edge to
  // the earlier of the user's `until` and the horizon so we never schedule past
  // the series' end date.
  const ruleForWindow: RecurrenceRule =
    job.rule.count !== undefined
      ? job.rule
      : {
          ...job.rule,
          until: job.rule.until && job.rule.until < horizonEnd ? job.rule.until : horizonEnd,
        };
  const all = computeOccurrences(job.anchorDate, ruleForWindow, 5000);
  return all.filter((d) => d >= opts.today && d <= horizonEnd && !done.has(d));
}

export async function materializeRecurringJob(
  job: RecurringJob,
  opts: MaterializeOptions,
  deps: MaterializeDeps
): Promise<MaterializeResult> {
  const actorId = opts.actorId ?? 'system';
  const horizonDays = opts.horizonDays ?? 30;

  const materialized = await deps.recurringJobRepo.listMaterializedDates(job.tenantId, job.id);
  const due = dueOccurrenceDates(job, { today: opts.today, horizonDays, materialized });
  if (due.length === 0) return { generated: [] };

  // Resolve the customer's primary service location once for the batch.
  const locations = await deps.locationRepo.findByCustomer(job.tenantId, job.customerId);
  const active = locations.filter((l) => !l.isArchived);
  const location = active.find((l) => l.isPrimary) ?? active[0];
  if (!location) return { generated: [], skippedReason: 'no_location' };

  const generated: GeneratedVisit[] = [];
  for (const date of due) {
    // Claim first so a crash/retry or concurrent worker never double-books.
    const ledgerId = await deps.recurringJobRepo.claimOccurrence(job.tenantId, job.id, date);
    if (!ledgerId) continue; // already claimed elsewhere

    // If anything below throws, release the claim so the ledger doesn't mark
    // this date materialized — otherwise the failed occurrence would be skipped
    // forever and that scheduled visit would silently never exist.
    try {
      const createdJob = await createJob(
        {
          tenantId: job.tenantId,
          customerId: job.customerId,
          locationId: location.id,
          summary: job.title,
          priority: 'normal',
          createdBy: actorId,
          actorRole: 'system',
        },
        deps.jobRepo,
        deps.auditRepo
      );

      const { start, end } = visitWindowUtc(date, job.anchorTime, job.durationMinutes, opts.timezone);
      const appointment = await createAppointment(
        {
          tenantId: job.tenantId,
          jobId: createdJob.id,
          scheduledStart: start,
          scheduledEnd: end,
          timezone: opts.timezone,
          appointmentType: job.appointmentType ?? undefined,
          notes: job.notes ?? undefined,
          createdBy: actorId,
        },
        deps.appointmentRepo,
        undefined,
        deps.auditRepo,
        'system'
      );

      await deps.recurringJobRepo.linkOccurrence(job.tenantId, ledgerId, createdJob.id, appointment.id);

      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: job.tenantId,
            actorId,
            actorRole: 'system',
            eventType: 'recurring_job.visit_generated',
            entityType: 'recurring_job',
            entityId: job.id,
            metadata: {
              occurrenceDate: date,
              jobId: createdJob.id,
              appointmentId: appointment.id,
            },
          })
        );
      }

      generated.push({ occurrenceDate: date, jobId: createdJob.id, appointmentId: appointment.id });
    } catch (err) {
      await deps.recurringJobRepo.releaseOccurrence(job.tenantId, ledgerId);
      throw err;
    }
  }

  return { generated };
}
