/**
 * Approval-time reference checks — belt and braces under the drafting gates.
 *
 * QA 2026-09-16 (matrix row AST-04): a `send_invoice` proposal carried a JOB's
 * UUID in `payload.invoiceId`. approveProposal blocks only on `missingFields`,
 * so it approved, and execution then failed with "Invoice not found" — an
 * approvable proposal that could never execute, the class D-029 forbids. The
 * drafting handler now checks what a UUID names; this module is the last
 * seam before a human's tap becomes a promise, and it makes the same demand:
 * an id in the payload must name a record this tenant owns.
 *
 * A check returns the payload fields whose referenced record does not exist.
 * approveProposal turns a non-empty result into the same ValidationError an
 * unfilled gate produces (`details.missingFields`), so the review card's edit
 * path takes over instead of a dead end. Checks are additive and per entity
 * kind; wire them where the repositories live (app.ts), never inside the
 * action layer.
 */
import type { Proposal, ProposalType } from './proposal';
import type { InvoiceRepository } from '../invoices/invoice';

export type ApprovalReferenceCheck = (tenantId: string, proposal: Proposal) => Promise<string[]>;

export interface ApprovalOptions {
  referenceChecks?: ApprovalReferenceCheck[];
}

/**
 * Proposal types whose execution handler requires `payload.invoiceId` to be a
 * real invoice and performs no resolution of its own. Extend deliberately —
 * a type listed here refuses approval when the id names nothing.
 */
const INVOICE_ID_PROPOSAL_TYPES: ReadonlySet<ProposalType> = new Set<ProposalType>(['send_invoice']);

export function invoiceReferenceCheck(
  invoiceRepo: Pick<InvoiceRepository, 'findById'>,
): ApprovalReferenceCheck {
  return async (tenantId, proposal) => {
    if (!INVOICE_ID_PROPOSAL_TYPES.has(proposal.proposalType)) return [];
    const id = proposal.payload.invoiceId;
    if (typeof id !== 'string' || id.length === 0) return [];
    const invoice = await invoiceRepo.findById(tenantId, id);
    return invoice ? [] : ['invoiceId'];
  };
}
