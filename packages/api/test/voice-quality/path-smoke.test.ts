/**
 * Offline path-smoke runner tests — inject a mock classify, no network.
 */
import { describe, it, expect } from 'vitest';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import {
  PATH_SMOKE_CASES,
  PATH_SMOKE_PASS_RATIO,
  allPathSmokeUtterances,
  runPathSmoke,
} from '../../src/ai/voice-quality/path-smoke';

function mockGateway(): LLMGateway {
  return new LLMGateway({ defaultProvider: 'mock' }, new Map());
}

describe('path-smoke cases catalog', () => {
  it('is non-empty and cost-bounded in turn count', () => {
    const utterances = allPathSmokeUtterances();
    expect(utterances.length).toBeGreaterThanOrEqual(8);
    // Keep the suite under ~15 classify calls so $1 cap stays comfortable.
    expect(utterances.length).toBeLessThanOrEqual(15);
  });

  it('default pass ratio is 80%', () => {
    expect(PATH_SMOKE_PASS_RATIO).toBe(0.8);
  });
});

describe('runPathSmoke', () => {
  it('passes when classify returns expected intents', async () => {
    const report = await runPathSmoke({
      gateway: mockGateway(),
      cases: PATH_SMOKE_CASES,
      classify: async (utterance, _ctx) => {
        // Map by matching the case turn expected intent via utterance lookup.
        for (const c of PATH_SMOKE_CASES) {
          for (const t of c.turns) {
            if (t.utterance === utterance) {
              return { intentType: t.expectedIntent, confidence: 0.95 };
            }
          }
        }
        return { intentType: 'unknown', confidence: 0 };
      },
    });
    expect(report.gatePassed).toBe(true);
    expect(report.passedCases).toBe(report.totalCases);
  });

  it('fails gate when too many cases miss', async () => {
    const report = await runPathSmoke({
      gateway: mockGateway(),
      cases: PATH_SMOKE_CASES,
      passRatio: 0.9,
      classify: async () => ({ intentType: 'unknown', confidence: 0.1 }),
    });
    expect(report.gatePassed).toBe(false);
    expect(report.passedCases).toBe(0);
  });

  it('accepts acceptableIntents aliases', async () => {
    const report = await runPathSmoke({
      gateway: mockGateway(),
      cases: [
        {
          pathId: 'quote',
          title: 'quote alias',
          turns: [
            {
              utterance: 'how much for a water heater',
              expectedIntent: 'draft_estimate',
              acceptableIntents: ['create_estimate'],
            },
          ],
        },
      ],
      classify: async () => ({
        intentType: 'create_estimate',
        confidence: 0.9,
      }),
    });
    expect(report.gatePassed).toBe(true);
    expect(report.results[0]?.passed).toBe(true);
  });

  it('records errors as failed turns without throwing', async () => {
    const report = await runPathSmoke({
      gateway: mockGateway(),
      cases: [
        {
          pathId: 'book',
          title: 'boom',
          turns: [{ utterance: 'hi', expectedIntent: 'create_appointment' }],
        },
      ],
      classify: async () => {
        throw new Error('provider down');
      },
    });
    expect(report.gatePassed).toBe(false);
    expect(report.results[0]?.turns[0]?.error).toMatch(/provider down/);
  });
});
