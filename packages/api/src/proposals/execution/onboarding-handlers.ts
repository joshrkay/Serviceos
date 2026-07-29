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
import { isRuntimeTimezone } from '../../shared/timezone';
import type { PendingInvitationRepository } from '../../users/pending-invitation';
import { inviteTeamMember, type ClerkInvitationConfig } from '../../users/invite-team-member';
import {
  OnboardingSchedulePayload,
  TeamMemberRole,
  WorkingHoursEntry,
} from '../../ai/tasks/onboarding/types';

/**
 * Fallback audit actor role for the onboarding handlers. `approveProposal`
 * now refuses every `onboarding_*` type without `settings:update`
 * (CONFIG_WRITING_PROPOSAL_TYPES), so whoever reached execution held the same
 * authority routes/onboarding.ts demands. Prefer the approver's REAL role
 * from the execution context when the caller supplied it, so the audit trail
 * names who actually acted instead of asserting owner.
 */
const ONBOARDING_ACTOR_ROLE = 'owner';

function actorRoleFor(context: { executedByRole?: string }): string {
  return context.executedByRole ?? ONBOARDING_ACTOR_ROLE;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isVerticalType(v: unknown): v is VerticalType {
  return typeof v === 'string' && VALID_VERTICAL_TYPES.includes(v as VerticalType);
}

// ─── onboarding_tenant_settings ────────────────────────────────────────────
//
// Payload: OnboardingTenantSettingsPayload — { businessName, city?,
// state?, verticalPacks: VerticalType[], hourlyRateCents? }. Writes BOTH
// halves of what the wizard splits across two routes: the identity fields
// (matching PUT /identity) and one activatePackWithSeed call per vertical
// pack (matching POST /pack). city/state have no dedicated tenant_settings
// columns — the closest existing field is service_area_text (a free
// string), so they're joined into it ("Austin, TX"); this is a
// best-effort mapping, not a 1:1 column match (documented — see the
// B1.19 report).
//
// B1.20 — this handler is also where the identity step's two previously
// missing columns get closed:
//   - hourlyRateCents: threaded through from the pricing capture (see
//     tenant-settings-proposer.ts's pickHourlyRateCents). Left untouched
//     (upsertIdentityFields only writes a key that's present) when the
//     conversation never captured a rate — never fabricated, because a
//     wrong hourly rate is a money defect.
//   - jobBufferMinutes: the conversation never asks for this at all, so
//     there is no extracted value to thread through. We instead write the
//     SAME default the form wizard pre-fills
//     (packages/web/src/components/onboarding/v2/steps/IdentityStep.tsx:77,
//     `useState<number>(30)`) so a form user who never touches the field
//     and a conversation user who never mentions it land on the identical
//     column value — genuine outcome parity, not a guess. This is
//     deliberately NOT the same move as timezone: routes/onboarding.ts's
//     PUT /identity refuses to ever default a timezone, because a wrong
//     zone silently misbooks appointments (Phoenix mis-booking postmortem,
//     migration 263) — there is no safe fallback value for "which zone is
//     this business in". A job buffer has no equivalent correctness
//     cliff: 30 minutes is a padding default the form itself ships to
//     every silent user, not a fact about the tenant that can be "wrong"
//     in a way that breaks bookings. Written unconditionally (every run of
//     this handler represents a fresh conversational onboarding) rather
//     than "only if unset", matching the wizard's own one-shot save.
//   - timezone: REQUIRED, and gated at draft time by
//     tenant-settings-proposer.ts so it is always supplied by the time the
//     card is approvable. This handler previously omitted the key entirely,
//     leaving tenant_settings.timezone NULL — and `isIdentityDone`
//     (onboarding/derive-status.ts) did not require it either, so the
//     conversation reported a completed identity step while
//     `CreateAppointmentTaskHandler` turned every spoken booking into a
//     timezone `voice_clarification`, deterministically. Refused (loudly)
//     rather than defaulted when absent, for the same reason `verticalPacks`
//     is: the two must stay in step with the gate, and there is NO safe
//     fallback zone.
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

    // B1.20 — integer-cents guard mirrors the money invariant enforced
    // everywhere else (see catalog-resolver.ts, settings.ts validators).
    // A malformed/negative value fails the whole proposal rather than
    // silently dropping the rate or writing garbage.
    let hourlyRateCents: number | undefined;
    if (payload.hourlyRateCents !== undefined) {
      if (
        typeof payload.hourlyRateCents !== 'number' ||
        !Number.isInteger(payload.hourlyRateCents) ||
        payload.hourlyRateCents < 0
      ) {
        return { success: false, error: 'hourlyRateCents must be a non-negative integer (cents)' };
      }
      hourlyRateCents = payload.hourlyRateCents;
    }

    // Gated at draft time (tenant-settings-proposer.ts). Refuse rather than
    // substitute a zone: writing a guess is the Phoenix mis-booking defect,
    // and writing nothing is the silent one this gate closes. Validated with
    // `isRuntimeTimezone` — the same predicate CreateAppointmentTaskHandler
    // gates bookings on — so anything this handler persists is a zone the
    // booking path will accept.
    if (!isNonEmptyString(payload.timezone)) {
      return {
        success: false,
        error:
          'Payload must include a timezone — bookings cannot be scheduled without one. ' +
          'Set the timezone on the review card first.',
      };
    }
    const timezone = payload.timezone.trim();
    if (!isRuntimeTimezone(timezone)) {
      return { success: false, error: `timezone is not a recognized IANA zone: ${timezone}` };
    }

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
        // B1.20 parity default — see the class doc above for why this is
        // safe to always write (unlike timezone).
        jobBufferMinutes: 30,
        ...(hourlyRateCents !== undefined ? { hourlyRateCents } : {}),
        timezone,
        bootstrapAiModel: resolveBootstrapAiModel(),
      });
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: actorRoleFor(context),
          eventType: 'tenant.identity_set',
          entityType: 'tenant_settings',
          entityId: context.tenantId,
          metadata: {
            businessName: payload.businessName,
            jobBufferMinutes: 30,
            ...(hourlyRateCents !== undefined ? { hourlyRateCents } : {}),
            timezone,
            source: 'onboarding_conversation',
          },
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
        actorRoleFor(context),
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
// Payload: OnboardingTeamMemberPayload — { name, role, email? }.
//
// This handler previously always refused, on the stated grounds that there was
// "no persistence target". That was wrong: `pending_invitations` and its
// repository (users/pending-invitation.ts) have existed since migration 082.
// The proposal is gated on `email` at draft time — voice cannot produce an
// address from "me and my cousin Carlos" — and the operator supplies it from
// the review card, exactly like any other missing field. Once they do, the
// gate clears and this handler creates the real invitation.
//
// A gate the operator can fill but that then fails anyway would be worse than
// no gate at all, so the two must stay in step: if the `email` gate is ever
// removed, this handler must stop depending on it. The same rule is why
// `onboardingTeamMemberPayloadSchema` now DECLARES `email` with
// `inviteUserSchema`'s exact rule — while the schema stayed silent about the
// key, `clearSatisfiedMissingFields` lifted the gate for any non-empty string
// (`carlos`, a padded address), the UI reported the card satisfied, and
// execution died in the invitation repository.
const TEAM_ROLES: ReadonlySet<TeamMemberRole> = new Set(['technician', 'dispatcher', 'owner']);

