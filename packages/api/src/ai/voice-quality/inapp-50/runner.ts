/**
 * The hermetic driver for the in-app 50-case register.
 *
 * One fresh `World` + one fresh `InAppVoiceAdapter` per case, wired the way
 * `app.ts` wires the live `/api/voice/sessions` adapter, with EXACTLY one
 * substitution: the LLM gateway replays `case.llm[i]` instead of calling a
 * provider. Everything downstream of the classifier — `transitions.ts`,
 * `resolveSchedulingEntities`, `buildVoiceProposalPayload`, the proposal
 * repository, the lookup dispatch — is the shipped code.
 *
 * That is the whole design: a green run means the REAL pipeline booked the
 * REAL fixture, not that a mock agreed with a mock.
 */
import { InAppVoiceAdapter } from '../../agents/customer-calling/inapp-adapter';
import type { InAppAdapterDeps } from '../../agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../agents/customer-calling/voice-session-store';
import type { VoiceSessionEvent } from '../../agents/customer-calling/voice-session-store';
import type { SideEffect } from '../../agents/customer-calling/types';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../gateway/gateway';
import { missingFieldsFor } from '../../../proposals/proposal';
import type { Register, RegisterCase, ScriptedLlmTurn } from './register';
import { turnsFor } from './register';
import { buildWorld, type World } from './world';
import {
  deriveStage,
  isIntentCaptureOnly,
  proposalContractViolation,
  scoreCase,
  type CaseEvidence,
  type ProposalEvidence,
  type RootCause,
  type Stage,
  type TurnEvidence,
  type Verdict,
} from './score';
import { buildRunResult, type RunResult } from './report';

/** Hard cap from the plan's turn driver — a case may never run away. */
export const MAX_TURNS_PER_CASE = 6;
/** Per-case wall-clock budget. A hang is a FAIL, not a hung CI job. */
export const CASE_TIMEOUT_MS = 10_000;
/** Disambiguation follow-ups the driver will send (mirrors the live probe). */
const MAX_DISAMBIGUATION_TURNS = 2;

export interface CaseResult {
  id: number;
  key: string;
  cluster: string;
  severity: RegisterCase['severity'];
  op: string;
  intent: string;
  verdict: Verdict;
  reason: string;
  stage: Stage;
  rootCause: RootCause | null;
  /** True ⇒ understood the request and produced nothing actionable. */
  intentCaptureOnly: boolean;
  failures: string[];
  turns: TurnEvidence[];
  proposals: ProposalEvidence[];
  durationMs: number;
}

export interface RunOptions {
  /** Injected clock for world seeding (the adapter itself has no clock seam). */
  now?: Date;
  timeoutMs?: number;
  /** Batch index (1..5) recorded on the artifact; null for a full run. */
  batch?: number | null;
}

/** The utterance a classify call is about: the LAST user message it carries. */
export function classifyUserText(request: Pick<LLMRequest, 'messages'>): string {
  const messages = request.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content ?? '';
  }
  return '';
}

/**
 * The scripted classifier.
 *
 * KEYED, then positional. For each `complete()` call:
 *   1. the first UNCONSUMED entry whose `for` is a case-insensitive substring
 *      of the call's user text,
 *   2. else the first UNCONSUMED entry with no `for` (pure positional — the
 *      original behavior),
 *   3. else the last entry, repeated.
 *
 * Purely positional scripting silently misaligns whenever a deterministic
 * pre-classifier answers a turn without calling the LLM: `book-05`'s first
 * turn ("Book a service visit") is handled by the new-booking phrase matcher,
 * so turn 2 consumed turn 1's empty-entity entry and the booking lost every
 * slot it had just been given. `for` pins an entry to its utterance; a
 * register with no `for` anywhere behaves exactly as before.
 */
export function scriptedGateway(script: readonly ScriptedLlmTurn[]): LLMGateway {
  const consumed = new Set<number>();
  const pick = (userText: string): number => {
    const needle = userText.toLowerCase();
    const keyed = script.findIndex(
      (entry, i) =>
        !consumed.has(i) &&
        typeof entry.for === 'string' &&
        needle.includes(entry.for.toLowerCase()),
    );
    if (keyed >= 0) return keyed;
    const positional = script.findIndex((entry, i) => !consumed.has(i) && entry.for === undefined);
    if (positional >= 0) return positional;
    return -1;
  };
  return {
    complete: async (request: LLMRequest): Promise<LLMResponse> => {
      const index = pick(classifyUserText(request));
      const entry = index >= 0 ? script[index] : script[script.length - 1];
      if (index >= 0) consumed.add(index);
      return {
        content: JSON.stringify(entry),
        model: 'scripted',
        provider: 'inapp-50-harness',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 0,
      };
    },
  } as unknown as LLMGateway;
}

