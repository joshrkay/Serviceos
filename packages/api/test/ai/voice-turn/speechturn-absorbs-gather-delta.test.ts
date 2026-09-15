/**
 * #962 (PR-B) — speechTurn absorbs the Gather delta, gated by the coverage
 * table.
 *
 * The processor's `speechTurn` becomes CAPABLE of the four families today
 * served only by Gather's own loop (`_handleGatherLocked`): lookup,
 * language_switch, create_customer (P18-001), and the silence/low-STT
 * reprompt→escalate ladder. Every ported branch consults
 * `coverage-table.ts` for the CURRENT surface's cell before running, so no
 * live transport's observable behavior changes:
 *
 *  - a surface whose cell declares the ported Gather branch (today: the
 *    `gather` column) runs the family inside the pipeline;
 *  - a refuse-cell surface (media_streams lookup, D-026) takes EXACTLY the
 *    fall-through it takes today — the drafting funnel, not a new spoken
 *    refusal;
 *  - a cell served by a DIFFERENT module (media_streams language_switch =
 *    adapter pre-scan; media_streams create_customer = generic FSM path;
 *    media_streams silence ladder = adapter-side A3/T2-F05) leaves the turn
 *    to that module, byte-identical to main.
 *
 * Harness mirrors `coverage-table.behavior.test.ts`'s processor seam — the
 * exact function the mediastream adapter dispatches finals into, driven
 * here as the minimal "fake transport". The `coverageSurface` dep is the
 * only thing that varies: 'gather' (the surface whose loop is being
 * absorbed) versus the default 'media_streams' (today's only production
 * speechTurn surface).
 *
 * The silence-ladder tests pin the ported streak counter to Gather's
 * CURRENT semantics (test/telephony/twilio-adapter.test.ts A3/T2-F03):
 * one shared streak for silence + low acoustic confidence, reprompt below
 * MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS, graceful escalation + end_session
 * at it, reset on a good turn — deliberately NOT merged with the FSM's
 * confidence_low cap (#965 keeps counter unification a separate decision).
 */
import { describe, it, expect, vi } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { COVERAGE_TABLE } from '../../../src/ai/voice-turn/coverage-table';
import {
  renderTtsText,
  LANGUAGE_SWITCH_ACK,
  LANGUAGE_UNSUPPORTED_LINE,
  LOW_STT_CONFIDENCE_REPROMPT_COPY,
  SPEECH_TURN_FAILURE_ESCALATION_COPY,
} from '../../../src/ai/agents/customer-calling/tts-copy';
import { CREATE_CUSTOMER_CONFIRMATION_TTS } from '../../../src/ai/tasks/create-customer-task';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { PhoneLookupDeps } from '../../../src/ai/voice-turn/phone-lookup-surface';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-prb';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

// ── tiny helpers (same shapes as coverage-table.behavior.test.ts) ──────────

function llmResponse(content: string): LLMResponse {
  return {
    content,
    model: 'stub',
    provider: 'stub',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  } as unknown as LLMResponse;
}

function gatewayAlways(content: string): LLMGateway {
  return { complete: vi.fn(async () => llmResponse(content)) } as unknown as LLMGateway;
}

function classifyJson(intentType: string, entities: Record<string, unknown> = {}): string {
  return JSON.stringify({
    intentType,
    confidence: 0.96,
    reasoning: 'PR-B gate test',
    extractedEntities: entities,
  });
}

const ttsTexts = (fx: SideEffect[]) =>
  fx
    .filter((f) => f.type === 'tts_play')
    .map((f) => String((f.payload as { text?: string }).text ?? ''));

const ttsWithSource = (fx: SideEffect[], source: string) =>
  fx.filter(
    (f) =>
      f.type === 'tts_play' &&
      (f.payload as { source?: string }).source === source,
  );

const endSessionReasons = (fx: SideEffect[]) =>
  fx
    .filter((f) => f.type === 'end_session')
    .map((f) => String((f.payload as { reason?: string }).reason ?? ''));

function materialsLookups(listPending: ReturnType<typeof vi.fn>): PhoneLookupDeps {
  return {
    answers: {
      resolveMemberRole: async () => 'technician',
      materialItemRepo: { listPending },
    } as unknown as PhoneLookupDeps['answers'],
    shared: {
      proposalRepo: { findByTenant: vi.fn(async () => []) },
    } as unknown as PhoneLookupDeps['shared'],
  } as PhoneLookupDeps;
}

