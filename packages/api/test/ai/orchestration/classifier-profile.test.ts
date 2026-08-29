/**
 * Surface-conditional classifier taxonomy (#886/#887).
 *
 * Three layers under test:
 * 1. Assembly — which blocks / rules / dictionary lines each profile's
 *    prompt advertises ('operator' byte-identity is pinned separately in
 *    intent-taxonomy-blocks.test.ts).
 * 2. classifyIntent wiring — profile-aware base message, section gating,
 *    the post-parse PROFILE_INTENTS guard ('intent_off_surface'), and the
 *    profile-gated deterministic inventory→expense override.
 * 3. classifierProfileForSession — profile derives from SESSION IDENTITY
 *    (channel / ownerSession / D-026 phone actor), never transcript text.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  advertisedIntentsForProfile,
  buildClassifierSystemPrompt,
  CUSTOMER_SCOPED_LOOKUP_INTENTS,
  PROFILE_INTENTS,
  type ClassifierProfile,
} from '../../../src/ai/orchestration/classifier-profile';
import {
  classifyIntent,
  CUSTOMER_PROTECTION_PROMPT_SECTION,
  EXTENDED_INTENTS_PROMPT_SECTION,
  isIntentAcceptedOnProfile,
  isInventoryLoggingPhrasing,
  SUPPORTED_INTENTS,
  SYSTEM_PROMPT,
} from '../../../src/ai/orchestration/intent-classifier';
import { classifierProfileForSession } from '../../../src/ai/voice-turn/create-voice-turn-processor';
import type { VoiceSession } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 100, output: 50, total: 150 },
      latencyMs: 42,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function systemMessagesOf(gateway: LLMGateway): Array<{ role: string; content: string }> {
  const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return call.messages.filter((m) => m.role === 'system');
}

/** Intent names advertised as list blocks (`- "name"`), in prompt order. */
function advertisedBlocks(prompt: string): string[] {
  return [...prompt.matchAll(/^- "([a-z_]+)"/gm)].map((m) => m[1]);
}

/** Field keys present in the extractedEntities dictionary. */
function dictionaryKeys(prompt: string): string[] {
  return [...prompt.matchAll(/^ {4}"([A-Za-z]+)":/gm)].map((m) => m[1]);
}

