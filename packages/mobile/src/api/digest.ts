/**
 * Digest API client — GET /api/digests/:date for the mobile digest screens.
 *
 * Mirrors the web digest view (`packages/web/src/pages/digest/DigestPage.tsx`);
 * accepts an AuthedFetch client from `useApiClient` so the Clerk JWT is attached.
 */
import { decodeError } from '../lib/appError';
import type { AuthedFetch } from './me';

export interface DigestPendingApproval {
  proposalId: string;
  proposalType: string;
  summary: string;
  customerName?: string;
  amountCents?: number;
  overallConfidence?: string;
  reviewInApp?: true;
}

export interface DigestUnbilledJob {
  jobId: string;
  customerId: string;
  customerName?: string;
  amountCents: number;
}

/** Mirrors `DailyDigestPayload` from packages/api digest-service. */
export interface DigestPayload {
  date: string;
  timezone: string;
  revenueCents: number;
  grossRevenueCents: number;
  refundsCents: number;
  paymentsCount: number;
  jobsCompletedCount: number;
  tomorrow: { appointmentCount: number; firstStartIso: string | null };
  pendingApprovals: { totalCount: number; top: DigestPendingApproval[] };
  overdueInvoicesCount: number;
  unbilledJobs: DigestUnbilledJob[];
}

export interface DigestResponse {
  date: string;
  payload: DigestPayload;
  narrative: string | null;
  generatedAt: string;
}

export async function fetchDigest(
  client: AuthedFetch,
  date: string | 'latest',
): Promise<DigestResponse> {
  const res = await client(`/api/digests/${encodeURIComponent(date)}`);
  if (!res.ok) {
    const err = await decodeError(res);
    throw new Error(err.message);
  }
  const body = (await res.json()) as { data: DigestResponse };
  return body.data;
}

/** Short summary line for the payload section (revenue + field count). */
export function formatDigestPayloadSummary(
  payload: DigestPayload,
  formatRevenue: (cents: number) => string = (cents) => `$${(cents / 100).toFixed(2)}`,
): string {
  const parts: string[] = [];
  if (typeof payload.revenueCents === 'number') {
    parts.push(`${formatRevenue(payload.revenueCents)} revenue`);
  }
  parts.push(`${Object.keys(payload).length} payload fields`);
  return parts.join(' · ');
}
