/**
 * B1.19 — execution handlers for the five `onboarding_*` proposal
 * types emitted by both the single-shot orchestrator
 * (ai/orchestration/onboarding.ts, dormant) and the conversational FSM
 * (ai/orchestration/onboarding-conversation.ts). Before this file
 * existed, approving one of these proposals threw HANDLER_NOT_FOUND
 * (proposals/execution/executor.ts) — the proposal reached "approved"
 * but configured nothing.
 *
 * CRITICAL — parity, not re-implementation: every handler below writes
 * through the SAME shared functions the form wizard's routes call
 * (routes/onboarding.ts), never a parallel implementation:
 *   - SettingsRepository.upsertIdentityFields  (PUT /identity)
 *   - activatePackWithSeed                     (POST /pack)
 *   - templates/estimate-template.ts createTemplate (routes/templates.ts)
 *
 * WS3 convention: a handler with a missing repo dependency reports
 * `isFullyWired() === false` and `execute()` returns a `handler_not_wired:`
 * failure — NEVER a synthetic-id passthrough that reports success while
 * persisting nothing.
 */
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { SettingsRepository, resolveBootstrapAiModel } from '../../settings/settings';
import { PackActivationRepository } from '../../settings/pack-activation';
import {
  activatePackWithSeed,
  ActivatePackWithSeedDeps,
} from '../../onboarding/activate-pack-with-seed';
import { SeedPackDefaultsDeps } from '../../packs/seed-pack-defaults';
import {
  EstimateTemplateRepository,
  LineItemTemplate,
  createTemplate,
} from '../../templates/estimate-template';
import { VALID_VERTICAL_TYPES, VerticalType } from '../../shared/vertical-types';
import {
  OnboardingSchedulePayload,
  TeamMemberRole,
  WorkingHoursEntry,
} from '../../ai/tasks/onboarding/types';

const ONBOARDING_ACTOR_ROLE = 'owner';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isVerticalType(v: unknown): v is VerticalType {
  return typeof v === 'string' && VALID_VERTICAL_TYPES.includes(v as VerticalType);
}

// ─── onboarding_tenant_settings ────────────────────────────────────────────
//
// Payload: OnboardingTenantSettingsPayload — { businessName, city?,
// state?, verticalPacks: VerticalType[] }. Writes BOTH halves of what
// the wizard splits across two routes: the identity fields (matching
// PUT /identity) and one activatePackWithSeed call per vertical pack
// (matching POST /pack). city/state have no dedicated tenant_settings
// columns — the closest existing field is service_area_text (a free
// string), so they're joined into it ("Austin, TX"); this is a
// best-effort mapping, not a 1:1 column match (documented — see the
// B1.19 report).
export class OnboardingTenantSettingsExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_tenant_settings';

  constructor(
    private readonly settingsRepo: SettingsRepository | undefined,
    private readonly packActivationRepo: PackActivationRepository | undefined,
    private readonly auditRepo: AuditRepository,
    private readonly packSeedDeps?: SeedPackDefaultsDeps,
  ) {}

  isFullyWired(): boolean {
    return Boolean(this.settingsRepo) && Boolean(this.packActivationRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!isNonEmptyString(payload.businessName)) {
      return { success: false, error: 'Payload must include a non-empty businessName' };
    }
    const verticalPacks = payload.verticalPacks;
    if (!Array.isArray(verticalPacks) || verticalPacks.length === 0 || !verticalPacks.every(isVerticalType)) {
      return { success: false, error: 'Payload must include at least one valid verticalPacks entry' };
    }
    const city = typeof payload.city === 'string' ? payload.city.trim() : '';
    const state = typeof payload.state === 'string' ? payload.state.trim() : '';
    const serviceAreaText = [city, state].filter((s) => s.length > 0).join(', ') || undefined;

    if (!this.settingsRepo || !this.packActivationRepo) {
      // WS3 — no synthetic success: fail before writing anything so a
      // partially-wired registry can't leave the tenant half-configured.
      return {
        success: false,
        error: `handler_not_wired:${!this.settingsRepo ? 'settingsRepo' : 'packActivationRepo'}`,
      };
    }

    try {
      await this.settingsRepo.upsertIdentityFields(context.tenantId, {
        businessName: payload.businessName,
        serviceAreaText,
        bootstrapAiModel: resolveBootstrapAiModel(),
      });
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: ONBOARDING_ACTOR_ROLE,
          eventType: 'tenant.identity_set',
          entityType: 'tenant_settings',
          entityId: context.tenantId,
          metadata: { businessName: payload.businessName, source: 'onboarding_conversation' },
        }),
      );

      const activateDeps: ActivatePackWithSeedDeps = {
        settingsRepo: this.settingsRepo,
        packActivationRepo: this.packActivationRepo,
        auditRepo: this.auditRepo,
        packSeedDeps: this.packSeedDeps,
      };
      for (const packId of verticalPacks as VerticalType[]) {
        // No lockClient — the executor doesn't run inside an HTTP
        // request's tenant transaction. See activatePackWithSeed's
        // lockClient doc for the (narrower, documented) race this
        // leaves relative to POST /pack.
        const result = await activatePackWithSeed(
          { tenantId: context.tenantId, packId, actorId: context.executedBy },
          activateDeps,
        );
        if (result.status === 'locked') {
          return { success: false, error: `PACK_ACTIVATION_IN_PROGRESS:${packId}` };
        }
      }

      return { success: true, resultEntityId: context.tenantId };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Tenant settings onboarding failed',
      };
    }
  }
}

