import { createProposal, CreateProposalInput, Proposal } from '../../../proposals/proposal';
import { assessConfidence, ConfidenceMetadata } from '../../guardrails/confidence';
import {
  BusinessProfileExtraction,
  OnboardingTenantSettingsPayload,
} from './types';

export interface TenantSettingsProposerResult {
  proposal: Proposal;
  confidence: ConfidenceMetadata;
}

/**
 * P4-EXT-006: Generate a proposal to update tenant settings from extracted business profile.
 */
export function createTenantSettingsProposal(
  tenantId: string,
  userId: string,
  extraction: BusinessProfileExtraction,
  conversationId?: string
): TenantSettingsProposerResult | null {
  if (!extraction.businessName && extraction.verticalPacks.length === 0) {
    return null;
  }

  const payload: OnboardingTenantSettingsPayload = {
    businessName: extraction.businessName ?? 'My Business',
    city: extraction.city ?? undefined,
    state: extraction.state ?? undefined,
    verticalPacks: extraction.verticalPacks
      .filter((v) => v.confidence >= 0.5)
      .map((v) => v.type),
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