describe('buildClassifierSystemPrompt — per-profile assembly', () => {
  it('caller advertises exactly the S1 capture + lookup + conversational set', () => {
    const prompt = buildClassifierSystemPrompt('caller');
    const blocks = advertisedBlocks(prompt);
    // trailing catch-all: 'unknown' closes the list a second time
    expect(blocks.filter((b) => b === 'unknown')).toHaveLength(2);
    expect([...new Set(blocks)].sort()).toEqual(
      [
        'create_customer',
        'create_appointment',
        'create_job',
        'reschedule_appointment',
        'draft_estimate',
        'lookup_appointments',
        'lookup_invoices',
        'lookup_balance',
        'lookup_jobs',
        'lookup_agreements',
        'lookup_account_summary',
        'lookup_customer',
        'lookup_estimates',
        'lookup_availability',
        'confirm',
        'operator_request',
        'language_switch',
        'unknown',
      ].sort(),
    );
    // No money/comms/edit taxonomy leaks into the caller prompt.
    expect(prompt).not.toContain('"record_payment"');
    expect(prompt).not.toContain('"send_invoice"');
    expect(prompt).not.toContain('"emergency_dispatch"');
    expect(prompt).not.toContain('"lookup_my_day"');
  });

  it('caller gets the money-ask preamble; other profiles do not', () => {
    const line = 'a person handles\nmoney on this line';
    expect(buildClassifierSystemPrompt('caller')).toContain(line);
    for (const profile of ['field_tech', 'owner_line', 'operator'] as const) {
      expect(buildClassifierSystemPrompt(profile)).not.toContain(line);
    }
  });

  it('caller drops every distinction rule (none contrasts only caller intents)', () => {
    expect(buildClassifierSystemPrompt('caller')).not.toContain('Distinctions that matter:');
    expect(buildClassifierSystemPrompt('operator')).toContain('Distinctions that matter:');
  });

  it('caller entity dictionary is trimmed to the 13 fields its intents extract (#896)', () => {
    expect(dictionaryKeys(buildClassifierSystemPrompt('caller'))).toEqual([
      'customerName',
      'jobReference',
      'amount',
      'dateTimeDescription',
      'lineItemDescriptions',
      'displayName',
      'email',
      'phone',
      'address',
      'appointmentReference',
      'newDateTimeDescription',
      'noteBody',
      'jobTitle',
    ]);
    // Trimmed dictionary must still read as the JSON example: the last
    // surviving line carries no trailing comma before the closing brace.
    expect(buildClassifierSystemPrompt('caller')).toMatch(/>"\n {2}\}\n\}/);
  });

  it('caller create_customer / jobTitle / noteBody use the short caller variants', () => {
    const prompt = buildClassifierSystemPrompt('caller');
    expect(prompt).toContain('an inbound CALLER is signing up');
    // operator-only CRM lore from the full block stays out
    expect(prompt).not.toContain('add_service_location');
    expect(prompt).toContain('the complaint text on complaint');
    expect(prompt).not.toContain('PERMIT: ');
    expect(prompt).not.toContain('Warranty — ');
  });

  it('field_tech advertises the trade-internal set, no customer lookups, no protection wording', () => {
    const prompt = buildClassifierSystemPrompt('field_tech');
    expect([...new Set(advertisedBlocks(prompt))].sort()).toEqual(
      [
        'create_customer',
        'create_appointment',
        'create_job',
        'reschedule_appointment',
        'draft_estimate',
        'schedule_inspection',
        'log_warranty_claim',
        'en_route',
        'lookup_my_day',
        'lookup_materials',
        'lookup_availability',
        'confirm',
        'operator_request',
        'language_switch',
        'unknown',
      ].sort(),
    );
    expect(prompt).not.toContain('"lookup_appointments"');
    // full jobTitle line (warranty/inspection prefixes) — no caller variant
    expect(prompt).toContain('Warranty — ');
  });

  it('owner_line drops exactly the customer-scoped lookups', () => {
    const prompt = buildClassifierSystemPrompt('owner_line');
    const blocks = new Set(advertisedBlocks(prompt));
    for (const intent of CUSTOMER_SCOPED_LOOKUP_INTENTS) {
      expect(blocks.has(intent)).toBe(false);
    }
    const operatorBlocks = new Set(advertisedBlocks(SYSTEM_PROMPT));
    expect(blocks.size).toBe(operatorBlocks.size - CUSTOMER_SCOPED_LOOKUP_INTENTS.size);
  });

  it('PROFILE_INTENTS accepts what prompt sections can advertise (guard never undoes a section)', () => {
    // caller: customer protection is unconditional on live telephony
    expect(PROFILE_INTENTS.caller.has('complaint')).toBe(true);
    expect(PROFILE_INTENTS.caller.has('negotiation')).toBe(true);
    // owner_line: all three sections can appear
    for (const intent of [
      'approve_proposal',
      'reject_proposal',
      'edit_proposal',
      'complaint',
      'negotiation',
      'lookup_day_overview',
      'lookup_digest',
      'lookup_pending_items',
      'lookup_crew_schedule',
      'lookup_timesheets',
    ] as const) {
      expect(PROFILE_INTENTS.owner_line.has(intent)).toBe(true);
    }
    // field_tech: no sections, no section intents
    expect(PROFILE_INTENTS.field_tech.has('complaint')).toBe(false);
    expect(PROFILE_INTENTS.field_tech.has('approve_proposal')).toBe(false);
  });

  it('emergency_dispatch is never advertised on S1 profiles (deterministic keyword scan owns the live path)', () => {
    // RV-140/142: the keyword scan runs before classification, so the LLM
    // block is prompt noise on the trimmed surfaces. A keyword-less
    // emergency the model detects anyway still escalates — the post-parse
    // guard exempts emergency_dispatch (see the wiring test below).
    for (const profile of ['caller', 'field_tech'] as const) {
      expect(PROFILE_INTENTS[profile].has('emergency_dispatch')).toBe(false);
      expect(buildClassifierSystemPrompt(profile)).not.toContain('"emergency_dispatch"');
    }
  });
});

describe('classifyIntent — profile wiring', () => {
  const ok = (intentType: string, confidence = 0.95) =>
    JSON.stringify({ intentType, confidence, reasoning: 'test' });

  it('no classifierProfile ⇒ the historical operator prompt, byte-identical', async () => {
    const gateway = mockGateway(ok('create_invoice'));
    await classifyIntent('Create an invoice for Acme for 450 dollars', { tenantId: 't1' }, gateway);
    const system = systemMessagesOf(gateway);
    expect(system).toHaveLength(1);
    expect(system[0].content).toBe(SYSTEM_PROMPT);
  });

  it("classifierProfile: 'caller' swaps the base message; protection section still appended", async () => {
    const gateway = mockGateway(ok('lookup_balance'));
    const result = await classifyIntent(
      'How much do I owe you guys?',
      { tenantId: 't1', classifierProfile: 'caller', customerProtectionIntents: true },
      gateway,
    );
    const system = systemMessagesOf(gateway);
    expect(system).toHaveLength(2);
    expect(system[0].content).toBe(buildClassifierSystemPrompt('caller'));
    expect(system[1].content).toBe(CUSTOMER_PROTECTION_PROMPT_SECTION);
    expect(result.intentType).toBe('lookup_balance');
  });

  it("field_tech never receives the protection or extended sections, even with flags set", async () => {
    const gateway = mockGateway(ok('lookup_my_day'));
    await classifyIntent(
      "What's my next job?",
      {
        tenantId: 't1',
        classifierProfile: 'field_tech',
        customerProtectionIntents: true,
        extendedIntents: false,
      },
      gateway,
    );
    const system = systemMessagesOf(gateway);
    expect(system).toHaveLength(1);
    expect(system[0].content).toBe(buildClassifierSystemPrompt('field_tech'));
  });

  it("owner_line keeps owner + protection + extended sections", async () => {
    // NOT a canonical extended-intent phrasing — those short-circuit before
    // the LLM when extendedIntents is set.
    const gateway = mockGateway(ok('approve_proposal'));
    await classifyIntent(
      'Approve the Henderson estimate',
      {
        tenantId: 't1',
        classifierProfile: 'owner_line',
        ownerSession: true,
        customerProtectionIntents: true,
        extendedIntents: true,
      },
      gateway,
    );
    const contents = systemMessagesOf(gateway).map((m) => m.content);
    expect(contents[0]).toBe(buildClassifierSystemPrompt('owner_line'));
    expect(contents).toContain(CUSTOMER_PROTECTION_PROMPT_SECTION);
    expect(contents).toContain(EXTENDED_INTENTS_PROMPT_SECTION);
  });

  it('post-parse guard: an off-surface classification becomes unknown/intent_off_surface', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'record_payment',
        confidence: 0.97,
        reasoning: 'caller wants to pay',
        extractedEntities: { customerName: 'Acme' },
      }),
    );
    const result = await classifyIntent(
      'I want to pay my invoice',
      { tenantId: 't1', classifierProfile: 'caller', customerProtectionIntents: true },
      gateway,
    );
    expect(result.intentType).toBe('unknown');
    expect(result.unknownReason).toBe('intent_off_surface');
    // #902 — the interception is not silent: the blocked intent travels on
    // the result so the live seams can audit it (voice.intent_off_surface).
    expect(result.offSurfaceIntent).toBe('record_payment');
    // confidence/entities/usage survive for observability + cost tracking
    expect(result.confidence).toBe(0.97);
    expect(result.extractedEntities).toEqual({ customerName: 'Acme' });
    expect(result.tokenUsage).toEqual({ input: 100, output: 50 });
  });

  it('an accepted classification never carries offSurfaceIntent', async () => {
    const gateway = mockGateway(ok('create_appointment'));
    const result = await classifyIntent(
      'Can you get somebody out here on Thursday?',
      { tenantId: 't1', classifierProfile: 'caller' },
      gateway,
    );
    expect(result.intentType).toBe('create_appointment');
    expect(result.offSurfaceIntent).toBeUndefined();
  });

  it('post-parse guard: off-surface lookups pass through to the D-026 dispatch layer', async () => {
    // An anonymous caller asking an owner/actor-grade question must reach
    // the shared lookup dispatch, whose RBAC refuses with purposeful copy —
    // the guard converting it to 'unknown' would replace that deliberate
    // refusal with a generic reprompt.
    const gateway = mockGateway(ok('lookup_my_day'));
    const result = await classifyIntent(
      "What's my schedule today?",
      { tenantId: 't1', classifierProfile: 'caller', customerProtectionIntents: true },
      gateway,
    );
    expect(result.intentType).toBe('lookup_my_day');
    expect(result.unknownReason).toBeUndefined();
  });

  it('post-parse guard: an LLM-detected emergency still fast-paths on caller (accepted, unadvertised)', async () => {
    const gateway = mockGateway(
      JSON.stringify({ intentType: 'emergency_dispatch', confidence: 0.97, reasoning: 'gas smell' }),
    );
    const result = await classifyIntent(
      'something smells really wrong in the basement and I feel dizzy',
      { tenantId: 't1', classifierProfile: 'caller', customerProtectionIntents: true },
      gateway,
    );
    expect(result.intentType).toBe('emergency_dispatch');
  });

  it('post-parse guard: the same classification passes on a profile that offers it', async () => {
    const gateway = mockGateway(ok('record_payment'));
    const result = await classifyIntent(
      'Record a payment from Acme',
      { tenantId: 't1', classifierProfile: 'owner_line' },
      gateway,
    );
    expect(result.intentType).toBe('record_payment');
    expect(result.unknownReason).toBeUndefined();
  });

  it('sign-up override outranks the guard: an off-surface guess on a sign-up phrasing still lands create_customer', async () => {
    const gateway = mockGateway(ok('record_payment'));
    const result = await classifyIntent(
      "I'd like to sign up as a new customer",
      { tenantId: 't1', classifierProfile: 'caller' },
      gateway,
    );
    expect(result.intentType).toBe('create_customer');
  });

  it('deterministic inventory→expense override is gated to operator/owner_line', async () => {
    const transcript = 'Log inventory: picked up ten filters from the supply house';
    expect(isInventoryLoggingPhrasing(transcript)).toBe(true);

    const callerGateway = mockGateway(ok('unknown', 0.9));
    const callerResult = await classifyIntent(
      transcript,
      { tenantId: 't1', classifierProfile: 'caller' },
      callerGateway,
    );
    expect(callerResult.intentType).toBe('unknown');

    const ownerGateway = mockGateway(ok('unknown', 0.9));
    const ownerResult = await classifyIntent(
      transcript,
      { tenantId: 't1', classifierProfile: 'owner_line' },
      ownerGateway,
    );
    expect(ownerResult.intentType).toBe('log_expense');

    const operatorGateway = mockGateway(ok('unknown', 0.9));
    const operatorResult = await classifyIntent(transcript, { tenantId: 't1' }, operatorGateway);
    expect(operatorResult.intentType).toBe('log_expense');
  });
});