// ─── onboarding_service_category ───────────────────────────────────────────
//
// Payload: OnboardingServiceCategoryPayload — { verticalType,
// categoryId, displayName }. There is no dedicated "service category"
// table in the schema (categories are a property of the vertical pack
// config, not a tenant row) — the real, wizard-equivalent write is
// activating the category's vertical pack, exactly like
// onboarding_service_category's sibling onboarding_tenant_settings
// proposal does per-pack. Idempotent: a tenant with three categories
// in the same vertical activates that pack once (activatePack no-ops
// on an already-active pack).
export class OnboardingServiceCategoryExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_service_category';

  constructor(
    private readonly settingsRepo: SettingsRepository | undefined,
    private readonly packActivationRepo: PackActivationRepository | undefined,
    private readonly auditRepo: AuditRepository,
    private readonly packSeedDeps?: SeedPackDefaultsDeps,
  ) {}

  isFullyWired(): boolean {
    return Boolean(this.settingsRepo) && Boolean(this.packActivationRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!isVerticalType(payload.verticalType)) {
      return { success: false, error: 'Payload must include a valid verticalType' };
    }
    if (!isNonEmptyString(payload.categoryId)) {
      return { success: false, error: 'Payload must include a non-empty categoryId' };
    }

    if (!this.settingsRepo || !this.packActivationRepo) {
      return {
        success: false,
        error: `handler_not_wired:${!this.settingsRepo ? 'settingsRepo' : 'packActivationRepo'}`,
      };
    }

    try {
      const result = await activatePackWithSeed(
        { tenantId: context.tenantId, packId: payload.verticalType, actorId: context.executedBy },
        {
          settingsRepo: this.settingsRepo,
          packActivationRepo: this.packActivationRepo,
          auditRepo: this.auditRepo,
          packSeedDeps: this.packSeedDeps,
        },
      );
      if (result.status === 'locked') {
        return { success: false, error: `PACK_ACTIVATION_IN_PROGRESS:${payload.verticalType}` };
      }
      return { success: true, resultEntityId: payload.verticalType };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Service category activation failed',
      };
    }
  }
}

