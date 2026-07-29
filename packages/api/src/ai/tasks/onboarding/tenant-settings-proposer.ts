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
 * last (and defaulted) so the dormant single-shot orchestrator
 * (ai/orchestration/onboarding.ts), which calls this without pricing, is
 * unaffected: it simply proposes no hourly rate.
 *
 * Gated on `verticalPacks` when the conversation never resolved one. An
 * owner can describe an unsupported trade ("pool service"), or the
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
 * DID say on the payload, and mark the one field voice could not produce
 * as missing so the review card asks for it instead of inviting a tap
 * that cannot work. The handler's refusal is the correct behaviour and is
 * deliberately untouched — the two must stay in step: the handler
 * requires a non-empty `verticalPacks`, so drafting gates on exactly that
 * key, and `editProposal` → `clearSatisfiedMissingFields` lifts the gate
 * once the operator supplies a pack (and the Zod contract rejects an edit
 * that puts an empty/invalid array back, so the gate cannot clear onto a
 * payload the handler would still refuse).
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

  // The one field the handler cannot execute without and the conversation
  // failed to produce. Non-empty ⇒ createProposal forces 'draft' and
  // approveProposal refuses until the operator fills it in.
  const missingFields = payload.verticalPacks.length === 0 ? ['verticalPacks'] : undefined;

  const summary = `Configure tenant: ${payload.businessName}` +
    (payload.verticalPacks.length > 0
      ? ` (${payload.verticalPacks.join(', ')})`
      : ' — which trade? (HVAC, plumbing, electrical, painting)');

  const input: CreateProposalInput = {
    tenantId,
    proposalType: 'onboarding_tenant_settings',
    payload: payload as unknown as Record<string, unknown>,
    summary,
    confidenceScore: confidence.score,
    confidenceFactors: confidence.factors,
    sourceContext: conversationId ? { conversationId } : undefined,
    createdBy: userId,
    ...(missingFields ? { missingFields } : {}),
  };

  return { proposal: createProposal(input), confidence };
}
