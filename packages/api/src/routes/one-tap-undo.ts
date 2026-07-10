/**
 * UB-D / D-015 (D3) — public one-tap UNDO endpoint for autonomous-lane
 * bookings.
 *
 * When the autonomous booking lane auto-approves a booking with no
 * supervisor present, the owner is texted a link to this route carrying an
 * HMAC-signed, single-use, ≤30-min token bound to proposal_id + tenant_id +
 * nonce (see `proposals/one-tap-undo.ts`). Redemption:
 *
 *   - proposal still 'approved' (inside the 5-second undo window — rare):
 *     the EXISTING `undoProposal` path (status → 'undone', audit,
 *     correction-lesson reversal semantics preserved) + the held slot is
 *     released (mirrors rejectProposal's hold release).
 *   - proposal 'executed': COMPENSATING flow — the booked appointment is
 *     canceled (`updateAppointment { status: 'canceled' }`, the same
 *     primitive the cancel execution handler uses) and the customer gets a
 *     FIXED-TEMPLATE apology SMS (no LLM; consent/DNC-gated via
 *     `sendCustomerMessage`). This is compensation, not resurrection —
 *     'executed' stays terminal in the proposal lifecycle.
 *
 * Idempotent: the nonce is single-use AND an appointment-status guard makes
 * a double-tap return success without double-cancelling (the already-undone
 * check runs on a NON-consuming peek, so a second tap never errors).
 *
 * Mounted under `/public/proposals` next to the one-tap approve route
 * (unauthenticated but token-gated), with the same minimal mobile HTML
 * responses.
 */
import { Router, Request, Response, urlencoded } from 'express';
import { verifyOneTapUndoToken } from '../proposals/one-tap-undo';
import { AUTONOMOUS_LANE_PROPOSAL_TYPES } from '../proposals/autonomous-lane';
import { undoProposal } from '../proposals/actions';
import type { Proposal, ProposalRepository } from '../proposals/proposal';
import {
  updateAppointment,
  type Appointment,
  type AppointmentRepository,
} from '../appointments/appointment';
import type { JobRepository } from '../jobs/job';
import type { CustomerRepository } from '../customers/customer';
import {
  sendCustomerMessage,
  type CustomerMessageDeliveryDeps,
} from '../notifications/customer-message-delivery';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { Role } from '../auth/rbac';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'one-tap-undo',
  environment: process.env.NODE_ENV || 'development',
});

/** Synthetic actor for SMS one-tap undos (no Clerk session). */
const ONE_TAP_UNDO_ACTOR_ID = 'one_tap_undo_sms';
const ONE_TAP_UNDO_ACTOR_ROLE: Role = 'owner';

/**
 * D-015 — FIXED apology template for the compensating cancel. Deliberately
 * static: never LLM-generated, never personalized beyond the send gates.
 */
export const AUTONOMOUS_UNDO_APOLOGY_SMS =
  'We’re sorry — the appointment we just confirmed had to be canceled. ' +
  'We’ll reach out shortly to find a time that works.';

