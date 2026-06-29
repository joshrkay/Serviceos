/**
 * P5-020 — End-of-day digest builder.
 *
 * Queries the DB directly (no repo layer) to collect aggregate data for the
 * end-of-day digest. Returns DigestSection[] (for rendering) and
 * DigestSourceData (for storage / tracking). All date boundaries are UTC;
 * the caller provides them pre-computed via luxon.
 */
import type { Pool } from 'pg';
import { withTenantSession } from '../db/rls-runtime-role';
import type { DigestSection, DigestSourceData } from './digest-types';
import { formatUsd } from './digest-service';

export interface BuildDigestDataResult {
  sections: DigestSection[];
  sourceData: DigestSourceData;
}

/**
 * Build the digest data for one tenant for the given local day.
 *
 * @param tenantId    Tenant UUID (validated before entering this function)
 * @param localDate   YYYY-MM-DD string in the tenant's local timezone
 * @param utcDayStart UTC start of the tenant's local calendar day
 * @param utcDayEnd   UTC end of the tenant's local calendar day (exclusive)
 * @param utcTomorrowStart UTC start of the next local calendar day
 * @param utcTomorrowEnd   UTC end of the next local calendar day (exclusive)
 * @param timezone    IANA timezone string for display labels
 */
export async function buildDigestData(
  pool: Pool,
  tenantId: string,
  localDate: string,
  utcDayStart: Date,
  utcDayEnd: Date,
  utcTomorrowStart: Date,
  utcTomorrowEnd: Date,
  timezone: string,
): Promise<BuildDigestDataResult> {
  return withTenantSession(pool, tenantId, async (client) => {

  // Section 1: Completed jobs
  const completedJobsResult = await client.query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE status = 'completed'
       AND updated_at >= $1
       AND updated_at < $2`,
    [utcDayStart, utcDayEnd],
  );
  const completedJobIds = completedJobsResult.rows.map((r) => r.id);

  // Section 2: Estimates sent today
  const sentEstimatesResult = await client.query<{ id: string; total_cents: number }>(
    `SELECT id, total_cents FROM estimates
     WHERE status = 'sent'
       AND sent_at >= $1
       AND sent_at < $2`,
    [utcDayStart, utcDayEnd],
  );
  const sentEstimateIds = sentEstimatesResult.rows.map((r) => r.id);
  const sentEstimatesTotalCents = sentEstimatesResult.rows.reduce(
    (sum, r) => sum + (r.total_cents ?? 0),
    0,
  );

  // Section 3: Invoices needing follow-up (open/partially_paid sent today)
  const followUpInvoicesResult = await client.query<{
    id: string;
    total_cents: number;
    amount_paid_cents: number;
  }>(
    `SELECT id, total_cents, amount_paid_cents FROM invoices
     WHERE status IN ('open', 'partially_paid')
       AND sent_at >= $1
       AND sent_at < $2`,
    [utcDayStart, utcDayEnd],
  );
  const followUpInvoiceIds = followUpInvoicesResult.rows.map((r) => r.id);

  // Section 4: Appointments tomorrow
  const tomorrowAppointmentsResult = await client.query<{ id: string }>(
    `SELECT id FROM appointments
     WHERE scheduled_start >= $1
       AND scheduled_start < $2
       AND status != 'canceled'`,
    [utcTomorrowStart, utcTomorrowEnd],
  );
  const tomorrowAppointmentIds = tomorrowAppointmentsResult.rows.map((r) => r.id);

  // Section 5: Proposals with uncertain (low/very_low) confidence
  const uncertainProposalsResult = await client.query<{ id: string }>(
    `SELECT id FROM proposals
     WHERE status IN ('ready_for_review', 'draft')
       AND (
         payload->'_meta'->>'overallConfidence' IN ('low', 'very_low')
       )`,
  );
  const uncertainProposalIds = uncertainProposalsResult.rows.map((r) => r.id);

  // Section 6: Proposal correction knowledge chunks from today
  const correctionChunksResult = await client.query<{ id: string; content: string }>(
    `SELECT id, content FROM knowledge_chunks
     WHERE source_type = 'proposal_correction'
       AND created_at >= $1
       AND created_at < $2`,
    [utcDayStart, utcDayEnd],
  );
  const correctionChunkIds = correctionChunksResult.rows.map((r) => r.id);

  // Section 6 (N-009 / P2-038): correction-loop lessons applied today. Scoped
  // by tenant-local calendar day (local_date), so an 11pm edit lands in the
  // right day's digest regardless of UTC. Reverted lessons are excluded.
  const correctionLessonsResult = await client.query<{ id: string; summary: string }>(
    `SELECT id, summary FROM correction_lessons
     WHERE status = 'applied'
       AND local_date = $1
     ORDER BY created_at ASC`,
    [localDate],
  );
  const correctionLessonIds = correctionLessonsResult.rows.map((r) => r.id);
  const correctionLessonLines = correctionLessonsResult.rows.map((r) => r.summary);

  // Build sections
  const sections: DigestSection[] = [];

  // Section 1: Jobs completed
  const jobsLabel = 'Jobs wrapped up today';
  const jobsLines: string[] = [];
  if (completedJobIds.length === 0) {
    jobsLines.push('No jobs completed today.');
  } else {
    jobsLines.push(
      `${completedJobIds.length} ${completedJobIds.length === 1 ? 'job' : 'jobs'} completed.`,
    );
  }
  sections.push({ label: jobsLabel, lines: jobsLines });

  // Section 2: Estimates sent
  const estimatesLabel = 'Estimates sent today';
  const estimatesLines: string[] = [];
  if (sentEstimateIds.length === 0) {
    estimatesLines.push('No estimates sent today.');
  } else {
    estimatesLines.push(
      `${sentEstimateIds.length} ${sentEstimateIds.length === 1 ? 'estimate' : 'estimates'} sent — ${formatUsd(sentEstimatesTotalCents)} total.`,
    );
  }
  sections.push({ label: estimatesLabel, lines: estimatesLines });

  // Section 3: Invoices needing follow-up
  const invoicesLabel = 'Invoices out for payment';
  const invoicesLines: string[] = [];
  if (followUpInvoiceIds.length === 0) {
    invoicesLines.push('No invoices sent today.');
  } else {
    const totalOwing = followUpInvoicesResult.rows.reduce(
      (sum, r) => sum + (r.total_cents - r.amount_paid_cents),
      0,
    );
    invoicesLines.push(
      `${followUpInvoiceIds.length} ${followUpInvoiceIds.length === 1 ? 'invoice' : 'invoices'} sent — ${formatUsd(totalOwing)} outstanding.`,
    );
  }
  sections.push({ label: invoicesLabel, lines: invoicesLines });

  // Section 4: Tomorrow's schedule
  const tomorrowLabel = "Tomorrow's schedule";
  const tomorrowLines: string[] = [];
  if (tomorrowAppointmentIds.length === 0) {
    tomorrowLines.push('Nothing booked for tomorrow.');
  } else {
    tomorrowLines.push(
      `${tomorrowAppointmentIds.length} ${tomorrowAppointmentIds.length === 1 ? 'visit' : 'visits'} on the calendar.`,
    );
  }
  sections.push({ label: tomorrowLabel, lines: tomorrowLines });

  // Section 5: What I wasn't sure about (uncertain proposals) — omit when empty
  if (uncertainProposalIds.length > 0) {
    sections.push({
      label: "What I wasn't sure about",
      lines: [
        `${uncertainProposalIds.length} ${uncertainProposalIds.length === 1 ? 'proposal needs' : 'proposals need'} your review — confidence was low.`,
      ],
    });
  }

  // Section 6: What I learned today — omit when nothing learned. Prefer the
  // structured correction-loop lessons (one line each); fall back to the
  // knowledge-chunk count only when chunks exist but no structured lesson did.
  if (correctionLessonLines.length > 0) {
    sections.push({
      label: 'What I learned today',
      lines: correctionLessonLines,
    });
  } else if (correctionChunkIds.length > 0) {
    sections.push({
      label: 'What I learned today',
      lines: [
        `${correctionChunkIds.length} ${correctionChunkIds.length === 1 ? 'correction' : 'corrections'} applied to my knowledge base.`,
      ],
    });
  }

  const sourceData: DigestSourceData = {
    completedJobIds,
    sentEstimateIds,
    followUpInvoiceIds,
    tomorrowAppointmentIds,
    uncertainProposalIds,
    correctionChunkIds,
    correctionLessonIds,
  };

  return { sections, sourceData };
  });
}