export class OnboardingTeamMemberExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'onboarding_team_member';

  // `inviteTeamMember` awaits Clerk when a secret key is configured, so this
  // handler is no longer DB-only. Without this flag the executor takes its
  // Path A branch and holds the advisory lock and a pooled connection across
  // that network round-trip; worse, a later audit or status write that rolls
  // back would erase the local `pending_invitations` row while Clerk had
  // already accepted — an invitation the recipient can act on with nothing
  // behind it. The flag is the difference between "we recorded an intent"
  // and "someone has an email".
  performsExternalIo = true;

  constructor(
    private readonly invitationRepo: PendingInvitationRepository | undefined,
    private readonly auditRepo: AuditRepository,
    private readonly clerk: ClerkInvitationConfig = {},
  ) {}

  isFullyWired(): boolean {
    return Boolean(this.invitationRepo);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!isNonEmptyString(payload.name)) {
      return { success: false, error: 'Payload must include a non-empty name' };
    }
    if (typeof payload.role !== 'string' || !TEAM_ROLES.has(payload.role as TeamMemberRole)) {
      return { success: false, error: 'Payload must include a valid role' };
    }
    // The draft-time gate should have held until this was supplied; refuse
    // rather than invent a placeholder address if it somehow did not.
    if (!isNonEmptyString(payload.email)) {
      return {
        success: false,
        error:
          'Payload must include an email — an invitation cannot be sent without one. ' +
          `Add ${payload.name}'s email on the review card first.`,
      };
    }
    // Trimmed for the same reason POST /api/users/invitations is: that route
    // passes `inviteUserSchema.parse(...)`'s OUTPUT, which `.trim()` has
    // already normalized. `validateProposalPayload` only safeParses (it keeps
    // the operator's raw string on the payload), so without this the two
    // paths would disagree about "  a@b.com  " — accepted at edit time by the
    // schema's trim, then rejected by the invitation repository's anchored
    // `EMAIL_RE` at execution. Shape of the very defect the schema closes.
    const email = payload.email.trim();
    if (!this.invitationRepo) {
      return { success: false, error: 'handler_not_wired:invitationRepo' };
    }

    try {
      // Through the same service POST /api/users/invitations calls, never
      // the repository directly: a local row on its own sends the teammate
      // nothing, and they cannot reach the accept flow.
      const { invitation, clerkInvitationId } = await inviteTeamMember(
        {
          tenantId: context.tenantId,
          email,
          role: payload.role as TeamMemberRole,
          invitedBy: context.executedBy,
        },
        this.invitationRepo,
        this.clerk,
      );
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: actorRoleFor(context),
          eventType: 'user.invitation_created',
          entityType: 'pending_invitation',
          entityId: invitation.id,
          metadata: {
            email: invitation.email,
            role: invitation.role,
            source: 'onboarding_voice',
            // Null when Clerk is unconfigured or the call failed — the row
            // stands as intent and the operator re-sends from the dashboard.
            // Recorded so the audit distinguishes "emailed" from "recorded".
            clerkInvitationId,
          },
        }),
      );
      return { success: true, resultEntityId: invitation.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Invitation creation failed',
      };
    }
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

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function hhmmToMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

