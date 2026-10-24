import type { Pool, PoolClient } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { voiceBlocksTotal } from '../monitoring/metrics';
import { decideTrialCall, type GateReason, type SubscriptionStatus } from './trial-limits';
import { sumBillableSecondsOn, sumTrialBillableSecondsOn } from '../billing/call-usage-events';
import { overageCapFromSettings } from '../billing/overage-cap';
import { isOverageCapReached } from '../billing/call-usage-pricing';
import { readTenantBillingState, type TenantBillingState } from '../billing/tenant-billing-state';
import type { BusinessHoursConfig } from '../compliance/business-hours';
import { withTenantClient } from '../db/tenant-transaction';
import { businessHoursFromSettings } from '../telephony/business-hours-loader';
import { samePhone } from './activation';
import { isOwnerLineAttested } from '../telephony/stir-attestation';

export interface VoiceGateInput {
  tenantId: string;
  callSid: string;
  /**
   * #1605 — the caller's E.164 number. Used only to recognize the owner's
   * own test call while the tenant is not_live (see the not_live branch
   * below); every other gate decision is unaffected by it. Optional so
   * existing callers that predate #1605 keep compiling.
   */
  from?: string | null;
  /**
   * #1605 / #1223 — Twilio's `StirVerstat` for this call. Caller-ID is
   * spoofable (that's the whole reason #1223 requires full attestation
   * before granting owner-line authority elsewhere), and
   * tenant_settings.business_phone defaults to the tenant's own DID at
   * provisioning — so without this check, spoofing From=To would satisfy
   * the owner/business-number match with no secret at all. The not_live
   * bypass below requires `isOwnerLineAttested` on top of the phone match.
   */
  stirVerstat?: string | null;
}

export interface VoiceGateResult {
  allowed: boolean;
  reason?: GateReason;
  /**
   * Usage caps (trial minutes, trial concurrency, paid overage cap) ring the
   * owner instead of dropping the caller: their phone, or null when none is
   * on file (the route then falls back to voicemail). Absent for other blocks.
   */
  forwardTo?: string | null;
  /**
   * On an answer decided from the tenant_settings row: that row's business
   * hours (null = no usable schedule), so the /voice after-hours fork does not
   * read the row a second time (raw-pg audit 2026-10-23 §4 P1.3: one tenant
   * session per inbound call). Absent when the decision never read the row
   * (dunning grace): the route then reads the hours itself.
   */
  businessHours?: BusinessHoursConfig | null;
}

export type VoiceGate = (input: VoiceGateInput) => Promise<VoiceGateResult>;

export interface VoiceGateDeps {
  pool: Pool;
  auditRepo: AuditRepository;
}

/**
 * Composes Gate A (subscription), the go-live gate — which carries its own
 * narrow, fully-attested owner-test-call bypass (#1605, see `decideForTenant`)
 * — and Gate B (usage caps) for the telephony /voice webhook.
 * Setup blocks return voicemail TwiML upstream; usage caps forward to the
 * owner (see VoiceGateResult.forwardTo).
 *
 * Cost per decision (raw-pg audit 2026-10-23 §4 P1.3 — this runs on every
 * inbound call): the tenants registry read (no RLS) decides billing on its
 * own; everything else is ONE tenant session (`withTenantClient`, so
 * `rls_app_runtime` and the RLS policies bound it) reading one tenant_settings
 * row for go-live, the owner numbers, forward-to, the overage cap and business
 * hours, plus the open-call count and the usage ledger. A block's audit row is
 * written after that session has released its connection.
 */
