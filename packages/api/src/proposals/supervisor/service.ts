/**
 * Rivet P2 F-1 — SupervisorPolicyService: the async half of the
 * deterministic supervisor.
 *
 * Implements the synchronous SupervisorCreationHook contract on top of
 * a per-tenant SNAPSHOT CACHE (rules + flag gate + current-window
 * counters). `evaluate` never does I/O: it reads the snapshot and runs
 * the pure engine. A missing/expired snapshot triggers a deduplicated
 * background refresh and the evaluation FAILS OPEN (returns null =
 * permissive parity) until the snapshot lands — a deliberate v1
 * trade-off so proposal creation never blocks on (or breaks because
 * of) the policy store. Counter snapshots are therefore approximate
 * across instances within the TTL; in-process increments are applied
 * optimistically so a single instance enforces its caps promptly.
 *
 * Counter windows are UTC (see budget-counters-repo.ts). Both side
 * channels (counter increments, audit writes) are fire-and-forget and
 * failure-isolated: a down DB can never turn into a proposal-creation
 * error.
 *
 * Settings/API exposure of policy versions (create/activate routes) is
 * DEFERRED — this track ships the engine, storage, hook and annotator
 * only; tenants get policies via ops tooling until the settings UI
 * lands in a follow-up.
 */
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import {
  actionClassForProposalType,
  Proposal,
  ProposalRepository,
} from '../proposal';
import { payloadHeadlineCents } from '../payload-money';
import {
  AUTO_APPROVALS_COUNTER_KEY,
  DAILY_SPEND_COUNTER_KEY,
  TenantBudgetCounterRepository,
  utcDayWindowStart,
  utcHourWindowStart,
} from './budget-counters-repo';
import type { SupervisorCreationHook, SupervisorCreationHookInput } from './hook';
import {
  DEFAULT_SUPERVISOR_RULES,
  evaluateSupervisorPolicy,
  PLATFORM_DEFAULT_SUPERVISOR_RULES,
  SupervisorDecision,
  SupervisorRules,
} from './policy';
import { SupervisorPolicyRepository } from './policies-repo';

/** Audit event emitted when a 'block' verdict suppressed normal routing. */
export const SUPERVISOR_BLOCKED_EVENT = 'supervisor.blocked_auto_approve';
/** Audit event emitted when a 'force_review' verdict capped the status. */
export const SUPERVISOR_FORCED_REVIEW_EVENT = 'supervisor.forced_review';

interface TenantSnapshot {
  enabled: boolean;
  rules: SupervisorRules;
  dayWindowStartMs: number;
  hourWindowStartMs: number;
  dailySpendCents: number;
  autoApprovalsThisHour: number;
  expiresAtMs: number;
}

interface SupervisorLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface SupervisorPolicyServiceDeps {
  policies: SupervisorPolicyRepository;
  counters: TenantBudgetCounterRepository;
  /** When provided, non-'allow' verdicts emit audit events. */
  auditRepo?: AuditRepository;
  /**
   * Per-tenant kill switch (flag key 'supervisor_agent' in production).
   * Absent → enabled for every tenant (tests / explicit dev wiring).
   */
  isEnabledForTenant?: (tenantId: string) => Promise<boolean>;
  /**
   * U3 — platform-default caps applied to tenants with NO provisioned policy
   * row. Lets the supervisor ship default-on with conservative budget caps for
   * everyone, while a per-tenant `supervisor_policies` row still overrides.
   * Absent → the permissive engine default (no caps), preserving prior tests.
   */
  defaultRules?: SupervisorRules;
  logger?: SupervisorLogger;
  /** Snapshot TTL; matches the tenant-flag cache order of magnitude. */
  snapshotTtlMs?: number;
  now?: () => Date;
}

const DEFAULT_SNAPSHOT_TTL_MS = 30_000;

/** Consecutive snapshot-refresh failures before escalating warn → error. */
const REFRESH_ERROR_ESCALATION_THRESHOLD = 3;

export class SupervisorPolicyService implements SupervisorCreationHook {
  private readonly snapshots = new Map<string, TenantSnapshot>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** Consecutive refresh failures per tenant; reset on success. */
  private readonly refreshFailures = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly logger: SupervisorLogger;
  private readonly now: () => Date;

  constructor(private readonly deps: SupervisorPolicyServiceDeps) {
    this.ttlMs = deps.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    // eslint-disable-next-line no-console
    this.logger = deps.logger ?? { warn: (m, meta) => console.warn(m, meta) };
    this.now = deps.now ?? (() => new Date());
  }

