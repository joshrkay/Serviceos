/**
 * Owner digest + morning briefing copy (JTBD #7 — Admin Reduction).
 *
 * Pure rendering of a tenant's day into a short, warm, glove-friendly SMS
 * the owner reads in two seconds — the "here's your day, here's what
 * needs you" that reclaims an evening. Stays under one SMS segment's
 * worth and surfaces only what's actionable (pending approvals), so it's
 * proactive without being noise.
 */

export interface DigestData {
  /** Jobs that moved to 'completed' in the tenant-local day. */
  jobsCompleted: number;
  /** Payments received today, integer cents. */
  revenueCents: number;
  /** Proposals waiting on the owner (ready_for_review + draft). */
  pendingApprovals: number;
  /** Count of invoices past due. */
  overdueInvoices: number;
  /** Appointments scheduled for tomorrow (end-of-day digest). */
  tomorrowAppointments: number;
  /** Appointments scheduled for today (morning briefing). */
  todayAppointments: number;
}

function formatMoney(cents: number): string {
  const dollars = cents / 100;
  // Whole-dollar when exact, else 2dp. "$2,150" / "$2,150.50".
  const opts: Intl.NumberFormatOptions =
    cents % 100 === 0
      ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `$${dollars.toLocaleString('en-US', opts)}`;
}

function jobsPhrase(n: number): string {
  if (n === 0) return 'No jobs marked done';
  return `${n} ${n === 1 ? 'job' : 'jobs'} done`;
}

function approvalsPhrase(n: number): string {
  if (n === 0) return 'Nothing needs your OK';
  return `${n} ${n === 1 ? 'thing needs' : 'things need'} your OK`;
}

const SMS_MAX = 320;
function clip(s: string): string {
  return s.length <= SMS_MAX ? s : `${s.slice(0, SMS_MAX - 1).trimEnd()}…`;
}

/**
 * End-of-day wrap-up. Example:
 *   "Today's wrap-up: 3 jobs done, $2,150 collected. 2 things need your
 *    OK. Tomorrow: 4 jobs booked."
 */
export function renderEndOfDayDigest(data: DigestData): string {
  const parts: string[] = [
    `Today's wrap-up: ${jobsPhrase(data.jobsCompleted)}, ${formatMoney(data.revenueCents)} collected.`,
    `${approvalsPhrase(data.pendingApprovals)}.`,
  ];
  if (data.overdueInvoices > 0) {
    parts.push(
      `${data.overdueInvoices} ${data.overdueInvoices === 1 ? 'invoice is' : 'invoices are'} overdue.`,
    );
  }
  parts.push(
    data.tomorrowAppointments > 0
      ? `Tomorrow: ${data.tomorrowAppointments} ${data.tomorrowAppointments === 1 ? 'job' : 'jobs'} booked.`
      : 'Tomorrow: nothing booked yet.',
  );
  return clip(parts.join(' '));
}

/**
 * Morning briefing. Example:
 *   "Good morning! Today: 4 jobs booked. 2 things still need your OK.
 *    1 invoice overdue."
 */
export function renderMorningBriefing(data: DigestData): string {
  const parts: string[] = [
    `Good morning! Today: ${
      data.todayAppointments > 0
        ? `${data.todayAppointments} ${data.todayAppointments === 1 ? 'job' : 'jobs'} booked.`
        : 'nothing booked yet.'
    }`,
  ];
  if (data.pendingApprovals > 0) {
    parts.push(`${approvalsPhrase(data.pendingApprovals)} from yesterday.`);
  }
  if (data.overdueInvoices > 0) {
    parts.push(
      `${data.overdueInvoices} ${data.overdueInvoices === 1 ? 'invoice is' : 'invoices are'} overdue.`,
    );
  }
  return clip(parts.join(' '));
}

/** True when there's nothing worth a notification (skip the send). */
export function isEmptyDigest(data: DigestData): boolean {
  return (
    data.jobsCompleted === 0 &&
    data.revenueCents === 0 &&
    data.pendingApprovals === 0 &&
    data.overdueInvoices === 0 &&
    data.tomorrowAppointments === 0 &&
    data.todayAppointments === 0
  );
}
