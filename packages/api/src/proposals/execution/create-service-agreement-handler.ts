import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { Agreement, AgreementRepository } from '../../agreements/agreement';
import { computeFirstRun } from '../../agreements/agreement-service';
import { createServiceAgreementPayloadSchema } from '../contracts/create-service-agreement';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

/**
 * Executes an approved `create_service_agreement` proposal: writes a
 * `service_agreements` row (migration 056, already live) and emits a
 * `service_agreement.created` audit event. Follows the LogExpense house
 * pattern (`log-expense-handler.ts`): validate the payload shape via the
 * Zod contract, degrade to a synthetic-id passthrough when the
 * `agreementRepo` isn't wired (in-memory unit fixtures), otherwise persist
 * for real; audit emission is failure-soft (a logging failure never
 * unwinds a successful agreement create).
 *
 * `nextRunAt` is computed via `computeFirstRun` (agreements/agreement-
 * service.ts, exported for this purpose) — the EXACT same math the
 * authenticated `POST /api/agreements` route uses via `createAgreement`,
 * so the recurring-agreements sweep (`runDueAgreements`,
 * `workers/recurring-agreements-worker.ts`) can never observe a
 * voice-drafted agreement's first-run pointer computed differently than a
 * form-created one. This handler does NOT call `createAgreement()`
 * directly: that function's own audit call is not failure-soft (a thrown
 * audit error there would propagate after the row was already inserted,
 * misreporting a successful create as a failed execution and risking a
 * duplicate row on retry) — so the repo write and the audit emission are
 * done separately here, exactly like every other LogExpense-family handler.
 *
 * Like `CreateChangeOrderExecutionHandler`, this handler mints a brand NEW
 * row on every `execute()` call (unlike `apply_credit`/`record_refund`,
 * which mutate an EXISTING row and are naturally idempotent elsewhere), so
 * a `resultEntityId` already stamped on the proposal short-circuits to a
 * pure replay — a redelivered/re-executed approval must never sign the
 * same customer up twice.
 *
 * New rows default to `status: 'active'`, `autoGenerateInvoice: true`,
 * `autoGenerateJob: true`, no auto-renew, no member discount, no priority
 * booking, no auto-collect-dues — the same defaults `createAgreement`
 * applies for a plan created through the authenticated route. None of
 * those fields are voice-extractable in v1, so there is no seam to thread
 * them through yet.
 */
export class CreateServiceAgreementExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_service_agreement';

  constructor(
    private readonly agreementRepo?: AgreementRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (saves nothing) without the
  // agreement repo; boot fails when a pool is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.agreementRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = createServiceAgreementPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error:
          'Could not determine the service agreement to create (missing customer, name, cadence, price, or start date).',
      };
    }

    // A brand-new row is minted on every execute() — replay the prior
    // result instead of signing the customer up twice (see class doc
    // comment above).
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.agreementRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    const { customerId, locationId, name, description, recurrenceRule, priceCents, startsOn } = parsed.data;

    let nextRunAt: Date;
    try {
      nextRunAt = computeFirstRun(recurrenceRule, startsOn);
    } catch (err) {
      return {
        success: false,
        error: `Could not compute the agreement's first run date: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const now = new Date();
    const agreement: Agreement = {
      id: uuidv4(),
      tenantId: context.tenantId,
      customerId,
      locationId,
      name,
      description,
      recurrenceRule,
      priceCents,
      autoGenerateInvoice: true,
      autoGenerateJob: true,
      nextRunAt,
      status: 'active',
      startsOn,
      autoRenew: false,
      renewalCount: 0,
      memberDiscountBps: 0,
      priorityBooking: false,
      autoCollectDues: false,
      createdBy: context.executedBy,
      createdAt: now,
      updatedAt: now,
    };

    let created: Agreement;
    try {
      created = await this.agreementRepo.create(agreement);
    } catch (err) {
      return {
        success: false,
        error: `Failed to create the service agreement: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: context.executedByRole ?? 'voice_agent',
            eventType: 'service_agreement.created',
            entityType: 'service_agreement',
            entityId: created.id,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'create_service_agreement',
              priceCents,
              recurrenceRule,
            },
          }),
        );
      } catch (auditErr) {
        // Audit failures must not unwind a successful agreement create —
        // but they MUST be diagnosable. Mirrors LogExpenseExecutionHandler /
        // CreateChangeOrderExecutionHandler.
        const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
        console.warn(
          `Failed to emit service_agreement.created audit event for agreement ${created.id} (proposal ${proposal.id}): ${msg}`,
        );
      }
    }

    return { success: true, resultEntityId: created.id };
  }
}