  evaluate(input: SupervisorCreationHookInput): SupervisorDecision | null {
    const now = this.now();
    const snapshot = this.snapshots.get(input.tenantId);

    // Kill-switch precedence (Rivet P2 review): the per-tenant flag gate must
    // short-circuit BEFORE any stale-snapshot enforcement. A readable 'false'
    // means the tenant has turned the supervisor OFF; we must not apply a
    // stale-but-enabled snapshot in that case. If the flag read fails we keep
    // the current behavior (fail-open → permissive).
    //
    // The flag gate is async (`isEnabledForTenant`), but `evaluate` is
    // intentionally synchronous (50+ call sites, synchronous hot path). The
    // SNAPSHOT already captures the flag value from the last refresh: when the
    // flag is false the refresh stores `enabled: false`, so the check below is
    // synchronous and correct. A stale snapshot with `enabled: false` is safe:
    // it means the supervisor was last seen OFF → permissive is the right
    // outcome. A stale snapshot with `enabled: true` will be refreshed below;
    // if the flag has since flipped to false, the next refresh will store the
    // new state.
    if (snapshot && !snapshot.enabled) return null;

    if (!snapshot || snapshot.expiresAtMs <= now.getTime()) {
      // Stale or cold: refresh in the background (deduplicated). A cold
      // cache evaluates permissive (fail-open); a stale one keeps
      // serving the previous snapshot until the refresh lands.
      void this.refresh(input.tenantId);
    }
    if (!snapshot) return null;

    // Counter values only apply inside their window; when the cached
    // window has rolled over, the fresh window starts at zero until the
    // background refresh replaces the snapshot.
    const dayStartMs = utcDayWindowStart(now).getTime();
    const hourStartMs = utcHourWindowStart(now).getTime();
    return evaluateSupervisorPolicy(
      {
        proposalType: input.proposalType,
        actionClass: input.actionClass,
        amountCents: input.amountCents,
        counters: {
          dailySpendCents:
            snapshot.dayWindowStartMs === dayStartMs ? snapshot.dailySpendCents : 0,
          autoApprovalsThisHour:
            snapshot.hourWindowStartMs === hourStartMs ? snapshot.autoApprovalsThisHour : 0,
        },
      },
      snapshot.rules,
    );
  }

