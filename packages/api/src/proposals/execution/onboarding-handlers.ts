/**
 * Execution handlers for the voice-first onboarding proposal types. The
 * OnboardingOrchestrator (run via POST /api/onboarding/voice) extracts a
 * spoken business description into onboarding_* proposals; approving one of
 * those proposals lands here, where it writes the SAME tenant config the
 * onboarding *form* endpoints write — so deriveOnboardingStatus advances the
 * wizard identically whether the operator typed or spoke (no parallel state).
 *
 * Load-bearing handlers (flip onboarding steps):
 *   - onboarding_tenant_settings → business name + pack activation + seed
 *     (advances the `identity` name requirement AND the `pack` step)
 *   - onboarding_schedule        → business_hours (advances `identity` hours)
 *
 * Enrichment handlers:
 *   - onboarding_estimate_template → creates a bespoke estimate template
 *   - onboarding_service_category  → confirms a (pack-defined) category
 *   - onboarding_team_member       → records a captured team member
 *
 * Every handler degrades to a validated success passthrough when its optional
 * dep is absent (in-memory tests that don't exercise the write path), mirroring
 * the convention used by the full-app voice handlers.
 *
 * Note (Core Patterns — catalog grounding): onboarding is the flow that SEEDS
 * the tenant catalog, so there is no pre-existing catalog to ground prices
 * against at this point. The grounding invariant is honored structurally: every
 * onboarding proposal is built without a sourceTrustTier, so it can never
 * auto-approve and always requires explicit human approval before any write.
 */
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import {
  SettingsRepository,
  resolveBootstrapAiModel,
} from '../../settings/settings';
import {
  PackActivationRepository,
  activatePack,
} from '../../settings/pack-activation';
import {
  seedPackDefaults,
  type SeedPackDefaultsDeps,
} from '../../packs/seed-pack-defaults';
import {
  EstimateTemplateRepository,
  LineItemTemplate,
  createTemplate,
} from '../../templates/estimate-template';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { VerticalType } from '../../verticals/registry';
import { v4 as uuidv4 } from 'uuid';

/** Packs that have canonical seed defaults (catalog + templates). */
const SEEDABLE_PACKS = new Set(['hvac', 'plumbing']);

/**
 * Normalize a spoken day name to the 3-letter key the business_hours JSONB
 * uses ("Monday" / "monday" / "mon" → "mon"). Unknown values are dropped.
 */
const DAY_KEYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
function normalizeDayKey(day: string): string | null {
  const key = day.trim().toLowerCase().slice(0, 3);
  return DAY_KEYS.has(key) ? key : null;
}

