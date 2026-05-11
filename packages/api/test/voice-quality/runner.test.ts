/**
 * VQ-008 — Runner + corpus loader tests.
 *
 * The runner takes a single `VoiceQualityScript` plus a context bundle
 * (driver factory + repo mode + optional gateway/cost-tracker) and
 * drives the script end-to-end through the production orchestration
 * pipeline, returning an `Observation` plus session timing/error
 * metadata. The runner does not grade — it only produces the pristine
 * observation graders later assert against.
 *
 * The corpus loader walks `corpus/scripts/<bucket>/*.json` and parses
 * each file through `VoiceQualityScriptSchema`, returning a sorted
 * array. Invalid files surface as aggregated errors.
 *
 * These tests use a synthetic in-memory `MockLLMProvider`-backed
 * gateway as the cassette substitute (cassettes are themselves
 * exercised by VQ-005's tests). Each test builds its own runner ctx so
 * sessions don't bleed across tests.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import { TextModeDriver } from '../../src/ai/voice-quality/text-mode-driver';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import {
  runScript,
  makeRepoBundle,
  type DriverFactoryContext,
} from '../../src/ai/voice-quality/runner';
import { loadCorpus, loadScript, loadLayer2Corpus } from '../../src/ai/voice-quality/corpus/loader';
import type { VoiceQualityScript } from '../../src/ai/voice-quality/schema';
import type { AgentDriver } from '../../src/ai/voice-quality/text-mode-driver';
import type { Customer } from '../../src/customers/customer';

function syntheticLookupScript(): VoiceQualityScript {
  return {
    id: 'synthetic-lookup',
    bucket: '01-happy-lookups',
    fixtures: {
      tenant: { id: 't-vq-008', name: 'Acme HVAC' },
      customers: [
        {
          id: 'cust-vq-1',
          tenantId: 't-vq-008',
          firstName: 'Jane',
          lastName: 'Smith',
          displayName: 'Jane Smith',
          primaryPhone: '+15555550100',
          preferredChannel: 'phone',
          smsConsent: true,
          isArchived: false,
          createdBy: 'system:vq',
          createdAt: new Date(),
          updatedAt: new Date(),
        } satisfies Customer,
      ],
    },
    callerId: '+15555550100',
    callerIdBlocked: false,
    turns: [
      {
        caller: 'Could you confirm my contact info on file?',
        expected: { intent: 'lookup_customer' },
        hangupAfter: false,
      },
    ],
    grading: { appliesFloor: [1, 2, 3, 4, 5, 6, 7, 8], appliesDisposition: [9, 10, 11, 12] },
    layer2Eligible: false,
  };
}

function syntheticHangupScript(): VoiceQualityScript {
  return {
    ...syntheticLookupScript(),
    id: 'synthetic-hangup',
    bucket: '06-hangup-edges',
    turns: [
      {
        caller: 'Could you confirm my contact info on file?',
        expected: { intent: 'lookup_customer' },
        hangupAfter: true,
      },
    ],
  };
}

/**
 * Build a driver factory that returns a fresh `TextModeDriver` per
 * call. Each driver gets its own `VoiceSessionStore` + `AgentEventBus`
 * so cross-call state is impossible.
 *
 * `customerId` is bound onto the freshly-created session inside
 * `driver.startSession`'s wrapper so customer-scoped lookups resolve.
 * Without this binding, the lookup_customer skill returns the
 * "couldn't identify you" fallback string and `lookup_executed` never
 * fires — defeating the test's purpose.
 */
/**
 * Build a driver-factory closure compatible with `RunScriptContext.driverFactory`.
 *
 * The runner owns the repo bundle + event bus and passes them into
 * this factory; the factory wires them into a fresh
 * `TextModeDriver`. Each `runScript` call instantiates one driver.
 */
function makeDriverFactory(
  scriptCustomerId: string | undefined,
  classifierResponse: string,
): (fctx: DriverFactoryContext) => AgentDriver {
  return (fctx) => {
    const store = new VoiceSessionStore({ startInterval: false });
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(classifierResponse);

    const driver = new TextModeDriver({
      voiceSessionStore: store,
      bus: fctx.bus,
      gateway,
      proposalRepo: fctx.repos.proposalRepo,
      customerRepo: fctx.repos.customerRepo,
      appointmentRepo: fctx.repos.appointmentRepo,
      invoiceRepo: fctx.repos.invoiceRepo,
      estimateRepo: fctx.repos.estimateRepo,
      jobRepo: fctx.repos.jobRepo,
      leadRepo: fctx.repos.leadRepo,
      auditRepo: fctx.repos.auditRepo,
      systemActorId: 'system:vq-test',
    });

    // Wrap startSession so the test can bind a customerId without
    // changing the driver contract. Production binds via caller-id
    // resolution; for synthetic scripts we attach it after
    // startSession resolves.
    const wrapped: AgentDriver = {
      startSession: async (opts) => {
        const r = await driver.startSession(opts);
        if (scriptCustomerId) {
          const session = store.get(r.sessionId);
          if (session) session.customerId = scriptCustomerId;
        }
        return r;
      },
      speak: (sid, t) => driver.speak(sid, t),
      hangup: (sid) => driver.hangup(sid),
      endSession: async (sid) => {
        await driver.endSession(sid);
        store.dispose();
      },
    };
    return wrapped;
  };
}