// `dayWindowFor` (scheduling/booking-availability.ts) reads a malformed or
// open>=close day as CLOSED and never guesses a window. So an unvalidated
// spoken schedule does not fail loudly — it persists and quietly makes the
// business unbookable on that day. The form wizard cannot reach that state
// because PUT /identity parses through `BusinessHoursSchema`; this path has
// to hold the same line before it writes.
function buildBusinessHours(
  workingHours: WorkingHoursEntry[],
): {
  hours: Record<string, { open: string; close: string }>;
  seasonalSkipped: number;
  invalid: string[];
} {
  const hours: Record<string, { open: string; close: string }> = {};
  const invalid: string[] = [];
  let seasonalSkipped = 0;
  for (const entry of workingHours) {
    if (entry.seasonal) {
      // No seasonal-hours column — see the class doc above.
      seasonalSkipped += 1;
      continue;
    }
    const wellFormed =
      HHMM_RE.test(entry.startTime) &&
      HHMM_RE.test(entry.endTime) &&
      hhmmToMinutes(entry.startTime) < hhmmToMinutes(entry.endTime);
    for (const day of entry.days) {
      const abbrev = DAY_ABBREVIATION[day.toLowerCase()];
      if (!abbrev) continue;
      if (!wellFormed) {
        invalid.push(`${abbrev} (${entry.startTime}-${entry.endTime})`);
        continue;
      }
      hours[abbrev] = { open: entry.startTime, close: entry.endTime };
    }
  }
  return { hours, seasonalSkipped, invalid };
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

    const { hours, seasonalSkipped, invalid } = buildBusinessHours(payload.workingHours);
    if (invalid.length > 0) {
      // Refuse the whole proposal rather than persist the well-formed days
      // and drop the rest: a dropped day reads downstream as "closed", which
      // is a silent wrong answer the operator never sees.
      return {
        success: false,
        error: `MALFORMED_HOURS: expected HH:MM with open before close — ${invalid.join(', ')}`,
      };
    }
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
          actorRole: actorRoleFor(context),
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
