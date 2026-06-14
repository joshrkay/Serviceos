import { LLMGateway } from '../gateway/gateway';
import { Proposal } from '../../proposals/proposal';
import {
  ExtractionContext,
  OnboardingExtraction,
  OnboardingBatch,
  OnboardingResult,
  BusinessProfileExtraction,
  ServiceCategoryExtraction,
  PricingExtraction,
  TeamMemberExtraction,
  ScheduleExtraction,
  OnboardingTeamMemberPayload,
  OnboardingServiceCategoryPayload,
  OnboardingSchedulePayload,
} from '../tasks/onboarding/types';
import { BusinessProfileExtractor } from '../tasks/onboarding/business-profile-extractor';
import { CategoryExtractor } from '../tasks/onboarding/category-extractor';
import { PricingExtractor } from '../tasks/onboarding/pricing-extractor';
import { TeamExtractor } from '../tasks/onboarding/team-extractor';
import { ScheduleExtractor } from '../tasks/onboarding/schedule-extractor';
import { createTenantSettingsProposal } from '../tasks/onboarding/tenant-settings-proposer';
import { assembleEstimateTemplates } from '../tasks/onboarding/template-assembler';
import { createProposal, CreateProposalInput } from '../../proposals/proposal';

const MAX_BATCH_SIZE = 5;

/**
 * P4-EXT-008: Orchestrate the full onboarding extraction pipeline.
 *
 * Dependency order:
 *   Phase 1: Business profile extraction
 *   Phase 2: Category + team + schedule extraction (parallel, depend on profile)
 *   Phase 3: Pricing extraction (depends on categories)
 *   Phase 4: Template assembly (depends on categories + pricing)
 *
 * Proposals generated in order:
 *   tenant settings → categories → templates → team → schedule
 */
export class OnboardingOrchestrator {
  private readonly gateway: LLMGateway;

  constructor(gateway: LLMGateway) {
    this.gateway = gateway;
  }

