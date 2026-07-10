/**
 * U2 — customer MMS-to-quote intake.
 *
 * The CUSTOMER counterpart to the tech photo path. The MMS worker
 * (src/workers/mms-ingest-worker.ts) runs the tech pipeline first
 * (`ingestInboundMms`, clock-in gated); when the sender is NOT a
 * registered technician, the worker hands the same inbound MMS to this
 * intake instead of silently dropping it.
 *
 * Flow:
 *   1. Resolve the inbound number to a tenant customer (phone match —
 *      the same caller-ID resolution `lookup-customer` uses). Three
 *      outcomes, mirroring the entity-resolver contract:
 *        - 0 matches  → create a new (prefilled) customer + audit, then
 *          draft against it.
 *        - 1 match    → draft against the resolved customer.
 *        - 2+ matches → emit a `voice_clarification` proposal listing the
 *          candidates and DRAFT NOTHING. Ambiguity is never a silent guess.
 *   2. Fetch + store each photo through the files pipeline (same Twilio
 *      Basic-auth fetcher + StorageProvider as the tech path), attached to
 *      the customer, and presign a short-lived URL per stored object.
 *   3. Call `MmsEstimateTaskHandler` (image blocks + customer context) →
 *      catalog-grounded draft_estimate proposal → persist + audit.
 *   4. Vision-parse failure → owner notice (SMS), no proposal, no crash.
 *
 * Never auto-issues: the draft lands in the owner approval queue (the
 * vision task caps uncatalogued-line confidence below the auto-approve
 * threshold).
 */
import type { InboundSmsContext } from '../inbound-dispatch';
import {
  createFileRecord,
  normalizeContentType,
  type FileRepository,
  type StorageProvider,
} from '../../files/file-service';
import {
  createCustomer,
  type CustomerRepository,
  type Customer,
} from '../../customers/customer';
import { normalizePhone } from '../../shared/phone';
import { createProposal, type ProposalRepository } from '../../proposals/proposal';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { createLogger, type Logger } from '../../logging/logger';
import type { CatalogItemRepository } from '../../catalog/catalog-item';
import type { LLMGateway } from '../../ai/gateway/gateway';
import {
  MmsEstimateTaskHandler,
  type MmsEstimateImage,
} from '../../ai/tasks/mms-estimate-task';
import type { FetchedMedia, MediaFetcher } from '../tech-status/mms-ingest';

const defaultLogger = createLogger({
  service: 'sms-customer-mms',
  environment: process.env.NODE_ENV || 'dev',
});

/** Actor recorded on customer/proposal/audit writes from this path. */
export const CUSTOMER_MMS_ACTOR = 'system:customer-mms-intake';

/** Owner notice when a customer photo could not be drafted into an estimate. */
export const CUSTOMER_MMS_PARSE_FALLBACK_NOTICE =
  'A customer texted a photo we could not turn into a draft estimate automatically. Check the conversation and follow up.';

/**
 * U6 — inbound MMS cost/abuse policy. Each photo-quote is a vision-model call
 * (+ a possible customer auto-create), so a sender is capped per phone per
 * window via the generic PhoneRateLimiter under this scope. Env-overridable.
 */
export const CUSTOMER_MMS_RATE_SCOPE = 'customer_mms';
export const CUSTOMER_MMS_RATE_LIMIT = Number(process.env.CUSTOMER_MMS_RATE_LIMIT ?? 5);
export const CUSTOMER_MMS_RATE_WINDOW_MS = Number(
  process.env.CUSTOMER_MMS_RATE_WINDOW_MS ?? 60 * 60 * 1000,
);

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function isSupportedImage(contentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    EXTENSION_BY_TYPE,
    normalizeContentType(contentType),
  );
}

export type CustomerMmsOutcome =
  | 'ignored_no_media'
  | 'rate_limited'
  | 'clarification'
  | 'no_storable_media'
  | 'parse_failed'
  | 'drafted';

export interface CustomerMmsResult {
  outcome: CustomerMmsOutcome;
  /** Set when a draft_estimate proposal was persisted. */
  proposalId?: string;
  /** Set when a new customer was created for an unknown sender. */
  customerId?: string;
  /** Photos successfully stored + presigned for the vision task. */
  storedImages: number;
}

export interface CustomerMmsIntakeDeps {
  customerRepo: CustomerRepository;
  proposalRepo: Pick<ProposalRepository, 'create'>;
  fileRepo: Pick<FileRepository, 'create'>;
  storage: Pick<StorageProvider, 'putObject' | 'generateDownloadUrl'>;
  storageBucket: string;
  fetchMedia: MediaFetcher;
  gateway: LLMGateway;
  /** Optional catalog grounding (every drafted price is resolved when present). */
  catalogRepo?: CatalogItemRepository;
  auditRepo?: AuditRepository;
  /** Owner notice transport for the parse-failure fallback. Absent → skipped. */
  notifyOwner?: (tenantId: string, body: string) => Promise<void>;
  /**
   * U6 — cost/abuse gate. Returns true when this sender is within the
   * photo-quote cap (and records the usage), false when over. Absent → no
   * limiting (e.g. in-memory/dev). Called BEFORE customer resolution and the
   * vision call so an over-limit sender creates nothing and costs nothing.
   */
  checkRateLimit?: (tenantId: string, fromPhone: string) => Promise<boolean>;
  /** Supervisor presence/mode, threaded to the auto-approve gate when known. */
  supervisorPresent?: boolean;
  logger?: Logger;
}

