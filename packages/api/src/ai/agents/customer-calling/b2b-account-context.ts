/**
 * U4 — B2B inbound recognition + priority routing.
 *
 * On inbound call/SMS identification, the caller-identity layer resolves a
 * phone number to a `Customer`. This module turns that resolved customer into
 * the account context the call / triage / booking path routes on:
 *
 *  - When the resolved customer is a BUSINESS account (`accountType` is 'b2b'
 *    or 'property_manager'), `assembleB2bAccountContext` loads the parent
 *    account (via `parentAccountId`) and any direct sub-accounts (via the
 *    `findByParentAccount` repo method) and returns a `B2bAccountContext` that
 *    marks the call PRIORITY and carries occupied-property awareness so triage
 *    treats an occupied managed property as a higher-urgency situation.
 *
 *  - When the caller's number is UNMATCHED but they claim to represent a
 *    business / property-manager account, `assessUnverifiedB2bClaim` does NOT
 *    silently associate them. It emits a confidence marker (reusing
 *    `ai/guardrails/confidence`) so the owner verifies the claim before any
 *    account is linked — ambiguity becomes a marker, never a silent guess.
 *
 * PURE: no I/O of its own beyond the injected repo's tenant-scoped lookups.
 * The adapter assembles the context once at session establishment (where
 * caller identity → context is wired) and stashes it on the session; the
 * detectors / prompt assembly consume it from there.
 */
import {
  assessConfidence,
  getConfidenceLevel,
  type ConfidenceLevel,
  type ConfidenceMetadata,
} from '../../guardrails/confidence';
import type { Customer, CustomerRepository } from '../../../customers/customer';

/** Account types that route as business accounts (priority-eligible). */
export type BusinessAccountType = 'b2b' | 'property_manager';

/**
 * True when the resolved account is a business / property-manager account.
 * Mirrors the property-type vulnerability detector's `b2b | property_manager`
 * check so recognition and the occupied-property signal stay in lock-step.
 */
export function isBusinessAccount(
  accountType: Customer['accountType'] | undefined,
): accountType is BusinessAccountType {
  return accountType === 'b2b' || accountType === 'property_manager';
}

/** A summary of a related account (parent or sub-account) for call context. */
export interface RelatedAccountSummary {
  customerId: string;
  displayName: string;
  accountType?: Customer['accountType'];
}

/**
 * Assembled account context for an identified business caller. Stashed on the
 * voice session and fed into triage / booking / prompt assembly so the call
 * routes with priority and the occupied-property signal is available.
 */
export interface B2bAccountContext {
  /** The resolved (matched) customer this context was assembled for. */
  customerId: string;
  accountType: BusinessAccountType;
  /**
   * True for any recognized business account — these accounts route with
   * priority (a property manager reporting a problem is a multi-unit, often
   * time-sensitive relationship, not a one-off residential call).
   */
  priority: true;
  /**
   * The parent account when the resolved customer is a sub-account
   * (`parentAccountId` set and the parent loads). Absent for a top-level
   * business account, and absent — with `parentMissing: true` — when the
   * `parentAccountId` is set but the parent could not be loaded (the call
   * degrades to standalone rather than failing).
   */
  parentAccount?: RelatedAccountSummary;
  /**
   * True when `parentAccountId` was set on the resolved customer but the
   * parent row could not be loaded (deleted / cross-tenant / repo gap). The
   * call still routes with priority off the sub-account itself.
   */
  parentMissing: boolean;
  /**
   * Direct sub-accounts (managed properties) of this account. When the
   * resolved customer is itself a sub-account, the siblings are loaded off the
   * PARENT so a property manager who happens to call from a managed unit still
   * sees the full portfolio.
   */
  subAccounts: RelatedAccountSummary[];
  /**
   * Occupied-property awareness. `currentlyOccupied` is only known once the
   * caller states it (explicit intent extraction); at identification time it
   * is undefined. The flag exists in the context so the booking / triage layer
   * can thread the caller's later utterance into the property-type detector
   * without re-resolving the account.
   */
  currentlyOccupied?: boolean;
}

function toSummary(c: Customer): RelatedAccountSummary {
  return {
    customerId: c.id,
    displayName: c.displayName,
    ...(c.accountType ? { accountType: c.accountType } : {}),
  };
}

export interface AssembleB2bAccountContextArgs {
  tenantId: string;
  /** The resolved (phone-matched) customer. */
  customer: Customer;
  repo: CustomerRepository;
  /**
   * Optional occupied-property signal when already known at assembly time
   * (e.g. an SMS body that already stated occupancy). Usually undefined on a
   * fresh inbound call — set later from explicit intent extraction.
   */
  currentlyOccupied?: boolean;
}

/**
 * Build the priority account context for an identified business caller.
 *
 * Returns null when the resolved customer is NOT a business account (a normal
 * residential caller routes unchanged). For a business account it always
 * returns a `priority: true` context; the parent / sub-account loads are
 * best-effort and degrade gracefully:
 *   - sub-accounts loaded off the parent when the caller is a sub-account,
 *     else off the caller itself;
 *   - a set-but-unloadable parent yields `parentMissing: true` (standalone,
 *     still priority) rather than throwing.
 *
 * All repo reads are tenant-scoped (RLS + explicit tenant_id predicate in the
 * repo). Lookup failures never strand the call — they collapse to "no related
 * accounts on file".
 */
