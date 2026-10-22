/**
 * What Rivet says when a "pick, don't build" choice turn opens (voice-only
 * onboarding, build plan PR 2): enough to choose without reading the screen.
 *
 *   1. the question
 *   2. the first option: its label, why (the card's detail), and what callers hear
 *   3. the same for the second option
 *   4. which one most shops pick, and "Which one?"
 *
 * Built only from the assembled choice the cards are drawn from, so the spoken
 * words, the cards and the setting cannot drift apart. One turn is one request
 * to `POST /api/voice/tts/batch`; its caps (packages/api/src/ai/tts/tts-batch.ts)
 * are sized from this function rendered at the longest names
 * (packages/api/test/onboarding/choices/registry-tts-caps.test.ts).
 *
 * Pure: no DOM, no network.
 */
import type { OnboardingOptionKey } from './onboarding-draft.js';

export interface NarratedOption {
  key: OnboardingOptionKey;
  label: string;
  detail?: string;
  rivetLine: string;
}

export interface NarratedChoice {
  question: string;
  options: readonly [NarratedOption, NarratedOption];
  mostShops: OnboardingOptionKey;
}

const ORDINAL = ['First', 'Second'] as const;

/** "Sentence." stays as is; "Sentence" gains a full stop, so clips join into speech that pauses. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]["”’)]?$/.test(t) ? t : `${t}.`;
}

function optionLine(option: NarratedOption, index: number): string {
  const parts = [`${ORDINAL[index]}: ${sentence(option.label)}`];
  if (option.detail) parts.push(sentence(option.detail));
  // The greeting's options are the very words callers hear: saying them twice adds nothing.
  if (option.rivetLine.trim() !== option.label.trim()) parts.push(`Callers hear: “${option.rivetLine.trim()}”`);
  return parts.join(' ');
}

export function narrateTurn(choice: NarratedChoice): string[] {
  const most = choice.options.findIndex((o) => o.key === choice.mostShops);
  const closing = most >= 0 ? `Most shops pick the ${most === 0 ? 'first' : 'second'}. Which one?` : 'Which one?';
  return [sentence(choice.question), ...choice.options.map(optionLine), closing];
}
