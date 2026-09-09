/**
 * The hermetic driver for the CHAT surfaces of the in-app 50-case register.
 *
 * The voice driver next door (`runner.ts`) drives `InAppVoiceAdapter` — the
 * live-voice session panel. It is NOT the surface an operator types on. The
 * web assistant page (`packages/web/src/components/assistant/AssistantPage.tsx`)
 * posts BOTH typed input and mic transcripts to `POST /api/assistant/chat`,
 * tagging the latter `inputMode: 'voice'`. That route runs the SAME intent
 * classifier, drafts through the SAME `buildTaskHandlers` registry, resolves
 * references through the SAME entity resolver and the gated-reference
 * ONE-question loop, answers lookups through the SAME `dispatchAssistantLookup`
 * and fires the SAME en-route act — and none of it was covered by a green
 * voice run.
 *
 * So this module stands up the REAL express router (`createAssistantRouter`)
 * over the SAME `World` repos the voice driver uses, wired the way `app.ts`
 * wires it, and drives each case's turns as sequential HTTP requests sharing
 * ONE `conversationId` — because the gated-reference follow-up and every
 * conversation-scoped resolution key on exactly that.
 *
 * Two seams, the same two the voice driver has: the LLM gateway (scripted per
 * case) and the entity resolver (`FixtureEntityResolver`, Postgres-free).
 * Everything between the HTTP boundary and the proposal row is shipped code.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type NextFunction, type Request, type Response } from 'express';

import type { AuthenticatedRequest } from '../../../auth/clerk';
import { InMemoryConversationRepository } from '../../../conversations/conversation-service';
import { missingFieldsFor } from '../../../proposals/proposal';
import { createAssistantRouter } from '../../../routes/assistant';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../gateway/gateway';
import {
  inputModeFor,
  llmForSurface,
  turnsForSurface,
  type RegisterCase,
  type ScriptedLlmTurn,
  type Surface,
} from './register';
import { scriptedGateway } from './runner';
import {
  proposalContractViolation,
  type ChatCaseEvidence,
  type ChatTurnEvidence,
  type ProposalEvidence,
} from './score';
import type { World } from './world';

/** Hard cap on turns, matching the voice driver's runaway guard. */
export const MAX_CHAT_TURNS_PER_CASE = 6;

/**
 * The narrative half of the scripted model.
 *
 * `content`/`reasoning` are what the route's GENERIC-LLM fallback path parses
 * (`assistantReplySchema`) on a turn no handler, lookup or act claimed. It must
 * (a) claim NOTHING — `detectFabricatedActionClaim` correctly rejects a reply
 * that says an action happened, and a harness that trips that guard would be
 * measuring its own fixture — and (b) contain no word any case's
 * `spokenMatches` looks for, so "the LLM said something vague" can never be
 * mistaken for "the surface answered".
 */
export const GENERIC_LLM_REPLY = {
  content: 'Tell me a bit more about what you need and I will take it from there.',
  reasoning: 'Generic assistant reply (no intent handler claimed this turn).',
};

/**
 * The DRAFTING model's output for a chat turn.
 *
 * Chat draws a second LLM call the voice path does not make: every AI task
 * handler (`ai/tasks/*`) asks a model to turn the operator's sentence into a
 * draft payload, where voice assembles the same payload deterministically in
 * `proposals/voice-payload.ts` from the classifier's extracted entities. To
 * compare the two surfaces at all, the drafting model has to be handed the
 * SAME raw material the voice payload builder gets — otherwise every chat case
 * would "fail" for the trivial reason that the harness's model said nothing,
 * and the register would be measuring its own fixture instead of the pipeline.
 *
 * So the stand-in is a FAITHFUL, NON-INVENTING model: it echoes the
 * classifier's extracted entities and applies exactly ONE normalization —
 * `lineItemDescriptions` → `lineItems`, which is verbatim what
 * `buildVoiceProposalPayload` does with the same field before handing them to
 * the catalog grounding (voice-payload.ts, "Line items (injected grounding)").
 * Prices are deliberately NOT invented: the handlers' own catalog resolver
 * grounds them, which is the behavior under test.
 *
 * Everything a handler needs beyond that — a verified customerId, a jobId, an
 * estimateId — is the PIPELINE's job to resolve, never the model's (see
 * create-appointment-task.ts's own note that "a drafting leg that depends on a
 * model repeating a UUID is not resolution"). This model repeats no uuid, so a
 * case that only passes because the model echoed one cannot exist here.
 */
