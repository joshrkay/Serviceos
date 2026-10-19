import type { Proposal, ProposalType } from './proposal';
import { hasPermission, isValidRole, type Permission } from '../auth/rbac';

/**
 * OVAS-02 — the permission each AUTO-APPROVABLE proposal type demands of the
 * actor who asked for it before it may execute without a human approval tap.
 *
 * A drafting handler that passes `sourceTrustTier: 'autonomous'` on a
 * capture-class type lets `decideInitialStatus` return 'approved' for a
 * supervised, high-confidence request, and the execution layer performs NO
 * permission check of its own. Without this gate the approval queue becomes a
 * way around RBAC: a technician (who holds `ai:run` + `proposals:create` but
 * deliberately not `estimates:*` / `invoices:*` / `appointments:create`) could
 * speak an invoice, an estimate edit or a confirmed booking into existence and
 * have it run on their say-so — the opposite of the owner decision recorded in
 * auth/rbac.ts ("a technician speaks an estimate into existence; a permission
 * holder approves it").
 *
 * Each entry is the permission the equivalent direct route demands. Every type
 * a drafting handler can bear 'autonomous' must appear here; the table-driven
 * test (test/proposals/caller-approval-gate.test.ts) scans the handlers and
 * fails when a new autonomous site appears without an entry.
 */
export const AUTO_APPROVE_DIRECT_PERMISSION: Readonly<Partial<Record<ProposalType, Permission>>> = {
  draft_estimate: 'estimates:create',
  update_estimate: 'estimates:update',
  draft_invoice: 'invoices:create',
  update_invoice: 'invoices:update',
  update_job: 'jobs:update',
  create_appointment: 'appointments:create',
  create_booking: 'appointments:create',
};

/**
 * Downgrade a born-'approved' proposal to 'ready_for_review' unless the
 * requesting actor's DB-authoritative role holds the type's direct permission.
 * Pure — returns the proposal unchanged when it was not auto-approved, so a
 * permission holder's behavior is byte-identical.
 *
 * Fails closed: a type with no entry above, an unknown / invalid role, or no
 * role at all (an unresolvable memo creator, a 'system' actor) downgrades.
 *
 * NOT for the D-015 autonomous booking lane (create-voice-turn-processor /
 * lane-eligible bookings): that lane has no requesting member, carries its own
 * gate set, and a blanket system-actor downgrade would silently disable it.
 */
export function holdIfCallerCannotApprove<
  P extends Pick<Proposal, 'proposalType' | 'status' | 'approvedAt'>,
>(proposal: P, callerRole: string | null | undefined): P {
  if (proposal.status !== 'approved') return proposal;
  const required = AUTO_APPROVE_DIRECT_PERMISSION[proposal.proposalType];
  const permitted =
    required !== undefined &&
    typeof callerRole === 'string' &&
    isValidRole(callerRole) &&
    hasPermission(callerRole, required);
  if (permitted) return proposal;
  return { ...proposal, status: 'ready_for_review', approvedAt: undefined };
}
