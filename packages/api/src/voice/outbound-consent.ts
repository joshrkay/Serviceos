import { Pool } from 'pg';
import { isOutboundAllowed, type OutboundCheck } from './outbound-allowlist';
import { applyTenantContext } from '../db/rls-runtime-role';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { normalizePhone } from '../shared/phone';
import {
  resolveOutboundConsent,
  type ConsentLedgerEventLike,
  type VoiceConsentStatus,
} from '../compliance/resolve-outbound-consent';
import type { ConsentEventRepository } from '../compliance/consent-events';
import type { Customer, CustomerRepository } from '../customers/customer';

/**
 * Blocker 11 — TCPA / DNC consent gate for outbound AI calls.
 *
 * The existing `isOutboundAllowed` rejects malformed and premium numbers
 * but says nothing about whether placing the call is *legal*. Three
 * additional gates close that:
 *
 *  1. **Tenant DNC list** (`tenant_dnc_list`, migration 052). A
 *     tenant-local opt-out registry. A number on this list cannot
 *     receive an outbound call regardless of any consent record.
 *
 *  2. **Cross-channel revocation** (WS12, one consent model — D-017).
 *     A standing sms/marketing revocation in the `consent_events` ledger
 *     (migration 168) — e.g. an SMS STOP or a portal/manual opt-out —
 *     blocks the CALL too, even when `consent_status` still reads
 *     'granted'. The rule is asymmetric: revocations cross channels,
 *     grants never do (see compliance/resolve-outbound-consent.ts).
 *
 *  3. **Per-customer consent** (`customers.consent_status`, migration
 *     132). Under TCPA, an autodialed/AI call to a US number requires
 *     prior express consent. We refuse calls for customers in
 *     `not_requested`, `revoked`, or `expired` states. Calls only go
 *     through when `consent_status = 'granted'` (or when no customer
 *     row matches and the operator has explicitly enabled
 *     consent-not-required mode — out of scope here; today we
 *     fail-closed when there's no customer record).
 *
 * Every block emits a `voice.outbound_blocked` audit event so the
 * tenant can prove they refused the call. Successful gate-passes are
 * NOT audited here — the call placement itself produces an audit event
 * downstream.
 */

export type OutboundBlockReason =
  | OutboundCheck['reason']  // malformed | non_nanp | premium_npa
  | 'dnc_listed'
  | 'consent_not_granted'
  | 'consent_revoked'
  | 'consent_expired'
  | 'customer_not_found';

export interface OutboundConsentResult {
  allowed: boolean;
  reason?: OutboundBlockReason;
  /** Human-readable explanation suitable for an operator log line. */
  message?: string;
}

export interface OutboundConsentDeps {
  pool: Pool;
  auditRepo?: AuditRepository;
}

export interface OutboundConsentContext {
  tenantId: string;
  phoneE164: string;
  /**
   * Caller identifier for audit (the voice runner that initiated the
   * call attempt, or a user id if the call was placed via the dashboard).
   */
  actorId: string;
  actorRole?: string;
  /** Optional — used for the audit event to link the block to a higher-level flow. */
  correlationId?: string;
}

interface CustomerRow {
  id: string;
  consent_status: 'not_requested' | 'granted' | 'revoked' | 'expired';
}

/**
 * Hard-decision gate. Order of checks (cheapest first):
 *
 *   format → DNC list → customer consent.
 *
 * Each gate emits a single audit event on the first reason it refuses.
 * Callers should NOT re-run the gate after a refusal — the auditRepo
 * call would duplicate the event.
 */
