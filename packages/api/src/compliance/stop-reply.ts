import { DncRepository, normalizePhone } from './dnc';
import {
  ConsentEventRepository,
  normalizeConsentPhone,
  updateDerivedConsentStatus,
} from './consent-events';
import type { CustomerRepository } from '../customers/customer';
import type { Pool } from 'pg';
import type { KeywordHandler } from '../sms/inbound-dispatch';

/**
 * Twilio-required opt-out keywords (carrier-honored). When the carrier sees
 * these single-token replies it auto-suppresses; we still mirror locally so
 * the DNC list reflects carrier reality and the next outbound send is gated.
 */
export const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'] as const;

/** Re-opt-in keywords. */
export const START_KEYWORDS = ['START', 'UNSTOP', 'YES'] as const;

/**
 * Story 10.6 — opt-out unification. STOP/START previously wrote ONLY to
 * tenant_dnc_list, leaving the consent ledger (`consent_events`) and the
 * customer rollup (`customers.consent_status`) out of sync, so consent-gated
 * paths could miss a STOP. These handlers now (best-effort) ALSO append an
 * immutable consent_events row and roll the derived status up onto the
 * matched customer(s), so every opt-out store agrees and the opt-out state is
 * visible on the customer record.
 */
export interface StopReplyHandlerDeps {
  dncRepo: DncRepository;
  /** When present, STOP/START also append to the consent ledger. */
  consentRepo?: ConsentEventRepository;
  /** Resolves phone -> customer(s) so the rollup can target the record. */
  customerRepo?: Pick<CustomerRepository, 'findByPhoneNormalized'>;
  /** Required for the Postgres customers.consent_status rollup. */
  pool?: Pool;
}

async function recordConsentTransition(
  deps: StopReplyHandlerDeps,
  tenantId: string,
  fromE164: string,
  state: 'granted' | 'revoked',
): Promise<void> {
  if (!deps.consentRepo) return;
  try {
    const digits = normalizeConsentPhone(fromE164);
    const customers = deps.customerRepo?.findByPhoneNormalized
      ? await deps.customerRepo.findByPhoneNormalized(tenantId, digits)
      : [];
    const primaryCustomerId = customers[0]?.id ?? null;

    await deps.consentRepo.append({
      tenantId,
      customerId: primaryCustomerId,
      phone: fromE164,
      kind: 'sms',
      state,
      source: 'sms',
    });

    // Roll the derived status onto every customer sharing the number (e.g.
    // household lines). No-op without a pool (in-memory/dev) — the ledger
    // append above is still the source of truth and is integration-tested.
    if (deps.pool) {
      for (const customer of customers) {
        await updateDerivedConsentStatus(deps.pool, {
          tenantId,
          customerId: customer.id,
          phone: fromE164,
          kind: 'sms',
          state,
          source: 'sms',
        });
      }
    }
  } catch {
    // Best-effort: the DNC mutation is the carrier-honored gate and must not
    // be undone by a ledger/rollup failure.
  }
}

/**
 * Build the STOP keyword handler. Registered against the inbound-SMS
 * dispatcher; when the first token of an inbound SMS matches any STOP
 * keyword, the sender's phone is normalised and inserted into the
 * tenant_dnc_list (idempotent at the repo level), and — when wired — the
 * consent ledger + customer rollup are updated to match.
 */
export function buildStopKeywordHandler(deps: StopReplyHandlerDeps): KeywordHandler {
  return {
    keywords: STOP_KEYWORDS,
    async handle(ctx) {
      await deps.dncRepo.addToDnc(ctx.tenantId, normalizePhone(ctx.fromE164), 'inbound-stop');
      await recordConsentTransition(deps, ctx.tenantId, ctx.fromE164, 'revoked');
      return { handled: true, handler: 'stop-reply' };
    },
  };
}

/**
 * Build the START / opt-back-in keyword handler. Removes the sender's
 * phone from the tenant DNC list and records the re-grant in the consent
 * ledger + customer rollup.
 */
export function buildStartKeywordHandler(deps: StopReplyHandlerDeps): KeywordHandler {
  return {
    keywords: START_KEYWORDS,
    async handle(ctx) {
      await deps.dncRepo.removeFromDnc(ctx.tenantId, normalizePhone(ctx.fromE164));
      await recordConsentTransition(deps, ctx.tenantId, ctx.fromE164, 'granted');
      return { handled: true, handler: 'start-reply' };
    },
  };
}