/**
 * Store one fetched photo through the files pipeline (attached to the
 * customer) and return a presigned URL the gateway can fetch. Returns
 * null when the item is not a storable image.
 */
async function storeAndPresign(
  ctx: InboundSmsContext,
  deps: CustomerMmsIntakeDeps,
  customerId: string,
  fetched: FetchedMedia,
  declaredContentType: string | undefined,
  index: number,
): Promise<MmsEstimateImage | null> {
  const contentType = normalizeContentType(fetched.contentType ?? declaredContentType ?? '');
  if (!isSupportedImage(contentType)) return null;

  const record = createFileRecord(
    {
      tenantId: ctx.tenantId,
      filename: `customer-mms-${ctx.messageSid}-${index}.${EXTENSION_BY_TYPE[contentType]}`,
      contentType,
      sizeBytes: fetched.bytes.length,
      entityType: 'customer',
      entityId: customerId,
      uploadedBy: CUSTOMER_MMS_ACTOR,
    },
    deps.storageBucket,
  );
  await deps.storage.putObject(record.storageBucket, record.storageKey, fetched.bytes, contentType);
  await deps.fileRepo.create(record);
  const url = await deps.storage.generateDownloadUrl(record.storageBucket, record.storageKey);
  return { url, contentType };
}

/**
 * Resolve the inbound number to a customer. Mirrors the `lookup-customer`
 * phone semantics (tenant-scoped, last-10-digit tolerant match). Returns
 * every match so the caller can branch on 0 / 1 / many.
 */
async function matchCustomersByPhone(
  deps: CustomerMmsIntakeDeps,
  tenantId: string,
  fromE164: string,
): Promise<Customer[]> {
  const normalized = normalizePhone(fromE164);
  if (normalized.length < 7) return [];
  if (deps.customerRepo.findByPhoneNormalized) {
    const matches = await deps.customerRepo.findByPhoneNormalized(tenantId, normalized);
    return matches.filter((c) => !c.isArchived);
  }
  // Fallback for repos that predate findByPhoneNormalized.
  const tail = normalized.slice(-10);
  const all = await deps.customerRepo.findByTenant(tenantId, { includeArchived: false });
  return all.filter((c) => {
    if (!c.primaryPhone) return false;
    const digits = normalizePhone(c.primaryPhone);
    return digits.endsWith(tail) || tail.endsWith(digits);
  });
}