describe('VQ-008 — runner', () => {
  it('VQ-008 — runScript with a synthetic single-turn lookup script returns Observation with non-empty events and lookup_executed', async () => {
    const script = syntheticLookupScript();
    const factory = makeDriverFactory(
      'cust-vq-1',
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );

    const result = await runScript(script, { driverFactory: factory, repoMode: 'memory' });

    expect(result.observation.scriptId).toBe(script.id);
    expect(result.observation.events.length).toBeGreaterThan(0);
    const lookupEvents = result.observation.events.filter(
      (e) => e.type === 'lookup_executed',
    );
    expect(lookupEvents).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    // Runner does not grade.
    expect(result.passed).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('VQ-008 — runScript with a hangup turn marks Observation.sessionEndedAs=terminated and hangupOccurred=true', async () => {
    const script = syntheticHangupScript();
    const factory = makeDriverFactory(
      'cust-vq-1',
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );

    const result = await runScript(script, { driverFactory: factory, repoMode: 'memory' });

    expect(result.observation.sessionEndedAs).toBe('terminated');
    expect(result.observation.hangupOccurred).toBe(true);
  });

  it('VQ-008 — runScript seeds fixtures: customer count delta is 0 when no creations expected', async () => {
    const script = syntheticLookupScript();
    const factory = makeDriverFactory(
      'cust-vq-1',
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );

    const result = await runScript(script, { driverFactory: factory, repoMode: 'memory' });

    // Seeded customer is counted both before AND after — delta is 0.
    expect(result.observation.customerCountDelta).toBe(0);
    // No proposals were created (read-only lookup).
    expect(result.observation.proposals).toHaveLength(0);
  });

  it('VQ-008 — runScript supports multiple sequential calls without state leakage', async () => {
    const scriptA = syntheticLookupScript();
    const scriptB: VoiceQualityScript = {
      ...syntheticLookupScript(),
      id: 'synthetic-lookup-b',
      fixtures: {
        ...syntheticLookupScript().fixtures,
        tenant: { id: 't-vq-008-b', name: 'Other HVAC' },
        customers: [
          {
            ...(syntheticLookupScript().fixtures.customers[0] as Record<string, unknown>),
            id: 'cust-vq-2',
            tenantId: 't-vq-008-b',
          },
        ],
      },
    };

    const factoryA = makeDriverFactory(
      'cust-vq-1',
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );
    const factoryB = makeDriverFactory(
      'cust-vq-2',
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );

    const a = await runScript(scriptA, { driverFactory: factoryA, repoMode: 'memory' });
    const b = await runScript(scriptB, { driverFactory: factoryB, repoMode: 'memory' });

    expect(a.observation.tenantId).toBe('t-vq-008');
    expect(b.observation.tenantId).toBe('t-vq-008-b');
    // Each runner gets a fresh event bus → events from A do not appear
    // in B's observation.
    const aLookups = a.observation.events.filter((e) => e.type === 'lookup_executed');
    const bLookups = b.observation.events.filter((e) => e.type === 'lookup_executed');
    expect(aLookups).toHaveLength(1);
    expect(bLookups).toHaveLength(1);
  });

  it("VQ-008 — runScript respects repoMode='pg' is not yet supported", () => {
    expect(() => makeRepoBundle('pg')).toThrow(/not yet supported/);
  });

  it('PR#265 review — runScript on a happy-path script emits session_terminated{completed} so observation.sessionEndedAs === completed', async () => {
    const script = syntheticLookupScript();
    const factory = makeDriverFactory(
      'cust-vq-1',
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );

    const result = await runScript(script, { driverFactory: factory, repoMode: 'memory' });

    expect(result.observation.hangupOccurred).toBe(false);
    expect(result.observation.sessionEndedAs).toBe('completed');
    const terminatedEvents = result.observation.events.filter(
      (e) => e.type === 'session_terminated',
    );
    expect(terminatedEvents).toHaveLength(1);
    expect(
      (terminatedEvents[0] as { type: 'session_terminated'; cause: string }).cause,
    ).toBe('completed');
  });

  it('PR#265 review — runScript on a hangup script still ends as terminated and does NOT add a competing completed event', async () => {
    const script = syntheticHangupScript();
    const factory = makeDriverFactory(
      'cust-vq-1',
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );

    const result = await runScript(script, { driverFactory: factory, repoMode: 'memory' });

    expect(result.observation.sessionEndedAs).toBe('terminated');
    expect(result.observation.hangupOccurred).toBe(true);
    const terminatedEvents = result.observation.events.filter(
      (e) => e.type === 'session_terminated',
    );
    // Only the hangup event — no spurious completed event tacked on.
    expect(terminatedEvents).toHaveLength(1);
    expect(
      (terminatedEvents[0] as { type: 'session_terminated'; cause: string }).cause,
    ).toBe('hangup');
  });
});

describe('VQ-008 — corpus loader', () => {
  it('VQ-008 — loadCorpus walks bucket directories and returns all valid scripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'vq-008-corpus-'));

    const bucketA = join(root, '01-happy-lookups');
    mkdirSync(bucketA, { recursive: true });
    const scriptA = syntheticLookupScript();
    writeFileSync(join(bucketA, `${scriptA.id}.json`), JSON.stringify(scriptA, null, 2));

    const bucketB = join(root, '06-hangup-edges');
    mkdirSync(bucketB, { recursive: true });
    const scriptB = syntheticHangupScript();
    writeFileSync(join(bucketB, `${scriptB.id}.json`), JSON.stringify(scriptB, null, 2));

    const scripts = loadCorpus(root);
    expect(scripts).toHaveLength(2);
    const ids = scripts.map((s) => s.id).sort();
    expect(ids).toEqual(['synthetic-hangup', 'synthetic-lookup']);
  });

  it('VQ-008 — loadCorpus throws aggregated error when any file fails parsing', () => {
    const root = mkdtempSync(join(tmpdir(), 'vq-008-corpus-bad-'));
    const bucket = join(root, '01-happy-lookups');
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, 'good.json'), JSON.stringify(syntheticLookupScript()));
    writeFileSync(join(bucket, 'bad.json'), '{ this is not valid json');

    expect(() => loadCorpus(root)).toThrow(/bad\.json/);
  });

  it('VQ-008 — loadScript throws on invalid JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'vq-008-loadscript-'));
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{ broken');
    expect(() => loadScript(bad)).toThrow();
  });

  it('VQ-008 — loadScript loads and validates a single script file', () => {
    const root = mkdtempSync(join(tmpdir(), 'vq-008-loadscript-ok-'));
    const file = join(root, 'ok.json');
    const script = syntheticLookupScript();
    writeFileSync(file, JSON.stringify(script));
    const loaded = loadScript(file);
    expect(loaded.id).toBe(script.id);
    expect(loaded.bucket).toBe(script.bucket);
  });
});

