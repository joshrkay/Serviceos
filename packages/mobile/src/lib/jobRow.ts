// Row presentation for the Jobs list. Mirrors the API Job shape served by
// GET /api/jobs (packages/api/src/jobs/job.ts → JobListResult.data): each row
// carries `jobNumber` + `summary` + `status`. The screen previously read
// `title` / `customerName` / `customer_name`, which the API never returns, so
// every row fell back to "Job <uuid>". Kept pure so it's unit-tested.

export interface JobRow {
  id: string;
  jobNumber?: string;
  summary?: string;
  status?: string;
}

export interface JobRowText {
  primary: string;
  secondary?: string;
}

export function jobRowText(job: JobRow): JobRowText {
  const summary = job.summary?.trim();
  // Prefer the human-readable summary; fall back to the job number, then to a
  // short id so a row is never blank.
  const primary = summary || job.jobNumber || `Job ${job.id.slice(0, 8)}`;
  // When the summary is the headline, keep the job number visible alongside the
  // status on the secondary line; otherwise just show the status.
  const parts = [summary ? job.jobNumber : undefined, job.status].filter(
    (p): p is string => Boolean(p),
  );
  return { primary, secondary: parts.length > 0 ? parts.join(' · ') : undefined };
}