export function draftingEcho(entry: ScriptedLlmTurn | undefined): Record<string, unknown> {
  const entities = (entry?.extractedEntities ?? {}) as Record<string, unknown>;
  const descriptions = Array.isArray(entities.lineItemDescriptions)
    ? entities.lineItemDescriptions.filter(
        (d): d is string => typeof d === 'string' && d.trim().length > 0,
      )
    : [];
  return {
    ...entities,
    ...(descriptions.length > 0
      ? { lineItems: descriptions.map((description) => ({ description, quantity: 1 })) }
      : {}),
    ...GENERIC_LLM_REPLY,
  };
}

/**
 * The case's scripted classifier, plus the drafting/narrative stand-in above.
 *
 * The chat route calls the gateway at least TWICE on a drafting turn — once to
 * classify, once inside the task handler. Feeding the second call from the
 * classifier script would consume a later turn's entry and silently misalign
 * the whole case, so the two are told apart by `taskType` (`classify_intent` is
 * the classifier's own, see ai/orchestration/intent-classifier.ts) and only the
 * classifier reads the script.
 */
export function chatScriptedGateway(script: readonly ScriptedLlmTurn[]): LLMGateway {
  let lastServed: ScriptedLlmTurn | undefined;
  const classifier = scriptedGateway(script, {
    onServe: (entry) => {
      lastServed = entry;
    },
  });
  return {
    complete: async (request: LLMRequest): Promise<LLMResponse> => {
      if (request.taskType === 'classify_intent') return classifier.complete(request);
      return {
        content: JSON.stringify(draftingEcho(lastServed)),
        model: 'scripted-drafting',
        provider: 'inapp-50-harness',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 0,
      };
    },
  } as unknown as LLMGateway;
}

/** A listening express app plus the handle that shuts it down. */
export interface ChatApp {
  url: string;
  close: () => Promise<void>;
}

/**
 * Stand up the assistant router over the world's repos.
 *
 * Deliberately mirrors `app.ts` (~5484) field for field, substituting the
 * in-memory equivalent of each production repo. Anything app.ts wires that has
 * no in-memory implementation (standing instructions, dunning events, the
 * vertical prompt pack) is simply absent — every one of those deps is optional
 * and failure-soft by contract, so its absence is the documented degradation,
 * not a harness-invented one.
 *
 * The auth shim is the one in `test/routes/assistant.route.test.ts#buildApp`:
 * an owner-role `req.auth` for the world's tenant and signed-in operator.
 * `requireAuth`/`requireTenant`/`requirePermission('ai:run')` then run for
 * real over it.
 */
export async function startChatApp(
  world: World,
  gateway: LLMGateway,
): Promise<ChatApp> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: world.ownerUserId,
      sessionId: 'inapp-50-harness',
      tenantId: world.tenantId,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({
      gateway,
      proposalRepo: world.proposalRepo,
      invoiceRepo: world.invoiceRepo,
      estimateRepo: world.estimateRepo,
      catalogRepo: world.catalogRepo,
      appointmentRepo: world.appointmentRepo,
      jobRepo: world.jobRepo,
      customerRepo: world.customerRepo,
      locationRepo: world.locationRepo,
      conversationRepo: new InMemoryConversationRepository(),
      auditRepo: world.auditRepo,
      entityResolver: world.entityResolver,
      tenantTimezoneResolver: async () => world.timezone,
      lookups: world.lookups,
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
    }),
  );

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface ChatReplyBody {
  taskType?: string;
  model?: string;
  degraded?: boolean;
  fallbackStage?: string;
  /** `AssistantLookupReply.outcome` — answered / empty / not_found / … */
  outcome?: string;
  conversationId?: string;
  message?: {
    content?: string;
    proposal?: {
      id?: string;
      type?: string;
      status?: string;
      missingFields?: string[];
    } | null;
  };
}

/**
 * Does this reply ask THE ONE gated question?
 *
 * Two shapes, both from `ai/resolution/gated-reference-resolution.ts`:
 *   1. a card whose gate is still up (`missingFields`) whose text asks
 *      something — the post-draft ambiguity question,
 *   2. a which-one line with no card at all — the shared
 *      `ambiguousReferenceLine` a lookup answers with.
 * Only then does the driver spend the case's `disambiguationFollowUp`: sending
 * it at any other reply would be the harness answering a question nobody asked.
 */