export async function assembleB2bAccountContext(
  args: AssembleB2bAccountContextArgs,
): Promise<B2bAccountContext | null> {
  const { tenantId, customer, repo } = args;
  if (!isBusinessAccount(customer.accountType)) return null;

  let parentAccount: RelatedAccountSummary | undefined;
  let parentMissing = false;
  // The id whose direct children are this account's portfolio: the parent when
  // the caller is a sub-account, otherwise the caller itself (a top-level
  // property manager owns the managed properties directly).
  let portfolioParentId = customer.id;

  if (customer.parentAccountId) {
    try {
      const parent = await repo.findById(tenantId, customer.parentAccountId);
      if (parent) {
        parentAccount = toSummary(parent);
        portfolioParentId = parent.id;
      } else {
        parentMissing = true;
      }
    } catch {
      // Best-effort: a parent lookup failure degrades to standalone-priority.
      parentMissing = true;
    }
  }

  let subAccounts: RelatedAccountSummary[] = [];
  if (repo.findByParentAccount) {
    try {
      const children = await repo.findByParentAccount(tenantId, portfolioParentId);
      // Never list the caller as its own sub-account (it can appear when the
      // portfolio is loaded off the parent and the caller is a sibling).
      subAccounts = children
        .filter((c) => c.id !== customer.id)
        .map(toSummary);
    } catch {
      subAccounts = [];
    }
  }

  return {
    customerId: customer.id,
    accountType: customer.accountType,
    priority: true,
    ...(parentAccount ? { parentAccount } : {}),
    parentMissing,
    subAccounts,
    ...(args.currentlyOccupied !== undefined
      ? { currentlyOccupied: args.currentlyOccupied }
      : {}),
  };
}

/** Reason stamped on the confidence marker for an unverified B2B claim. */
export const UNVERIFIED_B2B_CLAIM_MARKER_REASON = 'unverified_b2b_account_claim';

/**
 * The outcome of assessing an unverified B2B / property-manager claim from a
 * phone-unmatched caller. NEVER carries a `customerId` — the whole point is
 * that no association is made until the owner verifies.
 */
export interface UnverifiedB2bClaimAssessment {
  /** Always false here — recognition of a claim is not association. */
  associated: false;
  confidence: ConfidenceMetadata;
  level: ConfidenceLevel;
  markerReason: typeof UNVERIFIED_B2B_CLAIM_MARKER_REASON;
  /** The verbatim account name/handle the caller claimed (for owner review). */
  claimedAccountName: string;
}

export interface AssessUnverifiedB2bClaimArgs {
  /** The business / property-manager account the caller claims to represent. */
  claimedAccountName: string;
  /**
   * The caller's E.164 (unmatched). Recorded so the owner can decide whether
   * to associate it — never used to auto-link.
   */
  callerPhone?: string;
}

/**
 * A phone-unmatched caller claims to represent a business / property-manager
 * account. Do NOT associate them. Emit a confidence marker (reusing the shared
 * confidence guardrail) so the claim surfaces for owner verification.
 *
 * The confidence is deliberately LOW: an unverified, phone-unmatched account
 * claim is exactly the case the trust-tier decision must keep out of any
 * auto-approve path. We feed the guardrail a low score + explanatory factors
 * so every downstream surface renders it as "low confidence — verify".
 */
export function assessUnverifiedB2bClaim(
  args: AssessUnverifiedB2bClaimArgs,
): UnverifiedB2bClaimAssessment {
  const confidence = assessConfidence({
    // Low by construction: unverified claim from an unrecognized number.
    confidence_score: 0.2,
    explanation:
      `Caller's number did not match any account but they claim to represent ` +
      `"${args.claimedAccountName}". Not associated — verify before linking.`,
    payload: {
      claimedAccountName: args.claimedAccountName,
      ...(args.callerPhone ? { callerPhone: args.callerPhone } : {}),
      reason: UNVERIFIED_B2B_CLAIM_MARKER_REASON,
    },
  });
  return {
    associated: false,
    confidence,
    level: getConfidenceLevel(confidence.score),
    markerReason: UNVERIFIED_B2B_CLAIM_MARKER_REASON,
    claimedAccountName: args.claimedAccountName,
  };
}

/**
 * Render the assembled business-account context as a prompt section for the
 * live-call classifier / persona, mirroring the seam the vulnerable-caller
 * hint uses (`VULNERABLE_CALLER_PROMPT_HINT`). Kept NON-PII: names of managed
 * properties are operational context the agent already has on the account, but
 * we cap the listed sub-accounts so a large portfolio doesn't bloat the prompt.
 */
const MAX_PROMPTED_SUB_ACCOUNTS = 8;

export function buildAccountContextPromptSection(
  ctx: B2bAccountContext,
): string {
  const kind =
    ctx.accountType === 'property_manager' ? 'property-management' : 'business';
  const lines: string[] = [
    `This caller is a ${kind} account — treat this call as PRIORITY: be ` +
      `efficient, and surface scheduling / dispatch options first.`,
  ];
  if (ctx.parentAccount) {
    lines.push(
      `It is a managed property under the account "${ctx.parentAccount.displayName}".`,
    );
  }
  if (ctx.subAccounts.length > 0) {
    const shown = ctx.subAccounts.slice(0, MAX_PROMPTED_SUB_ACCOUNTS);
    const names = shown.map((s) => s.displayName).join(', ');
    const more =
      ctx.subAccounts.length > shown.length
        ? ` (+${ctx.subAccounts.length - shown.length} more)`
        : '';
    lines.push(`Managed properties on this account: ${names}${more}.`);
  }
  lines.push(
    'If the caller indicates a property is currently occupied, treat it as ' +
      'higher urgency.',
  );
  return lines.join(' ');
}