export async function checkOutboundConsent(
  deps: OutboundConsentDeps,
  ctx: OutboundConsentContext,
): Promise<OutboundConsentResult> {
  // 1. Format / premium-NPA filter. Cheapest check, no DB round-trip.
  const formatCheck = isOutboundAllowed(ctx.phoneE164);
  if (!formatCheck.allowed) {
    const result: OutboundConsentResult = {
      allowed: false,
      reason: formatCheck.reason,
      message: messageFor(formatCheck.reason!),
    };
    await emitBlockedAudit(deps, ctx, result);
    return result;
  }

  // 2. DNC list + 3. customer consent. Both queries against
  //    tenant-scoped tables — one connection, one transaction.
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await applyTenantContext(client, ctx.tenantId, { transactional: true });

    // DNC overrides consent. A number on the list cannot receive a call
    // even if a customer record has `consent_status = 'granted'`.
    const dnc = await client.query<{ phone: string }>(
      `SELECT phone FROM tenant_dnc_list
       WHERE tenant_id = $1 AND phone = $2
       LIMIT 1`,
      [ctx.tenantId, ctx.phoneE164],
    );
    if ((dnc.rowCount ?? 0) > 0) {
      const result: OutboundConsentResult = {
        allowed: false,
        reason: 'dnc_listed',
        message: 'Number is on the tenant Do-Not-Call list.',
      };
      await client.query('COMMIT');
      await emitBlockedAudit(deps, ctx, result);
      return result;
    }

    // Match the customer by normalized phone. `customers.phone_normalized`
    // (migration 053) is `regexp_replace(primary_phone, '[^0-9]', '', 'g')`
    // — digits only, KEEPING the leading country-code 1 (a customer saved as
    // "+15551112222" stores "15551112222"). `ctx.phoneE164` here is the
    // E.164 display form ("+15551112222"), so the old plain
    // `phone_normalized = $2` equality NEVER matched a +1 customer and
    // fail-closed reported `customer_not_found` (block mode false-refused a
    // granted customer). Normalize to the bare 10-digit key and match BOTH
    // storage conventions — with and without the leading 1 — mirroring the
    // proven reconciliation in identify-caller / findByPhoneNormalized. The
    // isOutboundAllowed gate above already guarantees a +1 NANP number, so an
    // exact `IN ($2, '1' || $2)` is sufficient (no LIKE / substring
    // over-match) and still targets the indexed column.
    const phoneKey = normalizePhone(ctx.phoneE164);
    const cust = await client.query<CustomerRow>(
      `SELECT id, consent_status FROM customers
       WHERE tenant_id = $1 AND phone_normalized IN ($2, '1' || $2)
       LIMIT 1`,
      [ctx.tenantId, phoneKey],
    );

    // WS12 — cross-channel revocation. Read the consent ledger for this
    // number (same transaction) so a standing sms/marketing revocation —
    // SMS STOP, portal/manual opt-out — blocks the call even when
    // consent_status still reads 'granted'. consent_events stores
    // digits-only phones (normalizeConsentPhone keeps the leading 1), so
    // match BOTH storage conventions, mirroring the customer lookup above.
    const ledger = await client.query<ConsentLedgerEventLike>(
      `SELECT kind, state FROM consent_events
       WHERE tenant_id = $1 AND phone_normalized IN ($2, '1' || $2)
       ORDER BY created_at DESC`,
      [ctx.tenantId, phoneKey],
    );
    await client.query('COMMIT');

    const row = cust.rows[0] as CustomerRow | undefined;
    // The shared resolver (compliance/resolve-outbound-consent.ts) is the
    // single decision core for both outbound channels. DNC already
    // short-circuited above, so dncListed is false here by construction.
    const decision = resolveOutboundConsent({
      channel: 'voice',
      dncListed: false,
      ledgerEvents: ledger.rows,
      voice: {
        customerFound: row !== undefined,
        consentStatus: row?.consent_status as VoiceConsentStatus | undefined,
      },
    });
    if (decision.allowed) return { allowed: true };

    const reason = mapVoiceBlockReason(decision.reason!, row?.consent_status);
    const result: OutboundConsentResult = {
      allowed: false,
      reason,
      message: messageFor(reason),
    };
    await emitBlockedAudit(deps, ctx, result);
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
    throw err;
  } finally {
    // Same GUC-leak guard as the rest of the repo layer (Blocker 3).
    try { await client.query('RESET app.current_tenant_id'); } catch { /* ignore */ }
    client.release();
  }
}