export function createVoiceGate(deps: VoiceGateDeps): VoiceGate {
  return async ({ tenantId, callSid, from, stirVerstat }) => {
    const tenant = await readTenantBillingState(deps.pool, tenantId);
    const rawStatus = tenant?.status ?? null;
    const status = normalizeStatus(rawStatus);

    // Billing resilience — dunning grace (Part A). A card that fails at
    // trial end flips the mirrored status to past_due; instead of
    // hard-blocking to voicemail immediately, we answer while the grace
    // window stamped by invoice.payment_failed is still in the future. The
    // account stays flagged past_due in subscription_status the whole time,
    // and once the grace lapses the gate below blocks as before.
    if (status === 'past_due' && isPastDueGraceActive(tenant?.pastDueGraceUntil ?? null)) {
      return { allowed: true };
    }

    if (status !== 'trialing' && status !== 'active') {
      return block(deps, {
        tenantId,
        callSid,
        reason: 'no_billing',
        rawStatus,
        usage: null,
      });
    }

    const decision = await withTenantClient(deps.pool, tenantId, (client) =>
      decideForTenant(client, { tenantId, status, tenant, from, stirVerstat }),
    );
    if (decision.answer) return decision.answer;
    return block(deps, { tenantId, callSid, rawStatus, ...decision.blocked });
  };
}

interface GateSettingsRow {
  voice_agent_live_at: Date | null;
  owner_phone: string | null;
  business_phone: string | null;
  business_hours: unknown;
  timezone: string | null;
  ai_overage_cap_cents: number | null;
  ai_overage_uncapped: boolean | null;
}

type TenantDecision =
  | { answer: VoiceGateResult; blocked?: undefined }
  | {
      answer?: undefined;
      blocked: { reason: GateReason; usage: Record<string, number> | null; forwardTo?: string | null };
    };

/**
 * Every tenant-table read behind a trialing/active decision, on the one
 * tenant-scoped client. Reads only — the block audit is the caller's, after
 * this transaction commits.
 */
