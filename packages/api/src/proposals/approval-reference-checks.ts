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
import type { JobRepository } from '../jobs/job';
import type { CustomerRepository } from '../customers/customer';
import type { LocationRepository } from '../locations/location';
import type { EstimateRepository } from '../estimates/estimate';
import { findInvoiceHoldingEstimate } from '../invoices/estimate-invoice-link';
import type { UserRepository } from '../users/user';
import { findActiveTenantMember } from '../users/tenant-member';
import { isChainRefToken } from './chain';
import { lacksExecutionAnchor } from './voice-payload';

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
 * #1476 / #1480 — a draft_estimate / draft_invoice / create_appointment with
 * neither a job nor a customer the executor can open one for. Same predicate
 * (`lacksExecutionAnchor`) the voice payload gate uses at drafting time, so a
 * proposal from ANY surface that lost its anchor — e.g. an invoice drafted
 * from an estimate whose job id was dropped — is refused here instead of
 * failing "neither a customerId nor a jobId" after the tap. The gate is
 * `customerId`, which the card's customer picker fills.
 */
export function executionAnchorReferenceCheck(): ApprovalReferenceCheck {
  return async (_tenantId, proposal) =>
    lacksExecutionAnchor(proposal.proposalType, proposal.payload) ? ['customerId'] : [];
}

/**
 * #1480 — `send_invoice` names no recipient of its own for the customer's
 * address to fall back to, and the customer has none on file for that
 * channel: the send service can only refuse ("Cannot send email — no email
 * provided and customer has no email on file"), after the approval tap. The
 * gap is `recipient`, a payload field the card's Edit fills, so it lifts.
 * Walks invoice → job → customer, the same hop the send service makes.
 */
export function sendRecipientReferenceCheck(deps: {
  invoiceRepo: Pick<InvoiceRepository, 'findById'>;
  jobRepo: Pick<JobRepository, 'findById'>;
  customerRepo: Pick<CustomerRepository, 'findById'>;
}): ApprovalReferenceCheck {
  return async (tenantId, proposal) => {
    if (proposal.proposalType !== 'send_invoice') return [];
    const { payload } = proposal;
    const channel = payload.channel ?? payload.sendChannel;
    if (channel !== 'email' && channel !== 'sms') return [];
    if (typeof payload.recipient === 'string' && payload.recipient.trim().length > 0) return [];
    const invoiceId = payload.invoiceId;
    // No invoice id yet is a different gate (invoiceId), never this one.
    if (typeof invoiceId !== 'string' || invoiceId.length === 0 || isChainRefToken(invoiceId)) return [];
    const invoice = await deps.invoiceRepo.findById(tenantId, invoiceId);
    if (!invoice) return [];
    const job = await deps.jobRepo.findById(tenantId, invoice.jobId);
    if (!job) return [];
    const customer = await deps.customerRepo.findById(tenantId, job.customerId);
    if (!customer) return [];
    const onFile = channel === 'email' ? customer.email : customer.primaryPhone;
    return typeof onFile === 'string' && onFile.trim().length > 0 ? [] : ['recipient'];
  };
}

/**
 * #1490 — a draft_invoice naming an estimate that ANOTHER invoice already
 * bills. uq_invoices_estimate allows one invoice per estimate, so execution
 * could only collide (live: the collision then masked itself as "current
 * transaction is aborted" and the proposal sat in 'executing'). The gap is a
 * sentence, not a field: the fix is the existing invoice, not an edit here.
 */
export function estimateInvoicedReferenceCheck(deps: {
  estimateRepo: Pick<EstimateRepository, 'findById'>;
  invoiceRepo: Pick<InvoiceRepository, 'findByJob'>;
}): ApprovalReferenceCheck {
  return async (tenantId, proposal) => {
    if (proposal.proposalType !== 'draft_invoice') return [];
    const estimateId = proposal.payload.estimateId;
    if (typeof estimateId !== 'string' || estimateId.length === 0 || isChainRefToken(estimateId)) return [];
    const held = await findInvoiceHoldingEstimate(tenantId, estimateId, deps);
    return held ? [ESTIMATE_ALREADY_INVOICED] : [];
  };
}