describe('VQ2-014 — loadLayer2Corpus', () => {
  it('VQ2-014 — loadLayer2Corpus returns only layer2Eligible scripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'vq2-014-layer2-'));

    // Eligible script.
    const bucketA = join(root, '01-happy-lookups');
    mkdirSync(bucketA, { recursive: true });
    const eligible = { ...syntheticLookupScript(), id: 'eligible-script', layer2Eligible: true };
    writeFileSync(join(bucketA, `${eligible.id}.json`), JSON.stringify(eligible));

    // Ineligible script (default false).
    const bucketB = join(root, '06-hangup-edges');
    mkdirSync(bucketB, { recursive: true });
    const ineligible = { ...syntheticHangupScript(), id: 'ineligible-script', layer2Eligible: false };
    writeFileSync(join(bucketB, `${ineligible.id}.json`), JSON.stringify(ineligible));

    const layer2 = loadLayer2Corpus(root);
    expect(layer2.map((s) => s.id)).toEqual(['eligible-script']);
  });

  it('VQ2-014 — loadLayer2Corpus excludes layer2Only=false scripts that are not layer2Eligible', () => {
    const root = mkdtempSync(join(tmpdir(), 'vq2-014-layer2-only-'));

    // Layer-2-only script (eligible AND layer2Only) should be included.
    const bucketA = join(root, '08-ambiguity');
    mkdirSync(bucketA, { recursive: true });
    const layer2Only = {
      ...syntheticLookupScript(),
      id: 'layer2-only-script',
      bucket: '08-ambiguity' as const,
      layer2Eligible: true,
      layer2Only: true,
    };
    writeFileSync(join(bucketA, `${layer2Only.id}.json`), JSON.stringify(layer2Only));

    // Default-flagged script (layer2Only false, layer2Eligible false) should be excluded.
    const bucketB = join(root, '04-identity-edges');
    mkdirSync(bucketB, { recursive: true });
    const defaultFlags = {
      ...syntheticLookupScript(),
      id: 'default-flags-script',
      bucket: '04-identity-edges' as const,
      layer2Eligible: false,
      layer2Only: false,
    };
    writeFileSync(join(bucketB, `${defaultFlags.id}.json`), JSON.stringify(defaultFlags));

    const layer2 = loadLayer2Corpus(root);
    expect(layer2.map((s) => s.id)).toEqual(['layer2-only-script']);
  });
});