  async run(
    tenantId: string,
    userId: string,
    transcript: string,
    conversationId?: string
  ): Promise<OnboardingResult> {
    const baseContext: ExtractionContext = {
      tenantId,
      transcript,
      conversationId,
      userId,
    };

    // Phase 1: Business profile
    const profileExtractor = new BusinessProfileExtractor(this.gateway);
    const profileResult = await profileExtractor.extract(baseContext);

    const partialExtraction: Partial<OnboardingExtraction> = {
      transcript,
      businessProfile: profileResult.data,
    };

    // Phase 2: Categories, team, schedule (parallel)
    const contextWithProfile: ExtractionContext = {
      ...baseContext,
      previousExtractions: partialExtraction,
    };

    const [categoryResult, teamResult, scheduleResult] = await Promise.all([
      new CategoryExtractor(this.gateway).extract(contextWithProfile),
      new TeamExtractor(this.gateway).extract(contextWithProfile),
      new ScheduleExtractor(this.gateway).extract(contextWithProfile),
    ]);

    partialExtraction.categories = categoryResult.data;
    partialExtraction.team = teamResult.data;
    partialExtraction.schedule = scheduleResult.data;

    // Phase 3: Pricing (depends on categories)
    const contextWithCategories: ExtractionContext = {
      ...baseContext,
      previousExtractions: partialExtraction,
    };

    const pricingResult = await new PricingExtractor(this.gateway).extract(contextWithCategories);
    partialExtraction.pricing = pricingResult.data;

    // Build full extraction
    const extraction: OnboardingExtraction = {
      transcript,
      businessProfile: profileResult.data,
      categories: categoryResult.data,
      pricing: pricingResult.data,
      team: teamResult.data,
      schedule: scheduleResult.data,
    };

    // Phase 4: Generate proposals in dependency order
    const proposals: Proposal[] = [];

    // 1. Tenant settings proposal
    const settingsResult = createTenantSettingsProposal(
      tenantId, userId, extraction.businessProfile, conversationId
    );
    if (settingsResult) {
      proposals.push(settingsResult.proposal);
    }

    // 2. Category proposals
    for (const cat of extraction.categories.categories) {
      const payload: OnboardingServiceCategoryPayload = {
        verticalType: cat.verticalType,
        categoryId: cat.categoryId,
        displayName: cat.name,
      };
      const input: CreateProposalInput = {
        tenantId,
        proposalType: 'onboarding_service_category',
        payload: payload as unknown as Record<string, unknown>,
        summary: `Activate category: ${cat.name} (${cat.verticalType})`,
        confidenceScore: cat.confidence,
        sourceContext: conversationId ? { conversationId } : undefined,
        createdBy: userId,
      };
      proposals.push(createProposal(input));
    }

    // 3. Template proposals
    const templateResult = assembleEstimateTemplates(
      tenantId, userId, extraction.categories, extraction.pricing, conversationId
    );
    proposals.push(...templateResult.proposals);

    // 4. Team member proposals
    for (const member of extraction.team.members) {
      const payload: OnboardingTeamMemberPayload = {
        name: member.name,
        role: member.inferredRole,
      };
      const input: CreateProposalInput = {
        tenantId,
        proposalType: 'onboarding_team_member',
        payload: payload as unknown as Record<string, unknown>,
        summary: `Add team member: ${member.name} (${member.inferredRole})`,
        confidenceScore: member.confidence,
        sourceContext: conversationId ? { conversationId } : undefined,
        createdBy: userId,
      };
      proposals.push(createProposal(input));
    }

    // 5. Schedule proposal
    if (extraction.schedule.workingHours.length > 0) {
      const payload: OnboardingSchedulePayload = {
        workingHours: extraction.schedule.workingHours,
        emergencySLA: extraction.schedule.sla
          ? { hoursTarget: extraction.schedule.sla.hoursTarget, isGuarantee: extraction.schedule.sla.isGuarantee }
          : undefined,
      };
      const input: CreateProposalInput = {
        tenantId,
        proposalType: 'onboarding_schedule',
        payload: payload as unknown as Record<string, unknown>,
        summary: 'Configure working hours and schedule',
        confidenceScore: scheduleResult.confidence.score,
        sourceContext: conversationId ? { conversationId } : undefined,
        createdBy: userId,
      };
      proposals.push(createProposal(input));
    }

    // Collect clarification needs
    const allClarificationQuestions: string[] = [];
    const needsClarification = [profileResult, categoryResult, pricingResult, teamResult, scheduleResult]
      .some((r) => r.needsClarification);

    for (const result of [profileResult, categoryResult, pricingResult, teamResult, scheduleResult]) {
      if (result.clarificationQuestions) {
        allClarificationQuestions.push(...result.clarificationQuestions);
      }
    }

    // Ambiguity becomes a one-tap voice_clarification (Core Patterns: voice
    // free-text references resolve through the resolver; ambiguity is never a
    // silent guess). Emitted as a real proposal so it lands in the operator's
    // feed alongside the onboarding_* proposals — the operator answers by
    // speaking again or filling the form, never a dropped extraction.
    //
    // Note on catalog grounding (Core Patterns): onboarding is the flow that
    // *seeds* the tenant catalog (pack activation runs seedPackDefaults at
    // approval time), so there is no pre-existing catalog to resolve voice
    // prices against here. The grounding invariant is honored structurally
    // instead — every onboarding proposal is built WITHOUT a sourceTrustTier,
    // so it can never auto-approve (decideInitialStatus → 'draft') and always
    // requires explicit human approval before any config is written.
    if (needsClarification && allClarificationQuestions.length > 0) {
      proposals.push(
        createProposal({
          tenantId,
          proposalType: 'voice_clarification',
          payload: {
            transcript: transcript.trim().slice(0, 4000) || '(empty)',
            reason: 'missing_entities',
            // The targeted follow-up questions render as one-tap chips in the
            // review card; the operator answers by speaking again.
            suggestedIntents: allClarificationQuestions.slice(0, 5),
            ...(conversationId ? { conversationId } : {}),
          },
          summary: 'A few details were unclear — tap to answer',
          explanation:
            'I captured most of your business, but some details were ambiguous. ' +
            'Answer below or fill them in on the form.',
          sourceContext: {
            source: 'onboarding_voice',
            ...(conversationId ? { conversationId } : {}),
          },
          createdBy: userId,
        }),
      );
    }

    // Group into batches of MAX_BATCH_SIZE
    const batches = groupIntoBatches(proposals);

    return {
      extraction,
      proposals,
      proposalIds: proposals.map((p) => p.id),
      batches,
      needsClarification,
      clarificationQuestions: allClarificationQuestions,
    };
  }
}

function groupIntoBatches(proposals: Proposal[]): OnboardingBatch[] {
  const batches: OnboardingBatch[] = [];
  for (let i = 0; i < proposals.length; i += MAX_BATCH_SIZE) {
    const batch = proposals.slice(i, i + MAX_BATCH_SIZE);
    batches.push({
      batchIndex: batches.length,
      proposalIds: batch.map((p) => p.id),
    });
  }
  return batches;
}
