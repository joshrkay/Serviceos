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
import type { Register, RegisterCase, ScriptedLlmTurn, Surface } from './register';
import { SURFACES, expectForSurface, isChatSurface, skipReasonForSurface, turnsFor } from './register';
import { buildWorld, type World } from './world';
import {
  deriveChatStage,
  deriveStage,
  isChatIntentCaptureOnly,
  isIntentCaptureOnly,
  proposalContractViolation,
  scoreCase,
  scoreChatCase,
  type CaseEvidence,
  type ChatCaseEvidence,
  type ChatTurnEvidence,
  type ProposalEvidence,
  type RootCause,
  type Stage,
  type TurnEvidence,
  type Verdict,
} from './score';
import { driveChatCase } from './chat-driver';
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
  /**
   * Which entry point produced this row. Present on every case so a run
   * artifact carries voice AND chat side by side and the two can never be
   * mistaken for each other in the dashboard, the triage report or the gate.
   */
  surface: Surface;
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
  /** Voice surfaces carry FSM turns; chat surfaces carry HTTP round trips. */
  turns: TurnEvidence[] | ChatTurnEvidence[];
  proposals: ProposalEvidence[];
  durationMs: number;
}

export interface RunOptions {
  /** Injected clock for world seeding (the adapter itself has no clock seam). */
  now?: Date;
  timeoutMs?: number;
  /** Batch index (1..5) recorded on the artifact; null for a full run. */
  batch?: number | null;
  /** Surfaces to drive; defaults to all three. */
  surfaces?: readonly Surface[];
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
export interface ScriptedGatewayOptions {
  /**
   * Called with each entry as it is served. The chat driver uses this to give
   * the drafting LLM call (a SECOND gateway call the voice path does not make)
   * the same extracted entities the classifier just produced — see
   * `chat-driver.ts#chatScriptedGateway`.
   */
  onServe?: (entry: ScriptedLlmTurn) => void;
}

export function scriptedGateway(
  script: readonly ScriptedLlmTurn[],
  options: ScriptedGatewayOptions = {},
): LLMGateway {
  const consumed = new Set<number>();
  const matchesKey = (entry: ScriptedLlmTurn, needle: string): boolean =>
    typeof entry.for === 'string' && needle.includes(entry.for.toLowerCase());
  const pick = (userText: string): number => {
    const needle = userText.toLowerCase();
    const keyed = script.findIndex((entry, i) => !consumed.has(i) && matchesKey(entry, needle));
    if (keyed >= 0) return keyed;
    // A keyed entry that is already CONSUMED still answers its own utterance.
    // The real classifier is a function of the text: the same sentence sent
    // twice classifies the same way twice. Falling through to the
    // repeat-the-last-entry rule instead let a DOUBLE-SUBMIT case pass for
    // the wrong reason — the second identical booking was answered with the
    // NEXT case's 'confirm' entry, so the route never even tried to draft a
    // second proposal and the harness scored "one proposal" as a de-dup the
    // product does not perform.
    const reused = script.findIndex((entry) => matchesKey(entry, needle));
    if (reused >= 0) return reused;
    const positional = script.findIndex((entry, i) => !consumed.has(i) && entry.for === undefined);
    if (positional >= 0) return positional;
    return -1;
  };
  return {
    complete: async (request: LLMRequest): Promise<LLMResponse> => {
      const index = pick(classifyUserText(request));
      const entry = index >= 0 ? script[index] : script[script.length - 1];
      if (index >= 0) consumed.add(index);
      options.onServe?.(entry);
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

/**
 * Run ONE case on ONE surface: fresh world, fresh driver, scored.
 *
 * The world is rebuilt per case×surface on purpose — a chat run must not see
 * the proposals a voice run just minted, or `proposalCount` would count the
 * other surface's work.
 */
export async function runCase(
  c: RegisterCase,
  register: Register,
  opts: RunOptions & { surface?: Surface } = {},
): Promise<CaseResult> {
  const surface: Surface = opts.surface ?? 'voice';
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? CASE_TIMEOUT_MS;
  const scoreOptions = { timezone: register.harnessSeeds.tenantTimezone };
  let world: World | undefined;

  const base = {
    id: c.id,
    key: c.key,
    surface,
    cluster: c.cluster,
    severity: c.severity,
    op: c.op,
    intent: c.intent,
  };

  if (isChatSurface(surface)) {
    let evidence: ChatCaseEvidence;
    try {
      world = await buildWorld(register, opts.now);
      evidence = await withTimeout(
        driveChatCase(c, world, surface),
        timeoutMs,
        (message) => chatTimeoutEvidence(message),
        `case '${c.key}' on ${surface} exceeded ${timeoutMs}ms`,
      );
    } catch (err) {
      evidence = {
        turns: [],
        proposals: [],
        replies: [],
        auditEvents: [],
        error: err instanceof Error ? err.message : String(err),
        clarificationTurnSent: false,
      };
    }
    const expect = expectForSurface(c, surface);
    const score = scoreChatCase(c, expect, evidence, world?.fixtureIds ?? {}, scoreOptions);
    const stage = score.stage ?? deriveChatStage(evidence);
    return {
      ...base,
      verdict: score.verdict,
      reason: score.reason,
      stage,
      rootCause: score.rootCause,
      intentCaptureOnly: isChatIntentCaptureOnly(stage, evidence),
      failures: score.failures,
      turns: evidence.turns,
      proposals: evidence.proposals,
      durationMs: Date.now() - startedAt,
    };
  }

  let evidence: CaseEvidence;
  try {
    world = await buildWorld(register, opts.now);
    const w = world;
    evidence = await withTimeout(
      driveCase(c, w),
      timeoutMs,
      timeoutEvidence,
      `case '${c.key}' exceeded ${timeoutMs}ms`,
    );
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

  const score = scoreCase(c, evidence, world?.fixtureIds ?? {}, scoreOptions);
  const stage = score.stage ?? deriveStage(evidence.turns, evidence.proposals);

  return {
    ...base,
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

/** Race `work` against the per-case budget; a hang is a FAIL, not a hung CI. */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: (message: string) => T,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function chatTimeoutEvidence(message: string): ChatCaseEvidence {
  return {
    turns: [],
    proposals: [],
    replies: [],
    auditEvents: [],
    error: message,
    timedOut: true,
    clarificationTurnSent: false,
  };
}

/**
 * Run a set of cases on every requested surface and assemble the run artifact.
 *
 * Cases run SEQUENTIALLY — each one owns a whole world (and, on chat, a whole
 * listening express app) — and surfaces are the OUTER loop so the console
 * scoreboard reads surface by surface. A case the register skips on a surface
 * (`chat.skip`) produces no row at all rather than a fake PASS; the gate's
 * expected count for that surface is reduced to match.
 */
export async function runRegister(
  register: Register,
  opts: RunOptions & { cases?: readonly RegisterCase[] } = {},
): Promise<RunResult> {
  const cases = opts.cases ?? register.cases;
  const surfaces = opts.surfaces ?? SURFACES;
  const startedAt = new Date();
  const results: CaseResult[] = [];
  for (const surface of surfaces) {
    for (const c of cases) {
      if (skipReasonForSurface(c, surface) !== undefined) continue;
      results.push(await runCase(c, register, { ...opts, surface }));
    }
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