/**
 * Minimal fake transport: constructs the processor for one declared surface
 * and drives `speechTurn` directly — the same seam the mediastream adapter
 * (and, at cutover, the Gather loop) dispatches turns into.
 */
function makeTurnHarness(opts: {
  gateway: LLMGateway;
  surface?: 'gather' | 'media_streams';
  actorUserId?: string;
  matchedCustomer?: boolean;
  supportedLanguages?: ('en' | 'es')[];
  deps?: Record<string, unknown>;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = {
    create: vi.fn(async (p: Record<string, unknown>) => p),
    findByTenant: vi.fn(async () => []),
  };
  const processor = createVoiceTurnProcessor({
    store,
    gateway: opts.gateway,
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo,
    proposalRepo,
    ...(opts.surface ? { coverageSurface: opts.surface } : {}),
    ...(opts.deps ?? {}),
  } as never);
  const callSid = `CA-prb-${Math.random().toString(36).slice(2, 8)}`;
  const session = store.create(TENANT, 'telephony', { callSid });
  if (opts.actorUserId) session.actorUserId = opts.actorUserId;
  if (opts.supportedLanguages) session.supportedLanguages = opts.supportedLanguages;
  session.machine.dispatch({
    type: 'incoming_call',
    tenantId: TENANT,
    callSid,
    from: '+15125550111',
    to: '+15125550000',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: CUSTOMER_ID });
  // The ported P18-001 branch keys off session.customerId (caller-ID match),
  // exactly like Gather's — leave it unset for the unknown-caller variants.
  if (opts.matchedCustomer !== false) session.customerId = CUSTOMER_ID;
  const events: Array<{ type?: string }> = [];
  session.events.on('voice-event', (e: { type?: string }) => events.push(e));
  const turn = (speech: string) =>
    processor.speechTurn({ session, speechResult: speech, callSid, tenantId: TENANT });
  return { processor, store, session, callSid, auditRepo, proposalRepo, events, turn };
}

// ── lookup ──────────────────────────────────────────────────────────────────

describe('PR-B lookup — gated by the (lookup, surface) cell', () => {
  it('runs on a surface whose cell declares the Gather branch: answered out-of-FSM via the shared dispatch', async () => {
    expect(COVERAGE_TABLE.lookup.gather.status).toBe('reachable');
    const listPending = vi.fn(async () => [
      {
        id: 'm1',
        tenantId: TENANT,
        description: '3/4 inch copper elbows',
        quantity: 6,
        status: 'pending',
        createdBy: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('lookup_materials')),
      surface: 'gather',
      actorUserId: 'clerk-tech',
      deps: { lookups: materialsLookups(listPending) },
    });

    const fx = await h.turn('what materials do I need');

    expect(listPending).toHaveBeenCalled();
    const answers = ttsWithSource(fx, 'lookup_skill');
    expect(answers).toHaveLength(1);
    expect(String((answers[0]!.payload as { text?: string }).text)).toContain('copper elbows');
    expect(ttsTexts(fx)).toContain('Anything else I can help you with?');
    // Out-of-FSM: the state is untouched, ready for the next request.
    expect(h.session.machine.currentState).toBe('intent_capture');
  });

  it('refuse-cell surface (media_streams): the SAME turn takes today\'s exact fall-through into the drafting funnel', async () => {
    expect(COVERAGE_TABLE.lookup.media_streams.status).toBe('refuse');
    const listPending = vi.fn(async () => []);
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('lookup_materials')),
      actorUserId: 'clerk-tech',
      deps: { lookups: materialsLookups(listPending) },
    });

    const fx = await h.turn('what materials do I need');

    // No new refusal line, no lookup dispatch — the declared degradation:
    // the FSM advanced out of intent_capture into the drafting funnel.
    expect(listPending).not.toHaveBeenCalled();
    expect(ttsWithSource(fx, 'lookup_skill')).toHaveLength(0);
    expect(h.events.some((e) => e.type === 'lookup_executed')).toBe(false);
    expect(h.session.machine.currentState).not.toBe('intent_capture');
  });
});

// ── language_switch ─────────────────────────────────────────────────────────