describe('classifierProfileForSession — identity-derived, fail-closed', () => {
  function session(over: {
    channel?: string;
    actorUserId?: string;
    ownerSession?: boolean;
  }): VoiceSession {
    return {
      channel: over.channel ?? 'telephony',
      ...(over.actorUserId ? { actorUserId: over.actorUserId } : {}),
      machine: {
        currentContext: over.ownerSession === true ? { ownerSession: true } : {},
      },
    } as unknown as VoiceSession;
  }

  it('trusted in-app channel keeps the full operator taxonomy', () => {
    expect(classifierProfileForSession(session({ channel: 'inapp' }))).toBe('operator');
  });

  it('anonymous/customer telephony is caller', () => {
    expect(classifierProfileForSession(session({}))).toBe('caller');
  });

  it('caller-ID-resolved employee (D-026 phone actor) is field_tech', () => {
    expect(classifierProfileForSession(session({ actorUserId: 'user-1' }))).toBe('field_tech');
  });

  it('verified owner line wins over everything', () => {
    expect(
      classifierProfileForSession(session({ ownerSession: true, actorUserId: 'user-1' })),
    ).toBe('owner_line');
  });

  it('a future untrusted channel fails closed to caller', () => {
    expect(classifierProfileForSession(session({ channel: 'web_chat' }))).toBe('caller');
  });
});

