/**
 * "That's right" — turn the onboarding draft into onboarding_* proposals and
 * approve them, in the caller's request transaction.
 *
 * The draft is the only pre-approval state. Approval mints exactly two
 * proposals from it: `onboarding_tenant_settings` (name, city, pack, chosen
 * prices, timezone) and `onboarding_voice_policy` (greeting, book-or-hold,
 * payment mode, hours, emergency target, after-hours mode), creates them,
 * approves them through the same `approveProposalsBatch` the inbox uses, and
 * marks the draft approved. Execution still runs through the execution worker
 * after the undo window, so the owner keeps "Saving, tap to undo".
 *
 * Runs inside the `/api` request transaction (middleware/tenant-context.ts):
 * any thrown error turns into a >= 400 response and the middleware rolls the
 * whole thing back, so a half-approved draft cannot exist.
 *
 * Concurrency: the first statement is a locking read of the draft row
 * (`getForTenantForUpdate`), and the proposals are built only from the row it
 * returns. A PUT /choices or a second approve therefore waits on the lock and
 * sees the committed outcome: a PUT that wins is IN the payload; an approve
 * that loses finds the draft `approved` and returns the winner's proposal ids
 * (`approvedNow: false`) without minting anything. An optional `expectedVersion`
 * lets a client that rendered version N refuse to approve a newer draft
 * (DraftVersionConflictError, before anything is minted); `markApproved`
 * re-checks the same version as the second guard.
 */
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import { approveProposalsBatch } from '../../proposals/actions';
import type { ApprovalOptions } from '../../proposals/approval-reference-checks';
import { createProposal, type CreateProposalInput, type ProposalRepository } from '../../proposals/proposal';
import type { OnboardingVoicePolicyPayload } from '../../proposals/contracts/onboarding';
import type { Role } from '../../auth/rbac';
import { ConflictError, ValidationError } from '../../shared/errors';
import { isRuntimeTimezone } from '../../shared/timezone';
import { CHOICE_KEYS, type AnyChoiceKey, type ChoiceWrites, type OptionKey } from '../choices/schema';
import type { AssembledChoice, AssembledOption } from '../choices/assemble';
import type { PriceTier } from '../choices/price-tiers';
import { DraftNotFoundError, DraftVersionConflictError, type OnboardingDraft, type OnboardingDraftRepository } from './repository';

export const ONBOARDING_READBACK_SURFACE = 'onboarding_readback';

export interface ResolvedChoice {
  settingKey: AnyChoiceKey;
  /** 'a' | 'b' when an option was picked or defaulted; 'override' for free speech. */
  source: OptionKey | 'override';
  label: string;
  writes: ChoiceWrites;
  prices?: PriceTier;
}

/** Each choice as the owner will see it on the read-back: picked, overridden, or the default. */
export function resolveChoices(draft: OnboardingDraft): ResolvedChoice[] {
  return draft.assembled.choices.map((c: AssembledChoice): ResolvedChoice => {
    const staged = draft.choices[c.settingKey];
    if (staged && 'override' in staged) {
      return { settingKey: c.settingKey, source: 'override', label: staged.override.label, writes: staged.override.writes, prices: staged.override.prices };
    }
    const key: OptionKey = staged && 'option' in staged ? staged.option : c.mostShops;
    const opt: AssembledOption = c.options[key === 'a' ? 0 : 1];
    return { settingKey: c.settingKey, source: key, label: opt.label, writes: opt.writes, ...(opt.prices ? { prices: opt.prices } : {}) };
  });
}

export interface DraftProposalInputs {
  tenantSettings: CreateProposalInput;
  voicePolicy: CreateProposalInput;
}

