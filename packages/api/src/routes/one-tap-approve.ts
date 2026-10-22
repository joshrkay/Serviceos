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
 *   409 — a manual edit request is pending (approve from the queue)
 *   410 — expired or already used (single-use nonce consumed)
 */
import { Router, Request, Response, urlencoded } from 'express';
import {
  createOneTapApproveToken,
  verifyOneTapApproveToken,
} from '../proposals/auto-approve';
import {
  approveChainSet,
  formatChainSetApprovalMessage,
  summarizeChainSetResult,
  type LinkedStepHoldReason,
} from '../proposals/actions';
import { actionClassForProposalType, type ProposalRepository } from '../proposals/proposal';
import type { ProposalSmsEventRepository } from '../proposals/sms/sms-event';
import {
  mintDraftInvoiceProposalForJob,
  type MintDraftInvoiceDeps,
} from '../digest/invoice-one-tap';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { Role } from '../auth/rbac';
import type { ApprovalReferenceCheck } from '../proposals/approval-reference-checks';
import type { ResolvedApprover } from '../proposals/approver-identity';
import { ForbiddenError, ValidationError } from '../shared/errors';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'one-tap-approve',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * Synthetic actor for SMS one-tap approvals (no Clerk session) — an owner
 * link. B1 — a link sent to anyone else (the backup supervisor, when the
 * tenant has no owner phone) carries its recipient's user id and role in the
 * signed token, and the approval acts as them instead — re-checked against
 * who the backup is when the link is tapped (`resolveBackupApprover`).
 */
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
  /**
   * P2-034 — when the owner's SMS edit could not be applied (recorded as
   * an unapplied `edit_request`), approval is blocked over SMS *and* via
   * this link: both would execute the stale payload the owner was told
   * needs the review queue. Optional so pre-P2-034 wiring keeps working.
   */
  smsEventRepo?: Pick<ProposalSmsEventRepository, 'hasUnappliedEditRequest'>;
  /**
   * B4 — the approval-time reference checks the dashboard approve route runs
   * (proposals/approval-reference-checks.ts). A link is not a side door: a
   * card the checks hold gets a plain "needs a closer look" page instead of
   * an "Approved" that then fails at execution.
   */
  approvalReferenceChecks?: ApprovalReferenceCheck[];
  /**
   * B1 — who the tenant's backup supervisor is RIGHT NOW
   * (`resolveBackupSupervisorApprover`). A link minted for the backup carries
   * their id and role from when the text went out; the tap re-checks it here,
   * so a backup who was replaced or deactivated since approves nothing and a
   * re-roled one acts with the role they hold now. Absent → the token's
   * claims are used as minted (unit fixtures).
   */
  resolveBackupApprover?: (tenantId: string) => Promise<ResolvedApprover | null>;
  /**
   * RV-065 — deps for the digest "invoice it" token variant
   * (action: 'mint_draft_invoice'). When the tapped token carries that
   * action, the route mints a draft_invoice proposal for the bound job via
   * the batch-invoice eligibility/payload machinery, then 302-redirects to
   * this same route with a fresh single-use approve token for the new
   * proposal. Optional: when absent, mint tokens answer 503.
   */
  invoiceMintDeps?: Omit<MintDraftInvoiceDeps, 'proposalRepo'>;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center;color:#111}
h1{font-size:1.4rem}p{color:#555}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;
}

/**
 * B4 follow-up — the page for a linked step held for its earlier step
 * (approveProposal's linked-step gate, `details.linkedStepReason`): what to do
 * about that earlier step, not a generic "something needs fixing".
 */
const LINKED_STEP_PAGES: Readonly<Record<LinkedStepHoldReason, { title: string; body: string }>> = {
  approve_parent_first: {
    title: 'Approve the earlier step first',
    body: 'This one depends on an earlier step that hasn’t run yet. Approve that one first — this one unlocks once it has run. It’s waiting in your review queue.',
  },
  issue_invoice_first: {
    title: 'Issue the invoice first',
    body: 'The invoice this sends will be a draft. Once it exists, issue it, then approve this one from your review queue.',
  },
  parent_did_not_run: {
    title: 'Nothing to act on',
    body: 'The earlier step this one depends on didn’t run, so there’s nothing for it to act on. It’s still in your review queue.',
  },
};