// ─── #902 — the one accept rule ──────────────────────────────────────────────

describe('isIntentAcceptedOnProfile — the exported three-way accept rule', () => {
  // The guard's rule is PROFILE_INTENTS ∪ lookup_* ∪ the exempt set, folded
  // into ONE exported predicate so no second call site can re-derive it
  // differently. These pins are the predicate's direct spec.
  it('accepts what the profile set offers', () => {
    expect(isIntentAcceptedOnProfile('caller', 'create_appointment')).toBe(true);
    expect(isIntentAcceptedOnProfile('field_tech', 'lookup_my_day')).toBe(true);
  });

  it('accepts every read-only lookup_* on every profile (D-026 dispatch RBAC owns them)', () => {
    for (const profile of ['caller', 'field_tech', 'owner_line', 'operator'] as const) {
      expect(isIntentAcceptedOnProfile(profile, 'lookup_revenue')).toBe(true);
      expect(isIntentAcceptedOnProfile(profile, 'lookup_crew_schedule')).toBe(true);
    }
  });

  it('accepts the guard-exempt downstream authorities on every profile', () => {
    for (const profile of ['caller', 'field_tech', 'owner_line', 'operator'] as const) {
      for (const intent of [
        'emergency_dispatch',
        'approve_proposal',
        'reject_proposal',
        'edit_proposal',
      ] as const) {
        expect(isIntentAcceptedOnProfile(profile, intent)).toBe(true);
      }
    }
  });

  it('rejects an off-surface mutation on the profiles that do not offer it', () => {
    expect(isIntentAcceptedOnProfile('caller', 'record_payment')).toBe(false);
    expect(isIntentAcceptedOnProfile('caller', 'send_invoice')).toBe(false);
    expect(isIntentAcceptedOnProfile('field_tech', 'record_payment')).toBe(false);
    expect(isIntentAcceptedOnProfile('owner_line', 'record_payment')).toBe(true);
  });

  it('operator accepts the entire taxonomy — intent_off_surface is unreachable without a profile', () => {
    // Every caller that omits classifierProfile (memo worker, in-app voice,
    // chat, evals) classifies as 'operator'; this pin is what makes the
    // guard a guaranteed no-op for them.
    for (const intent of SUPPORTED_INTENTS) {
      expect(isIntentAcceptedOnProfile('operator', intent)).toBe(true);
    }
  });
});

