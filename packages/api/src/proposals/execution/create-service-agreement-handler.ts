import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { AgreementRepository } from '../../agreements/agreement';
import { createAgreement } from '../../agreements/agreement-service';
import { createServiceAgreementPayloadSchema } from '../contracts/create-service-agreement';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { LocationRepository } from '../../locations/location';

/**
 * Executes an approved `create_service_agreement` proposal: writes a
 * `service_agreements` row (migration 056, already live) via
 * `createAgreement` and emits a `service_agreement.created` audit event.
 * Follows the LogExpense house pattern (`log-expense-handler.ts`):
 * validate the payload shape via the Zod contract, degrade to a
 * synthetic-id passthrough when a required dependency isn't wired
 * (in-memory unit fixtures), otherwise persist for real; audit emission is
 * failure-soft (a logging failure never unwinds a successful create).
 *
 * Quality-review CRITICAL fix (C1) — the drafting task never populates
 * `locationId` (no location-reference extraction seam exists for this
 * intent in v1), so `payload.locationId` was ALWAYS undefined. The
 * recurring sweep (`agreements/agreement-service.ts runDueAgreements`,
 * ticking every 60 seconds — app.ts) does `locationId: agreement.locationId
 * ?? ''` when generating each cycle's job, and `createJob` REJECTS an
 * empty `locationId` — so every voice-created agreement produced a
 * `failed` run on EVERY sweep tick, forever, with no operator-facing
 * signal beyond a buried `agreement_runs` row. Resolved here at EXECUTION
 * time instead: primary-then-fallback, the SAME shape
 * `EmergencyDispatchExecutionHandler` (emergency-dispatch-handler.ts) and
 * `CreateJobExecutionHandler`/`CreateAppointmentExecutionHandler`
 * (handlers.ts) already use for a customer's service location. If the
 * customer has no active location at all, execution FAILS with an
 * operator-actionable message rather than persisting a row the sweep can
 * never service. Disabling `autoGenerateJob` as a workaround was
 * considered and rejected: `createInvoice` independently requires a
 * `jobId` (invoices/invoice.ts), so a location-less agreement can never
 * produce EITHER side effect — there is no partial-success shape to fall
 * back to.
 *
 * `isFullyWired()` requires BOTH `agreementRepo` and `locationRepo` —
 * mirrors `CreateChangeOrderExecutionHandler`'s dual-dependency posture
 * (`estimateRepo && settingsRepo`): a location-less voice path is not a
 * degraded-but-usable mode here, since v1 NEVER supplies `locationId` on
 * the payload, so a missing `locationRepo` means every execution would
 * fail at the "no service location" branch.
 *
 * Quality-review IMPORTANT fix (I1) — calls `createAgreement`
 * (agreements/agreement-service.ts), the SAME function the authenticated
 * `POST /api/agreements` route uses, rather than hand-assembling the
 * `Agreement` row. Six defaults (`autoGenerateInvoice`/`autoGenerateJob`,
 * `autoRenew`, `renewalCount`, `memberDiscountBps`, `priorityBooking`,
 * `autoCollectDues`) and three invariants (`endsOn >= startsOn`, the
 * auto-renew term invariant, `parseRule` validation) live in ONE place
 * instead of two that can silently drift — most of those fields are
 * OPTIONAL on the `Agreement` interface (added well after the original
 * table), so the type system cannot catch a hand-rolled copy that misses
 * one; a future added column would compile fine and land NULL only on
 * voice-created rows. `createAgreement`'s own audit call is NOT
 * failure-soft (no try/catch — a thrown audit error there would propagate
 * AFTER the row was already inserted, misreporting a successful create as
 * a failed execution and risking a duplicate on retry), so it is called
 * here with `undefined` as the audit repo to suppress that internal
 * emission; this handler emits its OWN failure-soft
 * `service_agreement.created` event afterward instead, preserving the
 * LogExpense-family posture end to end.
 *
 * Note on `computeFirstRun`: it is not called directly here — reusing
 * `createAgreement` means it already runs internally. On TODAY's v1 voice
 * path this is currently equivalent to a plain copy of `startsOn`:
 * `computeFirstRun` only diverges from `startsOn` when the recurrence rule
 * carries a `BYMONTHDAY` clause, and none of
 * `CreateServiceAgreementTaskHandler`'s four cadence mappings emit one.
 * Calling the shared function is still the right call — parity with the
 * authenticated route, and correctness for any FUTURE cadence (or a
 * hand-edited proposal payload) that DOES carry `BYMONTHDAY` — not a fix
 * for a live bug in today's mapping table.
 *
 * Like `CreateChangeOrderExecutionHandler`, this handler mints a brand NEW
 * row on every `execute()` call (unlike `apply_credit`/`record_refund`,
 * which mutate an EXISTING row and are naturally idempotent elsewhere), so
 * a `resultEntityId` already stamped on the proposal short-circuits to a
 * pure replay — a redelivered/re-executed approval must never sign the
 * same customer up twice.
 */
export class CreateServiceAgreementExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_service_agreement';

  constructor(
    private readonly agreementRepo?: AgreementRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly locationRepo?: LocationRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (saves nothing) without
  // BOTH the agreement repo and the location repo (see class doc comment).
  // Boot fails when a pool is configured but this is false.
  isFullyWired(): boolean {
    return Boolean(this.agreementRepo) && Boolean(this.locationRepo);
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

    if (!this.agreementRepo || !this.locationRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    const {
      customerId,
      locationId: payloadLocationId,
      name,
      description,
      recurrenceRule,
      priceCents,
      startsOn,
    } = parsed.data;

    const locationId = payloadLocationId ?? (await this.resolveLocationId(context.tenantId, customerId));
    if (!locationId) {
      return {
        success: false,
        error: 'Customer has no service location — add one before starting a plan.',
      };
    }

    let created;
    try {
      created = await createAgreement(
        {
          tenantId: context.tenantId,
          customerId,
          locationId,
          name,
          description,
          recurrenceRule,
          priceCents,
          startsOn,
          createdBy: context.executedBy,
          actorRole: context.executedByRole,
        },
        this.agreementRepo,
        // I1 — deliberately no audit repo: createAgreement's own audit
        // call isn't failure-soft. See class doc comment.
        undefined,
      );
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
              locationId,
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

  /**
   * Primary-then-fallback service-location resolution (C1) — the customer's
   * primary ACTIVE location, else their first active location, else
   * `undefined` (the caller fails execution). Mirrors
   * `EmergencyDispatchExecutionHandler`'s identical resolution ladder.
   */
  private async resolveLocationId(tenantId: string, customerId: string): Promise<string | undefined> {
    if (!this.locationRepo) return undefined;
    const locations = await this.locationRepo.findByCustomer(tenantId, customerId);
    const primary = locations.find((l) => l.isPrimary && !l.isArchived);
    const fallback = locations.find((l) => !l.isArchived);
    return primary?.id ?? fallback?.id;
  }
}
