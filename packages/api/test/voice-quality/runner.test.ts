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
  coerceProposalDates,
  type DriverFactoryContext,
} from '../../src/ai/voice-quality/runner';
import type { Proposal } from '../../src/proposals/proposal';
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
          id: '00000000-0000-4000-8000-0000000000a1',
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
      // #869 — minimal shared lookup bundle so the synthetic `lookup_customer`
      // script exercises a real answered lookup (an unwired bundle would also
      // emit `lookup_executed`, but as `success:false, error:'unsupported'`).
      lookups: {
        answers: {},
        shared: {
          customerRepo: fctx.repos.customerRepo,
          jobRepo: fctx.repos.jobRepo,
          appointmentRepo: fctx.repos.appointmentRepo,
          proposalRepo: fctx.repos.proposalRepo,
        },
      },
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
      '00000000-0000-4000-8000-0000000000a1',
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );

    const result = await runScript(script, { driverFactory: factory, repoMode: 'memory' });

    expect(result.observation.scriptId).toBe(script.id);
    expect(result.observation.events.length).toBeGreaterThan(0);
    const lookupEvents = result.observation.events.filter(
      (e) => e.type === 'lookup_executed',
    );
    expect(lookupEvents).toHaveLength(1);
    // #869 — an ANSWERED lookup, not merely an emitted event: an unwired
    // bundle (or a fixture id the shared dispatch cannot parse) would also
    // emit exactly one `lookup_executed`, with `success: false`.
    expect(lookupEvents[0]).toMatchObject({ skillName: 'lookup_customer', success: true });
    expect(result.observation.errors).toEqual([]);
    expect(result.errors).toHaveLength(0);
    // Runner does not grade.
    expect(result.passed).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('VQ-008 — runScript with a hangup turn marks Observation.sessionEndedAs=terminated and hangupOccurred=true', async () => {
    const script = syntheticHangupScript();
    const factory = makeDriverFactory(
      '00000000-0000-4000-8000-0000000000a1',
      JSON.stringify({ intentType: 'lookup_customer', confidence: 0.95 }),
    );

    const result = await runScript(script, { driverFactory: factory, repoMode: 'memory' });

    expect(result.observation.sessionEndedAs).toBe('terminated');
    expect(result.observation.hangupOccurred).toBe(true);
  });

  it('VQ-008 — runScript seeds fixtures: customer count delta is 0 when no creations expected', async () => {
    const script = syntheticLookupScript();
    const factory = makeDriverFactory(
      '00000000-0000-4000-8000-0000000000a1',
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
      '00000000-0000-4000-8000-0000000000a1',
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

  it('WS1 — coerceProposalDates converts JSON-fixture ISO strings to real Date objects', () => {
    // JSON fixtures carry createdAt/updatedAt as ISO strings, but Proposal
    // types them as Date and the pending-proposal resolver sorts by
    // createdAt.getTime() — a batch owner-approval over ≥2 proposals threw
    // "createdAt.getTime is not a function" until this coercion.
    const raw = {
      id: 'p1',
      tenantId: 't1',
      proposalType: 'draft_estimate',
      status: 'ready_for_review',
      payload: {},
      summary: 's',
      createdBy: 'seed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    } as unknown as Proposal;

    const coerced = coerceProposalDates(raw);

    expect(coerced.createdAt).toBeInstanceOf(Date);
    expect(coerced.updatedAt).toBeInstanceOf(Date);
    expect(coerced.createdAt.getTime()).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    // Idempotent: a Date passes straight through.
    const already = coerceProposalDates(coerced);
    expect(already.createdAt).toBeInstanceOf(Date);
    expect(already.createdAt.getTime()).toBe(coerced.createdAt.getTime());
  });

  it('WS1 — makeRepoBundle builds a complete in-memory bundle (Layer 1 is memory-only; no pg mode)', () => {
    // The pg option was a throwing stub the nightly ran behind
    // continue-on-error — decorative, never a real Postgres run. It was
    // removed (QUALITY-2026-07-12 WS1); Layer 1 is memory-only.
    const bundle = makeRepoBundle('memory');
    expect(bundle.customerRepo).toBeDefined();
    expect(bundle.appointmentRepo).toBeDefined();
    expect(bundle.proposalRepo).toBeDefined();
    expect(bundle.auditRepo).toBeDefined();
  });

  it('PR#265 review — runScript on a happy-path script emits session_terminated{completed} so observation.sessionEndedAs === completed', async () => {
    const script = syntheticLookupScript();
    const factory = makeDriverFactory(
      '00000000-0000-4000-8000-0000000000a1',
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
      '00000000-0000-4000-8000-0000000000a1',
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

// #1331 / D-028 follow-up — a script that asks operator-only actions
// (add material, log an expense, apply a credit …) declares
// `harnessOperatorTaxonomy`. Layer 1 honours it by classifying on the full
// operator taxonomy; Layer 2 drives the production processor, which (rightly)
// refuses those actions on a customer's line. Owner decision 2026-10-01: on
// Layer 2 those scripts run as the OWNER line — the real surface where an
// owner asks for these actions by phone.
describe('#1331 — Layer 2 owner-line persona', () => {
  it('loadLayer2Corpus runs operator-taxonomy scripts as the owner line; others and Layer 1 are unchanged', () => {
    const layer2 = new Map(loadLayer2Corpus().map((s) => [s.id, s]));
    expect(layer2.get('add-material-known-customer')?.callerIsOwner).toBe(true);
    expect(layer2.get('apply-credit-known-customer')?.callerIsOwner).toBe(true);
    expect(layer2.get('create-appointment-known-customer')?.callerIsOwner).toBe(false);

    const layer1 = new Map(loadCorpus().map((s) => [s.id, s]));
    expect(layer1.get('add-material-known-customer')?.callerIsOwner).toBe(false);
  });

  // #1331 — the phone turn engine never drafts a write on the request turn:
  // it reads the request back ("Just to confirm — add material. Is that
  // right?") and drafts only on the caller's yes. The corpus encodes the
  // Layer 1 text-mode contract (draft on the request turn), so on Layer 2 the
  // caller answers the readback; the drafted-reply expectation moves to that
  // answer turn. Layer 1 keeps the one-turn script.
  it('loadLayer2Corpus answers the phone readback with a yes after every write turn', () => {
    const script = loadLayer2Corpus().find((s) => s.id === 'add-material-known-customer')!;
    expect(script.turns).toHaveLength(2);
    expect(script.turns[0]!.caller).toBe('Add three boxes of half-inch PEX to the shopping list.');
    expect(script.turns[0]!.expected).toEqual({
      intent: 'add_material',
      proposalType: 'add_material',
      slots: { quantity: 3 },
      escalates: false,
    });
    expect(script.turns[0]!.hangupAfter).toBe(false);
    expect(script.turns[1]).toEqual({
      caller: "Yes, that's right.",
      expected: {
        spokenAnswerMatches:
          "Got it — I've drafted an add material for review. Anything else I can help you with?",
      },
      hangupAfter: false,
    });

    const lookup = loadLayer2Corpus().find((s) => s.id === 'lookup-jobs-known-customer')!;
    expect(lookup.turns).toHaveLength(1);
    const layer1 = loadCorpus().find((s) => s.id === 'add-material-known-customer')!;
    expect(layer1.turns).toHaveLength(1);
  });
});

// #1331 — appointment / invoice fixture rows reach the repos with real Dates,
// as Pg-hydrated rows do. Seeded as JSON strings, the shared appointment
// lookup threw "a.scheduledStart.getTime is not a function" the moment a
// lookup fixture linked its appointment to the caller (B8.10's class of bug,
// fixed then for jobs / estimates / proposals only).
describe('#1331 — runScript seeds appointment and invoice dates as Dates', () => {
  it('hands the driver appointments and invoices whose date fields are Date objects', async () => {
    const script: VoiceQualityScript = {
      ...syntheticLookupScript(),
      fixtures: {
        ...syntheticLookupScript().fixtures,
        appointments: [
          {
            id: '00000000-0000-4000-8000-0000000000b1',
            tenantId: 't-vq-008',
            jobId: '00000000-0000-4000-8000-0000000000c1',
            scheduledStart: '2026-06-12T16:00:00.000Z',
            scheduledEnd: '2026-06-12T18:00:00.000Z',
            arrivalWindowStart: '2026-06-12T16:00:00.000Z',
            arrivalWindowEnd: '2026-06-12T16:30:00.000Z',
            timezone: 'America/Los_Angeles',
            status: 'scheduled',
            createdBy: 'user_seed',
            createdAt: '2026-04-30T10:00:00.000Z',
            updatedAt: '2026-04-30T10:00:00.000Z',
          },
        ],
        invoices: [
          {
            id: '00000000-0000-4000-8000-0000000000d1',
            tenantId: 't-vq-008',
            jobId: '00000000-0000-4000-8000-0000000000c1',
            invoiceNumber: 'INV-1',
            status: 'sent',
            lineItems: [],
            totals: { subtotalCents: 100, discountCents: 0, taxCents: 0, totalCents: 100 },
            amountPaidCents: 0,
            amountDueCents: 100,
            issuedAt: '2026-04-15T10:00:00.000Z',
            dueDate: '2026-05-15T10:00:00.000Z',
            createdBy: 'user_seed',
            createdAt: '2026-04-15T10:00:00.000Z',
            updatedAt: '2026-04-15T10:00:00.000Z',
          },
        ],
      },
    } as unknown as VoiceQualityScript;

    const seen: Record<string, unknown> = {};
    await runScript(script, {
      repoMode: 'memory',
      driverFactory: (fctx) => ({
        startSession: async () => {
          const [appt] = await fctx.repos.appointmentRepo.findByDateRange(
            't-vq-008',
            new Date('2026-01-01T00:00:00Z'),
            new Date('2027-01-01T00:00:00Z'),
          );
          const inv = await fctx.repos.invoiceRepo.findById('t-vq-008', '00000000-0000-4000-8000-0000000000d1');
          seen.scheduledStart = appt?.scheduledStart;
          seen.arrivalWindowEnd = appt?.arrivalWindowEnd;
          seen.dueDate = inv?.dueDate;
          seen.issuedAt = inv?.issuedAt;
          return { sessionId: 's-1' };
        },
        speak: async () => ({ agentResponse: '', latencyMs: 0 }),
        hangup: async () => {},
        endSession: async () => {},
      }),
    });

    expect(seen.scheduledStart).toEqual(new Date('2026-06-12T16:00:00.000Z'));
    expect(seen.arrivalWindowEnd).toEqual(new Date('2026-06-12T16:30:00.000Z'));
    expect(seen.dueDate).toEqual(new Date('2026-05-15T10:00:00.000Z'));
    expect(seen.issuedAt).toEqual(new Date('2026-04-15T10:00:00.000Z'));
  });
});

// #1331 — production contracts validate record ids as UUIDs
// (`customerId: Invalid uuid`). Corpus fixtures use readable ids
// ("cust_02_add_material_owner") that Layer 1's mocks tolerate, so on Layer 2
// every write proposal was gated on a bad customerId and lookup_balance
// failed outright (run 36829085635 log). The Layer 2 persona maps each
// readable fixture id to a stable UUID everywhere it appears.
describe('#1331 — loadLayer2Corpus fixture ids', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('gives every Layer 2 fixture record a UUID id, and keeps references and expected slots pointing at it', () => {
    const layer2 = loadLayer2Corpus();
    const create = layer2.find((s) => s.id === 'create-appointment-known-customer')!;
    const customer = (create.fixtures.customers as Array<{ id: string; tenantId: string }>)[0]!;
    expect(customer.id).toMatch(UUID);
    expect(create.turns[0]!.expected.slots?.customerId).toBe(customer.id);
    // Tenant ids are not record ids and stay as authored.
    expect(customer.tenantId).toBe('t_02_create_appointment');

    const cancel = layer2.find((s) => s.id === 'cancel-appointment-known-customer')!;
    const appt = (cancel.fixtures.appointments as Array<{ id: string; jobId: string }>)[0]!;
    expect(appt.id).toMatch(UUID);
    expect(appt.jobId).toMatch(UUID);
    expect(cancel.turns[0]!.expected.slots?.appointmentId).toBe(appt.id);

    // Stable across loads, so the three voting runs and every week agree.
    expect(
      loadLayer2Corpus().find((s) => s.id === 'create-appointment-known-customer')!.turns[0]!
        .expected.slots?.customerId,
    ).toBe(customer.id);

    // Layer 1 is untouched.
    const layer1 = loadCorpus().find((s) => s.id === 'create-appointment-known-customer')!;
    expect((layer1.fixtures.customers as Array<{ id: string }>)[0]!.id).toBe('cust_02_create_appt_jane');
  });
});
