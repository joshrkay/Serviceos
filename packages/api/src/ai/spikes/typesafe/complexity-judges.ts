import { classifyComplexity } from '../../gateway/complexity-classifier';
import type { BinaryJudge, BinaryVerdict } from './eval-harness';
import { SPIKE_MODEL, type SystemOneClient } from './system-one-client';

export const COMPLEXITY_QUESTION_ID = 'task_complexity';

/** Ordered easiest → hardest; each level stands on its own (docs: Score). */
export const COMPLEXITY_LEVELS = [
  'Simple: a single lookup or one-step action with nothing ambiguous',
  'Moderate: a few steps or a detail that needs care, but a clear intent',
  'Complex: multi-step, conditional or ambiguous, or an action with money or customer-impact stakes',
];

export interface ScoreVerdict extends BinaryVerdict {
  score: number;
  confidence?: number;
}

/** Today's production rule (word count / context size), wrapped as a judge. */
export const baselineComplexityJudge: BinaryJudge = (text) =>
  Promise.resolve({ positive: classifyComplexity({ message: text }) === 'complex' });

export function typesafeComplexityJudge(
  client: SystemOneClient,
  opts: { threshold: number }
): (text: string) => Promise<ScoreVerdict> {
  return async (text) => {
    const { answers } = await client.systemOne({
      state: { message: text },
      model: SPIKE_MODEL,
      questions: {
        [COMPLEXITY_QUESTION_ID]: {
          type: 'score',
          instructions:
            'How difficult is it to correctly handle this request from a field-service business owner or caller?',
          levels: COMPLEXITY_LEVELS,
        },
      },
    });
    const answer = answers[COMPLEXITY_QUESTION_ID];
    if (answer?.score === undefined) {
      throw new Error(`TypeSafe response missing score answer for ${COMPLEXITY_QUESTION_ID}`);
    }
    return { positive: answer.score >= opts.threshold, score: answer.score, confidence: answer.confidence };
  };
}