/**
 * Translate the shared resolver's canonical refusal into this gate's
 * pre-existing OutboundBlockReason vocabulary so the audit/metadata shape
 * is unchanged for every pre-WS12 scenario:
 *
 *   - cross_channel_revoked → 'consent_revoked' (the customer DID revoke
 *     consent — it just arrived on the other channel).
 *   - no_channel_consent    → the same per-status reason as before
 *     (not_requested/revoked/expired).
 *   - customer_not_found    → unchanged.
 */
function mapVoiceBlockReason(
  canonical: 'cross_channel_revoked' | 'no_channel_consent' | 'customer_not_found' | 'dnc' | 'missing_channel_context',
  consentStatus: CustomerRow['consent_status'] | undefined,
): OutboundBlockReason {
  switch (canonical) {
    case 'cross_channel_revoked':
      return 'consent_revoked';
    case 'customer_not_found':
      return 'customer_not_found';
    case 'no_channel_consent': {
      const reasonMap: Record<'not_requested' | 'revoked' | 'expired', OutboundBlockReason> = {
        not_requested: 'consent_not_granted',
        revoked: 'consent_revoked',
        expired: 'consent_expired',
      };
      return consentStatus && consentStatus !== 'granted'
        ? reasonMap[consentStatus]
        : 'consent_not_granted';
    }
    default:
      // 'dnc' / 'missing_channel_context' are unreachable on the voice path
      // (DNC short-circuits earlier; missing context is SMS-only).
      return 'consent_not_granted';
  }
}

function messageFor(reason: OutboundBlockReason): string {
  switch (reason) {
    case 'malformed':           return 'Phone number is not in a recognized E.164 form.';
    case 'non_nanp':            return 'Outbound calls are limited to NANP (+1) numbers.';
    case 'premium_npa':         return 'Premium-rate area codes (900, 976) are blocked.';
    case 'dnc_listed':          return 'Number is on the tenant Do-Not-Call list.';
    case 'customer_not_found':  return 'No customer record for this number; cannot verify consent.';
    case 'consent_not_granted': return 'Customer has not granted call consent.';
    case 'consent_revoked':     return 'Customer revoked call consent.';
    case 'consent_expired':     return 'Customer call consent has expired.';
    default:                    return 'Outbound call refused.';
  }
}

async function emitBlockedAudit(
  deps: OutboundConsentDeps,
  ctx: OutboundConsentContext,
  result: OutboundConsentResult,
): Promise<void> {
  if (!deps.auditRepo || result.allowed) return;
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole ?? 'system',
      eventType: 'voice.outbound_blocked',
      entityType: 'customer',
      entityId: ctx.phoneE164,
      metadata: {
        phone: ctx.phoneE164,
        reason: result.reason ?? 'unknown',
        message: result.message ?? '',
        correlationId: ctx.correlationId,
      },
    }),
  );
}

/**
 * Record a customer's consent decision. Updates `customers.consent_status`
 * + audit fields, and emits a `customer.consent_changed` audit event. Use
 * this from the consent-capture flows (intake forms, dashboard, voicemail
 * opt-in handler) instead of writing the columns directly.
 *
 * Kept despite having no production caller yet: since WS12 tightened the
 * ledger rollup (grants never move consent_status), this is deliberately the
 * ONLY seam that can write `consent_status = 'granted'` — the voice
 * channel's affirmative TCPA capture. Deleting it would leave no legitimate
 * write path for voice consent at all.
 */
export interface RecordConsentInput {
  tenantId: string;
  customerId: string;
  status: 'not_requested' | 'granted' | 'revoked' | 'expired';
  actorId: string;
  actorRole?: string;
  /** Free-form context: 'web_form', 'voice_opt_in', 'manual_dashboard', etc. */
  method?: string;
}