export interface OneTapUndoRouterDeps {
  proposalRepo: ProposalRepository;
  appointmentRepo: AppointmentRepository;
  auditRepo: AuditRepository;
  /** HMAC secret used to mint tokens. When absent the route returns 503. */
  secret?: string;
  /**
   * Single-use nonce consumer. Production wires the same durable
   * `webhook_events` receipt store the approve route uses, under a
   * DISTINCT source ('one_tap_undo') so the two nonce spaces can't collide.
   */
  consumeNonce: (nonce: string) => boolean | Promise<boolean>;
  /** Appointment → job → customer resolution for the apology SMS. */
  jobRepo?: Pick<JobRepository, 'findById'>;
  customerRepo?: Pick<CustomerRepository, 'findById'>;
  /**
   * Consent/DNC-gated customer delivery (sendCustomerMessage deps).
   * Optional: absent ⇒ the cancel still happens, the apology is skipped.
   */
  customerMessageDeps?: CustomerMessageDeliveryDeps;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center;color:#111}
h1{font-size:1.4rem}p{color:#555}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;
}

/** The appointment the token's proposal booked (resultEntityId is stamped by
 * the executor; payload.appointmentId covers the pre-execution window). */
function appointmentIdFor(proposal: Proposal): string | undefined {
  if (typeof proposal.resultEntityId === 'string' && proposal.resultEntityId) {
    return proposal.resultEntityId;
  }
  const fromPayload = proposal.payload?.appointmentId;
  return typeof fromPayload === 'string' && fromPayload ? fromPayload : undefined;
}

export function createOneTapUndoRouter(deps: OneTapUndoRouterDeps): Router {
  const router = Router();

  const sendApology = async (tenantId: string, appointment: Appointment): Promise<void> => {
    if (!deps.customerMessageDeps || !deps.jobRepo || !deps.customerRepo) return;
    try {
      const job = await deps.jobRepo.findById(tenantId, appointment.jobId);
      if (!job?.customerId) return;
      const customer = await deps.customerRepo.findById(tenantId, job.customerId);
      if (!customer) return;
      // sendCustomerMessage applies the sms_consent + DNC gates and is
      // itself best-effort; the per-appointment idempotency key means a
      // retried redemption can never text the customer twice.
      await sendCustomerMessage(deps.customerMessageDeps, {
        tenantId,
        customer,
        entityType: 'appointment_cancel',
        entityId: appointment.id,
        channels: ['sms'],
        smsBody: AUTONOMOUS_UNDO_APOLOGY_SMS,
        idempotencyKeyPrefix: `one-tap-undo:${appointment.id}`,
      });
    } catch (err) {
      logger.warn('one-tap undo apology SMS failed', {
        appointmentId: appointment.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const auditUndone = async (
    tenantId: string,
    proposalId: string,
    phase: 'pre_execution' | 'post_execution_compensated',
    appointmentId?: string,
  ): Promise<void> => {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: ONE_TAP_UNDO_ACTOR_ID,
        actorRole: 'owner',
        eventType: 'autonomous_booking_undone',
        entityType: 'proposal',
        entityId: proposalId,
        metadata: {
          channel: 'sms_one_tap',
          phase,
          ...(appointmentId ? { appointmentId } : {}),
        },
      }),
    );
  };

  const handler = async (req: Request, res: Response): Promise<void> => {
    const token =
      typeof req.query.token === 'string'
        ? req.query.token
        : typeof (req.body as Record<string, unknown> | undefined)?.token === 'string'
          ? ((req.body as Record<string, unknown>).token as string)
          : '';

    if (!deps.secret) {
      res
        .status(503)
        .type('html')
        .send(page('Unavailable', 'One-tap undo is not configured.'));
      return;
    }
    if (!token) {
      res.status(401).type('html').send(page('Invalid link', 'This undo link is not valid.'));
      return;
    }

    // Non-consuming peek: validates signature/TTL/shape WITHOUT burning the
    // single-use nonce, so the already-undone (double-tap) path below can
    // answer success without consuming anything.
    const peeked = await verifyOneTapUndoToken({
      token,
      secret: deps.secret,
      consumeNonce: () => true,
    });
    if (!peeked.ok) {
      const gone = peeked.reason === 'expired' || peeked.reason === 'already_used';
      res
        .status(gone ? 410 : 401)
        .type('html')
        .send(
          page(
            gone ? 'Link no longer valid' : 'Invalid link',
            peeked.reason === 'expired'
              ? 'This undo link has expired. You can still cancel the appointment from the app.'
              : 'This undo link is not valid.',
          ),
        );
      return;
    }

    const proposal = await deps.proposalRepo.findById(peeked.tenantId, peeked.proposalId);
    if (!proposal) {
      res
        .status(404)
        .type('html')
        .send(page('Not found', 'This booking could not be found.'));
      return;
    }

    // Defense in depth — undo tokens are only ever minted for the lane's two
    // booking types; a token forged/misminted against anything else is
    // refused before any state changes.
    if (!AUTONOMOUS_LANE_PROPOSAL_TYPES.includes(proposal.proposalType)) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: peeked.tenantId,
          actorId: ONE_TAP_UNDO_ACTOR_ID,
          actorRole: 'system',
          eventType: 'proposal.one_tap_undo_blocked_type',
          entityType: 'proposal',
          entityId: proposal.id,
          metadata: { channel: 'sms_one_tap', proposalType: proposal.proposalType },
        }),
      );
      res
        .status(403)
        .type('html')
        .send(page('Cannot undo', 'This link cannot undo that kind of proposal.'));
      return;
    }

    const appointmentId = appointmentIdFor(proposal);
    const appointment = appointmentId
      ? await deps.appointmentRepo.findById(peeked.tenantId, appointmentId)
      : null;

    // Idempotency (double-tap): already undone / already canceled answers
    // success WITHOUT consuming the nonce or re-cancelling.
    if (proposal.status === 'undone' || appointment?.status === 'canceled') {
      res
        .status(200)
        .type('html')
        .send(page('Already undone', 'This booking was already undone — nothing else to do.'));
      return;
    }

    // Real, nonce-consuming verify. From here the link is spent.
    const verified = await verifyOneTapUndoToken({
      token,
      secret: deps.secret,
      consumeNonce: deps.consumeNonce,
    });
    if (!verified.ok) {
      const gone = verified.reason === 'expired' || verified.reason === 'already_used';
      res
        .status(gone ? 410 : 401)
        .type('html')
        .send(
          page(
            gone ? 'Link no longer valid' : 'Invalid link',
            verified.reason === 'already_used'
              ? 'This undo link was already used.'
              : 'This undo link is not valid.',
          ),
        );
      return;
    }

    const tenantId = verified.tenantId;

    if (proposal.status === 'approved') {
      // Inside the 5-second undo window (rare — the owner beat the
      // executor): the EXISTING undo path. If the window just closed or the
      // proposal raced to 'executed', fall through to the compensating
      // cancel below — a canceled appointment can never be confirmed by the
      // create_booking execution handler, so cancelling is safe either way.
      try {
        await undoProposal(
          deps.proposalRepo,
          tenantId,
          proposal.id,
          ONE_TAP_UNDO_ACTOR_ID,
          ONE_TAP_UNDO_ACTOR_ROLE,
          deps.auditRepo,
        );
      } catch (err) {
        logger.warn('one-tap undo: undoProposal failed, falling back to compensating cancel', {
          proposalId: proposal.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Release the held slot (mirrors rejectProposal's hold release). The
      // already-canceled case returned early above, so this cancel never
      // double-applies.
      if (appointment) {
        await updateAppointment(
          tenantId,
          appointment.id,
          { status: 'canceled', holdPendingApproval: false },
          deps.appointmentRepo,
        );
      }
      await auditUndone(tenantId, proposal.id, 'pre_execution', appointment?.id);
      res
        .status(200)
        .type('html')
        .send(page('Booking undone', 'The booking was undone before it went out.'));
      return;
    }

    if (proposal.status === 'executed') {
      // Compensating flow: the customer confirmation already went out, so
      // cancel the appointment and send the fixed-template apology.
      if (!appointment) {
        res
          .status(404)
          .type('html')
          .send(page('Could not undo', 'The booked appointment could not be found.'));
        return;
      }
      const updated = await updateAppointment(
        tenantId,
        appointment.id,
        { status: 'canceled', holdPendingApproval: false },
        deps.appointmentRepo,
      );
      if (!updated) {
        res
          .status(500)
          .type('html')
          .send(page('Could not undo', 'Something went wrong — cancel it from the app.'));
        return;
      }
      await sendApology(tenantId, appointment);
      await auditUndone(tenantId, proposal.id, 'post_execution_compensated', appointment.id);
      res
        .status(200)
        .type('html')
        .send(
          page(
            'Booking undone',
            'The appointment was canceled and the customer received an apology text.',
          ),
        );
      return;
    }

    // Any other status (rejected / ready_for_review / draft) — the booking
    // never went live; nothing to undo from this link.
    res
      .status(409)
      .type('html')
      .send(page('Nothing to undo', 'This booking is not active — check your review queue.'));
  };

  router.get('/one-tap-undo', handler);
  router.post('/one-tap-undo', urlencoded({ extended: false }), handler);

  return router;
}
