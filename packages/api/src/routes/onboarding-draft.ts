/**
 * /api/onboarding/draft — "pick, don't build" onboarding (slice S1).
 *
 *   POST   /                      create the tenant's draft from trade + metro (idempotent;
 *                                 a repeat call may still record a changed clientTimezone)
 *   GET    /                      read it
 *   PUT    /choices/:settingKey   stage a choice (compare-and-swap on version)
 *   PUT    /owner-phone           add or change the owner's cell (compare-and-swap on version)
 *   PUT    /metro                 "Not Cleveland?": re-price an unstaged draft for another curated metro
 *                                 (409 DRAFT_APPROVED, then 409 DRAFT_METRO_LOCKED once any choice is
 *                                 staged, then 409 VERSION_CONFLICT; the code, the name and the whole
 *                                 assembled shop change in one version bump)
 *   POST   /approve               "That's right": lock the draft row, mint onboarding_* proposals and
 *                                 approve them (optional expectedVersion; repeat taps are idempotent)
 *   POST   /retry                 re-queue the proposals whose execution failed (lock the draft row,
 *                                 reset each execution_failed one to draft and approve it again for a
 *                                 fresh undo window; 409 DRAFT_NOT_APPROVED, then 409 DRAFT_RETRY_UNSAFE
 *                                 when a listed proposal is undone/rejected/expired/missing (nothing is
 *                                 re-queued), then 409 DRAFT_RETRY_NOTHING_FAILED when none failed;
 *                                 a successful retry is a new approval attempt and moves the draft
 *                                 `version` by one, the response carries it, a refused one moves nothing;
 *                                 S4: optional { expectedVersion }, 409 VERSION_CONFLICT after
 *                                 DRAFT_NOT_APPROVED and before DRAFT_RETRY_UNSAFE; the response adds
 *                                 `undoable` over the post-retry set)
 *   POST   /undo                  "Undo" on the saving screen: take back the whole approval or nothing
 *                                 (required { expectedVersion }; 409 DRAFT_NOT_APPROVED, then
 *                                 VERSION_CONFLICT, then DRAFT_UNDO_REFUSED / UNDO_WINDOW_CLOSED;
 *                                 200 { draft } editable again at version + 1)
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
import { NPA_METROS, metroForPhone } from '../compliance/us-geography';
import { assembleTypicalShop } from '../onboarding/choices/assemble';
import type { RegionalPriceTierRepository } from '../onboarding/choices/price-tiers';
import { ChoiceKeySchema, WritesNotAllowedError } from '../onboarding/choices/schema';
import {
  ApproveDraftBodySchema,
  CreateDraftInputSchema,
  RetryDraftBodySchema,
  SetMetroBodySchema,
  SetOwnerPhoneBodySchema,
  StageChoiceBodySchema,
  UndoDraftBodySchema,
} from '../onboarding/draft/contracts';
import { parseOwnerPhone } from '../onboarding/draft/owner-phone';
import { maskPhone } from '../telephony/twilio-call-control';
import {
  DraftAlreadyApprovedError,
  DraftMetroLockedError,
  DraftNotApprovedError,
  DraftNotFoundError,
  DraftVersionConflictError,
  type OnboardingDraftRepository,
} from '../onboarding/draft/repository';
import { approveDraft } from '../onboarding/draft/approve';
import { retryFailedDraftProposals } from '../onboarding/draft/retry';
import { undoApprovedDraft } from '../onboarding/draft/undo';

export interface OnboardingDraftRouterDeps {
  draftRepo: OnboardingDraftRepository;
  tierRepo: RegionalPriceTierRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  approvalReferenceChecks?: ApprovalReferenceCheck[];
}

/**
 * One mapping from repository errors to HTTP errors, shared by every draft
 * write (the field PUTs, approve, retry; undo and reset follow). The typed
 * errors are the ones `updateLocked` throws, in its order of checks.
 */
