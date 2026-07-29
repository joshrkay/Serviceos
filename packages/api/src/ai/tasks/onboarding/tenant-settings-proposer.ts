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

  const summary = `Configure tenant: ${payload.businessName}` +
    (payload.verticalPacks.length > 0 ? ` (${payload.verticalPacks.join(', ')})` : '');

  const input: CreateProposalInput = {
    tenantId,
    proposalType: 'onboarding_tenant_settings',
    payload: payload as unknown as Record<string, unknown>,
    summary,
    confidenceScore: confidence.score,
    confidenceFactors: confidence.factors,
    sourceContext: conversationId ? { conversationId } : undefined,
    createdBy: userId,
  };

  return { proposal: createProposal(input), confidence };
}
