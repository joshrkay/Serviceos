import type { GatewayConfig } from './types';

/**
 * Task-to-model routing table.
 *
 * Model names work for both OpenAI and OpenRouter:
 *   OpenAI:      gpt-4o, gpt-4o-mini
 *   OpenRouter:  openai/gpt-4o, openai/gpt-4o-mini, anthropic/claude-3-5-sonnet, etc.
 *
 * To switch providers, change AI_PROVIDER_BASE_URL + AI_PROVIDER_API_KEY in .env
 * and update model names here if using OpenRouter's namespaced format.
 */
export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  defaultModel: 'openai/gpt-4o-mini',
  routes: {
    draft_estimate: {
      model: 'openai/gpt-4o',
      temperature: 0.2,
      maxTokens: 2048,
      systemPrompt:
        'You are an expert estimator for HVAC and plumbing businesses. ' +
        'Generate accurate, detailed job estimates in structured JSON. ' +
        'Use integer cents for all money values.',
    },
    classify_intent: {
      model: 'openai/gpt-4o-mini',
      temperature: 0.0,
      maxTokens: 256,
      systemPrompt:
        'Classify the user intent from the provided text. ' +
        'Respond only with valid JSON matching the IntentClassification schema.',
    },
    extract_job_details: {
      model: 'openai/gpt-4o-mini',
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract structured job details from the provided text or transcript. ' +
        'Respond only with valid JSON. Use integer cents for money.',
    },
    generate_proposal: {
      model: 'openai/gpt-4o',
      temperature: 0.1,
      maxTokens: 4096,
      systemPrompt:
        'You generate human-review proposals for a service business OS. ' +
        'Output strictly valid JSON matching the proposal payload schema. ' +
        'Never include personally identifiable information in reasoning fields.',
    },
    transcription_correction: {
      model: 'openai/gpt-4o-mini',
      temperature: 0.1,
      maxTokens: 2048,
      systemPrompt:
        'Correct errors in voice transcriptions for HVAC/plumbing context. ' +
        'Fix technical terminology, names, and numbers. ' +
        'Return corrected text only — no commentary.',
    },
    summarize_conversation: {
      model: 'openai/gpt-4o-mini',
      temperature: 0.3,
      maxTokens: 512,
    },
    extract_business_profile: {
      model: 'openai/gpt-4o',
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract structured business profile data from an onboarding voice transcript. ' +
        'Return valid JSON. Only identify verticals from: hvac, plumbing.',
    },
    extract_categories: {
      model: 'openai/gpt-4o',
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract service categories from an onboarding voice transcript. ' +
        'Match against the canonical category taxonomy. Return valid JSON.',
    },
    extract_pricing: {
      model: 'openai/gpt-4o',
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract pricing information from an onboarding voice transcript. ' +
        'All amounts in integer cents. Return valid JSON.',
    },
    extract_team: {
      model: 'openai/gpt-4o-mini',
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract team member information from an onboarding voice transcript. ' +
        'Distinguish technician, dispatcher, and owner roles. Return valid JSON.',
    },
    extract_schedule: {
      model: 'openai/gpt-4o-mini',
      temperature: 0.1,
      maxTokens: 1024,
      systemPrompt:
        'Extract working hours and SLA expectations from an onboarding voice transcript. ' +
        'Use 24-hour time format. Return valid JSON.',
    },
    generate_clarification_questions: {
      model: 'openai/gpt-4o-mini',
      temperature: 0.3,
      maxTokens: 512,
      systemPrompt:
        'Generate targeted follow-up questions for incomplete onboarding data. ' +
        'Questions should be specific, not generic. Return valid JSON.',
    },
  },
};