export function asksGatedQuestion(body: ChatReplyBody): boolean {
  const content = body.message?.content ?? '';
  const whichOne = /more than one|which one|which (?:of|[A-Z])|did you mean|reply with/i.test(
    content,
  );
  const gated = (body.message?.proposal?.missingFields ?? []).length > 0;
  return whichOne || (gated && content.includes('?'));
}

async function postTurn(
  app: ChatApp,
  body: Record<string, unknown>,
): Promise<{ status: number; body: ChatReplyBody }> {
  const res = await fetch(`${app.url}/api/assistant/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: ChatReplyBody = {};
  try {
    parsed = (await res.json()) as ChatReplyBody;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
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

/**
 * Drive ONE case over `POST /api/assistant/chat`.
 *
 * All turns share one `conversationId` — the gated-reference loop, the
 * "issue the one we just drafted" resolution and every other
 * conversation-scoped rung key on it, and a driver that minted a fresh id per
 * turn would be testing a conversation nobody can have.
 *
 * There is NO readback in chat, so the voice driver's auto-confirm ladder
 * ("yes" until the FSM commits) is deliberately absent: a chat proposal is
 * committed by a screen tap, not by a spoken yes. The ONE follow-up the driver
 * will send is the case's `disambiguationFollowUp`, and only when the reply
 * actually asked for it.
 */
export async function driveChatCase(
  c: RegisterCase,
  world: World,
  surface: Surface,
): Promise<ChatCaseEvidence> {
  const app = await startChatApp(world, chatScriptedGateway(llmForSurface(c, surface)));
  const inputMode = inputModeFor(surface);
  const conversationId = `inapp50-${c.key}-${surface}`;
  const turns: ChatTurnEvidence[] = [];
  const replies: string[] = [];
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let clarificationTurnSent = false;

  try {
    const queue = turnsForSurface(c, surface).map((text) => ({
      text,
      clarificationFollowUp: false,
    }));
    let index = 0;

    while (queue.length > 0 && index < MAX_CHAT_TURNS_PER_CASE) {
      const next = queue.shift()!;
      index += 1;
      history.push({ role: 'user', content: next.text });

      let status = 0;
      let body: ChatReplyBody = {};
      try {
        ({ status, body } = await postTurn(app, {
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          conversationId,
          inputMode,
        }));
      } catch (err) {
        turns.push({
          index,
          text: next.text,
          inputMode,
          httpStatus: 0,
          content: '',
          proposalIds: [],
          error: err instanceof Error ? err.message : String(err),
          ...(next.clarificationFollowUp ? { clarificationFollowUp: true } : {}),
        });
        break;
      }

      const content = body.message?.content ?? '';
      const card = body.message?.proposal ?? undefined;
      const rows = await world.proposalRepo.findByTenant(world.tenantId);
      turns.push({
        index,
        text: next.text,
        inputMode,
        httpStatus: status,
        content,
        ...(body.taskType ? { taskType: body.taskType } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.degraded ? { degraded: true } : {}),
        ...(body.fallbackStage ? { fallbackStage: body.fallbackStage } : {}),
        ...(body.outcome ? { lookupOutcome: body.outcome } : {}),
        ...(card
          ? {
              card: {
                ...(card.id ? { id: card.id } : {}),
                ...(card.type ? { type: card.type } : {}),
                ...(card.status ? { status: card.status } : {}),
                ...(card.missingFields ? { missingFields: [...card.missingFields] } : {}),
              },
            }
          : {}),
        proposalIds: rows.map((p) => p.id),
        ...(next.clarificationFollowUp ? { clarificationFollowUp: true } : {}),
      });
      replies.push(content);
      history.push({ role: 'assistant', content });

      // ONE clarification answer, and only in answer to a real question.
      if (
        queue.length === 0 &&
        !clarificationTurnSent &&
        c.disambiguationFollowUp &&
        asksGatedQuestion(body)
      ) {
        clarificationTurnSent = true;
        queue.push({ text: c.disambiguationFollowUp, clarificationFollowUp: true });
      }
    }
  } finally {
    await app.close();
  }

  return {
    turns,
    proposals: await collectProposals(world),
    replies,
    auditEvents: world.auditRepo.getAll().map((event) => event.eventType),
    clarificationTurnSent,
  };
}
