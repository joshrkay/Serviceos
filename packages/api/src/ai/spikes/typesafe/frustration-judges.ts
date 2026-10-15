import { detectFrustration } from '../../agents/customer-calling/frustration-detector';
import type { BinaryJudge } from './eval-harness';
import { SPIKE_MODEL, type SystemOneClient } from './system-one-client';

export type { SystemOneClient } from './system-one-client';

export const FRUSTRATION_QUESTION_ID = 'caller_frustrated';

const FRUSTRATION_INSTRUCTIONS =
  'Is the caller frustrated, angry, or asking to speak to a human instead of the automated assistant?';

/** Today's production rule, wrapped as a judge so it can be compared. */
export const baselineFrustrationJudge: BinaryJudge = async (text) => ({
  positive: detectFrustration(text).matched,
});

export function typesafeFrustrationJudge(
  client: SystemOneClient,
  opts: { threshold: number }
): BinaryJudge {
  return async (text) => {
    const { answers } = await client.systemOne({
      state: text,
      model: SPIKE_MODEL,
      questions: {
        [FRUSTRATION_QUESTION_ID]: { type: 'noul', instructions: FRUSTRATION_INSTRUCTIONS },
      },
    });
    const probability = answers[FRUSTRATION_QUESTION_ID]?.noul;
    if (probability === undefined) {
      throw new Error(`TypeSafe response missing noul answer for ${FRUSTRATION_QUESTION_ID}`);
    }
    return { positive: probability >= opts.threshold, probability };
  };
}
