/**
 * Onboarding conversation orchestrator.
 *
 * Drives the multi-turn FSM at `src/ai/agents/onboarding/`. Per user
 * turn: load session → dispatch user_turn → execute side effects
 * (extractor calls go through the LLM gateway; proposal emission goes
 * through the existing single-shot orchestrator) → persist session →
 * return assistant message.
 *
 * The FSM is pure and channel-agnostic; this orchestrator is the only
 * place that touches infrastructure (gateway, repos, audit, proposal
 * emission).
 */
import { v4 as uuidv4 } from 'uuid';
import { LLMGateway } from '../gateway/gateway';
import {
  AuditRepository,
  createAuditEvent,
} from '../../audit/audit';
import {
  OnboardingSessionRepository,
  type OnboardingSession,
} from '../../db/onboarding-session-repository';
import { ProposalRepository, createProposal, CreateProposalInput } from '../../proposals/proposal';
import { createTenantSettingsProposal } from '../tasks/onboarding/tenant-settings-proposer';
import { assembleEstimateTemplates } from '../tasks/onboarding/template-assembler';
import { transition, STATE_OPENING_PROMPT } from '../agents/onboarding/transitions';
import type {
  OnboardingState,
  OnboardingEvent,
  OnboardingContext,
  ExtractionState,
  ExtractionResultPayload,
  SideEffect,
  TranscriptTurn,
} from '../agents/onboarding/types';
import { BusinessProfileExtractor } from '../tasks/onboarding/business-profile-extractor';
import { CategoryExtractor } from '../tasks/onboarding/category-extractor';
import { PricingExtractor } from '../tasks/onboarding/pricing-extractor';
import { TeamExtractor } from '../tasks/onboarding/team-extractor';
import { ScheduleExtractor } from '../tasks/onboarding/schedule-extractor';
import type {
  ExtractionContext,
  OnboardingExtraction,
  OnboardingServiceCategoryPayload,
  OnboardingTeamMemberPayload,
  OnboardingSchedulePayload,
} from '../tasks/onboarding/types';

const SYSTEM_ACTOR = 'system:onboarding_conversation';

export interface OnboardingConversationDeps {
  gateway: LLMGateway;
  sessionRepo: OnboardingSessionRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface TurnRequest {
  tenantId: string;
  userId: string;
  /** When undefined, a new session is created. */
  sessionId?: string;
  /** User utterance. Optional only when starting a new session — the
   *  caller may want the opening prompt before any text is entered. */
  userMessage?: string;
}

export interface TurnResponse {
  sessionId: string;
  assistantMessage: string;
  state: OnboardingState;
  turnCount: number;
  /** True once the FSM has reached `completed` or `capped`. */
  completed: boolean;
  /** Proposal IDs emitted on terminal transitions. Empty until then. */
  proposalIds: string[];
}

export class OnboardingConversationOrchestrator {
  constructor(private readonly deps: OnboardingConversationDeps) {}