const ESTIMATE_ALREADY_INVOICED = 'estimateAlreadyInvoiced';

/** Gaps that are a missing piece to supply, not an id naming nothing. */
const SENTENCE_GAPS: ReadonlySet<string> = new Set([
  'locationId',
  'recipient',
  'customerId',
  ESTIMATE_ALREADY_INVOICED,
]);

const ESTIMATE_ALREADY_INVOICED_SENTENCE =
  'the estimate is already invoiced — open that invoice instead of drafting a second one';

/**
 * The operator-facing refusal for a set of dangling references. A missing
 * service location is not "a record that does not exist" — it is a record the
 * operator has to add — so it gets its own sentence.
 */
export function describeDanglingReferences(fields: readonly string[]): string {
  const ids = fields.filter((f) => !SENTENCE_GAPS.has(f));
  const parts: string[] = [];
  if (ids.length > 0) parts.push(`${ids.join(', ')} does not name an existing record`);
  if (fields.includes('customerId')) {
    parts.push('it is not linked to a customer or a job yet — pick the customer before approving');
  }
  if (fields.includes('recipient')) {
    parts.push('the customer has nothing on file to send it to — add a recipient before approving');
  }
  if (fields.includes('locationId')) {
    parts.push('the customer has no service location — add one before approving');
  }
  if (fields.includes(ESTIMATE_ALREADY_INVOICED)) parts.push(ESTIMATE_ALREADY_INVOICED_SENTENCE);
  return `Cannot approve proposal: ${parts.join('; ')}`;
}

/**
 * #1480 — the ONE executability check. Every configured reference check, run
 * against a proposal as it stands. `approveProposal` runs it on a human tap;
 * a drafting surface runs it BEFORE persisting a proposal its status decision
 * auto-approved (`holdIfNotExecutable`), so "approved automatically" can never
 * skip what a tap would have refused (QA §17: an auto-approved estimate for a
 * customer with no service location failed at execution).
 */
export async function executabilityGaps(
  tenantId: string,
  proposal: Proposal,
  checks: readonly ApprovalReferenceCheck[] | undefined,
): Promise<string[]> {
  if (!checks || checks.length === 0) return [];
  return (await Promise.all(checks.map((check) => check(tenantId, proposal)))).flat();
}

/**
 * Pure. An auto-approved proposal with executability gaps is held for review
 * instead — the same demotion shape as `holdIfUnsupervised`. The gaps are NOT
 * written into `missingFields`: several (a service location, an email on
 * file) are fixed on another record, not by editing this payload, and a
 * `missingFields` gate nothing on the card can lift is the #909 dead end.
 * `approveProposal` re-runs the checks, so the tap stays refused until the
 * missing piece exists.
 */
export function holdIfNotExecutable(proposal: Proposal, gaps: readonly string[]): Proposal {
  if (gaps.length === 0 || proposal.status !== 'approved') return proposal;
  return { ...proposal, status: 'ready_for_review', approvedAt: undefined };
}

/**
 * The assistant's ask for the missing piece(s) — what the operator has to
 * supply before the card can go ahead.
 */
export function askForExecutabilityGaps(
  gaps: readonly string[],
  payload: Record<string, unknown> = {},
): string {
  const asks: string[] = [];
  if (gaps.includes('locationId')) {
    asks.push("the customer has no service location yet — what's the service address?");
  }
  if (gaps.includes('recipient')) {
    asks.push(
      (payload.channel ?? payload.sendChannel) === 'sms'
        ? 'the customer has no phone number on file — what number should it go to?'
        : 'the customer has no email on file — what email address should it go to?',
    );
  }
  if (gaps.includes('customerId')) {
    asks.push("it isn't linked to a customer or a job yet — which customer is it for?");
  }
  if (gaps.includes(ESTIMATE_ALREADY_INVOICED)) asks.push(ESTIMATE_ALREADY_INVOICED_SENTENCE);
  const unknown = gaps.filter((g) => !SENTENCE_GAPS.has(g));
  if (unknown.length > 0) asks.push(`${unknown.join(', ')} does not name an existing record`);
  return `This can't go ahead yet: ${asks.join('; ')}`;
}