function auditEventTypes(sideEffects: readonly SideEffect[]): string[] {
  return sideEffects
    .filter((fx) => fx.type === 'audit_log')
    .map((fx) => fx.payload.eventType)
    .filter((e): e is string => typeof e === 'string');
}

function spokenFrom(sideEffects: readonly SideEffect[]): string[] {
  return sideEffects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => fx.payload.text)
    .filter((t): t is string => typeof t === 'string');
}

/**
 * Build the adapter the way `app.ts` builds the live one.
 *
 * `lookups` is the SAME `AssistantLookupDeps` bundle the assistant-chat router
 * and the live phone are wired with (assembled in `world.ts` from the same
 * in-memory repos), so a `lookup_*` intent here takes the shipped shared
 * dispatch, not a harness-local answer.
 */
export function buildAdapter(world: World, script: readonly ScriptedLlmTurn[]): {
  adapter: InAppVoiceAdapter;
  store: VoiceSessionStore;
} {
  const store = new VoiceSessionStore({ startInterval: false });
  const deps: InAppAdapterDeps = {
    store,
    gateway: scriptedGateway(script),
    proposalRepo: world.proposalRepo,
    auditRepo: world.auditRepo,
    onCallRepo: world.onCallRepo,
    settingsRepo: world.settingsRepo,
    customerRepo: world.customerRepo,
    catalogRepo: world.catalogRepo,
    entityResolver: world.entityResolver,
    extendedIntentsEnabled: async () => true,
    lookups: world.lookups,
    // SCH-D4 — the same object set app.ts hands the adapter, so "on my way"
    // fires the shared audited act here too instead of reporting a wiring gap
    // the harness itself created.
    enRoute: {
      userRepo: world.userRepo,
      assignmentRepo: world.assignmentRepo,
      appointmentRepo: world.appointmentRepo,
      jobRepo: world.jobRepo,
      customerRepo: world.customerRepo,
      settingsRepo: world.settingsRepo,
      auditRepo: world.auditRepo,
      enRouteCoordinator: {
        enqueueEnRouteNotice: async (input) => {
          world.enRouteNotices.push({
            appointmentId: input.appointmentId,
            ...(input.technicianName ? { technicianName: input.technicianName } : {}),
          });
          return `en-route:${input.appointmentId}`;
        },
      },
    },
  };
  return { adapter: new InAppVoiceAdapter(deps), store };
}

interface DrivenTurn {
  text: string;
  clarificationFollowUp?: boolean;
}

/** Collect the evidence for one case by driving the real adapter. */
async function driveCase(
  c: RegisterCase,
  world: World,
): Promise<CaseEvidence> {
  const { adapter, store } = buildAdapter(world, c.llm);
  const turns: TurnEvidence[] = [];
  const spokenLines: string[] = [];
  let clarificationTurnSent = false;
  let finalState = 'idle';

  try {
    const started = await adapter.startSession(
      world.tenantId,
      world.ownerUserId,
      undefined,
      'owner',
    );
    finalState = started.state;

    // Session bus — `intent_classified` / `lookup_executed` are the two
    // signals the stage table reads that side effects don't carry.
    const busBuffer: VoiceSessionEvent[] = [];
    const session = store.peek(started.sessionId);
    session?.events.on('voice-event', (event: VoiceSessionEvent) => {
      busBuffer.push(event);
    });

    const scripted = turnsFor(c);
    const queue: DrivenTurn[] = scripted.map((text) => ({ text }));
    let disambiguationTurns = 0;
    let index = 0;

    while (queue.length > 0 && index < MAX_TURNS_PER_CASE) {
      const next = queue.shift()!;
      index += 1;
      const stateBefore = store.peek(started.sessionId)?.machine.currentState ?? finalState;
      busBuffer.length = 0;

      let evidence: TurnEvidence;
      try {
        const result = await adapter.handleInput(started.sessionId, next.text);
        const classified = busBuffer.find(
          (e): e is Extract<VoiceSessionEvent, { type: 'intent_classified' }> =>
            e.type === 'intent_classified',
        );
        evidence = {
          index,
          text: next.text,
          stateBefore,
          stateAfter: result.state,
          ...(result.ttsText !== undefined ? { ttsText: result.ttsText } : {}),
          sideEffectTypes: result.sideEffects.map((fx) => fx.type),
          auditEventTypes: auditEventTypes(result.sideEffects),
          proposalIds: [...result.proposalIds],
          busEventTypes: busBuffer.map((e) => e.type),
          ...(classified ? { classifiedIntent: classified.intentType } : {}),
          ...(classified ? { classifiedConfidence: classified.confidence } : {}),
          // R1 instrumentation, read opportunistically so the harness starts
          // recording it the moment the adapter returns one.
          ...(typeof (result as { trace?: unknown }).trace === 'object' &&
          (result as { trace?: unknown }).trace !== null
            ? { trace: (result as unknown as { trace: Record<string, unknown> }).trace }
            : {}),
          ...(next.clarificationFollowUp ? { clarificationFollowUp: true } : {}),
        };
        spokenLines.push(...spokenFrom(result.sideEffects));
        if (result.ttsText && !spokenFrom(result.sideEffects).includes(result.ttsText)) {
          spokenLines.push(result.ttsText);
        }
        finalState = result.state;
        turns.push(evidence);
        if (result.ended) break;
      } catch (err) {
        turns.push({
          index,
          text: next.text,
          stateBefore,
          stateAfter: stateBefore,
          sideEffectTypes: [],
          auditEventTypes: [],
          proposalIds: [],
          busEventTypes: [],
          error: err instanceof Error ? err.message : String(err),
          ...(next.clarificationFollowUp ? { clarificationFollowUp: true } : {}),
        });
        break;
      }

      // ── Auto-driver: disambiguation → entity confirm → intent confirm ──
      if (queue.length > 0 || c.autoConfirm === false) continue;
      const state = finalState;
      if (
        state === 'entity_resolution' &&
        c.disambiguationFollowUp &&
        disambiguationTurns < MAX_DISAMBIGUATION_TURNS
      ) {
        disambiguationTurns += 1;
        clarificationTurnSent = true;
        queue.push({ text: c.disambiguationFollowUp, clarificationFollowUp: true });
      } else if (state === 'entity_confirm' || state === 'intent_confirm') {
        queue.push({ text: 'yes' });
      }
    }
  } finally {
    store.dispose();
  }

  const proposals = await collectProposals(world);
  return {
    turns,
    proposals,
    spokenLines,
    auditEvents: world.auditRepo.getAll().map((event) => event.eventType),
    finalState,
    clarificationTurnSent,
  };
}

