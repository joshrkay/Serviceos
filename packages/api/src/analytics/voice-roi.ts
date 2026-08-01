import type { Proposal, ProposalRepository } from '../proposals/proposal';
import {
  type BusinessHoursConfig,
  checkBusinessHours,
} from '../compliance/business-hours';

/**
 * Epic 12.5 — Voice ROI metrics.
 *
 * `computeVoiceRoi` is pure: given already-fetched inbound voice sessions,
 * the tenant's executed proposals, the tenant's business-hours config, and
 * a window, it returns the owner-facing ROI headline. Repositories fetch the
 * rows; this function owns the math so it can be unit-tested without a DB.
 *
 * Why these definitions (documented so the numbers are auditable):
 *
 *  - inboundCalls: voice sessions on the `voice_inbound` channel that began
 *    inside the window. The agent's call volume.
 *  - answeredCalls: inbound calls the agent actually engaged — the session
 *    reached a terminal state (`endedAt` set) with an outcome other than the
 *    system-failure `'failed'`. A caller who hung up (`'dropped'`) still
 *    counts: the agent picked up. A `'failed'` session is a system error, not
 *    an answered call.
 *  - bookedByAgent: executed booking proposals in the window. Per the system
 *    invariant the agent never auto-books — every agent booking is an executed
 *    `create_appointment` / `create_booking` proposal a human approved. That
 *    executed proposal is the canonical "the agent booked a job" signal, so we
 *    count it rather than guessing a link from a call row (voice_sessions has
 *    no booking FK).
 *  - afterHoursCaptures: answered inbound calls that began outside the
 *    tenant's configured business hours. Only counts when a schedule exists —
 *    `checkBusinessHours` fails open (treats unconfigured tenants as always
 *    open), so we never claim an after-hours capture we can't substantiate.
 *  - wouldHaveHitVoicemail: the ROI headline — answered inbound calls a human
 *    would have missed, so without the agent they would have rolled to
 *    voicemail. That is the union (deduped) of: (a) after-hours captures, and
 *    (b) calls that overlapped another live inbound call (the line was busy).
 *    A superset of afterHoursCaptures, never smaller.
 */

const INBOUND_CHANNEL = 'voice_inbound';

/** Outcome that means the agent never engaged — a system failure, not a call. */
const UNANSWERED_OUTCOME = 'failed';

/** Booking proposal types the agent emits; an executed one = a booked job. */
const BOOKING_PROPOSAL_TYPES: ReadonlySet<string> = new Set([
  'create_appointment',
  'create_booking',
]);

/** Minimal structural shape the rollup needs from a voice session. */
export interface VoiceRoiSession {
  channel: string;
  startedAt: Date;
  endedAt?: Date;
  outcome?: string;
}

export interface VoiceRoiInput {
  sessions: VoiceRoiSession[];
  /** All tenant proposals; the rollup filters to executed booking types. */
  proposals: Proposal[];
  /** Tenant business hours; null/empty → no after-hours attribution. */
  businessHours: BusinessHoursConfig | null;
  windowStart: Date;
  windowEnd: Date;
}

export interface VoiceRoiSummary {
  /** ISO bounds of the window, echoed for the client. */
  windowStart: string;
  windowEnd: string;
  inboundCalls: number;
  answeredCalls: number;
  bookedByAgent: number;
  afterHoursCaptures: number;
  /** ROI headline: after-hours + line-busy captures, deduped. */
  wouldHaveHitVoicemail: number;
  /** answeredCalls / inboundCalls in [0,1]; 0 when there were no inbound calls. */
  answerRate: number;
}

function inWindow(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}

function isAnswered(s: VoiceRoiSession): boolean {
  return s.endedAt !== undefined && s.outcome !== UNANSWERED_OUTCOME;
}

/** True if `a` and `b` overlap in time. Calls still open (no endedAt) cannot
 * be proven to overlap, so they never contribute a line-busy capture. */
