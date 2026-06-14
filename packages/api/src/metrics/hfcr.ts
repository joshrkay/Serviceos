/**
 * Hands-Free Collected Revenue (HFCR) — the v1 wedge's single hero number.
 *
 * HFCR answers: "how much money did the business collect WITHOUT the owner
 * ever opening the app?" It is the credibility metric for the "run-by-text AI
 * office manager" thesis — proof that capture → invoice → payment can happen
 * with zero web sessions.
 *
 * Definition (conservative — a credibility number must never overclaim):
 *   For every COMPLETED payment received in the period, the payment's net
 *   amount (amountCents − refundedAmountCents) counts toward HFCR iff the
 *   invoice it paid is "hands-free collected":
 *     - it has at least one gating proposal (a proposal whose execution
 *       produced/targeted the invoice — resultEntityId/targetEntityId), AND
 *     - NONE of its gating proposals (plus their chain siblings) were
 *       approved on the web.
 *   "Approved on the web" = a `proposal.approved` audit event whose
 *   metadata.channel is 'ui' (the dashboard screen-tap) — or whose transport
 *   is unknown (a pre-RV-073 approval with no channel stamped; treated as web
 *   so we never claim hands-free on an approval that may have come from the
 *   app). Auto-approved proposals (no human approval event) and proposals
 *   approved via 'sms' / 'one_tap' / 'voice' are hands-free.
 *
 * A `voice`-channel approval anywhere in a hands-free invoice's chain marks it
 * a "recovered call" — the owner spoke an approval instead of touching glass.
 *
 * Pure of I/O beyond the injected repositories; reversed payments are already
 * excluded (a reversal flips status to 'failed', and we only read 'completed').
 */
import { PaymentRepository } from '../invoices/payment';
import { Proposal, ProposalRepository } from '../proposals/proposal';
import { AuditEvent, AuditRepository } from '../audit/audit';

export interface HfcrDeps {
  paymentRepo: PaymentRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
}

export interface HfcrPeriod {
  /** Inclusive lower bound on payment `receivedAt`. */
  from: Date;
  /** Exclusive upper bound on payment `receivedAt`. */
  to: Date;
}

export interface HfcrResult {
  /** Sum of net hands-free payment amounts in the period, integer cents. */
  hfcrCents: number;
  /** Distinct invoices that qualified as hands-free collected. */
  handsFreeInvoiceCount: number;
  /** Distinct hands-free invoices with a `voice` approval in the chain. */
  recoveredCallCount: number;
  /** Total completed payments considered (for observability / dilution). */
  consideredPaymentCount: number;
}

const EMPTY: HfcrResult = {
  hfcrCents: 0,
  handsFreeInvoiceCount: 0,
  recoveredCallCount: 0,
  consideredPaymentCount: 0,
};

function pushInto(map: Map<string, Proposal[]>, key: string, value: Proposal): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * Classify a single proposal's approval transport from its audit trail.
 * `web` is true when any approval used the dashboard ('ui') or an unknown
 * (unstamped) transport; `voice` is true when any approval was spoken.
 * No `proposal.approved` event → auto-approved → neither web nor voice.
 */
function classifyProposalApproval(events: AuditEvent[]): { web: boolean; voice: boolean } {
  let web = false;
  let voice = false;
  for (const e of events) {
    if (e.eventType !== 'proposal.approved') continue;
    const channel = e.metadata?.channel;
    if (channel === 'voice') voice = true;
    else if (channel === 'sms' || channel === 'one_tap') {
      // explicit non-web transport — hands-free, nothing to flag
    } else {
      // 'ui' (dashboard) or undefined/other (unknown transport) → web-touched
      web = true;
    }
  }
  return { web, voice };
}

