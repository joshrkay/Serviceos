import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { CatalogItemRepository, CatalogCategory, CatalogUnit, createCatalogItem } from '../../catalog/catalog-item';
import { addCatalogItemPayloadSchema } from '../contracts/add-catalog-item';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

/**
 * Task 12 (2026-08-07 tradesperson plan) — add_catalog_item execution
 * handler.
 *
 * Persists a new price-book entry via `CatalogItemRepository.create`
 * (catalog/catalog-item.ts). LogExpense-family posture (mirrors
 * add-material-handler.ts / create-service-agreement-handler.ts): validate
 * the payload shape via the Zod contract, degrade to a synthetic-id
 * passthrough when the repo isn't wired (in-memory unit fixtures),
 * otherwise persist for real; audit emission is failure-soft (a logging
 * failure never unwinds a successful create).
 *
 * ── Builds the CatalogItem directly — does NOT call `persistCatalogItem` ──
 *
 * Quality-review fix (2026-08-09, "I2") — `persistCatalogItem(repo, item,
 * actor, auditRepo?)` DOES take an optional audit repo, so `createAgreement`'s
 * `(input, repo, undefined)` escape hatch (`create-service-agreement-
 * handler.ts`) was considered here too — an earlier draft of this comment
 * wrongly implied the bundled audit call left no such option. It was
 * REJECTED: unlike `createAgreement` — whose direct-call route bypassed six
 * real defaults (`autoGenerateInvoice`/`autoGenerateJob`/`autoRenew`/etc.)
 * and three invariants (`endsOn >= startsOn`, the auto-renew term
 * invariant, `parseRule` validation), making the reroute genuinely worth
 * doing — `persistCatalogItem` with `auditRepo: undefined` degenerates to
 * literally `await repo.create(item)` plus an unused `actor` argument: no
 * defaults, no invariants, nothing this handler would otherwise have to
 * duplicate. Calling it that way would buy nothing over calling
 * `repo.create()` directly, while still carrying a name (`persistCatalogItem`)
 * that promises audit behavior this call site would silently opt out of.
 * So: build the item with the pure `createCatalogItem()` builder, persist
 * via `catalogRepo.create()` directly, and emit this handler's OWN
 * failure-soft audit event afterward instead, exactly like every other
 * LogExpense-family handler.
 *
 * ── Reuses `catalog_item.created` — the SAME audit event type/analytics
 * mapping `persistCatalogItem`'s HTTP-route path already emits ───────────
 *
 * `analytics/audit-event-mapping.ts` already maps `catalog_item.created` →
 * `catalog_item_created` (category/unit/unitPriceCents/hasImage). A voice-
 * added catalog item is the SAME real-world event as one added from the
 * Catalog screen, so this handler emits the identical eventType with a
 * matching metadata SHAPE (plus proposalId/proposalType for traceability)
 * — one product-analytics counter for "a catalog item was created",
 * regardless of surface. This is deliberately UNLIKE `add_material`'s
 * `material.requested` / `apply_credit`'s `credit.applied` (each omitted
 * from the mapping to avoid double-counting a signal an existing mapped
 * event already captures elsewhere) — there is no separate "item created"
 * event this could double with; it simply feeds the SAME counter the
 * authenticated route already drives.
 *
 * ── category/unit defaults ─────────────────────────────────────────────
 *
 * `CreateCatalogItemInput.category`/`.unit` are BOTH required at the
 * domain layer, but this intent's voice taxonomy has no category
 * extraction seam at all (v1 scope decision — see the drafting task's doc
 * comment) and `unit` is only sometimes spoken. This handler defaults
 * `category: 'Labor'` (both taxonomy examples — "smart thermostat
 * install", "sump pump replacement" — are installation/labor-type line
 * items; `test/catalog/catalog-item.test.ts`'s own fixture precedent pairs
 * an "Install" item with category 'Labor') and `unit: 'each'` (a flat,
 * one-off price-book line is naturally "each", not hourly) when the
 * drafted payload omits them.
 *
 * ── Idempotent replay, not just a synthetic-id passthrough ───────────────
 * Like `add_material`/`create_change_order`/`create_service_agreement`,
 * this handler mints a brand NEW row on every `execute()` call — a
 * `resultEntityId` already stamped on the proposal short-circuits to a
 * pure replay so a redelivered/re-executed approval can never double-add
 * the same item.
 */
export class AddCatalogItemExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'add_catalog_item';

  constructor(
    private readonly catalogRepo?: CatalogItemRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  // WS3 — degrades to a synthetic-id passthrough (saves nothing) without
  // the catalog repo. Boot fails when a pool is configured but this is
  // false.
  isFullyWired(): boolean {
    return Boolean(this.catalogRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = addCatalogItemPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Could not determine the catalog item to add (missing name or an invalid price).',
      };
    }

    // A brand-new row is minted on every execute() — replay the prior
    // result instead of double-adding the same item (see class doc
    // comment above).
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }

    if (!this.catalogRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    const { name, unitPriceCents, description, unit } = parsed.data;
    // See class doc comment — no category/unit extraction seam covers
    // every case, so these are the deliberate v1 defaults.
    const category: CatalogCategory = 'Labor';
    const resolvedUnit: CatalogUnit = unit ?? 'each';

    const item = createCatalogItem({
      tenantId: context.tenantId,
      name,
      description,
      category,
      unit: resolvedUnit,
      unitPriceCents,
    });

    let created;
    try {
      created = await this.catalogRepo.create(item);
    } catch (err) {
      return {
        success: false,
        error: `Failed to add catalog item: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: context.executedByRole ?? 'voice_agent',
            eventType: 'catalog_item.created',
            entityType: 'catalog_item',
            entityId: created.id,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'add_catalog_item',
              name: created.name,
              category: created.category,
              unit: created.unit,
              unitPriceCents: created.unitPriceCents,
              // EE-4 parity with persistCatalogItem's own audit metadata —
              // never true on this voice path (no imageFileId extraction
              // seam exists).
              hasImage: false,
            },
          }),
        );
      } catch (auditErr) {
        // Audit failures must not unwind a successful catalog item create —
        // but they MUST be diagnosable. Mirrors LogExpenseExecutionHandler /
        // AddMaterialExecutionHandler.
        const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
        console.warn(
          `Failed to emit catalog_item.created audit event for catalog item ${created.id} (proposal ${proposal.id}): ${msg}`,
        );
      }
    }

    return { success: true, resultEntityId: created.id };
  }
}