describe('PR-B language_switch — gated by the (language_switch, surface) cell', () => {
  it('runs on a surface whose cell declares the Gather branch: flips language + voice, acks in the target language', async () => {
    expect(COVERAGE_TABLE.language_switch.gather.status).toBe('reachable');
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('language_switch')),
      surface: 'gather',
      supportedLanguages: ['en', 'es'],
    });
    h.session.language = 'en';

    const fx = await h.turn('can we talk in Spanish?');

    expect(h.session.language).toBe('es');
    expect(h.session.languageSwitchCount).toBe(1);
    expect(ttsTexts(fx)).toContain(LANGUAGE_SWITCH_ACK.es);
    expect(h.events.some((e) => e.type === 'language_switched')).toBe(true);
    // Out-of-FSM, same as Gather: the next turn listens in the new language.
    expect(h.session.machine.currentState).toBe('intent_capture');
  });

  it('gather-declared surface, tenant not opted in: speaks the unsupported line and stays put', async () => {
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('language_switch')),
      surface: 'gather',
      supportedLanguages: ['en'],
    });
    h.session.language = 'en';

    const fx = await h.turn('hablemos en español');

    expect(h.session.language).toBe('en');
    expect(ttsTexts(fx)).toContain(LANGUAGE_UNSUPPORTED_LINE.en);
    expect(h.events.some((e) => e.type === 'language_switched')).toBe(false);
  });

  it('cell served by a DIFFERENT module (media_streams: adapter pre-scan): the pipeline leaves the turn to the adapter, byte-identical to main', async () => {
    const cell = COVERAGE_TABLE.language_switch.media_streams;
    expect(cell.status).toBe('reachable');
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('language_switch')),
      supportedLanguages: ['en', 'es'],
    });
    h.session.language = 'en';

    const fx = await h.turn('can we talk in Spanish?');

    // The processor does NOT switch — the classified intent rides the
    // audit_log side effect for the mediastream adapter's fallback branch
    // (UB-C1 trigger b), exactly like today.
    expect(h.session.language).toBe('en');
    const auditIntents = fx
      .filter((f) => f.type === 'audit_log')
      .map((f) => (f.payload as { intentType?: string }).intentType);
    expect(auditIntents).toContain('language_switch');
  });
});

// ── create_customer (P18-001) ───────────────────────────────────────────────

describe('PR-B create_customer — gated by the (create_customer, surface) cell', () => {
  it('runs on a surface whose cell declares the P18-001 branch: already-matched caller consumed in one turn', async () => {
    expect(COVERAGE_TABLE.create_customer.gather.status).toBe('reachable');
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('create_customer', { displayName: 'Maria Alvarez' })),
      surface: 'gather',
    });

    const fx = await h.turn('new customer, Maria Alvarez');

    expect(ttsTexts(fx).join(' | ')).toContain('in our system already');
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(h.proposalRepo.create).not.toHaveBeenCalled();
  });

  it('gather-declared surface, unknown caller: mints the contract-shaped proposal in ONE turn (no FSM round-trip)', async () => {
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('create_customer', { displayName: 'Maria Alvarez' })),
      surface: 'gather',
      matchedCustomer: false,
      deps: { callerPhoneResolver: () => '+15125550199' },
    });

    const fx = await h.turn('new customer, Maria Alvarez');

    expect(h.proposalRepo.create).toHaveBeenCalledTimes(1);
    const stored = h.proposalRepo.create.mock.calls[0]![0] as {
      proposalType?: string;
      payload?: Record<string, unknown>;
    };
    expect(stored.proposalType).toBe('create_customer');
    expect(ttsTexts(fx)).toContain(CREATE_CUSTOMER_CONFIRMATION_TTS);
    // One-turn consume: no entity_resolution → intent_confirm round-trip.
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(
      h.auditRepo.getAll().find((e) => e.eventType === 'proposal.created'),
    ).toBeDefined();
  });

  it('cell served by a DIFFERENT module (media_streams: generic FSM path): the declared drift is preserved', async () => {
    const cell = COVERAGE_TABLE.create_customer.media_streams;
    expect(cell.status).toBe('reachable');
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('create_customer', { displayName: 'Maria Alvarez' })),
    });

    const fx = await h.turn('new customer, Maria Alvarez');

    // No P18-001 one-turn consume: the FSM advanced into the multi-turn
    // confirm funnel (entity_resolution → intent_confirm readback).
    expect(ttsTexts(fx).join(' | ')).not.toContain('in our system already');
    expect(h.session.machine.currentState).not.toBe('intent_capture');
    expect(h.proposalRepo.create).not.toHaveBeenCalled();
  });
});

// ── silence / low-STT ladder ────────────────────────────────────────────────

