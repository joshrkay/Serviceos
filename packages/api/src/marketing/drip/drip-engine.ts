import { createAuditEvent, type AuditRepository } from '../../audit/audit';
import type { QuietHoursResult } from '../../compliance/jurisdiction';
import type { Customer } from '../../customers/customer';
import type { Logger } from '../../logging/logger';
import type { OutboundText, RecordedSendOutcome } from '../../notifications/outbound-messaging';
import type {
  OutboundConsentContext,
  OutboundConsentResult,
} from '../../voice/outbound-consent';
import { NotFoundError } from '../../shared/errors';
import type { DripRepository, DripSignals } from './drip-repository';
import {
  DEFAULT_TARGET_DAYS,
  DRIP_ATTRIBUTION_WINDOW_DAYS,
  DRIP_MAX_ENROLL_PER_RUN,
  DRIP_MAX_STEP_ATTEMPTS,
  DRIP_RETRY_MINUTES,
  addMinutes,
  advanceAfterStep,
  exitReasonForBlock,
  firstRunAt,
  renderStepBody,
  type DripChannel,
  type DripEnrollment,
  type DripExitReason,
  type DripSequence,
  type DripStep,
} from './sequence';

/**
 * #1735 — the drip engine. Advances each due enrollment by at most one step,
 * and EVERY step passes the same consent path the rest of the product uses:
 *
 *   - SMS   -> A2P 10DLC must be approved, then `OutboundMessaging.sendText`
 *              with purpose 'marketing' (consent flag + marketing grant in the
 *              ledger + DNC + standing revocation + kill switch + volume cap +
 *              send-claim dedupe, all inside the gated delivery).
 *   - call  -> `checkOutboundConsent` (format/premium-NPA filter, tenant DNC,
 *              voice consent) as a HARD gate regardless of
 *              TCPA_CONSENT_ENFORCEMENT, then the existing
 *              `initiateOutboundCall` service. Never a direct provider call.
 *   - email -> suppressed for a customer with a DNC entry or a standing
 *              contact-consent revocation.
 *
 * Quiet hours (tenant timezone window, `recipientQuietHours`) are checked
 * before any step runs: outside the window nothing is sent and the step is
 * rescheduled to the first allowed instant.
 *
 * Nothing here auto-executes a proposal; a sequence only runs after the owner
 * creates it, resumes it and enrolls targets.
 */

