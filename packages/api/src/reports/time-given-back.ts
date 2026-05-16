import type { Proposal, ProposalType, ProposalRepository } from '../proposals/proposal';
import type { SettingsRepository } from '../settings/settings';
import {
  TIME_CREDIT_VERSION,
  CALL_HANDLED_CREDIT_MINUTES,
  creditForProposalType,
} from './time-credits';

/**
 * §9 — the "Time Given Back" rollup.
 *
 * `computeTimeGivenBack` is pure: it takes already-fetched proposals
 * and voice sessions, a week window, and the tenant's hourly rate, and
 * returns the weekly summary + a legible receipt. Repositories fetch
 * the rows; this function owns the math.
 *
 * What counts:
 *  - Executed proposals (status === 'executed') whose executedAt — or
 *    updatedAt, if executedAt is missing on a historical row — falls
 *    inside [weekStart, weekEnd). Each credits `creditForProposalType`.
 *  - Voice sessions with an `endedAt` inside the window. Each credits
 *    `CALL_HANDLED_CREDIT_MINUTES`.
 */
export interface TimeGivenBackReceipt {
  /** Calls the agent handled end to end this week. */
  callsAnswered: number;
  /** Executed proposals counted this week. */
  proposalsHandled: number;
  /** Count of executed proposals by type — drives the legible receipt. */
  byProposalType: Partial<Record<ProposalType, number>>;
}

export interface TimeGivenBackSummary {
  /** ISO bounds of the window, echoed for the client. */
  weekStart: string;
  weekEnd: string;
  totalMinutes: number;
  /** totalMinutes / 60, rounded to one decimal. */
  totalHours: number;
  /** totalHours × hourlyRateCents, integer cents — or null if rate unset. */
  dollarValueCents: number | null;
  receipt: TimeGivenBackReceipt;
  /** The time-credit calibration that produced these numbers. */
  creditVersion: string;
}

/** Minimal structural shape the rollup needs from a voice session. */
export interface CountableVoiceSession {
  endedAt?: Date;
}

export interface TimeGivenBackInput {
  proposals: Proposal[];
  voiceSessions: CountableVoiceSession[];
  hourlyRateCents: number | null;
  weekStart: Date;
  weekEnd: Date;
}

function inWindow(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}

/** A 7-day [start, end) window ending at `now`. */
export function currentWeekWindow(now: Date): { weekStart: Date; weekEnd: Date } {
  const weekEnd = new Date(now.getTime());
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { weekStart, weekEnd };
}

export function computeTimeGivenBack(input: TimeGivenBackInput): TimeGivenBackSummary {
  const { weekStart, weekEnd } = input;

  const byProposalType: Partial<Record<ProposalType, number>> = {};
  let proposalMinutes = 0;
  let proposalsHandled = 0;

  for (const p of input.proposals) {
    if (p.status !== 'executed') continue;
    const at = p.executedAt ?? p.updatedAt;
    if (!at || !inWindow(at, weekStart, weekEnd)) continue;
    proposalMinutes += creditForProposalType(p.proposalType);
    proposalsHandled += 1;
    byProposalType[p.proposalType] = (byProposalType[p.proposalType] ?? 0) + 1;
  }

  const callsAnswered = input.voiceSessions.filter(
    (s) => s.endedAt !== undefined && inWindow(s.endedAt, weekStart, weekEnd),
  ).length;
  const callMinutes = callsAnswered * CALL_HANDLED_CREDIT_MINUTES;

  const totalMinutes = proposalMinutes + callMinutes;
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10;
  const dollarValueCents =
    input.hourlyRateCents != null
      ? Math.round(totalHours * input.hourlyRateCents)
      : null;

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    totalMinutes,
    totalHours,
    dollarValueCents,
    receipt: { callsAnswered, proposalsHandled, byProposalType },
    creditVersion: TIME_CREDIT_VERSION,
  };
}

/**
 * Repository seam for the route. The reporter composes the existing
 * proposal / voice-session / settings repositories and runs
 * `computeTimeGivenBack`.
 */
export interface TimeGivenBackReporter {
  query(tenantId: string, now: Date): Promise<TimeGivenBackSummary>;
}

/**
 * The voice-session repo, structurally — the reporter only needs to
 * list a tenant's sessions and read each one's `endedAt`. Kept minimal
 * so the reporter does not couple to the full VoiceSessionRepository
 * surface (see packages/api/src/voice/voice-session.ts). The optional
 * opts mirror VoiceSessionRepository.findByTenant — production wiring
 * passes `{ endedOnly: true, limit: 10000 }` to avoid the default
 * 50-row cap silently undercounting calls.
 */
export interface CountableVoiceSessionRepository {
  findByTenant(
    tenantId: string,
    opts?: { endedOnly?: boolean; limit?: number },
  ): Promise<CountableVoiceSession[]>;
}

/**
 * Production + test reporter. Composes the existing tenant-scoped
 * repositories — each already RLS-scoped — and runs the single tested
 * `computeTimeGivenBack`. One implementation serves both the Pg and
 * in-memory boot paths because the repositories abstract storage.
 *
 * `voiceSessionRepo` is optional: if it is not wired, handled-call
 * credits contribute zero rather than failing the whole rollup.
 */
export class RepoBackedTimeGivenBackReporter implements TimeGivenBackReporter {
  constructor(
    private readonly proposalRepo: ProposalRepository,
    private readonly settingsRepo: SettingsRepository,
    private readonly voiceSessionRepo?: CountableVoiceSessionRepository,
  ) {}

  async query(tenantId: string, now: Date): Promise<TimeGivenBackSummary> {
    const { weekStart, weekEnd } = currentWeekWindow(now);
    const [proposals, settings, voiceSessions] = await Promise.all([
      this.proposalRepo.findByTenant(tenantId),
      this.settingsRepo.findByTenant(tenantId),
      this.voiceSessionRepo
        ? this.voiceSessionRepo.findByTenant(tenantId, { endedOnly: true, limit: 10000 })
        : Promise.resolve([] as CountableVoiceSession[]),
    ]);
    return computeTimeGivenBack({
      proposals,
      voiceSessions,
      hourlyRateCents: settings?.hourlyRateCents ?? null,
      weekStart,
      weekEnd,
    });
  }
}
