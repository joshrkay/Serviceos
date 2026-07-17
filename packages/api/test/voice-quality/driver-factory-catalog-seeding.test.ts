/**
 * WS21b — the driver factory seeds `fixtures.catalog` into the catalog repo
 * the driver grounds against. Before WS21b the factory handed the driver an
 * EMPTY catalog, so a grounded-quote corpus scenario could never resolve a
 * spoken line item to a real price (the WS17 gap). This proves a seeded
 * catalog item's price OVERRIDES the LLM's invented number on a drafted
 * estimate.
 */
import { describe, it, expect } from 'vitest';
import { LLMGateway, type LLMRequest, type LLMResponse } from '../../src/ai/gateway/gateway';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import { makeRepoBundle } from '../../src/ai/voice-quality/runner';
import { VoiceQualityScriptSchema } from '../../src/ai/voice-quality/schema';
import { makeVoiceQualityDriverFactory } from './voice-quality-driver-factory';

const TENANT = 't_ws21b_catalog';
const CATALOG_PRICE_CENTS = 185000;

/** Two-taskType gateway: classify → draft_estimate, extraction → one line. */
class EstimateMockGateway extends LLMGateway {
  constructor() {
    super({ defaultProvider: 'mock' }, new Map());
  }
  override async complete(request: LLMRequest): Promise<LLMResponse> {
    const base = { model: 'mock', provider: 'mock', latencyMs: 1, tokenUsage: { input: 10, output: 10, total: 20 } };
    if (request.taskType === 'classify_intent') {
      return {
        ...base,
        content: JSON.stringify({
          intentType: 'draft_estimate',
          confidence: 0.95,
          extractedEntities: { lineItemDescriptions: ['Water heater install'] },
        }),
      };
    }
    if (request.taskType === 'draft_estimate') {
      // The LLM drafts $1,830 (within PRICE_CONFLICT tolerance of the
      // catalog's $1,850 — a larger deviation would surface a "did you
      // mean" conflict instead); the catalog must override it to $1,850.
      return {
        ...base,
        content: JSON.stringify({
          customerName: 'Jane Smith',
          summary: 'Water heater estimate',
          confidence_score: 0.9,
          lineItems: [{ description: 'Water heater install', unitPrice: 183000 }],
        }),
      };
    }
    return { ...base, content: '{}' };
  }
}

function buildScript() {
  return VoiceQualityScriptSchema.parse({
    id: 'ws21b-grounded-quote',
    bucket: '02-happy-booker',
    callerId: '+15555559999',
    callerIdBlocked: false,
    fixtures: {
      tenant: { id: TENANT, display_name: 'WS21b HVAC', timezone: 'America/Los_Angeles' },
      customers: [
        {
          id: 'cust_ws21b',
          tenantId: TENANT,
          firstName: 'Jane',
          lastName: 'Smith',
          displayName: 'Jane Smith',
          primaryPhone: '+15555559999',
          preferredChannel: 'phone',
          smsConsent: true,
          isArchived: false,
          createdBy: 'seed',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      catalog: [
        {
          id: 'cat_wh',
          tenantId: TENANT,
          name: 'Water heater install',
          description: 'Standard 40-gal water heater installation',
          category: 'service',
          unit: 'each',
          unitPriceCents: CATALOG_PRICE_CENTS,
          productServiceType: 'service',
          archivedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    turns: [
      {
        caller: 'Draft an estimate for a water heater install.',
        expected: { intent: 'draft_estimate', proposalType: 'draft_estimate' },
      },
    ],
    grading: { appliesFloor: [1, 2, 3, 4, 5, 6, 7, 8], appliesDisposition: [9, 10, 11, 12] },
  });
}

describe('WS21b — driver factory seeds fixtures.catalog for grounded quoting', () => {
  it('a seeded catalog price overrides the LLM number on a drafted estimate', async () => {
    const script = buildScript();
    const repos = makeRepoBundle('memory');
    const bus = new AgentEventBus();
    const factory = makeVoiceQualityDriverFactory(script);
    const driver = factory({
      repos,
      bus,
      gateway: new EstimateMockGateway(),
      scriptId: script.id,
      tenantId: TENANT,
    });

    // Seed the customer so identity resolves (mirrors the runner's seedFixtures).
    for (const c of script.fixtures.customers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await repos.customerRepo.create(c as any);
    }

    const { sessionId } = await driver.startSession({
      tenantId: TENANT,
      callerId: script.callerId,
      callerIdBlocked: false,
    });
    await driver.speak(sessionId, script.turns[0].caller);
    await driver.endSession(sessionId);

    const proposals = await repos.proposalRepo.findByTenant(TENANT);
    const estimate = proposals.find((p) => p.proposalType === 'draft_estimate');
    expect(estimate).toBeTruthy();
    const lineItems = (estimate!.payload as { lineItems?: Array<Record<string, unknown>> }).lineItems;
    expect(Array.isArray(lineItems)).toBe(true);
    // Grounded: the catalog's exact price won, not the LLM's invented $50.
    expect(lineItems![0].unitPrice).toBe(CATALOG_PRICE_CENTS);
    expect(lineItems![0].pricingSource).toBe('catalog');
  });
});