export async function recordCustomerConsent(
  deps: OutboundConsentDeps,
  input: RecordConsentInput,
): Promise<void> {
  const client = await deps.pool.connect();
  let previous: string | null = null;
  try {
    await client.query('BEGIN');
    await applyTenantContext(client, input.tenantId, { transactional: true });

    const before = await client.query<{ consent_status: string }>(
      `SELECT consent_status FROM customers
       WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [input.tenantId, input.customerId],
    );
    if ((before.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      throw new Error(`Customer ${input.customerId} not found in tenant ${input.tenantId}`);
    }
    previous = before.rows[0].consent_status;

    await client.query(
      `UPDATE customers
         SET consent_status = $3,
             consent_recorded_at = NOW(),
             consent_recorded_by = $4,
             consent_method = $5,
             updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.customerId, input.status, input.actorId, input.method ?? null],
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
    throw err;
  } finally {
    try { await client.query('RESET app.current_tenant_id'); } catch { /* ignore */ }
    client.release();
  }

  if (deps.auditRepo && previous !== input.status) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.actorId,
        actorRole: input.actorRole ?? 'system',
        eventType: 'customer.consent_changed',
        entityType: 'customer',
        entityId: input.customerId,
        metadata: {
          from: previous,
          to: input.status,
          method: input.method ?? null,
        },
      }),
    );
  }
}

// ─── WS18 — on-call SMS consent capture ──────────────────────────────────────

export interface SmsConsentFromVoiceDeps {
  /** Append-only consent ledger (migration 168). */
  consentLedger: ConsentEventRepository;
  /** Flips the SMS channel's affirmative column (`customers.sms_consent`). */
  customerRepo: Pick<CustomerRepository, 'findById' | 'update'>;
  auditRepo?: AuditRepository;
}

export interface SmsConsentFromVoiceInput {
  tenantId: string;
  customerId: string;
  /** Caller E.164 (the number they're calling from). */
  phone: string;
  /** The live voice session this grant was captured on (ledger provenance). */
  voiceSessionId?: string;
  actorId?: string;
}

/**
 * WS18 — capture a caller's affirmative SMS consent DURING a live call.
 *
 * This is the on-call TCPA capture seam. It writes BOTH:
 *   1. an append-only ledger row {kind:'sms', state:'granted', source:'voice',
 *      voiceSessionId} — provenance + the cross-channel view, AND
 *   2. `customers.sms_consent = true` — the SMS channel's affirmative column.
 *
 * It deliberately does NOT touch `customers.consent_status`: per D-017 a ledger
 * grant is channel-scoped (deriveConsentStatus returns null for grants), so a
 * voice-captured SMS opt-in must never manufacture autodialed-VOICE consent.
 * Never route this through `recordCustomerConsent` (which writes the voice
 * consent_status field). `resolveOutboundConsent` reads the ledger, so a later
 * SMS STOP still blocks — the grant clears only a prior sms-kind revocation.
 *
 * Returns whether the sms_consent column actually changed (already-true is a
 * no-op) so the caller can audit `customer.consent_changed` only on a real flip.
 */
export async function recordSmsConsentFromVoice(
  deps: SmsConsentFromVoiceDeps,
  input: SmsConsentFromVoiceInput,
): Promise<{ smsConsentChanged: boolean }> {
  // 1. Ledger the grant — channel-scoped (D-017): kind 'sms', source 'voice'.
  await deps.consentLedger.append({
    tenantId: input.tenantId,
    customerId: input.customerId,
    phone: input.phone,
    kind: 'sms',
    state: 'granted',
    source: 'voice',
    voiceSessionId: input.voiceSessionId ?? null,
  });

  // 2. Flip the SMS affirmative column — only when it isn't already granted.
  const existing: Customer | null = await deps.customerRepo.findById(
    input.tenantId,
    input.customerId,
  );
  const smsConsentChanged = existing !== null && existing.smsConsent !== true;
  if (smsConsentChanged) {
    await deps.customerRepo.update(input.tenantId, input.customerId, {
      smsConsent: true,
    });
    if (deps.auditRepo) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: input.tenantId,
          actorId: input.actorId ?? 'calling-agent',
          actorRole: 'system',
          eventType: 'customer.consent_changed',
          entityType: 'customer',
          entityId: input.customerId,
          metadata: {
            field: 'sms_consent',
            from: false,
            to: true,
            source: 'voice',
            ...(input.voiceSessionId ? { voiceSessionId: input.voiceSessionId } : {}),
          },
        }),
      );
    }
  }

  return { smsConsentChanged };
}
