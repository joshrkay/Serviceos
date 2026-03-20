import type { GatewayConfig } from './types';

/**
 * Task-to-model routing table.
 *
 * Model identifiers use the OpenRouter namespaced format by default.
 * Override per-environment via AI_DEFAULT_MODEL and AI_PROVIDER_BASE_URL env vars.
 *
 * System prompts are intentionally generic — they reference "service businesses"
 * rather than specific verticals so the same routing works for HVAC, plumbing,
 * painting, electrical, or any service type the tenant configures.
 */

const defaultModel = process.env.AI_DEFAULT_MODEL || 'openai/gpt-4o-mini';
const advancedModel = process.env.AI_ADVANCED_MODEL || 'openai/gpt-4o';

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  defaultModel,
  routes: {
    draft_estimate: {
      model: advancedModel,
      temperature: 0.2,
      maxTokens: 2048,
      systemPrompt:
        'You are an expert estimator for service businesses. ' +
        'Generate accurate, detailed job estimates in structured JSON. ' +
        'Adapt terminology and line items to the tenant\'s configured service vertical. ' +
        'Use integer cents for all money values.',
    },
    classify_intent: {
      model: defaultModel,
      temperature: 0.0,
      maxTokens: 256,
      systemPrompt:
        'Classify the user intent from the provided text. ' +
        'Respond only with valid JSON matching the IntentClassification schema.',
    },
    extract_job_details: {
      model: defaultModel,
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract structured job details from the provided text or transcript. ' +
        'Respond only with valid JSON. Use integer cents for money.',
    },
    generate_proposal: {
      model: advancedModel,
      temperature: 0.1,
      maxTokens: 4096,
      systemPrompt:
        'You generate human-review proposals for a service business OS. ' +
        'Output strictly valid JSON matching the proposal payload schema. ' +
        'Never include personally identifiable information in reasoning fields.',
    },
    transcription_correction: {
      model: defaultModel,
      temperature: 0.1,
      maxTokens: 2048,
      systemPrompt:
        'Correct errors in voice transcriptions for a service business context. ' +
        'Fix technical terminology, trade-specific terms, names, and numbers. ' +
        'Return corrected text only — no commentary.',
    },
    summarize_conversation: {
      model: defaultModel,
      temperature: 0.3,
      maxTokens: 512,
    },
    extract_business_profile: {
      model: advancedModel,
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract structured business profile data from an onboarding voice transcript. ' +
        'Return valid JSON. Identify the business vertical (e.g., HVAC, plumbing, ' +
        'painting, electrical, contracting, or any service trade described).',
    },
    extract_categories: {
      model: advancedModel,
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract service categories from an onboarding voice transcript. ' +
        'Match against the canonical category taxonomy when possible, ' +
        'but also capture custom categories the business describes. Return valid JSON.',
    },
    extract_pricing: {
      model: advancedModel,
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract pricing information from an onboarding voice transcript. ' +
        'All amounts in integer cents. Return valid JSON.',
    },
    extract_team: {
      model: defaultModel,
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract team member information from an onboarding voice transcript. ' +
        'Distinguish technician, dispatcher, and owner roles. Return valid JSON.',
    },
    extract_schedule: {
      model: defaultModel,
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract working hours and SLA expectations from an onboarding voice transcript. ' +
        'Use 24-hour time format. Return valid JSON.',
    },
    generate_clarification_questions: {
      model: defaultModel,
      temperature: 0.3,
      maxTokens: 512,
      systemPrompt:
        'Generate targeted follow-up questions for incomplete onboarding data. ' +
        'Questions should be specific, not generic. Return valid JSON.',
    },
  },
};
