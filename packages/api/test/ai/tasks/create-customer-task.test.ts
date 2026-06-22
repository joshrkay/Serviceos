/**
 * P18-001 — `create-customer-task` voice handler tests.
 *
 * Includes the AST-01 regression assertion: classifier + task pipeline
 * must produce a `create_customer` proposal (not `'unknown'`) for the
 * five canonical caller-side sign-up phrasings.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CreateCustomerVoiceTaskHandler,
  CREATE_CUSTOMER_CONFIRMATION_TTS,
  resolvePhone,
} from '../../../src/ai/tasks/create-customer-task';
import {
  classifyIntent,
  isCreateCustomerSignupPhrasing,
} from '../../../src/ai/orchestration/intent-classifier';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 10, output: 5, total: 15 },
      latencyMs: 5,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

const TENANT = 'tenant-1';
const SYSTEM_USER = 'voice_agent';
const SESSION = 'session-uuid-1';

describe('P18-001 create-customer-task — proposal building', () => {
  const handler = new CreateCustomerVoiceTaskHandler();

  it('builds a create_customer proposal with name + caller-id phone (AC-2)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: "I'd like to sign up as a new customer",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Alex Smith',
        callerIdPhone: '+15551230100',
        sessionId: SESSION,
        callSid: 'CA-100',
        classifierConfidence: 0.92,
      },
    });
    expect(out.status).toBe('proposal_drafted');
    expect(out.proposal).toBeDefined();
    expect(out.proposal!.proposalType).toBe('create_customer');
    expect(out.proposal!.payload.name).toBe('Alex Smith');
    expect(out.proposal!.payload.phone).toBe('+15551230100');
    // Optional email when not provided
    expect(out.proposal!.payload.email).toBeUndefined();
    // Voice provenance metadata captured
    const voice = out.proposal!.payload.voice as { phoneSource?: string; sessionId?: string };
    expect(voice.phoneSource).toBe('caller_id');
    expect(voice.sessionId).toBe(SESSION);
  });

  it('keeps proposal in draft so AC-3 (no auto-execute) holds', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: "I'm a new customer",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Maria Gomez',
        callerIdPhone: '+15551230101',
      },
    });
    expect(out.proposal!.status).toBe('draft');
  });

  it('extracts email when classifier provides it (AC-2)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: 'Add customer Acme, email a@a.com',
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Acme Corp',
        email: 'a@a.com',
        callerIdPhone: '+15550000001',
      },
    });
    expect(out.proposal!.payload.email).toBe('a@a.com');
  });

  it('escalates to needs_callback when caller-id is blocked and no spoken phone (path 4)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: "I'd like to sign up",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Jordan Lee',
        phoneBlocked: true,
      },
    });
    expect(out.status).toBe('needs_callback');
    expect(out.proposal).toBeUndefined();
  });

  it('returns already_customer when caller already matches (path 1)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: 'I want to become a customer',
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        existingCustomerId: 'cust-existing-1',
        callerIdPhone: '+15550000001',
      },
    });
    expect(out.status).toBe('already_customer');
    expect(out.proposal).toBeUndefined();
  });

  it('flags lead_match path when caller phone matches an existing lead (path 5)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: 'Sign me up',
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Test Lead',
        callerIdPhone: '+15550000001',
        existingLeadId: 'lead-42',
      },
    });
    expect(out.status).toBe('lead_match');
    expect(out.proposal).toBeDefined();
    expect(out.proposal!.sourceContext).toMatchObject({
      existingLeadId: 'lead-42',
      suggestLeadConversion: true,
    });
  });

  it('returns needs_name when only caller-id is available (path 3 minimum)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: "I'd like to sign up",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        callerIdPhone: '+15550000001',
      },
    });
    expect(out.status).toBe('needs_name');
  });

  it('omits SMS consent by default — tenant must opt-in (path 10)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: "I'd like to sign up",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Bob Builder',
        callerIdPhone: '+15550000003',
      },
    });
    expect(out.proposal!.payload.smsConsent).toBe(false);
  });

  it('includes voice metadata for AC-15 (approval UI context)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: 'New customer please',
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Sarah Connor',
        callerIdPhone: '+15550000004',
        callSid: 'CA-XYZ',
        classifierConfidence: 0.91,
        sessionId: SESSION,
      },
    });
    expect(out.proposal!.payload.voice).toMatchObject({
      callSid: 'CA-XYZ',
      classifierConfidence: 0.91,
      sessionId: SESSION,
    });
    expect(out.proposal!.sourceContext).toMatchObject({
      sessionId: SESSION,
      callSid: 'CA-XYZ',
      correlationId: SESSION,
    });
  });

  it('emits the AC-5 confirmation TTS string', () => {
    expect(CREATE_CUSTOMER_CONFIRMATION_TTS).toMatch(/sent your info|confirmation/i);
  });

  it('handle() falls back to a voice_clarification proposal when no proposal would be produced', async () => {
    const result = await handler.handle({
      tenantId: TENANT,
      message: "I'd like to sign up",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        phoneBlocked: true,
      },
    });
    expect(result.taskType).toBe('voice_clarification');
    expect(result.proposal.proposalType).toBe('voice_clarification');
  });
});

describe('P18-001 create-customer-task — malicious input (path 9)', () => {
  const handler = new CreateCustomerVoiceTaskHandler();

  it('stores SQL-injection-looking name as an inert string (Zod accepts, no interpolation)', async () => {
    const malicious = "Robert'); DROP TABLE customers;--";
    const out = await handler.run({
      tenantId: TENANT,
      message: `My name is ${malicious}`,
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: malicious,
        callerIdPhone: '+15550000009',
      },
    });
    // Zod validates shape; injection safety comes from prepared
    // statements downstream. The raw string must survive untouched
    // so the audit trail captures exactly what the caller said.
    expect(out.status).toBe('proposal_drafted');
    expect(out.proposal!.payload.name).toBe(malicious);
  });

  it('rejects a malformed/malicious email at the Zod gate', async () => {
    await expect(
      handler.run({
        tenantId: TENANT,
        message: 'sign me up',
        conversationId: SESSION,
        userId: SYSTEM_USER,
        existingEntities: {
          displayName: 'Eve Mallory',
          email: '<script>alert(1)</script>',
          callerIdPhone: '+15550000010',
        },
      })
    ).rejects.toThrow(/Invalid payload/);
  });
});

describe('P18-001 create-customer-task — tenant isolation (path 13)', () => {
  const handler = new CreateCustomerVoiceTaskHandler();

  it('scopes the proposal to the resolved tenant from context — never cross-tenant', async () => {
    const entsFor = (phone: string) => ({
      displayName: 'Same Caller',
      callerIdPhone: phone,
    });
    const a = await handler.run({
      tenantId: 'tenant-A',
      message: 'sign me up',
      conversationId: 'session-A',
      userId: SYSTEM_USER,
      existingEntities: entsFor('+15550000020'),
    });
    const b = await handler.run({
      tenantId: 'tenant-B',
      message: 'sign me up',
      conversationId: 'session-B',
      userId: SYSTEM_USER,
      existingEntities: entsFor('+15550000020'),
    });
    expect(a.proposal!.tenantId).toBe('tenant-A');
    expect(b.proposal!.tenantId).toBe('tenant-B');
    // No leakage of the other tenant's session into either proposal.
    expect(a.proposal!.sourceContext).toMatchObject({ correlationId: 'session-A' });
    expect(b.proposal!.sourceContext).toMatchObject({ correlationId: 'session-B' });
  });
});

describe('P18-001 classifier — low-confidence band (path 11)', () => {
  it('signup phrasing in the [0.6, 0.75) band is bumped past TAU_INT (no reprompt loop)', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'create_customer', confidence: 0.65 })
    );
    const result = await classifyIntent(
      "I'd like to sign up as a new customer",
      { tenantId: TENANT },
      gateway
    );
    expect(result.intentType).toBe('create_customer');
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('non-signup phrasing below 0.6 → unknown with lowConfidenceIntent for clarification reprompt', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'create_customer', confidence: 0.55 })
    );
    const result = await classifyIntent(
      'um maybe put me down or something',
      { tenantId: TENANT },
      gateway
    );
    expect(result.intentType).toBe('unknown');
    expect(result.unknownReason).toBe('low_confidence');
    expect(result.lowConfidenceIntent).toBe('create_customer');
  });
});

describe('P18-001 create-customer-task — phone resolution', () => {
  it('prefers spoken callback over caller-id', () => {
    const r = resolvePhone({ phone: '+15551230999', callerIdPhone: '+15550000001' });
    expect(r.phone).toBe('+15551230999');
    expect(r.phoneSource).toBe('spoken');
  });

  it('falls back to caller-id when only caller-id present', () => {
    const r = resolvePhone({ callerIdPhone: '+15550000001' });
    expect(r.phone).toBe('+15550000001');
    expect(r.phoneSource).toBe('caller_id');
  });

  it('returns nothing when phone is blocked AND no spoken callback', () => {
    const r = resolvePhone({ phoneBlocked: true });
    expect(r.phone).toBeUndefined();
    expect(r.phoneSource).toBeUndefined();
  });
});

describe('P18-001 create_customer regression — AST-01 classifier signup phrasings', () => {
  // AC-1 + AC-6: caller-side sign-up phrasings must NOT classify as
  // 'unknown'. The deterministic short-circuit forces create_customer
  // even if the LLM returns 'unknown'.
  const phrasings = [
    "I'd like to sign up as a new customer",
    "I'm a new customer",
    'Can you set up an account for me?',
    'I want to become a customer',
    'first time calling, please add me',
  ];

  for (const phrasing of phrasings) {
    it(`maps "${phrasing}" to create_customer (AST-01)`, async () => {
      // Simulate an LLM that misclassifies — the override must save us.
      const gateway = mockGateway(
        JSON.stringify({ intentType: 'unknown', confidence: 0.3 })
      );
      const result = await classifyIntent(phrasing, { tenantId: TENANT }, gateway);
      expect(result.intentType).toBe('create_customer');
      expect(result.confidence).toBeGreaterThanOrEqual(0.75);
    });
  }

  it('isCreateCustomerSignupPhrasing detects all 5 phrasings deterministically', () => {
    for (const phrasing of phrasings) {
      expect(isCreateCustomerSignupPhrasing(phrasing)).toBe(true);
    }
  });

  it('isCreateCustomerSignupPhrasing does NOT match unrelated requests', () => {
    expect(isCreateCustomerSignupPhrasing('Schedule an appointment for next Tuesday')).toBe(false);
    expect(isCreateCustomerSignupPhrasing('Send me my invoice')).toBe(false);
    expect(isCreateCustomerSignupPhrasing("I'd like to set up an appointment")).toBe(false);
  });

  it('respects classifier when LLM says create_customer (no override drift)', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.95,
        extractedEntities: { displayName: 'Alex' },
      })
    );
    const result = await classifyIntent("I'd like to sign up", { tenantId: TENANT }, gateway);
    expect(result.intentType).toBe('create_customer');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.extractedEntities?.displayName).toBe('Alex');
  });

  it('does NOT downgrade good operator-side phrasings (regression guard)', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.94,
        extractedEntities: { displayName: 'Acme Corp' },
      })
    );
    const result = await classifyIntent('Add customer Acme Corp', { tenantId: TENANT }, gateway);
    expect(result.intentType).toBe('create_customer');
  });

  it('Spanish "registrarme" routes to create_customer (path 6)', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'unknown', confidence: 0.3 })
    );
    const result = await classifyIntent(
      'Quisiera registrarme como cliente nuevo',
      { tenantId: TENANT },
      gateway
    );
    expect(result.intentType).toBe('create_customer');
  });
});

// ─── RV-007 (F-4): Confidence Marker `_meta` ─────────────────────────────
describe('RV-007 — create-customer task populates payload._meta', () => {
  const handler = new CreateCustomerVoiceTaskHandler();

  it('sets overallConfidence mapped from the classifier confidence (overall-only — no per-field signal)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: "I'd like to sign up as a new customer",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Alex Smith',
        callerIdPhone: '+15551230100',
        classifierConfidence: 0.92,
      },
    });

    const meta = out.proposal!.payload._meta as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta.overallConfidence).toBe('high'); // 0.92 ≥ 0.8
    expect(meta.fieldConfidence).toBeUndefined();
    expect(meta.markers).toBeUndefined();
  });

  it('maps a low classifier confidence to low', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: 'maybe sign me up I guess',
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Mumbly Caller',
        callerIdPhone: '+15551230101',
        classifierConfidence: 0.35,
      },
    });

    const meta = out.proposal!.payload._meta as Record<string, unknown>;
    expect(meta.overallConfidence).toBe('low');
  });

  it('omits _meta when no classifier confidence was threaded (non-voice callers unchanged)', async () => {
    const out = await handler.run({
      tenantId: TENANT,
      message: 'Add customer Acme',
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Acme Corp',
        callerIdPhone: '+15550000001',
      },
    });

    expect(out.proposal!.payload._meta).toBeUndefined();
  });
});

describe('4.3 — duplicate check before the proposal card', () => {
  // Minimal duplicate loader stub: returns a single same-tenant customer
  // whose phone matches, so checkCustomerDuplicatesPg scores a high-confidence
  // phone warning. Mirrors the CustomerDuplicateLoader contract.
  function loaderWithMatch(): {
    findDuplicates: (
      tenantId: string,
      criteria: { phone?: string; email?: string; name?: string }
    ) => Promise<Array<Record<string, unknown>>>;
  } {
    return {
      findDuplicates: async (tenantId: string) => [
        {
          id: 'existing-cust-1',
          tenantId,
          firstName: 'Alex',
          lastName: 'Smith',
          displayName: 'Alex Smith',
          primaryPhone: '+15551230100',
          preferredChannel: 'phone',
          smsConsent: false,
          isArchived: false,
          createdBy: 'u',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };
  }

  it('embeds duplicateWarnings in sourceContext when a loader is wired and a match exists', async () => {
    const handler = new CreateCustomerVoiceTaskHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      duplicateLoader: loaderWithMatch() as any,
    });
    const out = await handler.run({
      tenantId: TENANT,
      message: "I'd like to sign up as a new customer",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Alex Smith',
        callerIdPhone: '+15551230100',
      },
    });
    expect(out.status).toBe('proposal_drafted');
    const ctx = out.proposal!.sourceContext as Record<string, unknown>;
    expect(ctx.hasPossibleDuplicates).toBe(true);
    const warnings = ctx.duplicateWarnings as Array<{ matchType: string; existingId: string }>;
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.find((w) => w.matchType === 'phone')?.existingId).toBe('existing-cust-1');
  });

  it('omits duplicate fields when no loader is wired (unchanged behavior)', async () => {
    const handler = new CreateCustomerVoiceTaskHandler();
    const out = await handler.run({
      tenantId: TENANT,
      message: "I'd like to sign up as a new customer",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Alex Smith',
        callerIdPhone: '+15551230100',
      },
    });
    const ctx = out.proposal!.sourceContext as Record<string, unknown>;
    expect(ctx.hasPossibleDuplicates).toBeUndefined();
    expect(ctx.duplicateWarnings).toBeUndefined();
  });

  it('still drafts the proposal when the loader throws (best-effort, non-blocking)', async () => {
    const handler = new CreateCustomerVoiceTaskHandler({
      duplicateLoader: {
        findDuplicates: async () => {
          throw new Error('db down');
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    const out = await handler.run({
      tenantId: TENANT,
      message: "I'd like to sign up",
      conversationId: SESSION,
      userId: SYSTEM_USER,
      existingEntities: {
        displayName: 'Alex Smith',
        callerIdPhone: '+15551230100',
      },
    });
    expect(out.status).toBe('proposal_drafted');
    expect(out.proposal).toBeDefined();
  });
});