async function decideForTenant(
  client: PoolClient,
  input: {
    tenantId: string;
    status: 'trialing' | 'active';
    tenant: TenantBillingState | null;
    from?: string | null;
    stirVerstat?: string | null;
  },
): Promise<TenantDecision> {
  const { tenantId, status, tenant } = input;
  const settingsRes = await client.query<GateSettingsRow>(
    `SELECT voice_agent_live_at, owner_phone, business_phone, business_hours, timezone,
            ai_overage_cap_cents, ai_overage_uncapped
       FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const settings = settingsRes.rows[0];
  const answer: VoiceGateResult = {
    allowed: true,
    businessHours: settings ? businessHoursFromSettings(settings) : null,
  };

  if (!settings?.voice_agent_live_at) {
    // #1605 — the onboarding test-call step can only complete when a
    // voice_inbound session actually ends (deriveOnboardingStatus /
    // isTestCallDone), and go-live only auto-fires on a session end
    // (maybeAutoGoLiveOnInboundEnd) — but every call is blocked right
    // here until go-live, including the owner's own test call. That's a
    // deadlock the owner could only break by Skip-ping the step and
    // manually flipping "Turn on AI answering" blind. So: recognize the
    // owner's own verified caller-ID (their cell or the tenant's business
    // number — same two columns activation.ts already treats as
    // "verified, not a real customer") and let THAT call through as an
    // AI-answered test session. Every other caller still goes to
    // voicemail until go-live, exactly as before.
    //
    // Requires full STIR/SHAKEN attestation (#1223's own bar for
    // owner-line authority) on top of the phone match — caller-ID alone
    // is spoofable, and business_phone defaults to the tenant's own DID
    // at provisioning, so phone-match alone would let anyone spoofing
    // From=To through with no secret at all. A genuine owner on a
    // SHAKEN-capable carrier gets A-attestation automatically; a missing
    // or partial attestation fails closed to the pre-#1605 behavior
    // (voicemail) rather than granting the bypass.
    if (isOwnerLineAttested(input.stirVerstat) && isOwnersOwnNumber(input.from, settings)) {
      return { answer };
    }
    return { blocked: { reason: 'not_live', usage: null } };
  }

  // #1386 / O-2 (owner, 2026-09-26) — a missing reviewed E1 script is NOT a
  // reason to send the call to voicemail. Until a licensed trade pro plus
  // counsel sign the script, AI answering runs on the embedded placeholder,
  // HARD-FLAGGED: every E1 invocation stamps `e1ScriptPlaceholder: true` on
  // its audit row (transitions.ts), the owner sees a persistent banner
  // (GET /api/settings/e1-script), and boot still warns (app.ts). Once the
  // owner saves a reviewed script (PUT /api/settings/e1-script) it is spoken
  // instead. Every other gate reason above and below is unchanged.
  const forwardTo = settings.owner_phone?.trim() || null;

  if (status === 'trialing') {
    const concurrentRes = await client.query<{ concurrent: number }>(
      `SELECT COUNT(*)::int AS concurrent FROM voice_sessions
        WHERE tenant_id = $1 AND channel = 'voice_inbound' AND ended_at IS NULL`,
      [tenantId],
    );
    // The whole trial: every billable second recorded so far.
    const billableSecondsUsed = await sumTrialBillableSecondsOn(client, tenantId);
    const decision = decideTrialCall({
      billableSecondsUsed,
      concurrentCalls: concurrentRes.rows[0]?.concurrent ?? 0,
    });
    if (decision.action === 'answer') return { answer };
    return { blocked: { reason: decision.reason, usage: { billableSecondsUsed }, forwardTo } };
  }

  // Paid: forward once this period's overage has reached the owner's cap
  // (one plan price by default; none if they removed it). Without a
  // mirrored period, nothing to measure.
  const period = tenant?.period ?? null;
  const cap = period ? overageCapFromSettings(settings) : null;
  if (cap !== null && period) {
    const planId = tenant?.planId ?? 'starter';
    const billableSeconds = await sumBillableSecondsOn(client, tenantId, period.start, period.end);
    if (isOverageCapReached({ planId, billableSeconds, overageCapCents: cap })) {
      return { blocked: { reason: 'overage_cap', usage: { billableSeconds }, forwardTo } };
    }
  }
  return { answer };
}

async function block(
  deps: VoiceGateDeps,
  input: {
    tenantId: string;
    callSid: string;
    reason: GateReason;
    rawStatus: string | null;
    usage: Record<string, number> | null;
    forwardTo?: string | null;
  },
): Promise<VoiceGateResult> {
  voiceBlocksTotal.inc({ reason: input.reason });

  const eventType =
    input.reason === 'no_billing'
      ? 'voice_blocked_no_billing'
      : input.reason === 'not_live'
        ? 'voice_blocked_not_live'
        : input.reason === 'overage_cap'
          ? 'voice_forwarded_overage_cap'
          : 'voice_forwarded_trial_cap';

  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: 'system',
        actorRole: 'system',
        eventType,
        entityType: 'voice_session',
        entityId: input.callSid,
        metadata: {
          reason: input.reason,
          subscriptionStatus: input.rawStatus,
          ...(input.usage ? { usage: input.usage } : {}),
        },
      }),
    );
  } catch {
    // Audit failures must not block the response.
  }

  return input.forwardTo === undefined
    ? { allowed: false, reason: input.reason }
    : { allowed: false, reason: input.reason, forwardTo: input.forwardTo };
}

/**
 * #1605 — true when `from` is the tenant owner's verified cell or their own
 * business number (tenant_settings.owner_phone / business_phone — the same
 * two columns `activation.ts` treats as "verified, not a real customer"), read
 * from the decision's own settings row. `from` absent/empty never matches (no
 * caller-ID → no bypass), nor does a tenant with no settings row.
 */
function isOwnersOwnNumber(
  from: string | null | undefined,
  row: Pick<GateSettingsRow, 'owner_phone' | 'business_phone'> | undefined,
): boolean {
  if (!from || !row) return false;
  return samePhone(from, row.owner_phone) || samePhone(from, row.business_phone);
}

const VALID_STATUSES = new Set(['trialing', 'active', 'past_due', 'canceled', 'incomplete']);

function normalizeStatus(raw: string | null): SubscriptionStatus {
  if (!raw) return null;
  return VALID_STATUSES.has(raw) ? (raw as SubscriptionStatus) : null;
}

/**
 * Billing resilience — dunning grace (Part A). True while the
 * past_due_grace_until stamped by invoice.payment_failed is in the future.
 * (readTenantBillingState normalizes the column to Date | null.)
 */
function isPastDueGraceActive(graceUntil: Date | null): boolean {
  return graceUntil !== null && graceUntil.getTime() > Date.now();
}