function overlaps(a: VoiceRoiSession, b: VoiceRoiSession): boolean {
  if (!a.endedAt || !b.endedAt) return false;
  return a.startedAt.getTime() < b.endedAt.getTime() && b.startedAt.getTime() < a.endedAt.getTime();
}

export function computeVoiceRoi(input: VoiceRoiInput): VoiceRoiSummary {
  const { sessions, proposals, businessHours, windowStart, windowEnd } = input;

  const inbound = sessions.filter(
    (s) => s.channel === INBOUND_CHANNEL && inWindow(s.startedAt, windowStart, windowEnd),
  );
  const answered = inbound.filter(isAnswered);

  let afterHoursCaptures = 0;
  let wouldHaveHitVoicemail = 0;
  for (const call of answered) {
    const isAfterHours = !checkBusinessHours(businessHours, call.startedAt).isOpen;
    if (isAfterHours) afterHoursCaptures += 1;
    // Line-busy: this answered call overlapped any other inbound call.
    const lineBusy = inbound.some((other) => other !== call && overlaps(call, other));
    if (isAfterHours || lineBusy) wouldHaveHitVoicemail += 1;
  }

  let bookedByAgent = 0;
  for (const p of proposals) {
    if (p.status !== 'executed') continue;
    if (!BOOKING_PROPOSAL_TYPES.has(p.proposalType)) continue;
    const at = p.executedAt ?? p.updatedAt;
    if (!at || !inWindow(at, windowStart, windowEnd)) continue;
    bookedByAgent += 1;
  }

  const answerRate = inbound.length === 0 ? 0 : answered.length / inbound.length;

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    inboundCalls: inbound.length,
    answeredCalls: answered.length,
    bookedByAgent,
    afterHoursCaptures,
    wouldHaveHitVoicemail,
    answerRate: Math.round(answerRate * 100) / 100,
  };
}

/**
 * Repository seam for the route. The reporter composes the existing
 * voice-session + proposal repositories (each already RLS-scoped) and an
 * optional business-hours loader, then runs the single tested
 * `computeVoiceRoi`.
 */
export interface VoiceRoiReporter {
  query(tenantId: string, now: Date, opts?: { days?: number }): Promise<VoiceRoiSummary>;
}

/**
 * The voice-session repo, structurally — the reporter only lists a tenant's
 * sessions and reads channel/startedAt/endedAt/outcome. Kept minimal so the
 * reporter does not couple to the full VoiceSessionRepository surface. The
 * production wiring passes `{ limit: 10000 }` so the default 50-row cap does
 * not silently undercount calls.
 */
export interface VoiceRoiSessionRepository {
  findByTenant(
    tenantId: string,
    opts?: { limit?: number; endedOnly?: boolean },
  ): Promise<VoiceRoiSession[]>;
}

export const DEFAULT_VOICE_ROI_WINDOW_DAYS = 30;

export class RepoBackedVoiceRoiReporter implements VoiceRoiReporter {
  constructor(
    private readonly voiceSessionRepo: VoiceRoiSessionRepository,
    private readonly proposalRepo: ProposalRepository,
    private readonly businessHoursLoader?: (
      tenantId: string,
    ) => Promise<BusinessHoursConfig | null>,
  ) {}

  async query(
    tenantId: string,
    now: Date,
    opts: { days?: number } = {},
  ): Promise<VoiceRoiSummary> {
    const days = opts.days ?? DEFAULT_VOICE_ROI_WINDOW_DAYS;
    const windowEnd = new Date(now.getTime());
    const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const [sessions, proposals, businessHours] = await Promise.all([
      this.voiceSessionRepo.findByTenant(tenantId, { limit: 10000 }),
      this.proposalRepo.findByTenant(tenantId),
      this.businessHoursLoader
        ? this.businessHoursLoader(tenantId)
        : Promise.resolve(null),
    ]);
    return computeVoiceRoi({ sessions, proposals, businessHours, windowStart, windowEnd });
  }
}