  async turn(req: TurnRequest): Promise<TurnResponse> {
    const now = this.deps.now ?? (() => new Date());

    // 1. Load or create session.
    let session: OnboardingSession;
    if (req.sessionId) {
      const loaded = await this.deps.sessionRepo.findById(req.tenantId, req.sessionId);
      if (!loaded) {
        // RLS-friendly: from the API caller's perspective a session
        // belonging to another tenant simply "doesn't exist."
        throw new Error('ONBOARDING_SESSION_NOT_FOUND');
      }
      session = loaded;
    } else {
      session = await this.deps.sessionRepo.create(req.tenantId);
      // First contact — surface the opening prompt for profile_capture
      // unless the user already provided text.
      if (!req.userMessage) {
        const opening = STATE_OPENING_PROMPT.profile_capture;
        await this.persistAssistantTurn(session, opening, now());
        return {
          sessionId: session.id,
          assistantMessage: opening,
          state: session.fsmState,
          turnCount: session.turnCount,
          completed: false,
          proposalIds: [],
        };
      }
    }

    // 2. Terminal sessions short-circuit.
    if (session.fsmState === 'completed' || session.fsmState === 'capped') {
      return this.terminalResponse(session);
    }

    if (!req.userMessage) {
      // Resumed session with no new input — replay the most recent
      // assistant message (or opening prompt) without advancing state.
      const lastAssistant = [...session.transcriptTurns]
        .reverse()
        .find((t) => t.role === 'assistant');
      const message =
        lastAssistant?.text ?? STATE_OPENING_PROMPT[session.fsmState as ExtractionState];
      return {
        sessionId: session.id,
        assistantMessage: message,
        state: session.fsmState,
        turnCount: session.turnCount,
        completed: false,
        proposalIds: [],
      };
    }

    // 3. Build the FSM context from the persisted session.
    const ctx = this.toContext(session);

    // 4. Dispatch user_turn.
    let { nextState, updatedContext, sideEffects } = transition(
      session.fsmState,
      { kind: 'user_turn', utterance: req.userMessage, now: now().toISOString() },
      ctx,
    );

    // 5. Execute side effects. `call_extractor` produces a follow-on
    //    `extraction_result` event that re-enters `transition` once.
    const assistantUtterances: string[] = [];
    const emittedProposalIds: string[] = [];
    for (const effect of sideEffects) {
      const after = await this.executeSideEffect(
        effect,
        req,
        nextState,
        updatedContext,
        assistantUtterances,
        emittedProposalIds,
        now,
      );
      if (after) {
        nextState = after.nextState;
        updatedContext = after.updatedContext;
        sideEffects.push(...after.sideEffects);
      }
    }

    // 6. Persist updated session.
    const assistantText = assistantUtterances.join('\n') || updatedContext.pendingClarifications[0] || '…';
    const assistantTurn: TranscriptTurn = {
      role: 'assistant',
      text: assistantText,
      at: now().toISOString(),
      state: nextState,
    };
    const transcriptWithAssistant = [...updatedContext.transcript, assistantTurn];

    const completed = nextState === 'completed' || nextState === 'capped';
    const updated = await this.deps.sessionRepo.update(req.tenantId, session.id, {
      fsmState: nextState,
      transcriptTurns: transcriptWithAssistant,
      pendingClarifications: updatedContext.pendingClarifications,
      clarificationCountByState: updatedContext.clarificationCountByState,
      extractions: updatedContext.extractions,
      turnCount: updatedContext.turnCount,
      proposalBatchIds: [...session.proposalBatchIds, ...emittedProposalIds],
      ...(completed ? { completedAt: now() } : {}),
    });

    return {
      sessionId: session.id,
      assistantMessage: assistantText,
      state: updated?.fsmState ?? nextState,
      turnCount: updated?.turnCount ?? updatedContext.turnCount,
      completed,
      proposalIds: emittedProposalIds,
    };
  }

  // ── Side-effect executor ──────────────────────────────────────────────

  private async executeSideEffect(
    effect: SideEffect,
    req: TurnRequest,
    currentState: OnboardingState,
    currentContext: OnboardingContext,
    assistantUtterances: string[],
    emittedProposalIds: string[],
    now: () => Date,
  ): Promise<{
    nextState: OnboardingState;
    updatedContext: OnboardingContext;
    sideEffects: SideEffect[];
  } | null> {
    switch (effect.kind) {
      case 'emit_assistant_message': {
        assistantUtterances.push(effect.text);
        return null;
      }
      case 'audit_log': {
        await this.deps.auditRepo.create(
          createAuditEvent({
            tenantId: req.tenantId,
            actorId: req.userId,
            actorRole: 'owner',
            eventType: effect.eventType,
            entityType: 'onboarding_session',
            entityId: req.sessionId ?? 'pending',
            metadata: effect.metadata,
          }),
        );
        return null;
      }
      case 'call_extractor': {
        const result = await this.runExtractor(
          effect.state,
          effect.transcript,
          effect.previousExtractions,
          req,
        );
        return transition(
          currentState,
          { kind: 'extraction_result', result },
          currentContext,
        );
      }
      case 'emit_proposal_batches': {
        const ids = await this.emitProposalBatches(req, currentContext);
        emittedProposalIds.push(...ids);
        return null;
      }
    }
  }

  // ── Extractor invocation ──────────────────────────────────────────────