export interface DripEngineDeps {
  repo: DripRepository;
  signals: DripSignals;
  customerRepo: { findById(tenantId: string, id: string): Promise<Customer | null> };
  messaging: { sendText(text: OutboundText): Promise<RecordedSendOutcome> } | null;
  sendEmail:
    | ((message: {
        to: string;
        subject: string;
        text: string;
        tenantId: string;
        idempotencyKey: string;
      }) => Promise<unknown>)
    | null;
  placeCall:
    | ((input: {
        tenantId: string;
        customerId: string;
        agentPhone: string;
        actorId: string;
        actorRole: string;
      }) => Promise<{ callSid: string }>)
    | null;
  /** `checkOutboundConsent` bound to the tenant pool (audits its own blocks). */
  checkCallConsent: ((ctx: OutboundConsentContext) => Promise<OutboundConsentResult>) | null;
  /** True once the tenant's A2P 10DLC campaign is approved. */
  isSmsRegistered: (tenantId: string) => Promise<boolean>;
  /** Tenant-timezone send window for this recipient. */
  quietHours: (input: {
    tenantId: string;
    customerId: string;
    phone: string | null;
  }) => Promise<QuietHoursResult>;
  /** DNC entry or standing sms/marketing revocation for the number. */
  isOptedOut: (tenantId: string, phone: string) => Promise<boolean>;
  normalizePhone: (phone: string) => string;
  auditRepo: AuditRepository;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

type StepResult =
  | { kind: 'sent'; detail?: string }
  | { kind: 'skipped'; reason: string; exit?: DripExitReason }
  | { kind: 'retry'; reason: string }
  | { kind: 'rescheduled'; at: Date };

const SYSTEM_ACTOR = 'system:drip-campaigns';
const SYSTEM_ROLE = 'system';
const LEASE_MINUTES = 15;
const EMAIL_FOOTER = '\n\nIf you would rather not hear from us, reply to this email and we will remove you.';

export interface DripEngine {
  /** Enrolls the sequence's current targets (capped); returns how many were newly enrolled. */
  enrollTargets(tenantId: string, sequenceId: string, actor: { userId: string; role: string }): Promise<number>;
  /** Runs one sweep for a tenant; returns the number of enrollments processed. */
  runTenant(tenantId: string, limit?: number): Promise<number>;
}

export function createDripEngine(deps: DripEngineDeps): DripEngine {
  const clock = () => (deps.now ? deps.now() : new Date());

  async function audit(
    tenantId: string,
    eventType: string,
    enrollment: DripEnrollment,
    metadata: Record<string, unknown>,
    actor?: { userId: string; role: string },
  ): Promise<void> {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor?.userId ?? SYSTEM_ACTOR,
        actorRole: actor?.role ?? SYSTEM_ROLE,
        eventType,
        entityType: 'drip_enrollment',
        entityId: enrollment.id,
        metadata: { sequenceId: enrollment.sequenceId, customerId: enrollment.customerId, ...metadata },
      }),
    );
  }

  async function finish(
    enrollment: DripEnrollment,
    reason: DripExitReason,
    now: Date,
  ): Promise<void> {
    await deps.repo.updateEnrollment(enrollment.tenantId, enrollment.id, {
      status: reason === 'completed' ? 'completed' : 'exited',
      exitReason: reason,
      currentStep: enrollment.currentStep,
      stepAttempts: 0,
      nextRunAt: now,
      finishedAt: now,
    });
    await audit(enrollment.tenantId, 'drip.enrollment_exited', enrollment, { reason });
  }

  async function executeStep(
    enrollment: DripEnrollment,
    step: DripStep,
    customer: Customer,
  ): Promise<StepResult> {
    const tenantId = enrollment.tenantId;
    const phone = customer.primaryPhone?.trim() ? deps.normalizePhone(customer.primaryPhone) : null;
    const stepKey = `${enrollment.id}:${enrollment.currentStep}`;

    if (step.channel === 'sms') {
      if (!phone) return { kind: 'skipped', reason: 'no_phone' };
      if (!deps.messaging) return { kind: 'retry', reason: 'messaging_not_configured' };
      // A2P 10DLC: unregistered numbers get filtered by carriers; never send a
      // marketing text until the tenant's campaign is approved.
      if (!(await deps.isSmsRegistered(tenantId))) return { kind: 'retry', reason: 'a2p_not_approved' };
      const outcome = await deps.messaging.sendText({
        tenantId,
        recipient: { kind: 'customer', customerId: customer.id },
        purpose: 'marketing',
        about: { entityType: 'custom_message', entityId: customer.id },
        dedupe: { messageKind: 'drip_step', recordId: stepKey },
        body: renderStepBody(step.body, customer),
      });
      if (outcome.status === 'sent') return { kind: 'sent' };
      if (outcome.status === 'scheduled') return { kind: 'rescheduled', at: outcome.at };
      if (outcome.permanent) {
        return { kind: 'skipped', reason: outcome.reason, exit: exitReasonForBlock(outcome.reason) ?? undefined };
      }
      return { kind: 'retry', reason: outcome.reason };
    }

    if (step.channel === 'call') {
      if (!phone) return { kind: 'skipped', reason: 'no_phone' };
      if (!deps.placeCall || !deps.checkCallConsent) return { kind: 'retry', reason: 'calling_not_configured' };
      const consent = await deps.checkCallConsent({
        tenantId,
        phoneE164: phone,
        actorId: SYSTEM_ACTOR,
        actorRole: SYSTEM_ROLE,
        correlationId: enrollment.id,
      });
      if (!consent.allowed) {
        const reason = consent.reason ?? 'consent_not_granted';
        return { kind: 'skipped', reason, exit: exitReasonForBlock(reason) ?? undefined };
      }
      try {
        const result = await deps.placeCall({
          tenantId,
          customerId: customer.id,
          agentPhone: step.agentPhone,
          actorId: SYSTEM_ACTOR,
          actorRole: SYSTEM_ROLE,
        });
        return { kind: 'sent', detail: result.callSid };
      } catch (err) {
        const code = (err as { code?: string }).code;
        // The call service re-checks DNC/consent itself; map its refusals to a skip.
        if (code === 'dnc_blocked') return { kind: 'skipped', reason: 'dnc', exit: 'opted_out' };
        if (code === 'consent_blocked') return { kind: 'skipped', reason: 'consent_not_granted' };
        return { kind: 'retry', reason: code ?? 'call_failed' };
      }
    }

    // email
    const to = customer.email?.trim();
    if (!to) return { kind: 'skipped', reason: 'no_email' };
    if (phone && (await deps.isOptedOut(tenantId, phone))) {
      return { kind: 'skipped', reason: 'opted_out', exit: 'opted_out' };
    }
    if (!deps.sendEmail) return { kind: 'retry', reason: 'email_not_configured' };
    try {
      await deps.sendEmail({
        to,
        subject: step.subject,
        text: renderStepBody(step.body, customer) + EMAIL_FOOTER,
        tenantId,
        idempotencyKey: `drip_step:${stepKey}`,
      });
      return { kind: 'sent' };
    } catch (err) {
      deps.logger.warn('drip email step failed', {
        tenantId,
        enrollmentId: enrollment.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'retry', reason: 'email_failed' };
    }
  }

  async function processEnrollment(sequence: DripSequence, enrollment: DripEnrollment): Promise<void> {
    const tenantId = enrollment.tenantId;
    const now = clock();
    const customer = await deps.customerRepo.findById(tenantId, enrollment.customerId);
    if (!customer || customer.isArchived) {
      await finish(enrollment, 'customer_unavailable', now);
      return;
    }

    // Exit conditions, in precedence order: booked, renewed, replied, opted out.
    const booking = await deps.signals.findBookingSince(tenantId, customer.id, enrollment.enrolledAt);
    if (booking) {
      await deps.repo.recordBooking(tenantId, enrollment.id, booking);
      await audit(tenantId, 'drip.booking_attributed', enrollment, {
        appointmentId: booking.appointmentId,
        attribution: 'in_sequence',
      });
      await finish(enrollment, 'booked', now);
      return;
    }
    if (
      enrollment.sourceEntityType === 'service_agreement' &&
      enrollment.sourceEntityId &&
      (await deps.signals.hasRenewedMembership(tenantId, {
        agreementId: enrollment.sourceEntityId,
        customerId: customer.id,
        // At enrollment the membership ended within the target window; running
        // past the window's end now means it was extended.
        renewBy: addMinutes(enrollment.enrolledAt, sequence.targetDays * 24 * 60),
        since: enrollment.enrolledAt,
      }))
    ) {
      await finish(enrollment, 'renewed', now);
      return;
    }
    if (await deps.signals.hasRepliedSince(tenantId, customer.id, enrollment.enrolledAt)) {
      await finish(enrollment, 'replied', now);
      return;
    }
    const phone = customer.primaryPhone?.trim() ? deps.normalizePhone(customer.primaryPhone) : null;
    if (phone && (await deps.isOptedOut(tenantId, phone))) {
      await finish(enrollment, 'opted_out', now);
      return;
    }

    const step = sequence.steps[enrollment.currentStep];
    if (!step) {
      await finish(enrollment, 'completed', now);
      return;
    }

    // Quiet hours apply to every channel; a closed window consumes nothing.
    const window = await deps.quietHours({ tenantId, customerId: customer.id, phone });
    if (!window.isAllowedNow) {
      await deps.repo.updateEnrollment(tenantId, enrollment.id, {
        status: 'active',
        exitReason: null,
        currentStep: enrollment.currentStep,
        stepAttempts: enrollment.stepAttempts,
        nextRunAt: window.nextAllowedAt,
        finishedAt: null,
      });
      return;
    }

    const result = await executeStep(enrollment, step, customer);
    const channel: DripChannel = step.channel;

    if (result.kind === 'rescheduled') {
      await deps.repo.updateEnrollment(tenantId, enrollment.id, {
        status: 'active',
        exitReason: null,
        currentStep: enrollment.currentStep,
        stepAttempts: enrollment.stepAttempts,
        nextRunAt: result.at,
        finishedAt: null,
      });
      return;
    }

    if (result.kind === 'retry') {
      const attempts = enrollment.stepAttempts + 1;
      if (attempts < DRIP_MAX_STEP_ATTEMPTS) {
        await deps.repo.updateEnrollment(tenantId, enrollment.id, {
          status: 'active',
          exitReason: null,
          currentStep: enrollment.currentStep,
          stepAttempts: attempts,
          nextRunAt: addMinutes(now, DRIP_RETRY_MINUTES),
          finishedAt: null,
        });
        return;
      }
      // Out of attempts: record the failure and move on to the next step.
      await deps.repo.addStepEvent({
        tenantId,
        enrollmentId: enrollment.id,
        stepIndex: enrollment.currentStep,
        channel,
        outcome: 'failed',
        reason: result.reason,
      });
      await audit(tenantId, 'drip.step_failed', enrollment, {
        stepIndex: enrollment.currentStep,
        channel,
        reason: result.reason,
      });
    } else if (result.kind === 'skipped') {
      await deps.repo.addStepEvent({
        tenantId,
        enrollmentId: enrollment.id,
        stepIndex: enrollment.currentStep,
        channel,
        outcome: 'skipped',
        reason: result.reason,
      });
      await audit(tenantId, 'drip.step_skipped', enrollment, {
        stepIndex: enrollment.currentStep,
        channel,
        reason: result.reason,
      });
      if (result.exit) {
        await finish(enrollment, result.exit, now);
        return;
      }
    } else {
      await deps.repo.addStepEvent({
        tenantId,
        enrollmentId: enrollment.id,
        stepIndex: enrollment.currentStep,
        channel,
        outcome: 'sent',
        ...(result.detail ? { reason: result.detail } : {}),
      });
      await audit(tenantId, 'drip.step_sent', enrollment, {
        stepIndex: enrollment.currentStep,
        channel,
      });
    }

    const next = advanceAfterStep(sequence.steps, enrollment.currentStep, now);
    if (next.done) {
      await finish(enrollment, 'completed', now);
      return;
    }
    await deps.repo.updateEnrollment(tenantId, enrollment.id, {
      status: 'active',
      exitReason: null,
      currentStep: next.currentStep,
      stepAttempts: 0,
      nextRunAt: next.nextRunAt,
      finishedAt: null,
    });
  }

  /** A booking after the sequence ended (within the window) still credits it. */
  async function attributeLateBookings(tenantId: string, now: Date): Promise<void> {
    const since = addMinutes(now, -DRIP_ATTRIBUTION_WINDOW_DAYS * 24 * 60);
    const candidates = await deps.repo.listAttributionCandidates(tenantId, since, 100);
    for (const enrollment of candidates) {
      const booking = await deps.signals.findBookingSince(
        tenantId,
        enrollment.customerId,
        enrollment.enrolledAt,
      );
      if (!booking) continue;
      await deps.repo.recordBooking(tenantId, enrollment.id, booking);
      await audit(tenantId, 'drip.booking_attributed', enrollment, {
        appointmentId: booking.appointmentId,
        attribution: 'after_sequence',
      });
    }
  }

  return {
    async enrollTargets(tenantId, sequenceId, actor) {
      const sequence = await deps.repo.findSequence(tenantId, sequenceId);
      if (!sequence) throw new NotFoundError('Drip campaign', sequenceId);
      const now = clock();
      const days = sequence.targetDays ?? DEFAULT_TARGET_DAYS[sequence.targetKind];
      const targets = await deps.signals.findTargets(
        tenantId,
        sequence.targetKind,
        days,
        now,
        DRIP_MAX_ENROLL_PER_RUN,
      );
      const enrolled = await deps.repo.enroll(tenantId, sequence.id, targets, firstRunAt(sequence.steps, now));
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: actor.userId,
          actorRole: actor.role,
          eventType: 'drip.targets_enrolled',
          entityType: 'drip_sequence',
          entityId: sequence.id,
          metadata: { matched: targets.length, enrolled },
        }),
      );
      return enrolled;
    },

    async runTenant(tenantId, limit = 50) {
      const now = clock();
      const due = await deps.repo.listDue(tenantId, now, limit);
      let processed = 0;
      const sequences = new Map<string, DripSequence | null>();
      for (const enrollment of due) {
        try {
          // Lease first: a concurrent sweep (or a retry after a crash) must not run the same step twice.
          if (!(await deps.repo.claim(tenantId, enrollment.id, now, addMinutes(now, LEASE_MINUTES)))) continue;
          if (!sequences.has(enrollment.sequenceId)) {
            sequences.set(enrollment.sequenceId, await deps.repo.findSequence(tenantId, enrollment.sequenceId));
          }
          const sequence = sequences.get(enrollment.sequenceId);
          if (!sequence) continue;
          await processEnrollment(sequence, enrollment);
          processed += 1;
        } catch (err) {
          // One enrollment's failure must not stop the sweep; its lease expires and it retries.
          deps.logger.warn('drip enrollment failed', {
            tenantId,
            enrollmentId: enrollment.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await attributeLateBookings(tenantId, now);
      return processed;
    },
  };
}
