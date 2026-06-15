/**
 * P4-015 — Detect brand-voice deviation (banned phrases + formality drift).
 */
import type { BrandVoiceTone } from './prompts';

export interface DeviationInput {
  text: string;
  bannedPhrases?: string[];
  tone?: BrandVoiceTone | null;
}

export interface DeviationResult {
  drift: boolean;
  matches: string[];
}

const FORMAL_PHRASES = [
  'we regret to inform',
  'please be advised',
  'at your earliest convenience',
];

export function detectBrandVoiceDeviation(input: DeviationInput): DeviationResult {
  const haystack = input.text.toLowerCase();
  const matches: string[] = [];

  for (const phrase of input.bannedPhrases ?? []) {
    if (phrase && haystack.includes(phrase.toLowerCase())) {
      matches.push(phrase);
    }
  }

  if (input.tone?.formality === 'casual') {
    for (const phrase of FORMAL_PHRASES) {
      if (haystack.includes(phrase)) matches.push(phrase);
    }
  }

  return { drift: matches.length > 0, matches: [...new Set(matches)] };
}