/** Build the two proposal inputs from a draft. Pure; throws ValidationError when the draft cannot be approved honestly. */
export function buildDraftProposals(draft: OnboardingDraft, actorId: string): DraftProposalInputs {
  if (draft.status === 'approved') throw new ConflictError('DRAFT_ALREADY_APPROVED');
  const tz = draft.clientTimezone?.trim();
  if (!tz || !isRuntimeTimezone(tz)) {
    // Never default a zone (Phoenix mis-booking postmortem, migration 263).
    throw new ValidationError('TIMEZONE_REQUIRED: the browser timezone must be recorded on the draft before approval');
  }

  const resolved = resolveChoices(draft);
  const byKey = new Map(resolved.map((r) => [r.settingKey, r]));
  for (const k of CHOICE_KEYS) {
    if (!byKey.has(k)) throw new ValidationError(`DRAFT_INCOMPLETE: assembled shop is missing "${k}"`);
  }
  const price = byKey.get('trip_fee_and_rate')!;
  if (!price.prices) throw new ValidationError('DRAFT_INCOMPLETE: the price choice carries no prices');

  const merged: ChoiceWrites = {};
  for (const r of resolved) Object.assign(merged, r.writes);

  const sourceContext = { surface: ONBOARDING_READBACK_SURFACE, draftId: draft.id };

  const tenantSettings: CreateProposalInput = {
    tenantId: draft.tenantId,
    proposalType: 'onboarding_tenant_settings',
    payload: {
      businessName: draft.businessName,
      ...(draft.metroName ? { city: draft.metroName } : {}),
      verticalPacks: [draft.packId],
      hourlyRateCents: price.prices.hourlyRateCents,
      tripFeeCents: price.prices.tripFeeCents,
      timezone: tz,
    },
    summary: `Set up ${draft.businessName}: ${price.label}`,
    confidenceScore: 1,
    sourceContext,
    createdBy: actorId,
  };

  // `hasExistingBusinessNumber` is a draft-only answer, not a tenant setting:
  // the v3 shell reads it from draft.choices to pick the day-one branch, so it
  // is dropped here on purpose and never reaches the voice-policy proposal.
  const { hasExistingBusinessNumber: _draftOnly, ...settingWrites } = merged;
  const voicePayload: OnboardingVoicePolicyPayload = settingWrites;
  const voicePolicy: CreateProposalInput = {
    tenantId: draft.tenantId,
    proposalType: 'onboarding_voice_policy',
    payload: voicePayload as unknown as Record<string, unknown>,
    summary: `How ${draft.businessName} answers, books, and gets paid`,
    confidenceScore: 1,
    sourceContext,
    createdBy: actorId,
  };

  return { tenantSettings, voicePolicy };
}

export interface ApproveDraftDeps {
  draftRepo: OnboardingDraftRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  approvalOptions?: ApprovalOptions;
}

export interface ApproveDraftResult {
  draft: OnboardingDraft;
  proposalIds: string[];
  /** True when this call approved; false when the draft was already approved (idempotent re-tap). */
  approvedNow: boolean;
}

export async function approveDraft(
  deps: ApproveDraftDeps,
  tenantId: string,
  actor: { userId: string; role: Role },
  opts: { expectedVersion?: number } = {},
): Promise<ApproveDraftResult> {
  const draft = await deps.draftRepo.getForTenantForUpdate(tenantId);
  if (!draft) throw new DraftNotFoundError(tenantId);
  if (draft.status === 'approved') {
    // Idempotent re-tap, a lost-response retry, or the loser of an approve race:
    // the winner's ids, nothing minted. Runs before the version check on purpose.
    return { draft, proposalIds: draft.proposalIds, approvedNow: false };
  }
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== draft.version) {
    throw new DraftVersionConflictError(opts.expectedVersion, draft.version);
  }

  const inputs = buildDraftProposals(draft, actor.userId);
  const proposals = await deps.proposalRepo.createMany([
    createProposal(inputs.tenantSettings),
    createProposal(inputs.voicePolicy),
  ]);
  const ids = proposals.map((p) => p.id);

  const result = await approveProposalsBatch(
    deps.proposalRepo,
    tenantId,
    ids,
    actor.userId,
    actor.role,
    deps.auditRepo,
    'ui',
    deps.approvalOptions,
  );
  if (result.failed.length > 0) {
    // Throwing turns the response into a 409, and the request transaction rolls
    // back the proposals created above: all or nothing.
    const reasons = result.failed.map((f) => `${f.id}: ${f.reason}`).join('; ');
    throw new ConflictError(`DRAFT_APPROVAL_FAILED: ${reasons}`);
  }

  const approved = await deps.draftRepo.markApproved(tenantId, ids, draft.version);
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId: actor.userId,
      actorRole: actor.role,
      eventType: 'onboarding.draft_approved',
      entityType: 'onboarding_draft',
      entityId: approved.id,
      metadata: { proposalIds: ids, draftVersion: draft.version, choices: resolveChoices(draft).map((r) => ({ key: r.settingKey, source: r.source })) },
    }),
  );
  return { draft: approved, proposalIds: ids, approvedNow: true };
}
