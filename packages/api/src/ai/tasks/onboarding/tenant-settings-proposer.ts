import { createProposal, CreateProposalInput, Proposal } from '../../../proposals/proposal';
import { assessConfidence, ConfidenceMetadata } from '../../guardrails/confidence';
import {
  BusinessProfileExtraction,
  OnboardingTenantSettingsPayload,
  PricingExtraction,
} from './types';

export interface TenantSettingsProposerResult {
  proposal: Proposal;
  confidence: ConfidenceMetadata;
}

/**
 * B1.20 — pull the owner's hourly rate out of the pricing capture, if the
 * conversation produced one. Multiple `hourly_rate` entries can appear
 * (different services quoted at different hourly rates); we take the
 * highest-confidence one rather than guessing which is "the" rate. Returns
 * undefined (never a fabricated 0 or a guess) when no hourly_rate entry
 * exists — a wrong hourly rate is a money defect, so absence must stay
 * absence all the way to the DB column.
 */
function pickHourlyRateCents(pricing: PricingExtraction | undefined): number | undefined {
  const hourlyEntries = (pricing?.prices ?? []).filter((p) => p.priceType === 'hourly_rate');
  if (hourlyEntries.length === 0) return undefined;
  const best = hourlyEntries.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  return best.amountCents;
}

/**
 * P4-EXT-006: Generate a proposal to update tenant settings from extracted business profile.
 *
 * B1.20: also accepts the pricing extraction so the same proposal carries
 * the owner's hourly rate — see `pickHourlyRateCents`. Optional param kept
 * last so callers that have no pricing capture at all still compile; they
 * get a proposal gated on `hourlyRateCents` rather than one that silently
 * writes NULL.
 *
 * Gated on `verticalPacks` and on `hourlyRateCents` — independently, and
 * both at once when both are absent.
 *
 * The `hourlyRateCents` gate closes the SILENT half of the same B1.20
 * requirement the `verticalPacks` gate closes loudly. `PricingExtractor`
 * treats any nonempty price list as a complete capture, so an owner who
 * quotes only a service-call fee or a flat per-job price ("$95 to come
 * out", "$450 for a water heater") yields prices with no
 * `price_type: 'hourly_rate'` entry, and `pickHourlyRateCents` correctly
 * returns undefined. Ungated, that proposal is approvable AND the handler
 * executes it SUCCESSFULLY (`upsertIdentityFields` simply never writes the
 * key), leaving `tenant_settings.hourly_rate_cents` NULL — which
 * `deriveOnboardingStatus` (onboarding/derive-status.ts, `isIdentityDone`)
 * requires non-null, so the owner is bounced back to the identity form
 * after a conversation that reported success. Worse than the
 * `verticalPacks` case: there the failure is visible as
 * `execution_failed`; here nothing looks wrong at all.
 *
 * The fix is a GATE, never a default: an invented hourly rate is a money
 * defect (it feeds reports/time-given-back.ts and the owner's value-of-time
 * figure). `jobBufferMinutes` may default to 30 only because that is
 * genuine parity with the wizard's own pre-filled value; a price has no
 * equivalent safe fallback. Gated whenever no rate was captured — including
 * when no pricing extraction was passed at all — because the identity step
 * requires the column unconditionally.
 *
 * An owner can describe an unsupported trade ("pool service"), or the
 * extractor can keep failing to pin a vertical down until the FSM
 * force-advances past profile_capture (agents/onboarding/transitions.ts,
 * `forcedAdvance`) — either way the business profile arrives here with
 * `verticalPacks: []` while the identity fields are perfectly good.
 * Drafting that ungated produced an APPROVABLE proposal that
 * `OnboardingTenantSettingsExecutionHandler` then always refused
 * ("Payload must include at least one valid verticalPacks entry"), so the
 * owner tapped approve and got `execution_failed` — losing the business
 * name, service area and hourly rate too, since the handler writes
 * identity and packs in one shot.
 *
 * Same idiom as the `onboarding_team_member` `email` gate
 * (orchestration/onboarding-conversation.ts): keep everything the owner
 * DID say on the payload, and mark the fields voice could not produce as
 * missing so the review card asks for them instead of inviting a tap that
 * cannot work. The handler's refusal is the correct behaviour and is
 * deliberately untouched — the two must stay in step.
 *
 * Both gate keys are REAL flat keys of the emitted payload and of
 * `onboardingTenantSettingsPayloadSchema` (proposals/contracts/onboarding.ts),
 * which is what makes them fillable: `editProposal` re-validates the merged
 * payload against that schema and then `clearSatisfiedMissingFields`
 * (proposals/missing-fields.ts) drops a gate only when that exact flat key
 * was edited to a non-empty value. A synthetic key (`hourlyRate`,
 * `pricing.hourlyRate`) would be permanently unfillable. And because the
 * schema still applies, the gate cannot clear onto a payload the handler
 * would refuse: `verticalPacks` must be a non-empty array of known
 * verticals, `hourlyRateCents` a non-negative integer (cents).
 */
export function createTenantSettingsProposal(
  tenantId: string,
  userId: string,
  extraction: BusinessProfileExtraction,
  conversationId?: string,
  pricing?: PricingExtraction,
): TenantSettingsProposerResult | null {
  if (!extraction.businessName && extraction.verticalPacks.length === 0) {
    return null;
  }

  const hourlyRateCents = pickHourlyRateCents(pricing);

  const payload: OnboardingTenantSettingsPayload = {
    businessName: extraction.businessName ?? 'My Business',
    city: extraction.city ?? undefined,
    state: extraction.state ?? undefined,
    verticalPacks: extraction.verticalPacks
      .filter((v) => v.confidence >= 0.5)
      .map((v) => v.type),
    ...(hourlyRateCents !== undefined ? { hourlyRateCents } : {}),
  };

  if (payload.verticalPacks.length === 0 && extraction.verticalPacks.length > 0) {
    // Include low-confidence verticals if they're all we have
    payload.verticalPacks = extraction.verticalPacks.map((v) => v.type);
  }

  const confidence = assessConfidence({
    confidence_score: extraction.confidence,
    business_name: extraction.businessName,
    verticals: extraction.verticalPacks,
  });

  // The fields the identity step cannot be completed without and the
  // conversation failed to produce. Independent — an owner can arrive here
  // missing either or both. Non-empty ⇒ createProposal forces 'draft' and
  // approveProposal refuses until the operator fills them in.
  const missingFields: string[] = [];
  if (payload.verticalPacks.length === 0) missingFields.push('verticalPacks');
  // Absent (never 0, never a guess) ⇒ hourly_rate_cents would stay NULL and
  // deriveOnboardingStatus would send the owner back to the identity form.
  if (payload.hourlyRateCents === undefined) missingFields.push('hourlyRateCents');

  const summary = `Configure tenant: ${payload.businessName}` +
    (payload.verticalPacks.length > 0
      ? ` (${payload.verticalPacks.join(', ')})`
      : ' — which trade? (HVAC, plumbing, electrical, painting)') +
    (payload.hourlyRateCents === undefined
      ? ' — what is your hourly labor rate?'
      : '');

  const input: CreateProposalInput = {
    tenantId,
    proposalType: 'onboarding_tenant_settings',
    payload: payload as unknown as Record<string, unknown>,
    summary,
    confidenceScore: confidence.score,
    confidenceFactors: confidence.factors,
    sourceContext: conversationId ? { conversationId } : undefined,
    createdBy: userId,
    ...(missingFields.length > 0 ? { missingFields } : {}),
  };

  return { proposal: createProposal(input), confidence };
}
