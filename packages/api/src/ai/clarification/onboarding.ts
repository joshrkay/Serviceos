import { OnboardingExtraction, ExtractionContext } from '../tasks/onboarding/types';

/**
 * P4-EXT-009: Generate targeted clarification questions for incomplete extractions.
 * Questions are specific (not generic "tell me more").
 */
export function generateOnboardingClarifications(
  extraction: Partial<OnboardingExtraction>
): string[] {
  const questions: string[] = [];

  // Business profile gaps
  if (!extraction.businessProfile) {
    questions.push('What type of services does your business provide? (e.g., HVAC, plumbing)');
    questions.push('What is your business name and location?');
  } else {
    if (extraction.businessProfile.verticalPacks.length === 0) {
      questions.push('What type of services does your business provide? (e.g., HVAC, plumbing)');
    }
    if (!extraction.businessProfile.businessName) {
      questions.push('What is your business name?');
    }
  }

  // Category gaps
  if (!extraction.categories || extraction.categories.categories.length === 0) {
    const verticals = extraction.businessProfile?.verticalPacks.map((v) => v.type) ?? [];
    if (verticals.includes('hvac')) {
      questions.push('What HVAC services do you offer? (e.g., AC repair, maintenance, installations)');
    }
    if (verticals.includes('plumbing')) {
      questions.push('What plumbing services do you offer? (e.g., drain clearing, water heater installs, repipes)');
    }
    if (verticals.length === 0) {
      questions.push('What specific services do you offer to your customers?');
    }
  }

  // Pricing gaps
  if (!extraction.pricing || extraction.pricing.prices.length === 0) {
    questions.push('What do you typically charge for your most common services?');
  }

  // Schedule gaps
  if (!extraction.schedule || extraction.schedule.workingHours.length === 0) {
    questions.push('What are your typical business hours and days of operation?');
  }

  return questions;
}

/**
 * Merge a follow-up transcript with the original extraction context.
 * Supplements rather than overwrites — keeps the original transcript and appends.
 */
export function mergeSupplementalTranscript(
  originalContext: ExtractionContext,
  supplementalTranscript: string
): ExtractionContext {
  return {
    ...originalContext,
    transcript: `${originalContext.transcript}\n\n[Follow-up recording]\n${supplementalTranscript}`,
  };
}