  private async runExtractor(
    state: ExtractionState,
    transcript: string,
    previousExtractions: Partial<OnboardingExtraction>,
    req: TurnRequest,
  ): Promise<ExtractionResultPayload> {
    const ctx: ExtractionContext = {
      tenantId: req.tenantId,
      userId: req.userId,
      transcript,
      previousExtractions,
    };
    try {
      switch (state) {
        case 'profile_capture': {
          const r = await new BusinessProfileExtractor(this.deps.gateway).extract(ctx);
          return {
            state,
            data: r.data,
            confidence: r.confidence.score,
            needsClarification: r.needsClarification,
            clarificationQuestions: r.clarificationQuestions ?? [],
          };
        }
        case 'category_capture': {
          const r = await new CategoryExtractor(this.deps.gateway).extract(ctx);
          return {
            state,
            data: r.data,
            confidence: r.confidence.score,
            needsClarification: r.needsClarification,
            clarificationQuestions: r.clarificationQuestions ?? [],
          };
        }
        case 'pricing_capture': {
          const r = await new PricingExtractor(this.deps.gateway).extract(ctx);
          return {
            state,
            data: r.data,
            confidence: r.confidence.score,
            needsClarification: r.needsClarification,
            clarificationQuestions: r.clarificationQuestions ?? [],
          };
        }
        case 'team_capture': {
          const r = await new TeamExtractor(this.deps.gateway).extract(ctx);
          return {
            state,
            data: r.data,
            confidence: r.confidence.score,
            needsClarification: r.needsClarification,
            clarificationQuestions: r.clarificationQuestions ?? [],
          };
        }
        case 'schedule_capture': {
          const r = await new ScheduleExtractor(this.deps.gateway).extract(ctx);
          return {
            state,
            data: r.data,
            confidence: r.confidence.score,
            needsClarification: r.needsClarification,
            clarificationQuestions: r.clarificationQuestions ?? [],
          };
        }
      }
    } catch (err) {
      // Surface as low-confidence so the FSM falls through to a
      // clarification rather than crashing the request. The audit
      // event already records the gateway failure inside the gateway.
      const message = err instanceof Error ? err.message : String(err);
      return {
        state,
        data: emptyExtractionData(state),
        confidence: 0,
        needsClarification: true,
        clarificationQuestions: [`Sorry, I had trouble understanding — could you rephrase? (${message.slice(0, 80)})`],
      } as ExtractionResultPayload;
    }
  }

  // ── Proposal emission ─────────────────────────────────────────────────