  onAutoApproved(tenantId: string): void {
    // Only counted while the supervisor is active for the tenant — the
    // budget is a supervisor concept; permissive tenants don't pay a
    // counter write per auto-approval.
    const snapshot = this.snapshots.get(tenantId);
    if (!snapshot || !snapshot.enabled) return;
    const now = this.now();
    const hourStart = utcHourWindowStart(now);
    if (snapshot.hourWindowStartMs !== hourStart.getTime()) {
      snapshot.hourWindowStartMs = hourStart.getTime();
      snapshot.autoApprovalsThisHour = 0;
    }
    snapshot.autoApprovalsThisHour += 1;
    void this.deps.counters
      .increment(tenantId, AUTO_APPROVALS_COUNTER_KEY, hourStart, 1)
      .catch((err) =>
        this.logger.warn('supervisor: auto-approval counter increment failed', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  onDecision(proposal: Proposal, decision: SupervisorDecision): void {
    if (decision.verdict === 'allow' || !this.deps.auditRepo) return;
    const eventType =
      decision.verdict === 'block' ? SUPERVISOR_BLOCKED_EVENT : SUPERVISOR_FORCED_REVIEW_EVENT;
    void this.deps.auditRepo
      .create(
        createAuditEvent({
          tenantId: proposal.tenantId,
          actorId: 'supervisor-agent',
          actorRole: 'system',
          eventType,
          entityType: 'proposal',
          entityId: proposal.id,
          metadata: {
            proposalType: proposal.proposalType,
            status: proposal.status,
            verdict: decision.verdict,
            reasons: decision.reasons,
          },
        }),
      )
      .catch((err) =>
        this.logger.warn('supervisor: audit write failed', {
          tenantId: proposal.tenantId,
          proposalId: proposal.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  /**
   * Executed money-class spend feeds the daily cap. Called from the
   * executor's onExecuted seam (see recordExecutedProposalSpend) —
   * throws are contained there; here we also update the local snapshot
   * so the cap engages in-process without waiting for a refresh.
   */
  async recordExecutedSpend(tenantId: string, amountCents: number, at?: Date): Promise<void> {
    const when = at ?? this.now();
    const dayStart = utcDayWindowStart(when);
    await this.deps.counters.increment(tenantId, DAILY_SPEND_COUNTER_KEY, dayStart, amountCents);
    const snapshot = this.snapshots.get(tenantId);
    if (snapshot) {
      if (snapshot.dayWindowStartMs !== dayStart.getTime()) {
        snapshot.dayWindowStartMs = dayStart.getTime();
        snapshot.dailySpendCents = 0;
      }
      snapshot.dailySpendCents += amountCents;
    }
  }

  /** Load (or force-reload) a tenant snapshot. Awaitable for tests/boot warmup. */
  async prime(tenantId: string): Promise<void> {
    await this.refresh(tenantId);
  }

  private refresh(tenantId: string): Promise<void> {
    const existing = this.inflight.get(tenantId);
    if (existing) return existing;
    const job = (async () => {
      try {
        const now = this.now();

        // Kill-switch precedence: read the flag gate FIRST. A 'false' result
        // means the supervisor is OFF for this tenant; store an
        // `enabled: false` snapshot so evaluate() short-circuits immediately.
        // A flag-read FAILURE is treated as "unknown" — we fall through to
        // load the policy snapshot so the existing stale-snapshot behavior is
        // preserved (fail-open on flag errors, not fail-closed).
        let enabled = true;
        if (this.deps.isEnabledForTenant) {
          try {
            enabled = await this.deps.isEnabledForTenant(tenantId);
          } catch {
            // Flag-read failure: keep enabled=true and fall through to
            // snapshot refresh — current behavior preserved.
          }
        }
        if (!enabled) {
          this.snapshots.set(tenantId, {
            enabled: false,
            rules: DEFAULT_SUPERVISOR_RULES,
            dayWindowStartMs: 0,
            hourWindowStartMs: 0,
            dailySpendCents: 0,
            autoApprovalsThisHour: 0,
            expiresAtMs: now.getTime() + this.ttlMs,
          });
          this.refreshFailures.delete(tenantId);
          return;
        }
        const active = await this.deps.policies.getActive(tenantId);
        // Precedence: a provisioned tenant policy wins; else the platform
        // default caps (U3); else the permissive engine default (no caps).
        const rules = active?.rules ?? this.deps.defaultRules ?? DEFAULT_SUPERVISOR_RULES;
        const dayStart = utcDayWindowStart(now);
        const hourStart = utcHourWindowStart(now);
        const [dailySpendCents, autoApprovalsThisHour] = await Promise.all([
          this.deps.counters.read(tenantId, DAILY_SPEND_COUNTER_KEY, dayStart),
          this.deps.counters.read(tenantId, AUTO_APPROVALS_COUNTER_KEY, hourStart),
        ]);
        this.snapshots.set(tenantId, {
          enabled: true,
          rules,
          dayWindowStartMs: dayStart.getTime(),
          hourWindowStartMs: hourStart.getTime(),
          dailySpendCents,
          autoApprovalsThisHour,
          expiresAtMs: now.getTime() + this.ttlMs,
        });
        // Success: reset the consecutive-failure counter.
        this.refreshFailures.delete(tenantId);
      } catch (err) {
        // Fail open: keep the stale snapshot (or none). The next
        // evaluate() retries the refresh.
        //
        // Observability escalation: after REFRESH_ERROR_ESCALATION_THRESHOLD
        // consecutive failures for the same tenant, emit logger.error ONCE
        // (a greppable signal for on-call), then revert to warn. This avoids
        // alert fatigue on transient blips while surfacing persistent failures.
        const prev = this.refreshFailures.get(tenantId) ?? 0;
        const next = prev + 1;
        this.refreshFailures.set(tenantId, next);
        const meta = {
          tenantId,
          consecutiveFailures: next,
          error: err instanceof Error ? err.message : String(err),
        };
        if (next === REFRESH_ERROR_ESCALATION_THRESHOLD) {
          // Escalate once when the threshold is first crossed.
          if (this.logger.error) {
            this.logger.error('supervisor: snapshot refresh failing repeatedly', meta);
          } else {
            this.logger.warn('supervisor: snapshot refresh failing repeatedly', meta);
          }
        } else {
          this.logger.warn('supervisor: snapshot refresh failed', meta);
        }
      } finally {
        this.inflight.delete(tenantId);
      }
    })();
    this.inflight.set(tenantId, job);
    return job;
  }
}

/**
 * Failure-isolated bridge from the executor's onExecuted callback to the
 * daily-spend counter: loads the executed proposal, and when it is
 * money-class with a headline amount, records the spend. NEVER throws —
 * the proposal is already executed; budget accounting must not break
 * the execution path.
 */
export async function recordExecutedProposalSpend(opts: {
  service: SupervisorPolicyService;
  proposalRepo: Pick<ProposalRepository, 'findById'>;
  tenantId: string;
  proposalId: string;
  logger?: SupervisorLogger;
}): Promise<void> {
  // eslint-disable-next-line no-console
  const logger = opts.logger ?? { warn: (m: string, meta?: Record<string, unknown>) => console.warn(m, meta) };
  try {
    const proposal = await opts.proposalRepo.findById(opts.tenantId, opts.proposalId);
    if (!proposal) return;
    if (actionClassForProposalType(proposal.proposalType) !== 'money') return;
    const amountCents = payloadHeadlineCents(proposal.payload);
    if (amountCents === null || amountCents <= 0) return;
    await opts.service.recordExecutedSpend(opts.tenantId, amountCents, proposal.executedAt);
  } catch (err) {
    logger.warn('supervisor: executed-spend recording failed', {
      tenantId: opts.tenantId,
      proposalId: opts.proposalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