// ─── #902 — advertise vs accept is structural ────────────────────────────────

describe('advertisedIntentsForProfile — derived from the block table, never hand-kept', () => {
  it('accepted ⊇ advertised for every profile, by construction', () => {
    for (const profile of ['caller', 'field_tech', 'owner_line', 'operator'] as const) {
      for (const intent of advertisedIntentsForProfile(profile)) {
        expect(PROFILE_INTENTS[profile].has(intent)).toBe(true);
      }
    }
  });

  it('caller advertises 18 base-prompt intents and accepts 20', () => {
    // The delta is exactly the protection-section pair: complaint /
    // negotiation have no base block (the always-appended customer-
    // protection section advertises them on live telephony), but the guard
    // must accept them — the docs (D-027, voice-action-catalog.md) state
    // both numbers.
    const advertised = advertisedIntentsForProfile('caller');
    expect(advertised.size).toBe(18);
    expect(PROFILE_INTENTS.caller.size).toBe(20);
    const acceptedNotAdvertised = [...PROFILE_INTENTS.caller].filter((i) => !advertised.has(i));
    expect(acceptedNotAdvertised.sort()).toEqual(['complaint', 'negotiation']);
  });

  it('advertised counts per profile match the assembled prompts', () => {
    const expected: Record<ClassifierProfile, number> = {
      caller: 18,
      field_tech: 15,
      owner_line: 60,
      operator: 68,
    };
    for (const profile of ['caller', 'field_tech', 'owner_line', 'operator'] as const) {
      const advertised = advertisedIntentsForProfile(profile);
      expect(advertised.size).toBe(expected[profile]);
      // The derivation IS the assembly filter: every advertised intent has a
      // block in the profile's prompt.
      const blocks = new Set(advertisedBlocks(buildClassifierSystemPrompt(profile)));
      expect([...advertised].sort()).toEqual([...blocks].sort());
    }
  });
});