// Same 24h HH:MM contract the PUT /identity form enforces (contracts.ts
// TimeOfDay). The LLM extractor can emit loose strings ("8am", "5 pm",
// "8:00"); reject them rather than persist malformed times that break
// downstream HH:MM parsers (scheduling, availability rendering).
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ─── onboarding_tenant_settings ───────────────────────────────────────────
//
// THE load-bearing onboarding proposal. Writes the business name and activates
// (+ seeds) each extracted vertical pack — the same writes PUT /identity and
// POST /pack perform — so approving it flips both the `identity` (name) and
// `pack` steps of the wizard.
export class OnboardingTenantSettingsExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_tenant_settings';

  constructor(
    private readonly settingsRepo?: SettingsRepository,
    private readonly packActivationRepo?: PackActivationRepository,
    private readonly packSeedDeps?: SeedPackDefaultsDeps,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const businessName =
      typeof payload.businessName === 'string' && payload.businessName.trim().length > 0
        ? payload.businessName.trim()
        : undefined;
    const verticalPacks = Array.isArray(payload.verticalPacks)
      ? payload.verticalPacks.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [];

    if (!businessName && verticalPacks.length === 0) {
      return {
        success: false,
        error: 'onboarding_tenant_settings requires a businessName or at least one verticalPack',
      };
    }

    if (!this.settingsRepo) {
      return { success: true };
    }

    try {
      const existing = await this.settingsRepo.findByTenant(context.tenantId);
      const mergedPacks = Array.from(
        new Set([...(existing?.activeVerticalPacks ?? []), ...verticalPacks]),
      );

      if (existing) {
        await this.settingsRepo.update(context.tenantId, {
          ...(businessName ? { businessName } : {}),
          ...(verticalPacks.length > 0 ? { activeVerticalPacks: mergedPacks } : {}),
        });
      } else {
        // Mirror POST /pack's minimal bootstrap row so a tenant that spoke
        // before touching any form still gets a valid settings row.
        await this.settingsRepo.create({
          id: uuidv4(),
          tenantId: context.tenantId,
          businessName: businessName ?? '',
          timezone: 'America/New_York',
          estimatePrefix: 'EST-',
          invoicePrefix: 'INV-',
          nextEstimateNumber: 1001,
          nextInvoiceNumber: 1001,
          defaultPaymentTermDays: 30,
          activeVerticalPacks: mergedPacks,
          aiModel: resolveBootstrapAiModel(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Activate + seed each pack. The executor runs handlers outside any
      // wrapping transaction, so a multi-pack approval that fails partway
      // leaves the earlier packs committed. That is safe because every step is
      // IDEMPOTENT — activatePack no-ops an already-active pack and
      // seedPackDefaults skips when canonical rows exist — so re-running the
      // proposal completes the remaining packs without duplicating anything.
      for (const packId of verticalPacks) {
        if (this.packActivationRepo) {
          await activatePack(
            { tenantId: context.tenantId, packId },
            this.packActivationRepo,
            this.auditRepo,
            { actorId: context.executedBy, actorRole: 'owner' },
          );
        }
        if (this.packSeedDeps && SEEDABLE_PACKS.has(packId)) {
          await seedPackDefaults(
            { tenantId: context.tenantId, packId, actorId: context.executedBy },
            this.packSeedDeps,
          );
        }
      }

      if (this.auditRepo) {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'owner',
            eventType: 'onboarding.tenant_settings_applied',
            entityType: 'tenant_settings',
            entityId: context.tenantId,
            metadata: { businessName, verticalPacks },
          }),
        );
      }

      return { success: true, resultEntityId: context.tenantId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ─── onboarding_schedule ──────────────────────────────────────────────────
//
// Writes business_hours from the spoken working hours — the column
// deriveOnboardingStatus reads for the `identity` step's hours requirement.
export class OnboardingScheduleExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_schedule';

  constructor(
    private readonly settingsRepo?: SettingsRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const workingHours = Array.isArray(payload.workingHours) ? payload.workingHours : [];
    if (workingHours.length === 0) {
      return { success: false, error: 'onboarding_schedule requires at least one workingHours entry' };
    }

    // Translate [{ days:[...], startTime, endTime }] → { mon:{open,close}, … },
    // dropping entries whose times aren't valid HH:MM.
    const spokenHours: Record<string, { open: string; close: string }> = {};
    for (const entry of workingHours) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const days = Array.isArray(e.days) ? e.days : [];
      const open = typeof e.startTime === 'string' ? e.startTime : undefined;
      const close = typeof e.endTime === 'string' ? e.endTime : undefined;
      if (!open || !close || !TIME_RE.test(open) || !TIME_RE.test(close)) continue;
      for (const day of days) {
        if (typeof day !== 'string') continue;
        const key = normalizeDayKey(day);
        if (key) spokenHours[key] = { open, close };
      }
    }

    if (Object.keys(spokenHours).length === 0) {
      return { success: false, error: 'onboarding_schedule produced no recognizable day/time entries' };
    }

    if (!this.settingsRepo) {
      return { success: true };
    }

    try {
      // Merge over any hours already set (e.g. via the IdentityStep form) so a
      // partial spoken update ("we're open weekdays 8 to 5") doesn't clobber
      // the Saturday hours the operator entered earlier — last-writer-wins on
      // the whole JSONB column would silently drop them.
      const existing = await this.settingsRepo.findByTenant(context.tenantId);
      if (!existing) {
        return { success: false, error: 'Tenant settings not found — set business identity first' };
      }
      const businessHours = { ...(existing.businessHours ?? {}), ...spokenHours };
      const updated = await this.settingsRepo.update(context.tenantId, { businessHours });
      if (!updated) {
        return { success: false, error: 'Tenant settings not found — set business identity first' };
      }
      if (this.auditRepo) {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'owner',
            eventType: 'onboarding.schedule_applied',
            entityType: 'tenant_settings',
            entityId: context.tenantId,
            metadata: { days: Object.keys(businessHours) },
          }),
        );
      }
      return { success: true, resultEntityId: context.tenantId };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ─── onboarding_estimate_template ─────────────────────────────────────────
//
// Creates a bespoke estimate template from the spoken pricing — additive to
// the canonical templates pack activation seeds.
export class OnboardingEstimateTemplateExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_estimate_template';

  constructor(
    private readonly templateRepo?: EstimateTemplateRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const verticalType = payload.verticalType as VerticalType | undefined;
    const categoryId = typeof payload.categoryId === 'string' ? payload.categoryId : undefined;
    const templateName = typeof payload.templateName === 'string' ? payload.templateName : undefined;
    const rawLineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];

    if (!verticalType || !categoryId || !templateName || rawLineItems.length === 0) {
      return {
        success: false,
        error: 'onboarding_estimate_template requires verticalType, categoryId, templateName, and lineItems',
      };
    }

    const lineItemTemplates: LineItemTemplate[] = rawLineItems
      .filter((li): li is Record<string, unknown> => !!li && typeof li === 'object')
      .map((li, idx): LineItemTemplate => ({
        description: typeof li.description === 'string' ? li.description : '',
        category:
          li.category === 'labor' || li.category === 'material' || li.category === 'equipment'
            ? li.category
            : 'other',
        defaultQuantity: typeof li.defaultQuantity === 'number' ? li.defaultQuantity : 1,
        defaultUnitPriceCents:
          typeof li.defaultUnitPriceCents === 'number' ? Math.round(li.defaultUnitPriceCents) : 0,
        taxable: typeof li.taxable === 'boolean' ? li.taxable : false,
        sortOrder: typeof li.sortOrder === 'number' ? li.sortOrder : idx,
        isOptional: false,
      }))
      .filter((li) => li.description.length > 0);

    if (lineItemTemplates.length === 0) {
      return { success: false, error: 'onboarding_estimate_template has no usable line items' };
    }

    if (!this.templateRepo) {
      return { success: true };
    }

    try {
      const created = await createTemplate(
        {
          tenantId: context.tenantId,
          verticalType,
          categoryId,
          name: templateName,
          lineItemTemplates,
          ...(typeof payload.defaultNotes === 'string'
            ? { defaultCustomerMessage: payload.defaultNotes }
            : {}),
          createdBy: context.executedBy,
        },
        this.templateRepo,
        this.auditRepo,
        'owner',
      );
      return { success: true, resultEntityId: created.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ─── onboarding_service_category ──────────────────────────────────────────
//
// Service categories are PACK-DEFINED (static per vertical, activated via pack
// activation), not a per-tenant table — so there is nothing bespoke to write
// here. Approving this proposal CONFIRMS the category and records provenance;
// the category becomes usable once its pack is activated by the tenant_settings
// handler. Registered so an approval never errors on a missing handler.
export class OnboardingServiceCategoryExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_service_category';

  constructor(private readonly auditRepo?: AuditRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const categoryId = typeof payload.categoryId === 'string' ? payload.categoryId : undefined;
    const verticalType = typeof payload.verticalType === 'string' ? payload.verticalType : undefined;
    if (!categoryId || !verticalType) {
      return { success: false, error: 'onboarding_service_category requires verticalType and categoryId' };
    }
    if (this.auditRepo) {
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: 'owner',
          eventType: 'onboarding.service_category_confirmed',
          entityType: 'tenant_packs',
          entityId: `${verticalType}:${categoryId}`,
          metadata: {
            categoryId,
            verticalType,
            displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
          },
        }),
      );
    }
    return { success: true, resultEntityId: `${verticalType}:${categoryId}` };
  }
}

// ─── onboarding_team_member ───────────────────────────────────────────────
//
// Voice extraction captures a name + inferred role, but provisioning a real
// user requires an email + auth invite the spoken intake never has. Approving
// this proposal RECORDS the captured member (provenance) so the owner can send
// the actual invite from Team settings. Registered so approvals never error.
export class OnboardingTeamMemberExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_team_member';

  constructor(private readonly auditRepo?: AuditRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as Record<string, unknown>;
    const name = typeof payload.name === 'string' && payload.name.trim().length > 0
      ? payload.name.trim()
      : undefined;
    if (!name) {
      return { success: false, error: 'onboarding_team_member requires a name' };
    }
    const role =
      payload.role === 'technician' || payload.role === 'dispatcher' || payload.role === 'owner'
        ? payload.role
        : 'technician';
    if (this.auditRepo) {
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: 'owner',
          eventType: 'onboarding.team_member_noted',
          entityType: 'user',
          entityId: context.tenantId,
          metadata: { name, role },
        }),
      );
    }
    return { success: true, resultEntityId: context.tenantId };
  }
}
