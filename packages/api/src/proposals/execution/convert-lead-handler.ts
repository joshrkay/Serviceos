import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { LeadRepository } from '../../leads/lead';
import { convertToCustomer } from '../../leads/lead-service';
import { CustomerRepository } from '../../customers/customer';
import { AuditRepository } from '../../audit/audit';
import { LocationRepository } from '../../locations/location';

/**
 * Executes a `convert_lead` proposal: promotes an existing lead to a
 * customer via the shared `convertToCustomer` service (which writes the
 * customer row, primary service location, stamps `lead.converted_customer_id`,
 * sets stage='won', and emits the `lead.converted` +
 * `customer.created_from_lead` audit events inside one transaction).
 *
 * The payload must carry a concrete `leadId` by execution time. The
 * voice task handler flags `leadId` as a missing field when the
 * classifier only had a free-text `leadReference`, so the proposal
 * stays in 'draft' until the operator resolves the lead in the review
 * UI — execution never runs on an unresolved reference.
 *
 * Optional address fields on the payload supply a primary service
 * location when the lead has none (QA-MANUAL-0730).
 *
 * Degrades to a synthetic-id passthrough when no leadRepo is wired, so
 * in-memory tests that don't exercise the mutation path don't have to
 * provide the dep.
 */
export class ConvertLeadExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'convert_lead';

  constructor(
    private readonly leadRepo?: LeadRepository,
    private readonly customerRepo?: CustomerRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly locationRepo?: LocationRepository,
  ) {}

  // WS3 — degrades to an id passthrough (converts nothing) without both the
  // lead repo and the customer repo; boot fails when a pool is configured but
  // this is false. Location repo is required for the real mutation path.
  isFullyWired(): boolean {
    return Boolean(this.leadRepo) && Boolean(this.customerRepo) && Boolean(this.locationRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const leadId = typeof payload.leadId === 'string' ? payload.leadId : undefined;

    if (!leadId) {
      return { success: false, error: 'convert_lead requires a resolved leadId' };
    }

    if (!this.leadRepo || !this.customerRepo || !this.locationRepo) {
      // No repos wired (in-memory test path) — report success without mutating.
      return { success: true, resultEntityId: leadId };
    }

    const addressOverride =
      typeof payload.street1 === 'string' &&
      typeof payload.city === 'string' &&
      typeof payload.state === 'string' &&
      typeof payload.postalCode === 'string'
        ? {
            street1: payload.street1,
            street2: typeof payload.street2 === 'string' ? payload.street2 : undefined,
            city: payload.city,
            state: payload.state,
            postalCode: payload.postalCode,
            country: typeof payload.country === 'string' ? payload.country : undefined,
            accessNotes:
              typeof payload.accessNotes === 'string' ? payload.accessNotes : undefined,
            label: typeof payload.label === 'string' ? payload.label : undefined,
          }
        : undefined;

    try {
      const result = await convertToCustomer(
        context.tenantId,
        leadId,
        this.leadRepo,
        this.customerRepo,
        context.executedBy,
        'owner',
        this.auditRepo,
        this.locationRepo,
        addressOverride,
      );
      if (!result) {
        return { success: false, error: `Lead ${leadId} not found` };
      }
      return { success: true, resultEntityId: result.customer.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