function rethrowDraftError(err: unknown, tenantId: string): never {
  if (err instanceof WritesNotAllowedError) throw new ValidationError(err.message);
  if (err instanceof DraftNotFoundError) throw new NotFoundError('OnboardingDraft', tenantId);
  if (err instanceof DraftVersionConflictError) {
    throw new ConflictError(`VERSION_CONFLICT: expected ${err.expected}, found ${err.actual}; re-read the draft`);
  }
  if (err instanceof DraftAlreadyApprovedError) throw new ConflictError('DRAFT_APPROVED: the draft is already approved');
  if (err instanceof DraftNotApprovedError) throw new ConflictError('DRAFT_NOT_APPROVED: the draft has not been approved');
  if (err instanceof DraftMetroLockedError) {
    throw new ConflictError('DRAFT_METRO_LOCKED: a choice is already staged, so the city can no longer change here');
  }
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

      // Validated before the existing-draft lookup so a malformed cell is always a
      // 400 naming `phone` and nothing is created. On a repeat call for an existing
      // draft the value is otherwise ignored: PUT /owner-phone is the only way to
      // change it later, so a re-rendered first screen cannot overwrite a number
      // the owner corrected.
      const ownerPhone = body.phone === undefined ? null : parseOwnerPhone(body.phone, 'phone');

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
            // Approved between the read above and the lock: 409 DRAFT_APPROVED, as for every draft write.
            rethrowDraftError(err, tenantId);
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
        ownerPhone,
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
            hasOwnerPhone: draft.ownerPhone !== null,
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

  router.put(
    '/owner-phone',
    ...guards,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const body = validate(SetOwnerPhoneBodySchema, req.body);
      const ownerPhone = parseOwnerPhone(body.ownerPhone, 'ownerPhone');

      let draft;
      try {
        draft = await draftRepo.setOwnerPhone(tenantId, ownerPhone, body.version);
      } catch (err) {
        rethrowDraftError(err, tenantId);
      }

      // The full number never goes into audit metadata or logs.
      await auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role as Role,
          eventType: 'onboarding.owner_phone_set',
          entityType: 'onboarding_draft',
          entityId: draft.id,
          metadata: { ownerPhone: maskPhone(ownerPhone), version: draft.version },
        }),
      );
      res.json({ draft });
    }),
  );

  router.put(
    '/metro',
    ...guards,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      // Validated before anything is locked: an unknown code is a 400 naming `metro`.
      const body = validate(SetMetroBodySchema, req.body);
      const metro = { kind: 'metro' as const, metroCode: body.metro, name: NPA_METROS[body.metro].name };

      let from: string | null = null;
      let draft;
      try {
        // Built from the LOCKED row, inside the one write: the shop the approval copies is this one.
        draft = await draftRepo.setMetro(tenantId, body.metro, body.version, (row) => {
          from = row.metroCode;
          return assembleTypicalShop(tierRepo, {
            packId: row.packId,
            businessName: row.businessName,
            ownerFirstName: row.ownerFirstName ?? undefined,
            metro,
          });
        });
      } catch (err) {
        rethrowDraftError(err, tenantId);
      }

      await auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role as Role,
          eventType: 'onboarding.metro_changed',
          entityType: 'onboarding_draft',
          entityId: draft.id,
          metadata: { from, to: draft.metroCode, version: draft.version },
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

  // The body is optional ({ expectedVersion? }); none keeps the bodyless behaviour.
  // The retry's own guards are plain AppErrors (404/409); a stale version and the
  // version bump answer through the shared mapper.
  router.post(
    '/retry',
    ...guards,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      // Express 5 leaves req.body undefined when no body was sent.
      const body = validate(RetryDraftBodySchema, req.body ?? {});
      let result;
      try {
        result = await retryFailedDraftProposals(
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

  router.post(
    '/undo',
    ...guards,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      // Validated before anything is locked: a missing or malformed version is a 400.
      const body = validate(UndoDraftBodySchema, req.body ?? {});
      let result;
      try {
        result = await undoApprovedDraft(
          { draftRepo, proposalRepo, auditRepo },
          tenantId,
          { userId: req.auth!.userId, role: req.auth!.role as Role },
          { expectedVersion: body.expectedVersion },
        );
      } catch (err) {
        rethrowDraftError(err, tenantId);
      }
      res.json({ draft: result.draft });
    }),
  );

  return router;
}