/** Minimal HTML-attribute/text escaping for values echoed into pages. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * GET-mint interstitial: link scanners (SMS preview bots, mail security
 * proxies) issue GETs — a confirm page makes those harmless and keeps the
 * single-use nonce intact. The button POSTs the SAME token; the nonce is
 * only consumed (and the draft only minted) on the POST. ≥44px tap target
 * per the mobile/public UI rule.
 */
function mintConfirmPage(jobLabel: string, token: string, action: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Create invoice?</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center;color:#111}
h1{font-size:1.4rem}p{color:#555}
button{min-height:44px;padding:12px 32px;font-size:1rem;border:0;border-radius:8px;
background:#111;color:#fff;cursor:pointer}</style></head>
<body><h1>Create invoice?</h1>
<p>Create the invoice for ${escapeHtml(jobLabel)}?</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Create invoice</button>
</form></body></html>`;
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

    // Non-consuming peek: validates signature/TTL/shape WITHOUT burning the
    // single-use nonce, so we can learn the token's action first. A GET on a
    // MINT token renders a confirm page (link scanners' GETs stay harmless);
    // everything else falls through to the real, nonce-consuming verify.
    const peeked = await verifyOneTapApproveToken({
      token,
      secret: deps.secret,
      consumeNonce: () => true,
    });

    if (peeked.ok && peeked.action === 'mint_draft_invoice' && req.method === 'GET') {
      if (!deps.invoiceMintDeps) {
        res
          .status(503)
          .type('html')
          .send(page('Unavailable', 'Invoice drafting from this link is not configured.'));
        return;
      }
      // Best-effort job label for the confirm copy; the POST re-verifies
      // everything, so a missing job here only degrades the wording.
      let jobLabel = 'this job';
      try {
        const job = await deps.invoiceMintDeps.jobRepo.findById(
          peeked.tenantId,
          peeked.jobId,
        );
        if (job?.summary) jobLabel = job.summary;
      } catch {
        // Keep the generic label.
      }
      res
        .status(200)
        .type('html')
        .send(mintConfirmPage(jobLabel, token, `${req.baseUrl}${req.path}`));
      return;
    }

    // Track-E money-gating (pre-consume, defense-in-depth): a one-tap link
    // approves with a SINGLE tap and no second factor. Capture-class proposals
    // are safe to approve this way; money / comms / irreversible require a
    // deliberate confirm. The token's `confirm` flag is set ONLY by sanctioned
    // non-capture mints (the voice-approval fallback), so a non-capture token
    // WITHOUT it — e.g. a future mint site that forgets to class-gate — is
    // refused here even though every current mint site is class-gated. Checked
    // on the NON-consuming peek so a refused link never burns its single-use
    // nonce.
    if (peeked.ok && peeked.action === 'approve' && peeked.confirm !== true) {
      const target = await deps.proposalRepo.findById(peeked.tenantId, peeked.proposalId);
      if (target && actionClassForProposalType(target.proposalType) !== 'capture') {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: peeked.tenantId,
            actorId: ONE_TAP_ACTOR_ID,
            actorRole: 'system',
            eventType: 'proposal.one_tap_blocked_action_class',
            entityType: 'proposal',
            entityId: peeked.proposalId,
            metadata: {
              channel: 'sms_one_tap',
              actionClass: actionClassForProposalType(target.proposalType),
            },
          }),
        );
        res
          .status(403)
          .type('html')
          .send(
            page(
              'Approve in the app',
              'This one needs the app or its own approval link — a one-tap link can’t approve it on its own. It’s waiting in your review queue.',
            ),
          );
        return;
      }
    }

    const verified = peeked.ok
      ? await verifyOneTapApproveToken({
          token,
          secret: deps.secret,
          consumeNonce: deps.consumeNonce,
        })
      : peeked;

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

    // Track E note — action-class check deliberately NOT added here
    // (unlike the SMS Y reply handler's `sms_approve_blocked_action_class`
    // guard). A texted Y is contextless — it targets whatever render is
    // latest — so non-capture classes must refuse it. This link is the
    // opposite: HMAC-bound to ONE proposal, and tokens for money/comms/
    // irreversible proposals are only minted by deliberate, sanctioned
    // paths (RV-071's voice-approval fallback "I've sent you a text link",
    // RV-061's daily-digest approval links). The Y-refusal copy itself
    // directs the owner to "its own approval link" — blocking the class
    // here would brick both shipped flows. Mint sites stay class-gated:
    // the unsupervised single path only routes ready_for_review (capture-
    // only by decideInitialStatus) and the chain send site suppresses the
    // token for non-capture heads (`suppressApproveLink`).
    //
    // RV-065 — digest "invoice it" tap. The token binds tenant+jobId; the
    // nonce above is already consumed, so a replayed link can never mint a
    // second draft. Mint the draft_invoice proposal through the existing
    // batch-invoice eligibility/payload machinery, then hand off to the
    // STANDARD approve flow via a 302 with a fresh single-use approve token
    // — approval itself stays on the one path (undo window, audit,
    // executor) with no bypass.
    if (verified.action === 'mint_draft_invoice') {
      if (!deps.invoiceMintDeps) {
        res
          .status(503)
          .type('html')
          .send(page('Unavailable', 'Invoice drafting from this link is not configured.'));
        return;
      }
      let minted;
      try {
        minted = await mintDraftInvoiceProposalForJob(
          verified.tenantId,
          verified.jobId,
          ONE_TAP_ACTOR_ID,
          { ...deps.invoiceMintDeps, proposalRepo: deps.proposalRepo },
        );
      } catch (err) {
        logger.warn('one-tap invoice mint failed after token verify', {
          jobId: verified.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
        res
          .status(500)
          .type('html')
          .send(page('Could not draft invoice', 'Something went wrong — try again from your queue.'));
        return;
      }
      if (!minted.ok) {
        const alreadyMinted = minted.reason === 'already_minted';
        res
          .status(alreadyMinted ? 409 : 404)
          .type('html')
          .send(
            page(
              alreadyMinted ? 'Already drafted' : 'Nothing to invoice',
              alreadyMinted
                ? 'An invoice draft for this job is already waiting in your review queue.'
                : 'This job has nothing left to invoice — it may already be billed.',
            ),
          );
        return;
      }

      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: verified.tenantId,
          actorId: ONE_TAP_ACTOR_ID,
          actorRole: 'system',
          eventType: 'proposal.one_tap_invoice_minted',
          entityType: 'proposal',
          entityId: minted.proposalId,
          metadata: { channel: 'sms_one_tap', jobId: verified.jobId },
        }),
      );

      // Fresh approve token for the freshly minted proposal (same TTL/nonce
      // machinery), then 302 into the standard approve page — this same
      // route, approve variant.
      const { token: approveToken } = createOneTapApproveToken({
        proposalId: minted.proposalId,
        tenantId: verified.tenantId,
        secret: deps.secret,
      });
      res.redirect(
        302,
        `${req.baseUrl}${req.path}?token=${encodeURIComponent(approveToken)}`,
      );
      return;
    }

    // P2-034 — pending manual edit: the owner asked to change this
    // proposal and the change awaits the review queue. Approving from
    // the (older) link would execute the stale payload. The nonce is
    // already consumed — the link stays single-use either way.
    if (
      deps.smsEventRepo &&
      (await deps.smsEventRepo.hasUnappliedEditRequest(
        verified.tenantId,
        verified.proposalId,
      ))
    ) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: verified.tenantId,
          actorId: ONE_TAP_ACTOR_ID,
          actorRole: 'system',
          eventType: 'proposal.one_tap_blocked_pending_edit',
          entityType: 'proposal',
          entityId: verified.proposalId,
          metadata: { channel: 'sms_one_tap' },
        }),
      );
      res
        .status(409)
        .type('html')
        .send(
          page(
            'Change pending',
            'You asked to change this proposal — your note is attached. Review and approve it in your queue.',
          ),
        );
      return;
    }

    // B1 — an owner link approves as the owner; a link minted for the backup
    // supervisor approves as who the backup is NOW. Replaced, deactivated, or
    // unknown because the lookup failed → nothing is approved (fail closed;
    // the nonce is spent either way).
    let actorId = ONE_TAP_ACTOR_ID;
    let actorRole: Role = ONE_TAP_ACTOR_ROLE;
    if (verified.approver) {
      let current: Pick<ResolvedApprover, 'role' | 'userId'> | null = verified.approver;
      if (deps.resolveBackupApprover) {
        try {
          current = await deps.resolveBackupApprover(verified.tenantId);
        } catch (err) {
          logger.warn('one-tap backup recheck failed — refusing', {
            proposalId: verified.proposalId,
            error: err instanceof Error ? err.message : String(err),
          });
          current = null;
        }
      }
      if (!current?.userId || current.userId !== verified.approver.userId) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: verified.tenantId,
            actorId: ONE_TAP_ACTOR_ID,
            actorRole: 'system',
            eventType: 'proposal.one_tap_blocked_recipient',
            entityType: 'proposal',
            entityId: verified.proposalId,
            metadata: { channel: 'sms_one_tap', recipient: verified.approver.userId },
          }),
        );
        res
          .status(403)
          .type('html')
          .send(
            page(
              'Ask the owner',
              'This link can’t approve anything now — the owner needs to. It’s still waiting in the review queue.',
            ),
          );
        return;
      }
      actorId = current.userId;
      actorRole = current.role;
    }

    try {
      // EXISTING approval path: status transition guards, missing-field
      // guard, approvedAt stamp (undo window), `proposal.approved` audit
      // event — and the execution worker picks up the approved proposal
      // through its normal idempotent path.
      const result = await approveChainSet(
        deps.proposalRepo,
        verified.tenantId,
        verified.proposalId,
        actorId,
        actorRole,
        deps.auditRepo,
        'one_tap', // RV-073 — HMAC one-tap link approval
        deps.smsEventRepo
          ? (tenantId, proposalId) =>
              deps.smsEventRepo!.hasUnappliedEditRequest(tenantId, proposalId)
          : undefined,
        { referenceChecks: deps.approvalReferenceChecks },
      );
      const approved = result.approved[0];
      const summary = summarizeChainSetResult(result);

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
          metadata: {
            channel: 'sms_one_tap',
            approvedCount: summary.approvedCount,
            skippedCount: summary.followCount,
            skipped: summary.skipped,
          },
        }),
      );

      res
        .status(200)
        .type('html')
        .send(
          page(
            'Approved',
            formatChainSetApprovalMessage(
              summary,
              `”${escapeHtml(approved?.summary ?? 'Proposal')}” has been approved and will execute shortly.`,
            ),
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
      // B1 — the link's recipient (a backup supervisor) holds a role that
      // does not reach this card. Nothing was approved; say who can.
      if (err instanceof ForbiddenError) {
        res
          .status(403)
          .type('html')
          .send(
            page(
              'Ask the owner',
              'You can’t approve this one — the owner needs to. It’s still waiting in the review queue.',
            ),
          );
        return;
      }
      // B4 follow-up — a linked step held for its earlier step: say what to
      // do about that step, not that this one "needs fixing".
      const linkedStepPage =
        err instanceof ValidationError
          ? LINKED_STEP_PAGES[err.details?.linkedStepReason as LinkedStepHoldReason]
          : undefined;
      if (linkedStepPage) {
        res.status(409).type('html').send(page(linkedStepPage.title, linkedStepPage.body));
        return;
      }
      // B4 — still waiting, but something on it has to be fixed first (an
      // unfilled field, or a reference check: e.g. its job belongs to another
      // customer — both carry `details.missingFields`). Say so plainly instead
      // of "it may already be handled". Other refusals (an expired window)
      // keep the page below.
      if (err instanceof ValidationError && Array.isArray(err.details?.missingFields)) {
        res
          .status(409)
          .type('html')
          .send(
            page(
              'Needs a closer look',
              'This can’t be approved from the link yet — something on it needs fixing first. It’s waiting in your review queue.',
            ),
          );
        return;
      }
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
  // The mint confirm page submits a standard HTML form — parse
  // application/x-www-form-urlencoded bodies so the token reaches the
  // handler regardless of the host app's body-parser configuration.
  router.post('/one-tap-approve', urlencoded({ extended: false }), handler);

  return router;
}