export async function computeHfcrForTenant(
  tenantId: string,
  period: HfcrPeriod,
  deps: HfcrDeps,
): Promise<HfcrResult> {
  const payments = await deps.paymentRepo.findByTenant(tenantId, {
    status: 'completed',
    from: period.from,
    to: period.to,
  });
  if (payments.length === 0) return EMPTY;

  // Index every proposal once so per-invoice qualification doesn't re-scan.
  const allProposals = await deps.proposalRepo.findByTenant(tenantId);
  const byInvoice = new Map<string, Proposal[]>();
  const byChain = new Map<string, Proposal[]>();
  for (const p of allProposals) {
    if (p.resultEntityId) pushInto(byInvoice, p.resultEntityId, p);
    if (p.targetEntityId && p.targetEntityId !== p.resultEntityId) {
      pushInto(byInvoice, p.targetEntityId, p);
    }
    if (p.chainId) pushInto(byChain, p.chainId, p);
  }

  // Cache the per-proposal approval classification (a proposal can gate via
  // both resultEntityId and a chain). Cache the per-invoice verdict (an
  // invoice can have several payments).
  const approvalCache = new Map<string, { web: boolean; voice: boolean }>();
  const invoiceVerdict = new Map<string, { handsFree: boolean; voiceRecovered: boolean }>();

  const classify = async (proposal: Proposal): Promise<{ web: boolean; voice: boolean }> => {
    const cached = approvalCache.get(proposal.id);
    if (cached) return cached;
    const events = await deps.auditRepo.findByEntity(tenantId, 'proposal', proposal.id);
    const verdict = classifyProposalApproval(events);
    approvalCache.set(proposal.id, verdict);
    return verdict;
  };

  const qualifyInvoice = async (
    invoiceId: string,
  ): Promise<{ handsFree: boolean; voiceRecovered: boolean }> => {
    const cached = invoiceVerdict.get(invoiceId);
    if (cached) return cached;

    // Gating proposals: those that produced/targeted the invoice, plus every
    // sibling in their chains (a voice utterance approves the chain together).
    const gating = new Map<string, Proposal>();
    for (const p of byInvoice.get(invoiceId) ?? []) gating.set(p.id, p);
    const chainIds = new Set<string>();
    for (const p of gating.values()) if (p.chainId) chainIds.add(p.chainId);
    for (const chainId of chainIds) {
      for (const m of byChain.get(chainId) ?? []) gating.set(m.id, m);
    }

    let verdict: { handsFree: boolean; voiceRecovered: boolean };
    if (gating.size === 0) {
      // No proposal evidence — not provably hands-free (e.g. an invoice
      // hand-created in the web app). Excluded.
      verdict = { handsFree: false, voiceRecovered: false };
    } else {
      let anyWeb = false;
      let anyVoice = false;
      for (const proposal of gating.values()) {
        const { web, voice } = await classify(proposal);
        if (web) anyWeb = true;
        if (voice) anyVoice = true;
      }
      verdict = { handsFree: !anyWeb, voiceRecovered: !anyWeb && anyVoice };
    }
    invoiceVerdict.set(invoiceId, verdict);
    return verdict;
  };

  // Qualify each DISTINCT paid invoice once, in parallel — the audit lookups
  // are I/O-bound and the hero-tile endpoint awaits this synchronously, so we
  // don't serialize them. qualifyInvoice memoizes into invoiceVerdict, so the
  // summing loop below just reads the resolved verdicts.
  const uniqueInvoiceIds = [...new Set(payments.map((p) => p.invoiceId))];
  await Promise.all(uniqueInvoiceIds.map((id) => qualifyInvoice(id)));

  let hfcrCents = 0;
  const handsFreeInvoices = new Set<string>();
  const recoveredCallInvoices = new Set<string>();

  for (const payment of payments) {
    const net = payment.amountCents - (payment.refundedAmountCents ?? 0);
    if (net <= 0) continue;
    const verdict = invoiceVerdict.get(payment.invoiceId);
    if (!verdict || !verdict.handsFree) continue;
    hfcrCents += net;
    handsFreeInvoices.add(payment.invoiceId);
    if (verdict.voiceRecovered) recoveredCallInvoices.add(payment.invoiceId);
  }

  return {
    hfcrCents,
    handsFreeInvoiceCount: handsFreeInvoices.size,
    recoveredCallCount: recoveredCallInvoices.size,
    consideredPaymentCount: payments.length,
  };
}

/** Calendar-month period [first-of-month, first-of-next-month) for a reference date. */
export function monthPeriod(ref: Date): HfcrPeriod {
  const from = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const to = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));
  return { from, to };
}

/** Trailing 7-day period [ref−7d, ref) for the weekly owner summary. */
export function trailingWeekPeriod(ref: Date): HfcrPeriod {
  const to = new Date(ref);
  const from = new Date(ref.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}