async function collectProposals(world: World): Promise<ProposalEvidence[]> {
  const rows = await world.proposalRepo.findByTenant(world.tenantId);
  return rows.map((p) => {
    const violation = proposalContractViolation(p);
    return {
      id: p.id,
      proposalType: p.proposalType,
      status: p.status,
      missingFields: missingFieldsFor(p),
      payload: p.payload,
      ...(violation ? { contractViolation: violation } : {}),
    };
  });
}

function timeoutEvidence(message: string): CaseEvidence {
  return {
    turns: [],
    proposals: [],
    spokenLines: [],
    auditEvents: [],
    finalState: 'unknown',
    error: message,
    timedOut: true,
    clarificationTurnSent: false,
  };
}

/** Run ONE case end to end: fresh world, fresh adapter, scored. */
export async function runCase(
  c: RegisterCase,
  register: Register,
  opts: RunOptions = {},
): Promise<CaseResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? CASE_TIMEOUT_MS;
  let world: World | undefined;
  let evidence: CaseEvidence;

  try {
    world = await buildWorld(register, opts.now);
    const w = world;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<CaseEvidence>((resolve) => {
      timer = setTimeout(
        () => resolve(timeoutEvidence(`case '${c.key}' exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      evidence = await Promise.race([driveCase(c, w), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    evidence = {
      turns: [],
      proposals: [],
      spokenLines: [],
      auditEvents: [],
      finalState: 'unknown',
      error: err instanceof Error ? `${err.message}` : String(err),
      clarificationTurnSent: false,
    };
  }

  const fixtureIds = world?.fixtureIds ?? {};
  const score = scoreCase(c, evidence, fixtureIds, {
    timezone: register.harnessSeeds.tenantTimezone,
  });
  const stage = score.stage ?? deriveStage(evidence.turns, evidence.proposals);

  return {
    id: c.id,
    key: c.key,
    cluster: c.cluster,
    severity: c.severity,
    op: c.op,
    intent: c.intent,
    verdict: score.verdict,
    reason: score.reason,
    stage,
    rootCause: score.rootCause,
    intentCaptureOnly: isIntentCaptureOnly(stage, evidence),
    failures: score.failures,
    turns: evidence.turns,
    proposals: evidence.proposals,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Run a set of cases (default: the whole register) and assemble the run
 * artifact. Cases run SEQUENTIALLY — each one owns a whole world, and a
 * deterministic order keeps the artifact diffable run to run.
 */
export async function runRegister(
  register: Register,
  opts: RunOptions & { cases?: readonly RegisterCase[] } = {},
): Promise<RunResult> {
  const cases = opts.cases ?? register.cases;
  const startedAt = new Date();
  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(await runCase(c, register, opts));
  }
  return buildRunResult(register, results, {
    startedAt,
    finishedAt: new Date(),
    batch:
      opts.batch === undefined || opts.batch === null
        ? null
        : { index: opts.batch, size: 10 },
  });
}