describe('PR-B silence/low-STT ladder — Gather semantics, own streak counter (NOT the FSM confidence_low cap, #965)', () => {
  it('gather-declared surface: first silent turn reprompts, no classifier call, no empty caller transcript line', async () => {
    expect(COVERAGE_TABLE.silence_low_stt_ladder.gather.status).toBe('reachable');
    const gateway = gatewayAlways(classifyJson('unknown'));
    const h = makeTurnHarness({ gateway, surface: 'gather' });

    const fx = await h.turn('');

    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(ttsTexts(fx)).toContain(renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'en'));
    expect(endSessionReasons(fx)).toHaveLength(0);
    expect(h.session.ended).toBe(false);
    // T2-F03/deriveCallOutcome: a no-speech timeout must NOT record an
    // empty `caller:` transcript line (Gather's guarded append, ported).
    const transcript = h.session.transcript as ReadonlyArray<{ speaker?: string; text?: string }>;
    expect(
      transcript.some((t) => t.speaker === 'caller' && (t.text ?? '').trim() === ''),
    ).toBe(false);
  });

  it('gather-declared surface: two consecutive silent turns escalate gracefully and end the session', async () => {
    const gateway = gatewayAlways(classifyJson('unknown'));
    const h = makeTurnHarness({ gateway, surface: 'gather' });

    await h.turn('');
    const fx2 = await h.turn('   ');

    expect((gateway.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(ttsTexts(fx2)).toContain(
      renderTtsText(SPEECH_TURN_FAILURE_ESCALATION_COPY, {}, 'en'),
    );
    expect(endSessionReasons(fx2)).toContain('low_stt_confidence_max_retries');
    expect(h.session.ended).toBe(true);
    expect(h.session.terminalOutcome).toBeDefined();
  });

  it('gather-declared surface: a spoken turn between silences resets the streak — third turn reprompts, not escalates', async () => {
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('unknown')),
      surface: 'gather',
    });

    await h.turn('');
    await h.turn('uh let me think');
    const fx3 = await h.turn('');

    expect(ttsTexts(fx3)).toContain(renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'en'));
    expect(endSessionReasons(fx3)).toHaveLength(0);
    expect(h.session.ended).toBe(false);
  });

  it('gather-declared surface: silence and a low-Confidence turn share ONE streak (terminates at combined 2)', async () => {
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('unknown')),
      surface: 'gather',
    });

    await h.turn('');
    // The transport-side entry for a NON-empty low-acoustic-confidence turn
    // (Twilio's Gather `Confidence` arrives with the webhook, outside the
    // SpeechTurnHandler contract) — same ladder, same streak.
    const fx2 = h.processor.maybeHandleLowSttConfidence(h.session, 0.3);

    expect(fx2).not.toBeNull();
    expect(ttsTexts(fx2!)).toContain(
      renderTtsText(SPEECH_TURN_FAILURE_ESCALATION_COPY, {}, 'en'),
    );
    expect(endSessionReasons(fx2!)).toContain('low_stt_confidence_max_retries');
    expect(h.session.ended).toBe(true);
  });

  it('gather-declared surface: high (or absent) confidence returns null and clears the streak', async () => {
    const h = makeTurnHarness({
      gateway: gatewayAlways(classifyJson('unknown')),
      surface: 'gather',
    });

    await h.turn('');
    expect(h.processor.maybeHandleLowSttConfidence(h.session, 0.95)).toBeNull();
    // The streak was cleared: the next silence is a fresh 1st strike.
    const fx = await h.turn('');
    expect(ttsTexts(fx)).toContain(renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'en'));
    expect(h.session.ended).toBe(false);
  });

  it('cell served by a DIFFERENT module (media_streams: adapter-side A3/T2-F05): the empty turn keeps today\'s confidence_low dispatch', async () => {
    const cell = COVERAGE_TABLE.silence_low_stt_ladder.media_streams;
    expect(cell.status).toBe('reachable');
    const h = makeTurnHarness({ gateway: gatewayAlways(classifyJson('unknown')) });

    const fx = await h.turn('');

    // The ported ladder did NOT fire (no reprompt copy, no ladder
    // end_session) — the FSM's confidence_low repair handled the turn,
    // exactly like main; the adapter owns silence handling on this surface.
    expect(ttsTexts(fx)).not.toContain(renderTtsText(LOW_STT_CONFIDENCE_REPROMPT_COPY, {}, 'en'));
    expect(endSessionReasons(fx)).not.toContain('low_stt_confidence_max_retries');
    expect(h.session.ended).toBe(false);
    // …and the transport-side confidence entry stays closed on this surface.
    expect(h.processor.maybeHandleLowSttConfidence(h.session, 0.1)).toBeNull();
  });
});
