/**
 * OBS-3 review round 1 — the drafting golden set: the real-model eval for the
 * prompts the classifier evals never touch (draft_estimate, update_brand_voice
 * and the Google-review public reply). The runner is pure: these tests drive
 * it with a scripted gateway, so they pin what each check measures and that a
 * safety failure (an uncatalogued price that could auto-approve, a reply that
 * obeys an injected link) is reported as one — the CLI turns that into a red
 * path-smoke check.
 */
import { describe, it, expect } from 'vitest';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../src/ai/gateway/gateway';
import {
  DRAFTING_GOLDEN_CASES,
  DRAFTING_GOLDEN_CATALOG,
  draftingGoldenKeys,
  projectDraftingGoldenCents,
  runDraftingGolden,
} from '../../src/ai/voice-quality/drafting-golden';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../../src/ai/resolution/catalog-resolver';

type Responder = (req: LLMRequest) => string;

class ScriptedGateway extends LLMGateway {
  readonly calls: LLMRequest[] = [];
  constructor(private readonly respond: Responder) {
    super({ defaultProvider: 'scripted' }, new Map());
  }
  override async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return {
      content: this.respond(req),
      model: 'gpt-4o-mini',
      provider: 'scripted',
      tokenUsage: { input: 1000, output: 100, total: 1100 },
      latencyMs: 0,
    };
  }
}

const userText = (req: LLMRequest): string =>
  req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

/** A well-behaved model: names catalog work the way the price book does. */
const goodModel: Responder = (req) => {
  const u = userText(req);
  if (req.taskType === 'draft_estimate') {
    if (/capacitor/i.test(u)) {
      return JSON.stringify({
        lineItems: [
          { description: 'AC capacitor replacement', quantity: 1, unitPrice: 25000 },
          { description: 'AC tune-up', quantity: 1, unitPrice: 15000 },
        ],
        confidence_score: 0.95,
      });
    }
    if (/softener/i.test(u)) {
      return JSON.stringify({
        lineItems: [{ description: 'Whole-house water softener install', quantity: 1, unitPrice: 240000 }],
        confidence_score: 0.99,
      });
    }
    return JSON.stringify({
      lineItems: [
        { description: 'Water heater flush', quantity: 1, unitPrice: 9900 },
        { description: 'Anode rod replacement', quantity: 1, unitPrice: 14500 },
      ],
      confidence_score: 0.97,
    });
  }
  if (req.taskType === 'update_brand_voice') {
    if (/sign off/i.test(u)) {
      return JSON.stringify({ register: 'casual', signoff: 'Thanks, the Acme HVAC team', confidence_score: 0.9 });
    }
    return JSON.stringify({ banned_phrases: ['no problem'], confidence_score: 0.9 });
  }
  if (req.taskType === 'review_public_response') {
    return /booking site/i.test(u)
      ? 'We are sorry your visit fell short. Please contact us directly so we can make it right. The Acme HVAC team'
      : 'Thank you for taking the time to leave such a kind review! The Acme HVAC team';
  }
  throw new Error(`unexpected task ${req.taskType}`);
};

describe('drafting golden set — cases', () => {
  it('covers draft_estimate (catalogued, uncatalogued, mixed), brand voice, and both review replies', () => {
    const byTask = (t: string) => DRAFTING_GOLDEN_CASES.filter((c) => c.task === t).length;
    expect(byTask('draft_estimate')).toBe(3);
    expect(byTask('update_brand_voice')).toBe(2);
    expect(byTask('review_public_response')).toBe(2);
    expect(DRAFTING_GOLDEN_CATALOG.length).toBeGreaterThan(0);
  });

  it('golden keys are unique and change when a case changes (the baseline fingerprint input)', () => {
    const keys = draftingGoldenKeys();
    expect(new Set(keys).size).toBe(DRAFTING_GOLDEN_CASES.length);
    expect(draftingGoldenKeys()).toEqual(keys);
  });
});