  /**
   * Build + persist the existing five `onboarding_*` proposal types
   * from the accumulated FSM extraction context. Mirrors the single-shot
   * `OnboardingOrchestrator.run()` proposal-assembly logic but actually
   * calls `proposalRepo.create` for each — the single-shot path is
   * dormant in the codebase and never persists its output.
   *
   * Empty extractions short-circuit: a `capped` session with no
   * captured data shouldn't emit no-op proposals.
   */
  private async emitProposalBatches(
    req: TurnRequest,
    ctx: OnboardingContext,
  ): Promise<string[]> {
    const ex = ctx.extractions;
    const inputs: CreateProposalInput[] = [];
    const sourceContext = ctx.sessionId ? { conversationId: ctx.sessionId } : undefined;

    // 1. Tenant settings (business profile).
    if (ex.businessProfile) {
      const settings = createTenantSettingsProposal(
        req.tenantId,
        req.userId,
        ex.businessProfile,
        ctx.sessionId,
      );
      if (settings) {
        // createTenantSettingsProposal returns a Proposal + payload tuple
        // (not a CreateProposalInput) — persist directly via the repo.
        await this.deps.proposalRepo.create(settings.proposal);
      }
    }

    // 2. Per-category proposals.
    if (ex.categories) {
      for (const cat of ex.categories.categories) {
        const payload: OnboardingServiceCategoryPayload = {
          verticalType: cat.verticalType,
          categoryId: cat.categoryId,
          displayName: cat.name,
        };
        inputs.push({
          tenantId: req.tenantId,
          proposalType: 'onboarding_service_category',
          payload: payload as unknown as Record<string, unknown>,
          summary: `Activate category: ${cat.name} (${cat.verticalType})`,
          confidenceScore: cat.confidence,
          sourceContext,
          createdBy: req.userId,
        });
      }
    }

    // 3. Estimate template proposals (require both categories + pricing).
    if (ex.categories && ex.pricing) {
      const templateResult = assembleEstimateTemplates(
        req.tenantId,
        req.userId,
        ex.categories,
        ex.pricing,
        ctx.sessionId,
      );
      for (const proposal of templateResult.proposals) {
        await this.deps.proposalRepo.create(proposal);
      }
    }

    // 4. Per-team-member proposals.
    if (ex.team) {
      for (const member of ex.team.members) {
        const payload: OnboardingTeamMemberPayload = {
          name: member.name,
          role: member.inferredRole,
        };
        inputs.push({
          tenantId: req.tenantId,
          proposalType: 'onboarding_team_member',
          payload: payload as unknown as Record<string, unknown>,
          summary: `Add team member: ${member.name} (${member.inferredRole})`,
          confidenceScore: member.confidence,
          sourceContext,
          createdBy: req.userId,
        });
      }
    }

    // 5. Schedule proposal (one, if any working hours captured).
    if (ex.schedule && ex.schedule.workingHours.length > 0) {
      const payload: OnboardingSchedulePayload = {
        workingHours: ex.schedule.workingHours,
        emergencySLA: ex.schedule.sla
          ? { hoursTarget: ex.schedule.sla.hoursTarget, isGuarantee: ex.schedule.sla.isGuarantee }
          : undefined,
      };
      inputs.push({
        tenantId: req.tenantId,
        proposalType: 'onboarding_schedule',
        payload: payload as unknown as Record<string, unknown>,
        summary: 'Configure working hours and schedule',
        // We don't have the original ScheduleExtraction confidence here;
        // a captured schedule is high-signal so default to 1.0.
        confidenceScore: 1.0,
        sourceContext,
        createdBy: req.userId,
      });
    }

    // Build + persist the simple-payload proposals collected above.
    const created: string[] = [];
    for (const input of inputs) {
      const proposal = createProposal(input);
      await this.deps.proposalRepo.create(proposal);
      created.push(proposal.id);
    }
    return created;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async persistAssistantTurn(
    session: OnboardingSession,
    text: string,
    at: Date,
  ): Promise<void> {
    const turn: TranscriptTurn = {
      role: 'assistant',
      text,
      at: at.toISOString(),
      state: session.fsmState,
    };
    await this.deps.sessionRepo.update(session.tenantId, session.id, {
      transcriptTurns: [...session.transcriptTurns, turn],
    });
  }

  private toContext(session: OnboardingSession): OnboardingContext {
    return {
      tenantId: session.tenantId,
      sessionId: session.id,
      transcript: session.transcriptTurns,
      extractions: session.extractions,
      clarificationCountByState: session.clarificationCountByState,
      turnCount: session.turnCount,
      pendingClarifications: session.pendingClarifications,
    };
  }

  private terminalResponse(session: OnboardingSession): TurnResponse {
    const lastAssistant = [...session.transcriptTurns].reverse().find((t) => t.role === 'assistant');
    return {
      sessionId: session.id,
      assistantMessage: lastAssistant?.text ?? '',
      state: session.fsmState,
      turnCount: session.turnCount,
      completed: true,
      proposalIds: session.proposalBatchIds,
    };
  }
}

function emptyExtractionData(state: ExtractionState): unknown {
  switch (state) {
    case 'profile_capture':
      return {
        businessName: null,
        city: null,
        state: null,
        verticalPacks: [],
        serviceDescriptions: [],
        confidence: 0,
        lowConfidenceFields: [],
      };
    case 'category_capture':
      return { categories: [] };
    case 'pricing_capture':
      return { prices: [] };
    case 'team_capture':
      return { members: [] };
    case 'schedule_capture':
      return { workingHours: [] };
  }
}

// Exported for direct unit testing of the conversation orchestrator
// without standing up a route.
export { SYSTEM_ACTOR };
export type { OnboardingSession };
