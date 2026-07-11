import { ProposalType } from '../enums.js';

/**
 * Capture-class proposal types — the auto/one-tap-safe lane.
 *
 * A capture-class action records an operator-stated fact, moves no money, sends
 * no customer-facing message, and is reversible. The other action classes
 * (comms / money / irreversible) are deliberately NOT here: per CLAUDE.md
 * "Never auto-execute", they must be reviewed and approved individually, never
 * swept up by a bulk "approve all".
 *
 * This is the single source consumers outside the API use to know the safe
 * lane — notably the mobile inbox's "approve all eligible". It is kept in EXACT
 * lockstep with the API's authoritative `actionClassForProposalType` switch
 * (packages/api/src/proposals/proposal.ts) by a parity test
 * (proposal-action-class.test.ts), so a new capture type can't be added in one
 * place and silently forgotten in the other.
 */
export const CAPTURE_PROPOSAL_TYPES: ReadonlySet<string> = new Set<string>([
  ProposalType.CREATE_CUSTOMER,
  ProposalType.UPDATE_CUSTOMER,
  ProposalType.CREATE_JOB,
  ProposalType.CREATE_APPOINTMENT,
  ProposalType.CREATE_BOOKING,
  ProposalType.CALLBACK,
  ProposalType.DRAFT_ESTIMATE,
  ProposalType.UPDATE_ESTIMATE,
  ProposalType.DRAFT_INVOICE,
  ProposalType.UPDATE_INVOICE,
  ProposalType.CREATE_INVOICE_SCHEDULE,
  ProposalType.BATCH_INVOICE,
  ProposalType.REASSIGN_APPOINTMENT,
  ProposalType.RESCHEDULE_APPOINTMENT,
  ProposalType.ADD_CREW_MEMBER,
  ProposalType.REMOVE_CREW_MEMBER,
  ProposalType.ADD_NOTE,
  ProposalType.ONBOARDING_TENANT_SETTINGS,
  ProposalType.ONBOARDING_SERVICE_CATEGORY,
  ProposalType.ONBOARDING_ESTIMATE_TEMPLATE,
  ProposalType.ONBOARDING_TEAM_MEMBER,
  ProposalType.ONBOARDING_SCHEDULE,
  ProposalType.LOG_EXPENSE,
  ProposalType.CONVERT_LEAD,
  ProposalType.CONFIRM_APPOINTMENT,
  ProposalType.MARK_LEAD_LOST,
  ProposalType.ADD_SERVICE_LOCATION,
  ProposalType.LOG_TIME_ENTRY,
  ProposalType.VOICE_CLARIFICATION,
  // UB-A2 — writes a tenant directive row; no money, no customer contact.
  // The voice task handler omits sourceTrustTier, so despite being
  // capture-class the instruction proposal always lands for review in v1.
  ProposalType.CREATE_STANDING_INSTRUCTION,
  // WS20 — updates a catalog item's unit price. Config change: moves no money
  // (future pricing only), sends no customer message, reversible (edit the
  // price back). The correction loop creates it with no trust tier, so it
  // always lands for review — never auto-executed (D-004).
  ProposalType.UPDATE_CATALOG_ITEM,
]);

/**
 * True when a proposal type is capture-class (the auto-safe lane). Accepts a
 * raw string so API (union) and mobile (JSON string) callers use it the same
 * way; unknown types are non-capture (safe default — excluded from bulk
 * approval).
 */
export function isCaptureProposalType(type: string): boolean {
  return CAPTURE_PROPOSAL_TYPES.has(type);
}
