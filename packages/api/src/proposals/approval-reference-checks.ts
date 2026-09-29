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
import type { LocationRepository } from '../locations/location';
import type { UserRepository } from '../users/user';
import { findActiveTenantMember } from '../users/tenant-member';
import { isChainRefToken } from './chain';

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
    // A chained tail carries `$ref:chain[n].invoiceId` until
    // resolveChainReferences fills it at execution time — not an id yet.
    if (isChainRefToken(id)) return [];
    const invoice = await invoiceRepo.findById(tenantId, id);
    return invoice ? [] : ['invoiceId'];
  };
}

/**
 * #1271 — proposal types whose executor, handed a resolved `customerId` and no
 * `jobId`, opens a job at the customer's primary (else first live) service
 * location and fails "Customer has no service location — add one before
 * approving" when there is none (DraftEstimateExecutionHandler,
 * CreateInvoiceExecutionHandler). The executor's own copy calls it a
 * pre-approval condition, so approval enforces it.
 */
const JOB_AUTO_OPEN_PROPOSAL_TYPES: ReadonlySet<ProposalType> = new Set<ProposalType>([
  'draft_estimate',
  'draft_invoice',
]);

export function serviceLocationReferenceCheck(
  locationRepo: Pick<LocationRepository, 'findByCustomer'>,
): ApprovalReferenceCheck {
  return async (tenantId, proposal) => {
    if (!JOB_AUTO_OPEN_PROPOSAL_TYPES.has(proposal.proposalType)) return [];
    const { customerId, jobId } = proposal.payload;
    // A named job is the container; no job is opened, so no location is read.
    if (typeof jobId === 'string' && jobId.length > 0) return [];
    if (typeof customerId !== 'string' || customerId.length === 0) return [];
    if (isChainRefToken(customerId)) return [];
    const locations = await locationRepo.findByCustomer(tenantId, customerId);
    return locations.some((loc) => !loc.isArchived) ? [] : ['locationId'];
  };
}

/**
 * #1463 — payload fields that ASSIGN a technician, per proposal type. Their
 * executors write the assignment with a hardcoded technician role and never
 * look the user up, so approval is where a uuid naming another tenant's user,
 * a suspended member, or nobody is refused. (`remove_crew_member` only
 * detaches an existing assignment, so it is deliberately absent.)
 */
const TECHNICIAN_ASSIGNEE_FIELDS: Partial<Record<ProposalType, string>> = {
  create_appointment: 'technicianId',
  add_crew_member: 'technicianId',
  reassign_appointment: 'toTechnicianId',
};

export function technicianReferenceCheck(
  userRepo: Pick<UserRepository, 'findById'>,
): ApprovalReferenceCheck {
  return async (tenantId, proposal) => {
    const field = TECHNICIAN_ASSIGNEE_FIELDS[proposal.proposalType];
    if (!field) return [];
    const id = proposal.payload[field];
    if (typeof id !== 'string' || id.length === 0) return [];
    if (isChainRefToken(id)) return [];
    const user = await findActiveTenantMember(userRepo, tenantId, id);
    return user && user.role === 'technician' ? [] : [field];
  };
}

/**
 * The operator-facing refusal for a set of dangling references. A missing
 * service location is not "a record that does not exist" — it is a record the
 * operator has to add — so it gets its own sentence.
 */
export function describeDanglingReferences(fields: readonly string[]): string {
  const ids = fields.filter((f) => f !== 'locationId');
  const parts: string[] = [];
  if (ids.length > 0) parts.push(`${ids.join(', ')} does not name an existing record`);
  if (fields.includes('locationId')) {
    parts.push('the customer has no service location — add one before approving');
  }
  return `Cannot approve proposal: ${parts.join('; ')}`;
}
