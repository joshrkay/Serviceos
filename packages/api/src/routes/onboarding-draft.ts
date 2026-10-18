/**
 * /api/onboarding/draft — "pick, don't build" onboarding (slice S1).
 *
 *   POST   /                      create the tenant's draft from trade + metro (idempotent;
 *                                 a repeat call may still record a changed clientTimezone)
 *   GET    /                      read it
 *   PUT    /choices/:settingKey   stage a choice (compare-and-swap on version)
 *   POST   /approve               "That's right": lock the draft row, mint onboarding_* proposals and
 *                                 approve them (optional expectedVersion; repeat taps are idempotent)
 *
 * Owner-only, like POST /api/onboarding/pack and the conversation lane: every
 * write here ends in config-change proposals against the tenant's settings.
 * Runs under the `/api` request transaction, so approve is all-or-nothing.
 */
import { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth/clerk';
import type { Role } from '../auth/rbac';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import { asyncRoute } from '../middleware/async-route';
import { validate } from '../shared/validation';
import { isRuntimeTimezone } from '../shared/timezone';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { ProposalRepository } from '../proposals/proposal';
import type { ApprovalReferenceCheck } from '../proposals/approval-reference-checks';
import { metroForPhone } from '../compliance/us-geography';
import { assembleTypicalShop } from '../onboarding/choices/assemble';
import type { RegionalPriceTierRepository } from '../onboarding/choices/price-tiers';
import { ChoiceKeySchema, WritesNotAllowedError } from '../onboarding/choices/schema';
import { ApproveDraftBodySchema, CreateDraftInputSchema, StageChoiceBodySchema } from '../onboarding/draft/contracts';
import {
  DraftAlreadyApprovedError,
  DraftNotFoundError,
  DraftVersionConflictError,
  type OnboardingDraftRepository,
} from '../onboarding/draft/repository';
import { approveDraft } from '../onboarding/draft/approve';

export interface OnboardingDraftRouterDeps {
  draftRepo: OnboardingDraftRepository;
  tierRepo: RegionalPriceTierRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  approvalReferenceChecks?: ApprovalReferenceCheck[];
}

/** One mapping from repository errors to HTTP errors, shared by PUT /choices and POST /approve. */
function rethrowDraftError(err: unknown, tenantId: string): never {
  if (err instanceof WritesNotAllowedError) throw new ValidationError(err.message);
  if (err instanceof DraftNotFoundError) throw new NotFoundError('OnboardingDraft', tenantId);
  if (err instanceof DraftVersionConflictError) {
    throw new ConflictError(`VERSION_CONFLICT: expected ${err.expected}, found ${err.actual}; re-read the draft`);
  }
  if (err instanceof DraftAlreadyApprovedError) throw new ConflictError('DRAFT_APPROVED: the draft is already approved');
  throw err;
}

export function createOnboardingDraftRouter(deps: OnboardingDraftRouterDeps): Router {
  const { draftRepo, tierRepo, proposalRepo, auditRepo, approvalReferenceChecks } = deps;
  const router = Router();
  const guards = [requireAuth, requireTenant, requireRole('owner')];

  router.post(
    '/',
    ...guards,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const body = validate(CreateDraftInputSchema, req.body);

      const clientTimezone = body.clientTimezone?.trim();
      if (clientTimezone !== undefined && !isRuntimeTimezone(clientTimezone)) {
        throw new ValidationError(`clientTimezone "${clientTimezone}" is not a recognized IANA timezone`);
      }

      const existing = await draftRepo.getForTenant(tenantId);
      if (existing) {
        // The first call may have run before the browser knew its zone; approval
        // refuses a draft without one, so a later call can still record it.
        // An approved draft is frozen: the repeat call stays an idempotent read.
        if (existing.status === 'draft' && clientTimezone !== undefined && clientTimezone !== existing.clientTimezone) {
          let updated;
          try {
            updated = await draftRepo.setClientTimezone(tenantId, clientTimezone);
          } catch (err) {
            if (err instanceof DraftAlreadyApprovedError) throw new ConflictError('DRAFT_APPROVED: the draft is already approved');
            throw err;
          }
          await auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role as Role,
              eventType: 'onboarding.draft_timezone_set',
              entityType: 'onboarding_draft',
              entityId: updated.id,
              metadata: { from: existing.clientTimezone, to: clientTimezone, version: updated.version },
            }),
          );
          res.status(200).json({ draft: updated, created: false });
          return;
        }
        res.status(200).json({ draft: existing, created: false });
        return;
      }

      const metro = body.phone ? metroForPhone(body.phone) : null;
      const assembled = await assembleTypicalShop(tierRepo, {
        packId: body.packId,
        businessName: body.businessName,
        ownerFirstName: body.ownerFirstName,
        metro,
      });
      const draft = await draftRepo.create(tenantId, {
        packId: body.packId,
        trade: assembled.trade,
        metroCode: assembled.metroCode,
        metroName: assembled.metroName,
        businessName: body.businessName,
        ownerFirstName: body.ownerFirstName ?? null,
        clientTimezone: clientTimezone ?? null,
        assembled,
      });
      await auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role as Role,
          eventType: 'onboarding.draft_created',
          entityType: 'onboarding_draft',
          entityId: draft.id,
          metadata: {
            packId: draft.packId,
            trade: draft.trade,
            metroCode: draft.metroCode,
            priceSource: assembled.priceSource,
            metroCandidates: assembled.metroCandidates,
          },
        }),
      );
      res.status(201).json({ draft, created: true });
    }),
  );

  router.get(
    '/',
    ...guards,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const draft = await draftRepo.getForTenant(req.auth!.tenantId);
      if (!draft) throw new NotFoundError('OnboardingDraft', req.auth!.tenantId);
      res.json({ draft });
    }),
  );

  router.put(
    '/choices/:settingKey',
    ...guards,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const keyParse = ChoiceKeySchema.safeParse(req.params.settingKey);
      if (!keyParse.success) throw new ValidationError(`unknown choice "${String(req.params.settingKey)}"`);
      const body = validate(StageChoiceBodySchema, req.body);

      let draft;
      try {
        draft = await draftRepo.stageChoice(tenantId, keyParse.data, body.choice, body.version);
      } catch (err) {
        rethrowDraftError(err, tenantId);
      }

      await auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role as Role,
          eventType: 'onboarding.choice_staged',
          entityType: 'onboarding_draft',
          entityId: draft.id,
          metadata: { settingKey: keyParse.data, choice: body.choice, version: draft.version },
        }),
      );
      res.json({ draft });
    }),
  );

  router.post(
    '/approve',
    ...guards,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      // Express 5 leaves req.body undefined when no body was sent.
      const body = validate(ApproveDraftBodySchema, req.body ?? {});
      let result;
      try {
        result = await approveDraft(
          {
            draftRepo,
            proposalRepo,
            auditRepo,
            ...(approvalReferenceChecks ? { approvalOptions: { referenceChecks: approvalReferenceChecks } } : {}),
          },
          tenantId,
          { userId: req.auth!.userId, role: req.auth!.role as Role },
          { expectedVersion: body.expectedVersion },
        );
      } catch (err) {
        rethrowDraftError(err, tenantId);
      }
      res.json(result);
    }),
  );

  return router;
}
