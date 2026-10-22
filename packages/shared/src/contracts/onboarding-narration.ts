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
 * `answerHelp` is what Rivet says when the owner asks for help on that turn
 * ("say that again", "what does that mean?", "give me an example", "what do
 * most shops do?"), built the same way and held to the same caps.
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
  supportLine?: string;
  /** Rivet's answer to "what does that mean?" (absent on drafts assembled before it existed). */
  explain?: string;
  /** Rivet's answer to "give me an example" (absent on drafts assembled before it existed). */
  example?: string;
  options: readonly [NarratedOption, NarratedOption];
  mostShops: OnboardingOptionKey;
}

/** The help an owner can ask for out loud on a choice turn. */
export type OnboardingHelpRequest = 'repeat' | 'explain' | 'example' | 'most_shops';

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

const WHICH_ONE = 'Which one?';

export function narrateTurn(choice: NarratedChoice): string[] {
  const most = choice.options.findIndex((o) => o.key === choice.mostShops);
  const closing = most >= 0 ? `Most shops pick the ${most === 0 ? 'first' : 'second'}. ${WHICH_ONE}` : WHICH_ONE;
  return [sentence(choice.question), ...choice.options.map(optionLine), closing];
}

/**
 * What Rivet says back to a help request on a choice turn, ending on "Which one?" so the
 * owner is asked again. A draft assembled before the explain/example text existed falls
 * back to the support line and the cards' own words, so a question is never met with silence.
 */
export function answerHelp(choice: NarratedChoice, help: OnboardingHelpRequest): string[] {
  switch (help) {
    case 'repeat':
      return narrateTurn(choice);
    case 'explain':
      if (choice.explain?.trim()) return [sentence(choice.explain), WHICH_ONE];
      return [...(choice.supportLine?.trim() ? [sentence(choice.supportLine)] : []), ...choice.options.map(optionLine), WHICH_ONE];
    case 'example':
      if (choice.example?.trim()) return [sentence(choice.example), WHICH_ONE];
      return [
        ...choice.options.map((o, i) => `With the ${i === 0 ? 'first' : 'second'}, callers hear: “${o.rivetLine.trim()}”`),
        WHICH_ONE,
      ];
    case 'most_shops': {
      const most = choice.options.findIndex((o) => o.key === choice.mostShops);
      const option = choice.options[most];
      if (!option) return [WHICH_ONE];
      const why = option.detail ? ` ${sentence(option.detail)}` : '';
      return [`Most shops pick the ${most === 0 ? 'first' : 'second'}: ${sentence(option.label)}${why}`, WHICH_ONE];
    }
  }
}
