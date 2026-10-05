/**
 * #1602 — production voice-quality grades: the store seam.
 *
 * A `VoiceSessionGrade` is one graded production call: per-criterion
 * pass/fail with the judge's rationale, the model that judged it and what
 * it cost. Grades live in `voice_session_grades` (migration 305, RLS) and
 * are read back by the owner-facing `GET /api/voice/quality` and by the
 * platform SLO monitor's 7-day graded pass rate.
 *
 * The store also answers the three questions the grader and the nightly
 * worker ask of the EXISTING production tables, so the service never
 * reaches past this interface:
 *
 *   - `loadSession` — the stored transcript (`voice_sessions.transcript`,
 *     migration 092), the recording-disclosure evidence and the billable
 *     classification for one call (see `GradableVoiceSession`);
 *   - `listUngradedCandidates` — ended inbound calls in a window that
 *     carried the disclosure, were billable and have no grade yet;
 *   - `quota` / `countGradedSince` — the per-tenant sample rate + hard
 *     daily cap (tenant_settings, migration 305) and today's spend
 *     against it.
 */

export type VoiceGradeTrigger = 'nightly' | 'manual';

export type VoiceGraderName = 'floor' | 'disposition_llm' | 'perceived_completion';

export interface VoiceSessionGradeCriterion {
  /** Which existing grader produced this row. */
  grader: VoiceGraderName;
  /** Rubric v1 criterion id (3 = noHang, 10 = rightSlotsExtracted, 12 = rightCallerFacingAnswer). */
  criterion: number;
  /** Rubric v1 criterion name, as `ai/voice-quality/rubric/rubric.v1.json` spells it. */
  name: string;
  passed: boolean;
  /** The judge's rationale (LLM graders) or the mechanical check's reason. */
  rationale: string;
}

export interface VoiceSessionGrade {
  id: string;
  tenantId: string;
  sessionId: string;
  gradedAt: Date;
  /** Every graded criterion passed. */
  passed: boolean;
  criteria: VoiceSessionGradeCriterion[];
  /** Rubric that produced the criteria ('v1' today); read back from the row, never assumed. */
  rubricVersion: string;
  /** Model that answered the judge calls (last response's model id). */
  model: string;
  /** Number of LLM judge calls this grade cost. */
  judgeCalls: number;
  /** Summed `LLMResponse.costMicroCents` across the judge calls (0 when unpriced). */
  costMicroCents: number;
  trigger: VoiceGradeTrigger;
  /** The call's `voice_sessions.ended_at`, so pass rates window on the CALL, not the grading run. */
  callEndedAt: Date;
  /** The call's `voice_sessions.outcome` at grading time. */
  outcome: string | null;
}

/** What the grader needs to know about one production call. */
export interface GradableVoiceSession {
  id: string;
  tenantId: string;
  channel: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: string | null;
  /** `voice_sessions.transcript` — `"caller: …"` / `"agent: …"` lines in order. */
  transcript: string[];
  /**
   * Consent gate (#1602 §2). TRUE when the call carried the recording / AI
   * disclosure: a `consent_events` row `{ kind: 'recording', state:
   * 'implicit', source: 'voice', voice_session_id = this session }` — the row
   * each transport commits only once the disclosure actually PLAYED
   * (`DisclosureResult.commitConsentLedger`, disclose-recording.ts) — and no
   * later `{ kind: 'recording', state: 'revoked' }` for the same session.
   */
  recordingDisclosed: boolean;
  /**
   * `call_usage_events.billable` for this call (the owner / business-phone
   * test-call rule in billing/call-usage-events.ts `classifyCall`). `null`
   * when the ledger has no row for the session — treated as not gradable.
   */
  billable: boolean | null;
  /** Tenant IANA zone, so the judges read spoken dates on the right calendar. */
  timezone: string;
  /**
   * Stored timing markers, when the mid-call transcript persistence
   * (`call_transcript_turns.started_at`, keyed by call SID + session) captured
   * them. Absent → floor #3 (no hang) is not graded for this call.
   */
  turnTimings?: Array<{ speaker: 'caller' | 'agent'; startedAt: Date }>;
}

export interface VoiceQualityQuota {
  /** Share of eligible ended inbound calls to grade per night (0..100). */
  sampleRatePct: number;
  /** Hard ceiling on grades per tenant per UTC day. */
  dailyCap: number;
}

/**
 * Defaults when tenant_settings carries no override. A sample rate of 0 turns
 * grading OFF for the tenant (nightly and the owner's sample trigger alike);
 * a daily cap of 0 does the same.
 */
export const DEFAULT_VOICE_QUALITY_SAMPLE_RATE_PCT = 20;
export const DEFAULT_VOICE_QUALITY_DAILY_CAP = 20;

export interface VoiceQualityWindow {
  graded: number;
  passed: number;
}

export interface VoiceQualitySummary {
  /** Grades whose CALL ended in the trailing 7 / 30 days. */
  last7d: VoiceQualityWindow;
  last30d: VoiceQualityWindow;
  /** Most recently graded calls, newest first (at most `RECENT_GRADES_LIMIT`). */
  recent: VoiceSessionGrade[];
}

export const RECENT_GRADES_LIMIT = 10;