// ─── onboarding_estimate_template ──────────────────────────────────────────
//
// Payload: OnboardingEstimateTemplatePayload — { verticalType,
// categoryId, templateName, lineItems, defaultNotes? }. Writes through
// the SAME createTemplate domain function POST /api/templates uses
// (templates/estimate-template.ts) — the estimate-template creation
// surface the wizard's seedPackDefaults also targets, but this proposal
// carries owner-spoken content (not a canned pack default), so it calls
// createTemplate directly rather than the pack seeder.
export class OnboardingEstimateTemplateExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_estimate_template';

  constructor(
    private readonly templateRepo: EstimateTemplateRepository | undefined,
    private readonly auditRepo: AuditRepository,
  ) {}

  isFullyWired(): boolean {
    return Boolean(this.templateRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!isVerticalType(payload.verticalType)) {
      return { success: false, error: 'Payload must include a valid verticalType' };
    }
    if (!isNonEmptyString(payload.categoryId) || !isNonEmptyString(payload.templateName)) {
      return { success: false, error: 'Payload must include categoryId and templateName' };
    }
    const rawLineItems = payload.lineItems;
    if (!Array.isArray(rawLineItems) || rawLineItems.length === 0) {
      return { success: false, error: 'Payload must include at least one line item' };
    }

    const lineItemTemplates: LineItemTemplate[] = [];
    for (const raw of rawLineItems) {
      if (typeof raw !== 'object' || raw === null) {
        return { success: false, error: 'Each line item must be an object' };
      }
      const item = raw as Record<string, unknown>;
      if (!isNonEmptyString(item.description)) {
        return { success: false, error: 'Each line item requires a non-empty description' };
      }
      if (typeof item.defaultUnitPriceCents !== 'number' || !Number.isInteger(item.defaultUnitPriceCents) || item.defaultUnitPriceCents < 0) {
        return { success: false, error: 'Each line item requires a non-negative integer defaultUnitPriceCents' };
      }
      lineItemTemplates.push({
        description: item.description,
        category:
          item.category === 'labor' || item.category === 'material' ||
          item.category === 'equipment' || item.category === 'other'
            ? item.category
            : 'other',
        defaultQuantity: typeof item.defaultQuantity === 'number' && item.defaultQuantity >= 0 ? item.defaultQuantity : 1,
        defaultUnitPriceCents: item.defaultUnitPriceCents,
        taxable: item.taxable === true,
        sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : lineItemTemplates.length,
        isOptional: false,
      });
    }

    if (!this.templateRepo) {
      return { success: false, error: 'handler_not_wired:templateRepo' };
    }

    try {
      const created = await createTemplate(
        {
          tenantId: context.tenantId,
          verticalType: payload.verticalType,
          categoryId: payload.categoryId,
          name: payload.templateName,
          description: typeof payload.defaultNotes === 'string' ? payload.defaultNotes : undefined,
          lineItemTemplates,
          defaultCustomerMessage: typeof payload.defaultNotes === 'string' ? payload.defaultNotes : undefined,
          createdBy: context.executedBy,
        },
        this.templateRepo,
        this.auditRepo,
        ONBOARDING_ACTOR_ROLE,
      );
      return { success: true, resultEntityId: created.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Estimate template creation failed',
      };
    }
  }
}

// ─── onboarding_team_member ────────────────────────────────────────────────
//
// Payload: OnboardingTeamMemberPayload — { name, role }. There is
// genuinely no wizard-equivalent write target for this proposal: the
// only real team-member persistence surface in the app,
// POST /api/users/invitations, requires an email (it drives a Clerk
// invitation) and the voice extractor cannot produce one ("me and my
// cousin Carlos" carries no address). Rather than fabricate a
// placeholder email or invent a new table out of scope for this story,
// this handler always reports not-wired — WS3-honest: the proposal
// still reaches "approved" and is visible for the operator to act on
// manually (Team Settings → invite, with a real email), but execution
// never claims to have created a real account. See the B1.19 report's
// "could not assert parity" note for `team`.
const TEAM_ROLES: ReadonlySet<TeamMemberRole> = new Set(['technician', 'dispatcher', 'owner']);

