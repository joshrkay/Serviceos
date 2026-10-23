/**
 * #1736 — `scoreVoiceCall` at handler level: in-memory stores + a mocked
 * gateway. Verdict -> score numbers follow the declared rubric weights; the
 * price expectations follow the seeded catalog (14900 cents) vs the dollar
 * amounts the seeded agent lines speak.
 */
import { describe, it, expect, vi } from 'vitest';
import type { LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import { InMemoryVoiceSessionGradeStore } from '../../../src/voice/quality/voice-session-grade-store';
import { InMemoryCallScoreStore } from '../../../src/voice/scoring/call-score-store';
import {
  createVoiceCallScorer,
  extractAmountsCents,
  findUngroundedPriceTurns,
} from '../../../src/voice/scoring/score-voice-call';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-05T08:00:00.000Z');
const ENDED = new Date('2026-10-04T15:02:00.000Z');

function verdict(items: Record<string, 'pass' | 'fail' | 'not_applicable'>, flags: unknown[] = []) {
  return JSON.stringify({
    items: Object.entries(items).map(([id, v]) => ({ id, verdict: v, rationale: `${id} ${v}` })),
    flags,
    summary: 'Booked a tune-up.',
  });
}

function gateway(content: string) {
  const requests: LLMRequest[] = [];
  const complete = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
    requests.push(req);
    return {
      content,
      model: 'scorer-mock-1',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
      costMicroCents: 300_000,
    };
  });
  return { complete, requests };
}

async function setup(
  transcript: string[],
  over: Partial<{ disclosed: boolean; billable: boolean | null; enabled: boolean }> = {},
) {
  const sessions = new InMemoryVoiceSessionGradeStore();
  sessions.seedSession({
    id: SESSION,
    tenantId: TENANT,
    channel: 'voice_inbound',
    startedAt: new Date(ENDED.getTime() - 120_000),
    endedAt: ENDED,
    outcome: 'completed',
    transcript,
    recordingDisclosed: over.disclosed ?? true,
    billable: over.billable === undefined ? true : over.billable,
  });
  const store = new InMemoryCallScoreStore();
  store.seedCatalog(TENANT, [{ name: 'AC tune-up', unitPriceCents: 14900 }]);
  if (over.enabled ?? true) await store.setEnabled(TENANT, true);
  return { sessions, store };
}

const ALL_PASS = verdict({
  booked: 'pass',
  price_grounded: 'pass',
  escalation_handled: 'pass',
  follow_up_set: 'pass',
});

const BOOKING_CALL = [
  'agent: Thanks for calling. This call may be recorded.',
  'caller: My AC is blowing warm air, can you come out Thursday?',
  'agent: The AC tune-up is $149. I can book Thursday at 10am.',
  'caller: Great, book it.',
  'agent: Done, you are booked for Thursday at 10am.',
];