export interface ListCandidatesOptions {
  /** Calls that ended at/after this instant… */
  endedSince: Date;
  /** …and before this one. */
  endedBefore: Date;
  limit: number;
}

export interface VoiceSessionGradeStore {
  loadSession(tenantId: string, sessionId: string): Promise<GradableVoiceSession | null>;
  findGrade(tenantId: string, sessionId: string): Promise<VoiceSessionGrade | null>;
  /**
   * Session ids of ended `voice_inbound` calls in the window that carried the
   * disclosure, were billable, have a non-empty transcript and no grade yet.
   * Newest first.
   */
  listUngradedCandidates(tenantId: string, opts: ListCandidatesOptions): Promise<string[]>;
  /**
   * How many calls in the window are eligible at all (graded or not). The
   * nightly sample size is a share of THIS, so grades landing during the
   * night never shrink the night's target.
   */
  countEligible(tenantId: string, opts: Pick<ListCandidatesOptions, 'endedSince' | 'endedBefore'>): Promise<number>;
  countGradedSince(tenantId: string, since: Date): Promise<number>;
  quota(tenantId: string): Promise<VoiceQualityQuota>;
  /** Upsert on (tenant, session): a manual re-grade replaces the earlier grade. */
  saveGrade(grade: VoiceSessionGrade): Promise<void>;
  summary(tenantId: string, now: Date): Promise<VoiceQualitySummary>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** In-memory store for unit tests and in-memory dev boots. */
export class InMemoryVoiceSessionGradeStore implements VoiceSessionGradeStore {
  private readonly sessions = new Map<string, GradableVoiceSession>();
  private readonly grades = new Map<string, VoiceSessionGrade>();
  private readonly quotas = new Map<string, VoiceQualityQuota>();

  seedSession(session: Omit<GradableVoiceSession, 'timezone'> & { timezone?: string }): void {
    this.sessions.set(key(session.tenantId, session.id), {
      ...session,
      timezone: session.timezone ?? 'America/New_York',
    });
  }

  setQuota(tenantId: string, quota: VoiceQualityQuota): void {
    this.quotas.set(tenantId, quota);
  }

  async loadSession(tenantId: string, sessionId: string): Promise<GradableVoiceSession | null> {
    return this.sessions.get(key(tenantId, sessionId)) ?? null;
  }

  async findGrade(tenantId: string, sessionId: string): Promise<VoiceSessionGrade | null> {
    return this.grades.get(key(tenantId, sessionId)) ?? null;
  }

  private eligible(
    tenantId: string,
    opts: Pick<ListCandidatesOptions, 'endedSince' | 'endedBefore'>,
  ): GradableVoiceSession[] {
    return [...this.sessions.values()].filter(
      (s) =>
        s.tenantId === tenantId &&
        s.channel === 'voice_inbound' &&
        s.endedAt !== null &&
        s.endedAt >= opts.endedSince &&
        s.endedAt < opts.endedBefore &&
        s.recordingDisclosed &&
        s.billable === true &&
        s.transcript.length > 0,
    );
  }

  async listUngradedCandidates(tenantId: string, opts: ListCandidatesOptions): Promise<string[]> {
    return this.eligible(tenantId, opts)
      .filter((s) => !this.grades.has(key(tenantId, s.id)))
      .sort((a, b) => b.endedAt!.getTime() - a.endedAt!.getTime())
      .slice(0, opts.limit)
      .map((s) => s.id);
  }

  async countEligible(
    tenantId: string,
    opts: Pick<ListCandidatesOptions, 'endedSince' | 'endedBefore'>,
  ): Promise<number> {
    return this.eligible(tenantId, opts).length;
  }

  async countGradedSince(tenantId: string, since: Date): Promise<number> {
    return [...this.grades.values()].filter((g) => g.tenantId === tenantId && g.gradedAt >= since)
      .length;
  }

  async quota(tenantId: string): Promise<VoiceQualityQuota> {
    return (
      this.quotas.get(tenantId) ?? {
        sampleRatePct: DEFAULT_VOICE_QUALITY_SAMPLE_RATE_PCT,
        dailyCap: DEFAULT_VOICE_QUALITY_DAILY_CAP,
      }
    );
  }

  async saveGrade(grade: VoiceSessionGrade): Promise<void> {
    this.grades.set(key(grade.tenantId, grade.sessionId), { ...grade, criteria: [...grade.criteria] });
  }

  async summary(tenantId: string, now: Date): Promise<VoiceQualitySummary> {
    const all = [...this.grades.values()].filter((g) => g.tenantId === tenantId);
    const window = (days: number): VoiceQualityWindow => {
      const since = new Date(now.getTime() - days * DAY_MS);
      const inWindow = all.filter((g) => g.callEndedAt >= since && g.callEndedAt <= now);
      return { graded: inWindow.length, passed: inWindow.filter((g) => g.passed).length };
    };
    // Newest grade first; grades from the same pass share a timestamp, so the
    // newer CALL wins the tie (the Pg store orders the same way).
    const recent = [...all]
      .sort(
        (a, b) =>
          b.gradedAt.getTime() - a.gradedAt.getTime() ||
          b.callEndedAt.getTime() - a.callEndedAt.getTime(),
      )
      .slice(0, RECENT_GRADES_LIMIT);
    return { last7d: window(7), last30d: window(30), recent };
  }
}

function key(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
}