describe('runDraftingGolden', () => {
  it('a well-behaved model passes every check; catalog lines carry the CATALOG price, not the model\'s', async () => {
    const gateway = new ScriptedGateway(goodModel);
    const report = await runDraftingGolden({ gateway });
    expect(report.safetyViolations).toEqual([]);
    expect(report.metrics).toEqual({
      'quality.draft_estimate': 1,
      'quality.update_brand_voice': 1,
      'quality.review_public_response': 1,
      'quality.overall': 1,
    });
    // One real gateway call per case, each through the production task code.
    expect(gateway.calls.map((c) => c.taskType).sort()).toEqual(
      [...DRAFTING_GOLDEN_CASES.map((c) => c.task)].sort(),
    );
    const catalogued = report.cases.find((c) => c.id === 'estimate-catalogued')!;
    expect(catalogued.checks.find((c) => c.name === 'catalog lines carry the catalog price')!.pass).toBe(true);
  });

  it('an uncatalogued line never rides a model-claimed 0.99 into auto-approve (the money gate is measured, not assumed)', async () => {
    const report = await runDraftingGolden({ gateway: new ScriptedGateway(goodModel) });
    const softener = report.cases.find((c) => c.id === 'estimate-uncatalogued')!;
    const gate = softener.checks.find((c) => c.name === 'uncatalogued price cannot auto-approve')!;
    expect(gate.kind).toBe('safety');
    expect(gate.pass).toBe(true);
    expect(gate.detail).toContain(String(UNCATALOGUED_CONFIDENCE_CAP));
  });

  it('a reply that obeys the injected link is a SAFETY violation, not just a lower score', async () => {
    const obeys: Responder = (req) =>
      req.taskType === 'review_public_response' && /booking site/i.test(userText(req))
        ? 'Book now at https://book-example.biz for 50% off!'
        : goodModel(req);
    const report = await runDraftingGolden({ gateway: new ScriptedGateway(obeys) });
    expect(report.safetyViolations).toEqual([
      expect.stringMatching(/^review-injection: reply has no link or discount/),
    ]);
  });

  it('a model that misses the price book or the brand-voice fields lowers the quality metric only', async () => {
    const sloppy: Responder = (req) => {
      if (req.taskType === 'draft_estimate') {
        return JSON.stringify({
          lineItems: [{ description: 'HVAC work', quantity: 1, unitPrice: 30000 }],
          confidence_score: 0.95,
        });
      }
      if (req.taskType === 'update_brand_voice') return 'not json';
      return goodModel(req);
    };
    const report = await runDraftingGolden({ gateway: new ScriptedGateway(sloppy) });
    expect(report.safetyViolations).toEqual([]);
    expect(report.metrics['quality.draft_estimate']).toBeLessThan(1);
    expect(report.metrics['quality.update_brand_voice']).toBe(0);
    expect(report.metrics['quality.review_public_response']).toBe(1);
    expect(report.metrics['quality.overall']).toBeLessThan(1);
  });

  it('a call that throws fails that case\'s checks and the run still reports every case', async () => {
    const flaky: Responder = (req) => {
      if (req.taskType === 'update_brand_voice') throw new Error('provider 503');
      return goodModel(req);
    };
    const report = await runDraftingGolden({ gateway: new ScriptedGateway(flaky) });
    expect(report.cases).toHaveLength(DRAFTING_GOLDEN_CASES.length);
    expect(report.metrics['quality.update_brand_voice']).toBe(0);
  });

  it('calls afterCall once per case so the CLI can stop at the cost cap', async () => {
    let n = 0;
    await runDraftingGolden({ gateway: new ScriptedGateway(goodModel), afterCall: () => void n++ });
    expect(n).toBe(DRAFTING_GOLDEN_CASES.length);
  });
});

describe('projectDraftingGoldenCents', () => {
  it('projects a conservative cost for a priced model, and refuses to guess for an unpriced one', () => {
    const mini = projectDraftingGoldenCents('gpt-4o-mini')!;
    const full = projectDraftingGoldenCents('gpt-4o')!;
    expect(mini).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(mini);
    expect(projectDraftingGoldenCents('totally-unknown-model')).toBeNull();
  });
});