export async function ingestCustomerMms(
  ctx: InboundSmsContext,
  deps: CustomerMmsIntakeDeps,
): Promise<CustomerMmsResult> {
  const logger = deps.logger ?? defaultLogger;
  const media = ctx.media ?? [];
  if (media.length === 0) {
    return { outcome: 'ignored_no_media', storedImages: 0 };
  }

  // U6 — bound cost/abuse BEFORE resolving/creating a customer or calling the
  // vision model. Over-limit is silent: no proposal, no customer, no LLM spend.
  if (deps.checkRateLimit) {
    const allowed = await deps.checkRateLimit(ctx.tenantId, ctx.fromE164);
    if (!allowed) {
      logger.info('customer MMS: rate limited (sender over photo-quote cap)', {
        tenantId: ctx.tenantId,
        messageSid: ctx.messageSid,
      });
      return { outcome: 'rate_limited', storedImages: 0 };
    }
  }

  // 1. Customer resolution — 0 / 1 / many.
  const matches = await matchCustomersByPhone(deps, ctx.tenantId, ctx.fromE164);

  if (matches.length > 1) {
    // Ambiguous (e.g. a shared household line). Never guess — surface a
    // clarification proposal listing the candidates and draft nothing.
    const clarification = createProposal({
      tenantId: ctx.tenantId,
      proposalType: 'voice_clarification',
      payload: {
        reason: 'ambiguous_entity',
        entityKind: 'customer',
        fromPhone: ctx.fromE164,
        candidates: matches.map((c) => ({
          id: c.id,
          label: c.displayName,
          hint: c.primaryPhone ?? null,
        })),
      },
      summary: `Customer photo from ${ctx.fromE164} matched ${matches.length} customers — pick which one before drafting.`,
      sourceContext: { source: 'customer_mms', messageSid: ctx.messageSid, fromPhone: ctx.fromE164 },
      createdBy: CUSTOMER_MMS_ACTOR,
      idempotencyKey: `customer-mms-clarify:${ctx.messageSid}`,
    });
    const stored = await deps.proposalRepo.create(clarification);
    if (deps.auditRepo) {
      try {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: ctx.tenantId,
            actorId: CUSTOMER_MMS_ACTOR,
            actorRole: 'system',
            eventType: 'customer_mms.clarification_raised',
            entityType: 'proposal',
            entityId: stored.id,
            metadata: { messageSid: ctx.messageSid, candidateCount: matches.length },
          }),
        );
      } catch {
        /* audit best-effort */
      }
    }
    return { outcome: 'clarification', proposalId: stored.id, storedImages: 0 };
  }

  let customer: Customer;
  if (matches.length === 1) {
    customer = matches[0];
  } else {
    // Unknown sender → create a prefilled customer so the draft has a
    // concrete (RLS-scoped) customerId. createCustomer emits the
    // customer.created audit event.
    const digits = normalizePhone(ctx.fromE164);
    const created = await createCustomer(
      {
        tenantId: ctx.tenantId,
        firstName: '',
        lastName: '',
        companyName: `New customer ${digits.slice(-4)}`,
        primaryPhone: ctx.fromE164,
        preferredChannel: 'sms',
        smsConsent: false,
        createdBy: CUSTOMER_MMS_ACTOR,
        actorRole: 'system',
      },
      deps.customerRepo as CustomerRepository,
      deps.auditRepo,
    );
    customer = created;
  }

  // 2. Fetch + store + presign each photo.
  const images: MmsEstimateImage[] = [];
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    try {
      if (item.contentType && !isSupportedImage(item.contentType)) continue;
      const fetched = await deps.fetchMedia(ctx.tenantId, item.url);
      if (!fetched) continue;
      const image = await storeAndPresign(ctx, deps, customer.id, fetched, item.contentType, i);
      if (image) images.push(image);
    } catch (err) {
      logger.warn('customer MMS: media item failed', {
        tenantId: ctx.tenantId,
        messageSid: ctx.messageSid,
        mediaIndex: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (images.length === 0) {
    return {
      outcome: 'no_storable_media',
      customerId: customer.id,
      storedImages: 0,
    };
  }

  // 3. Vision draft → catalog-grounded proposal.
  const task = new MmsEstimateTaskHandler(deps.gateway, deps.catalogRepo);
  const result = await task.handle({
    tenantId: ctx.tenantId,
    customerId: customer.id,
    message: ctx.body || undefined,
    context: {
      customerId: customer.id,
      customerName: customer.displayName || customer.companyName || undefined,
      fromPhone: ctx.fromE164,
    },
    images,
    createdBy: CUSTOMER_MMS_ACTOR,
    conversationId: ctx.messageSid,
    // Customer MMS is async and unsupervised by nature: the photo + caption are
    // fully caller-controlled, so a prompt injection could coax a high
    // self-reported confidence_score. Force supervisorPresent=false so an
    // MMS-sourced draft can NEVER auto-approve — it always lands in
    // ready_for_review for a human (defense against the confidence self-report
    // bypass; the confidence number alone must not write a real estimate).
    supervisorPresent: false,
  });

  // 4. Parse failure → owner notice, no proposal, no crash.
  if (result.status === 'parse_failed') {
    if (deps.notifyOwner) {
      try {
        await deps.notifyOwner(ctx.tenantId, CUSTOMER_MMS_PARSE_FALLBACK_NOTICE);
      } catch (err) {
        logger.warn('customer MMS: owner parse-fallback notice failed', {
          tenantId: ctx.tenantId,
          messageSid: ctx.messageSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('customer MMS: vision draft fell back (no proposal)', {
      tenantId: ctx.tenantId,
      messageSid: ctx.messageSid,
      reason: result.reason,
    });
    return {
      outcome: 'parse_failed',
      customerId: customer.id,
      storedImages: images.length,
    };
  }

  const stored = await deps.proposalRepo.create(result.proposal);
  if (deps.auditRepo) {
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: ctx.tenantId,
          actorId: CUSTOMER_MMS_ACTOR,
          actorRole: 'system',
          eventType: 'customer_mms.estimate_drafted',
          entityType: 'proposal',
          entityId: stored.id,
          metadata: {
            messageSid: ctx.messageSid,
            customerId: customer.id,
            photos: images.length,
          },
        }),
      );
    } catch {
      /* audit best-effort — the proposal itself is the source of truth */
    }
  }

  // U3 — surface the draft to the owner. The proposal lands in the review
  // queue regardless, but a customer-initiated photo quote warrants a proactive
  // heads-up (the in-app/voice paths already SMS their proposals; this path did
  // not). Best-effort and idempotent: the mms_ingest queue dedupes on
  // messageSid, so intake runs once per inbound MMS — one notice per draft.
  if (deps.notifyOwner) {
    try {
      const who = customer.displayName || customer.companyName || ctx.fromE164;
      await deps.notifyOwner(
        ctx.tenantId,
        `New photo quote ready to review${who ? ` — from ${who}` : ''}. Open the app to approve, edit, or reject.`,
      );
    } catch (err) {
      logger.warn('customer MMS: owner draft-ready notice failed', {
        tenantId: ctx.tenantId,
        messageSid: ctx.messageSid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    outcome: 'drafted',
    proposalId: stored.id,
    customerId: customer.id,
    storedImages: images.length,
  };
}