export class OnboardingTeamMemberExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_team_member';

  isFullyWired(): boolean {
    return false;
  }

  async execute(proposal: Proposal): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!isNonEmptyString(payload.name)) {
      return { success: false, error: 'Payload must include a non-empty name' };
    }
    if (typeof payload.role !== 'string' || !TEAM_ROLES.has(payload.role as TeamMemberRole)) {
      return { success: false, error: 'Payload must include a valid role' };
    }
    return {
      success: false,
      error:
        'handler_not_wired:no_persistence_target — team members require an invitation email ' +
        '(POST /api/users/invitations), which voice extraction does not capture. Invite ' +
        `${payload.name} manually from Team Settings with their email.`,
    };
  }
}

// ─── onboarding_schedule ────────────────────────────────────────────────────
//
// Payload: OnboardingSchedulePayload — { workingHours, emergencySLA? }.
// Writes through the SAME upsertIdentityFields the wizard's PUT
// /identity uses, targeting only the businessHours column (the wizard
// bundles hours into the same one-shot form save; the conversational
// engine captures them in a separate FSM state/proposal, so this
// handler patches just that column via the shared partial-upsert).
// Seasonal entries and emergencySLA have no tenant_settings
// representation — neither does the form wizard (BusinessHoursSchema
// has no seasonal concept and there is no SLA column), so this is not
// a regression, just an unbuilt surface on both paths.
const DAY_ABBREVIATION: Record<string, string> = {
  monday: 'mon',
  tuesday: 'tue',
  wednesday: 'wed',
  thursday: 'thu',
  friday: 'fri',
  saturday: 'sat',
  sunday: 'sun',
};

function buildBusinessHours(
  workingHours: WorkingHoursEntry[],
): { hours: Record<string, { open: string; close: string }>; seasonalSkipped: number } {
  const hours: Record<string, { open: string; close: string }> = {};
  let seasonalSkipped = 0;
  for (const entry of workingHours) {
    if (entry.seasonal) {
      // No seasonal-hours column — see the class doc above.
      seasonalSkipped += 1;
      continue;
    }
    for (const day of entry.days) {
      const abbrev = DAY_ABBREVIATION[day.toLowerCase()];
      if (!abbrev) continue;
      hours[abbrev] = { open: entry.startTime, close: entry.endTime };
    }
  }
  return { hours, seasonalSkipped };
}

export class OnboardingScheduleExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_schedule';

  constructor(
    private readonly settingsRepo: SettingsRepository | undefined,
    private readonly auditRepo: AuditRepository,
  ) {}

  isFullyWired(): boolean {
    return Boolean(this.settingsRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const payload = proposal.payload as unknown as OnboardingSchedulePayload;
    if (!Array.isArray(payload.workingHours) || payload.workingHours.length === 0) {
      return { success: false, error: 'Payload must include at least one workingHours entry' };
    }

    const { hours, seasonalSkipped } = buildBusinessHours(payload.workingHours);
    if (Object.keys(hours).length === 0) {
      // Every entry was seasonal-only — nothing safe to write (writing
      // an empty map would CLEAR any hours already stored by a prior
      // proposal, which is worse than a no-op failure).
      return {
        success: false,
        error: 'ALL_ENTRIES_SEASONAL: no base weekly hours to persist (tenant_settings has no seasonal-hours column)',
      };
    }

    if (!this.settingsRepo) {
      return { success: false, error: 'handler_not_wired:settingsRepo' };
    }

    try {
      await this.settingsRepo.upsertIdentityFields(context.tenantId, {
        businessHours: hours,
        bootstrapAiModel: resolveBootstrapAiModel(),
      });
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: ONBOARDING_ACTOR_ROLE,
          eventType: 'tenant.identity_set',
          entityType: 'tenant_settings',
          entityId: context.tenantId,
          metadata: { businessHours: hours, seasonalEntriesSkipped: seasonalSkipped, source: 'onboarding_conversation' },
        }),
      );
      return { success: true, resultEntityId: context.tenantId };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Schedule onboarding failed',
      };
    }
  }
}
