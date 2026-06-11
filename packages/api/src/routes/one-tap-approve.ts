/**
 * P12-004 wiring — public one-tap proposal approve endpoint.
 *
 * The unsupervised `queue_and_sms` routing texts the owner a link to this
 * route. The link carries an HMAC-signed, single-use, ≤30-min token bound to
 * proposal_id + tenant_id + nonce (see `proposals/auto-approve.ts`). The
 * route verifies the token (consuming the nonce), then approves the proposal
 * through the EXISTING approval path (`approveProposal`) — so execution,
 * idempotency, and the undo window all behave exactly as a dashboard
 * approval. No executor bypass.
 *
 * Mounted under `/public` (unauthenticated but token-gated, rate-limited),
 * mirroring the public estimate/invoice token routes.
 *
 * Responses are minimal mobile-friendly HTML:
 *   200 — approved (or already approved via this same path)
 *   401 — malformed / bad signature / tenant mismatch
 *   410 — expired or already used (single-use nonce consumed)
 */
import { Router, Request, Response } from 'express';
import { verifyOneTapApproveToken } from '../proposals/auto-approve';
import { approveProposal } from '../proposals/actions';
import type { ProposalRepository } from '../proposals/proposal';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { Role } from '../auth/rbac';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'one-tap-approve',
  environment: process.env.NODE_ENV || 'development',
});

/** Synthetic actor for SMS one-tap approvals (no Clerk session). */
const ONE_TAP_ACTOR_ID = 'one_tap_sms';
const ONE_TAP_ACTOR_ROLE: Role = 'owner';

export interface OneTapApproveRouterDeps {
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  /** HMAC secret used to mint tokens. When absent the route returns 503. */
  secret?: string;
  /**
   * Single-use nonce consumer. Production wires a durable store backed by
   * the `webhook_events` (source, idempotency_key) unique index; tests and
   * single-instance dev may use `createInMemoryNonceStore()`.
   */
  consumeNonce: (nonce: string) => boolean | Promise<boolean>;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center;color:#111}
h1{font-size:1.4rem}p{color:#555}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;
}

export function createOneTapApproveRouter(deps: OneTapApproveRouterDeps): Router {
  const router = Router();

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
        .send(page('Unavailable', 'One-tap approvals are not configured.'));
      return;
    }
    if (!token) {
      res.status(401).type('html').send(page('Invalid link', 'This approval link is not valid.'));
      return;
    }

    const verified = await verifyOneTapApproveToken({
      token,
      secret: deps.secret,
      consumeNonce: deps.consumeNonce,
    });

    if (!verified.ok) {
      const gone = verified.reason === 'expired' || verified.reason === 'already_used';
      const status = gone ? 410 : 401;
      res
        .status(status)
        .type('html')
        .send(
          page(
            gone ? 'Link no longer valid' : 'Invalid link',
            verified.reason === 'expired'
              ? 'This approval link has expired. The proposal is still waiting in your review queue.'
              : verified.reason === 'already_used'
                ? 'This approval link was already used.'
                : 'This approval link is not valid.',
          ),
        );
      return;
    }

    try {
      // EXISTING approval path: status transition guards, missing-field
      // guard, approvedAt stamp (undo window), `proposal.approved` audit
      // event — and the execution worker picks up the approved proposal
      // through its normal idempotent path.
      const approved = await approveProposal(
        deps.proposalRepo,
        verified.tenantId,
        verified.proposalId,
        ONE_TAP_ACTOR_ID,
        ONE_TAP_ACTOR_ROLE,
        deps.auditRepo,
      );

      // P12-004 — record that this approval came through the one-tap SMS
      // link specifically (in addition to the standard proposal.approved
      // event emitted by approveProposal).
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: verified.tenantId,
          actorId: ONE_TAP_ACTOR_ID,
          actorRole: 'system',
          eventType: 'proposal.one_tap_approved',
          entityType: 'proposal',
          entityId: verified.proposalId,
          metadata: { channel: 'sms_one_tap' },
        }),
      );

      res
        .status(200)
        .type('html')
        .send(
          page(
            'Approved',
            `“${approved.summary}” has been approved and will execute shortly.`,
          ),
        );
    } catch (err) {
      // The nonce is consumed even when approval fails (e.g. the proposal
      // was already approved/rejected in the dashboard). That is the safe
      // direction — a link can never approve twice.
      logger.warn('one-tap approval failed after token verify', {
        proposalId: verified.proposalId,
        error: err instanceof Error ? err.message : String(err),
      });
      res
        .status(410)
        .type('html')
        .send(
          page(
            'Could not approve',
            'This proposal can no longer be approved from this link — it may already have been handled. Check your review queue.',
          ),
        );
    }
  };

  router.get('/one-tap-approve', handler);
  router.post('/one-tap-approve', handler);

  return router;
}