describe('scoreVoiceCall (#1736)', () => {
  it('scores a booked, catalog-priced call 100 and persists it with the judge model and cost', async () => {
    const { sessions, store } = await setup(BOOKING_CALL);
    const gw = gateway(
      verdict(
        { booked: 'pass', price_grounded: 'pass', escalation_handled: 'not_applicable', follow_up_set: 'pass' },
        [{ kind: 'strength', turnIndex: 0, note: 'Quoted the tune-up and offered a slot in one reply.' }],
      ),
    );
    const scorer = createVoiceCallScorer({ store, sessions, gateway: gw, now: () => NOW });

    const result = await scorer.scoreVoiceCall(TENANT, SESSION);

    expect(result.status).toBe('scored');
    if (result.status !== 'scored') throw new Error('unreachable');
    expect(result.score.score).toBe(100);
    expect(result.score.model).toBe('scorer-mock-1');
    expect(result.score.costMicroCents).toBe(300_000);
    expect(result.score.flags).toHaveLength(1);
    expect(result.score.flags[0].excerpt).toContain('AC tune-up is $149');
    expect(await store.findScore(TENANT, SESSION)).toMatchObject({ score: 100, callEndedAt: ENDED });
  });

  it('routes through the gateway as voice_call_scoring for the real tenant, with the transcript fenced as untrusted', async () => {
    const { sessions, store } = await setup(BOOKING_CALL);
    const gw = gateway(ALL_PASS);
    await createVoiceCallScorer({ store, sessions, gateway: gw }).scoreVoiceCall(TENANT, SESSION);

    const req = gw.requests[0];
    expect(req.taskType).toBe('voice_call_scoring');
    expect(req.tenantId).toBe(TENANT);
    const user = req.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('UNTRUSTED CALLER CONTENT (BEGIN)');
    expect(user).toContain('AC tune-up: 14900 cents');
  });

  it('overrides a judge pass when the agent spoke a price that is not in the catalog', async () => {
    const { sessions, store } = await setup([
      'caller: How much for a tune-up?',
      'agent: That will be $89.',
      'caller: ok book it',
      'agent: Booked for Thursday.',
    ]);
    const gw = gateway(
      verdict({ booked: 'pass', price_grounded: 'pass', escalation_handled: 'not_applicable', follow_up_set: 'pass' }),
    );
    const result = await createVoiceCallScorer({ store, sessions, gateway: gw }).scoreVoiceCall(TENANT, SESSION);

    if (result.status !== 'scored') throw new Error('expected scored');
    expect(result.score.items.find((i) => i.id === 'price_grounded')?.verdict).toBe('fail');
    // booked 35 + follow-up 15 pass of 75 applicable weight -> 50/75 = 67
    expect(result.score.score).toBe(67);
    expect(result.score.flags).toEqual([expect.objectContaining({ kind: 'ungrounded_price', turnIndex: 0 })]);
  });

  it('marks price_grounded not_applicable when the agent never spoke a price, whatever the judge said', async () => {
    const { sessions, store } = await setup(['caller: Are you open Saturday?', 'agent: Yes, 8 to 4.']);
    const gw = gateway(
      verdict({ booked: 'not_applicable', price_grounded: 'pass', escalation_handled: 'not_applicable', follow_up_set: 'fail' }),
    );
    const result = await createVoiceCallScorer({ store, sessions, gateway: gw }).scoreVoiceCall(TENANT, SESSION);

    if (result.status !== 'scored') throw new Error('expected scored');
    expect(result.score.items.find((i) => i.id === 'price_grounded')?.verdict).toBe('not_applicable');
    expect(result.score.score).toBe(0);
  });

  it('drops flags that point past the end of the call', async () => {
    const { sessions, store } = await setup(BOOKING_CALL);
    const gw = gateway(
      verdict({ booked: 'pass', price_grounded: 'pass', escalation_handled: 'pass', follow_up_set: 'pass' }, [
        { kind: 'strength', turnIndex: 9, note: 'invented turn' },
      ]),
    );
    const result = await createVoiceCallScorer({ store, sessions, gateway: gw }).scoreVoiceCall(TENANT, SESSION);
    if (result.status !== 'scored') throw new Error('expected scored');
    expect(result.score.flags).toEqual([]);
  });

  it('spends nothing when the tenant has not opted in, or the call fails a gate', async () => {
    const cases = [
      ['disabled', { enabled: false }, 'disabled'],
      ['no disclosure', { disclosed: false }, 'no_disclosure'],
      ['not billable', { billable: false }, 'not_billable'],
    ] as const;
    for (const [label, over, reason] of cases) {
      const { sessions, store } = await setup(BOOKING_CALL, over);
      const gw = gateway(ALL_PASS);
      const result = await createVoiceCallScorer({ store, sessions, gateway: gw }).scoreVoiceCall(TENANT, SESSION);
      expect(result, label).toEqual({ status: 'skipped', reason });
      expect(gw.complete, label).not.toHaveBeenCalled();
    }
  });

  it('skips an unknown call', async () => {
    const { sessions, store } = await setup(BOOKING_CALL);
    const result = await createVoiceCallScorer({ store, sessions, gateway: gateway(ALL_PASS) }).scoreVoiceCall(
      TENANT,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    expect(result).toEqual({ status: 'skipped', reason: 'not_found' });
  });

  it('returns the stored score for an already-scored call and re-scores on force', async () => {
    const { sessions, store } = await setup(BOOKING_CALL);
    const gw = gateway(ALL_PASS);
    const scorer = createVoiceCallScorer({ store, sessions, gateway: gw });
    await scorer.scoreVoiceCall(TENANT, SESSION);
    expect((await scorer.scoreVoiceCall(TENANT, SESSION)).status).toBe('already_scored');
    expect(gw.complete).toHaveBeenCalledTimes(1);
    expect((await scorer.scoreVoiceCall(TENANT, SESSION, { force: true })).status).toBe('scored');
    expect(gw.complete).toHaveBeenCalledTimes(2);
  });

  it('throws (so the worker counts a failure) on judge output that is not valid JSON or off-contract', async () => {
    const a = await setup(BOOKING_CALL);
    await expect(
      createVoiceCallScorer({ ...a, gateway: gateway('not json') }).scoreVoiceCall(TENANT, SESSION),
    ).rejects.toThrow(/invalid JSON/);
    const b = await setup(BOOKING_CALL);
    const offContract = '{"items":[{"id":"nope","verdict":"pass","rationale":""}],"flags":[],"summary":""}';
    await expect(
      createVoiceCallScorer({ ...b, gateway: gateway(offContract) }).scoreVoiceCall(TENANT, SESSION),
    ).rejects.toThrow(/schema validation/);
    expect(await b.store.findScore(TENANT, SESSION)).toBeNull();
  });
});

describe('price extraction (#1736)', () => {
  it('reads dollar amounts as integer cents', () => {
    expect(extractAmountsCents('It is $149, or $1,250.50 for the big one, $5.5 flat')).toEqual([14900, 125050, 550]);
    expect(extractAmountsCents('no price here')).toEqual([]);
  });

  it('flags only turns where a spoken amount matches no catalog price; an empty catalog grounds nothing', () => {
    const turns = [
      { caller: 'a', agent: 'That is $149.' },
      { caller: 'b', agent: 'Or $89.' },
      { caller: 'c', agent: null },
      { caller: 'd', agent: 'No price.' },
    ];
    expect(findUngroundedPriceTurns(turns, [{ unitPriceCents: 14900 }])).toEqual({
      spokenTurns: [0, 1],
      ungroundedTurns: [1],
    });
    expect(findUngroundedPriceTurns(turns, [])).toEqual({ spokenTurns: [0, 1], ungroundedTurns: [0, 1] });
  });
});
