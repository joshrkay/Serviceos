import { describe, expect, it } from 'vitest';
import {
  baselineFrustrationJudge,
  typesafeFrustrationJudge,
  FRUSTRATION_QUESTION_ID,
  type SystemOneClient,
} from '../../../../src/ai/spikes/typesafe/frustration-judges';

describe('baselineFrustrationJudge', () => {
  it('flags a literal keyword phrase and passes a calm utterance', async () => {
    expect((await baselineFrustrationJudge('honestly this is ridiculous')).positive).toBe(true);
    expect((await baselineFrustrationJudge('my furnace stopped working')).positive).toBe(false);
  });
});

describe('typesafeFrustrationJudge', () => {
  const clientReturning = (probability: number) => {
    const calls: unknown[] = [];
    const client: SystemOneClient = {
      async systemOne(req) {
        calls.push(req);
        return { answers: { [FRUSTRATION_QUESTION_ID]: { noul: probability } } };
      },
    };
    return { client, calls };
  };

  it('sends the caller utterance as state with one noul question and thresholds the probability', async () => {
    const { client, calls } = clientReturning(0.91);
    const verdict = await typesafeFrustrationJudge(client, { threshold: 0.5 })('you people never call back');

    expect(verdict).toEqual({ positive: true, probability: 0.91 });
    const req = calls[0] as { state: string; questions: Record<string, { type: string }> };
    expect(req.state).toBe('you people never call back');
    expect(req.questions[FRUSTRATION_QUESTION_ID].type).toBe('noul');
  });

  it('is negative below the threshold', async () => {
    const { client } = clientReturning(0.2);
    const verdict = await typesafeFrustrationJudge(client, { threshold: 0.5 })('ok thanks');
    expect(verdict).toEqual({ positive: false, probability: 0.2 });
  });
});
