/**
 * In-App Voice Adapter — P8-009
 *
 * Wires the CallingAgentStateMachine to HTTP/SSE endpoints for in-app
 * (browser) voice sessions. Manages the session lifecycle, executes
 * side effects, and broadcasts FSM state changes to SSE clients.
 */

import { v4 as uuidv4 } from 'uuid';
import { VoiceSessionStore } from './voice-session-store';
import type { CallingAgentState, SideEffect } from './types';
import type { LLMGateway } from '../../gateway/gateway';
import type { TtsProvider } from '../../tts/tts-provider';
import type { ProposalRepository } from '../../../proposals/proposal';
import { createProposal } from '../../../proposals/proposal';
import type { AuditRepository } from '../../../audit/audit';
import type { OnCallRepository } from '../../../oncall/rotation';
import { identifyCaller } from '../../skills/identify-caller';
import { classifyIntent } from '../../orchestration/intent-classifier';
import { PgEntityResolver } from '../../resolution/pg-entity-resolver';
import { confirmIntent } from '../../skills/confirm-intent';
import { escalateToHuman } from '../../skills/escalate-to-human';
import { createLogger } from '../../../logging/logger';
import type { Pool } from 'pg';

const logger = createLogger({
  service: 'inapp-voice-adapter',
  environment: process.env.NODE_ENV || 'development',
});

export interface InAppAdapterDeps {
  gateway: LLMGateway;
  proposalRepo: ProposalRepository;
  /** Postgres pool for identify-caller + entity resolver. */
  pool?: Pool;
  ttsProvider?: TtsProvider;
  onCallRepo: OnCallRepository;
  auditRepo?: AuditRepository;
  sessionStore: VoiceSessionStore;
}

export class InAppVoiceAdapter {
  constructor(private deps: InAppAdapterDeps) {}

  /**
   * Create a new in-app voice session.
   * Dispatches session_started → FSM moves to 'greeting' → executes greeting TTS.
   * Returns the sessionId.
   */
  async startSession(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<string> {
    const sessionId = uuidv4();

    // Create the session in the store first so the FSM context is consistent.
    this.deps.sessionStore.create(tenantId, 'inapp', {
      sessionId,
      tenantId,
      channel: 'inapp',
      conversationId,
    });

    const session = this.deps.sessionStore.get(sessionId)!;

    // Dispatch the session_started event — FSM transitions idle → greeting
    const sideEffects = session.machine.dispatch({
      type: 'session_started',
      userId,
      tenantId,
      conversationId,
    });

    // After greeting side effects fire (tts_play with template: 'greeting'),
    // immediately fire greeted_ok so the FSM advances to 'identifying'.
    await this.executeSideEffects(sessionId, sideEffects, undefined);

    // Auto-advance from greeting → identifying.
    const greeterEffects = session.machine.dispatch({ type: 'greeted_ok' });
    await this.executeSideEffects(sessionId, greeterEffects, undefined);

    this.broadcastState(sessionId);
    return sessionId;
  }

  /**
   * Process a text input from the user.
   * Routes to the correct skill based on current FSM state, then executes
   * all returned side effects.
   */
  async handleInput(
    sessionId: string,
    text: string,
  ): Promise<{
    state: CallingAgentState;
    ttsAudio?: Buffer;
    proposalId?: string;
  }> {
    const session = this.deps.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    this.deps.sessionStore.touch(sessionId);
    session.transcript.push(text);

    const currentState = session.machine.currentState;
    const context = session.machine.currentContext;
    let sideEffects: SideEffect[] = [];

    if (currentState === 'identifying' || currentState === 'ask_caller') {
      // In-app sessions don't have a phone number — use the text as an
      // identity cue. If we have a pool, try a name-based lookup (text);
      // otherwise fall back to unknown_caller to let the FSM prompt the user.
      if (this.deps.pool) {
        try {
          const result = await identifyCaller({
            tenantId: session.tenantId,
            fromPhone: text,
            pool: this.deps.pool,
          });
          if (result.status === 'matched') {
            sideEffects = session.machine.dispatch({
              type: 'caller_known',
              customerId: result.customerId,
            });
          } else {
            sideEffects = session.machine.dispatch({ type: 'unknown_caller' });
          }
        } catch (err) {
          logger.warn('identifyCaller failed, treating as unknown', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          sideEffects = session.machine.dispatch({ type: 'unknown_caller' });
        }
      } else {
        sideEffects = session.machine.dispatch({ type: 'unknown_caller' });
      }
    } else if (currentState === 'intent_capture') {
      try {
        const classification = await classifyIntent(
          text,
          { tenantId: session.tenantId },
          this.deps.gateway,
        );
        sideEffects = session.machine.dispatch({
          type: 'intent_classified',
          intentType: classification.intentType,
          entities: (classification.extractedEntities ?? {}) as Record<string, unknown>,
          confidence: classification.confidence,
        });
      } catch (err) {
        logger.warn('classifyIntent failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        sideEffects = session.machine.dispatch({ type: 'text_input', text });
      }
    } else if (currentState === 'entity_resolution') {
      // Run entity resolver for each extracted entity key.
      if (this.deps.pool) {
        const resolver = new PgEntityResolver(this.deps.pool);
        const entities = context.extractedEntities ?? {};
        const refs: Record<string, string> = {};
        let ambiguous = false;
        let notFound = false;

        for (const [key, value] of Object.entries(entities)) {
          if (typeof value !== 'string') continue;
          try {
            const resolvedKind = key.includes('customer')
              ? 'customer'
              : key.includes('job')
                ? 'job'
                : key.includes('invoice')
                  ? 'invoice'
                  : key.includes('appointment')
                    ? 'appointment'
                    : null;

            if (!resolvedKind) {
              refs[key] = value;
              continue;
            }

            const result = await resolver.resolve({
              tenantId: session.tenantId,
              reference: value,
              kind: resolvedKind,
            });

            if (result.kind === 'resolved') {
              refs[key] = result.candidate.id;
            } else if (result.kind === 'ambiguous') {
              ambiguous = true;
              sideEffects = session.machine.dispatch({
                type: 'entity_ambiguous',
                candidates: result.candidates.map((c) => ({
                  id: c.id,
                  name: c.label,
                  score: c.score,
                })),
              });
              break;
            } else if (result.kind === 'not_found') {
              notFound = true;
              sideEffects = session.machine.dispatch({ type: 'entity_not_found' });
              break;
            } else {
              // skipped — pass through the raw value
              refs[key] = value;
            }
          } catch (err) {
            logger.warn('entity resolver failed for key', {
              sessionId,
              key,
              error: err instanceof Error ? err.message : String(err),
            });
            refs[key] = value;
          }
        }

        if (!ambiguous && !notFound) {
          sideEffects = session.machine.dispatch({
            type: 'entity_resolved',
            refs,
          });
        }
      } else {
        // No pool — pass entities through as-is.
        sideEffects = session.machine.dispatch({
          type: 'entity_resolved',
          refs: Object.fromEntries(
            Object.entries(context.extractedEntities ?? {}).filter(
              ([, v]) => typeof v === 'string',
            ) as [string, string][],
          ),
        });
      }
    } else if (currentState === 'intent_confirm') {
      const intentSummary = context.currentIntent ?? 'your request';
      try {
        const result = await confirmIntent({
          intentSummary,
          callerResponse: text,
          tenantId: session.tenantId,
          gateway: this.deps.gateway,
          ttsProvider: this.deps.ttsProvider,
        });
        if (result.confirmed) {
          sideEffects = session.machine.dispatch({ type: 'confirmed' });
        } else {
          sideEffects = session.machine.dispatch({
            type: 'correction',
            newTranscript: result.correction ?? text,
          });
        }
      } catch (err) {
        logger.warn('confirmIntent failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        sideEffects = session.machine.dispatch({ type: 'text_input', text });
      }
    } else {
      // All other states: dispatch as raw text_input (FSM will ignoredTransition).
      sideEffects = session.machine.dispatch({ type: 'text_input', text });
    }

    const result = await this.executeSideEffects(sessionId, sideEffects, text);
    this.broadcastState(sessionId);

    return {
      state: session.machine.currentState,
      ttsAudio: result.ttsAudio,
      proposalId: result.proposalId ?? session.proposalIds[session.proposalIds.length - 1],
    };
  }

  /**
   * End a voice session: dispatch session_ended, execute side effects,
   * then remove from the store.
   */
  async endSession(sessionId: string): Promise<void> {
    const session = this.deps.sessionStore.get(sessionId);
    if (!session) return;

    const sideEffects = session.machine.dispatch({ type: 'session_ended' });
    await this.executeSideEffects(sessionId, sideEffects, undefined);
    this.broadcastState(sessionId);
    this.deps.sessionStore.delete(sessionId);
  }

  /**
   * Broadcast a JSON event payload to all SSE clients for a session.
   */
  pushSseEvent(sessionId: string, event: object): void {
    const session = this.deps.sessionStore.get(sessionId);
    if (!session) return;
    const payload = JSON.stringify(event);
    for (const client of session.sseClients) {
      try {
        client(payload);
      } catch {
        // Client may have disconnected; remove it.
        session.sseClients.delete(client);
      }
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Execute a list of side effects in order, collecting TTS audio and
   * proposal IDs. Returns the first ttsAudio produced and the last
   * proposalId created.
   */
  private async executeSideEffects(
    sessionId: string,
    effects: SideEffect[],
    _inputText: string | undefined,
  ): Promise<{ ttsAudio?: Buffer; proposalId?: string }> {
    let ttsAudio: Buffer | undefined;
    let proposalId: string | undefined;

    for (const effect of effects) {
      try {
        switch (effect.type) {
          case 'tts_play': {
            if (!this.deps.ttsProvider) break;
            const template = effect.payload.template as string | undefined;
            let text: string;

            if (template === 'greeting' || template === 'greeting_with_disclosure') {
              // In-app channel skips disclosure.
              text = 'Thank you for calling. How can I help you today?';
            } else if (template === 'confirm_intent') {
              const intent = effect.payload.intent as string | undefined;
              text = intent
                ? `Just to confirm — ${intent}. Is that right?`
                : 'Can you confirm your request?';
            } else if (template === 'disambiguate') {
              const candidates = effect.payload.candidates as Array<{
                id: string;
                name: string;
              }> | undefined;
              if (candidates && candidates.length > 0) {
                const names = candidates.map((c) => c.name).join(', or ');
                text = `Did you mean ${names}?`;
              } else {
                text = 'Could you clarify which one you mean?';
              }
            } else {
              // Arbitrary text side effect.
              text = (effect.payload.text as string | undefined) ?? '';
            }

            if (text) {
              try {
                const result = await this.deps.ttsProvider.synthesize({
                  text,
                  tenantId: (effect.payload.tenantId as string | undefined) ??
                    this.deps.sessionStore.get(sessionId)?.tenantId,
                });
                if (!ttsAudio) {
                  ttsAudio = result.audio;
                }
              } catch (err) {
                logger.warn('TTS synthesis failed (non-fatal)', {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            break;
          }

          case 'create_proposal': {
            const session = this.deps.sessionStore.get(sessionId);
            if (!session) break;

            const intentType = effect.payload.intent as string | undefined;
            const entities = (effect.payload.entities as Record<string, unknown> | undefined) ?? {};

            // Map intentType → ProposalType; fall back to 'voice_clarification'.
            const proposalTypeMap: Record<string, string> = {
              create_invoice: 'draft_invoice',
              draft_estimate: 'draft_estimate',
              create_appointment: 'create_appointment',
              update_invoice: 'update_invoice',
              update_estimate: 'update_estimate',
              issue_invoice: 'issue_invoice',
              create_customer: 'create_customer',
              create_job: 'create_job',
              reschedule_appointment: 'reschedule_appointment',
              cancel_appointment: 'cancel_appointment',
              reassign_appointment: 'reassign_appointment',
              add_note: 'add_note',
              send_invoice: 'send_invoice',
              record_payment: 'record_payment',
              emergency_dispatch: 'emergency_dispatch',
            };

            const resolvedType =
              (intentType && proposalTypeMap[intentType]) ?? 'voice_clarification';

            const proposal = createProposal({
              tenantId: session.tenantId,
              proposalType: resolvedType as import('../../../proposals/proposal').ProposalType,
              payload: {
                intent: intentType,
                entities,
                sessionId,
                callSid: effect.payload.callSid,
                conversationId: effect.payload.conversationId,
                customerId: effect.payload.customerId,
              },
              summary: intentType
                ? `Voice session: ${intentType}`
                : 'Voice session request',
              createdBy: sessionId,
            });

            await this.deps.proposalRepo.create(proposal);
            proposalId = proposal.id;
            session.proposalIds.push(proposal.id);
            break;
          }

          case 'audit_log': {
            if (this.deps.auditRepo) {
              const { createAuditEvent } = await import('../../../audit/audit');
              const session = this.deps.sessionStore.get(sessionId);
              const tenantId =
                (effect.payload.tenantId as string | undefined) ??
                session?.tenantId ??
                'unknown';
              try {
                const auditEvent = createAuditEvent({
                  tenantId,
                  actorId: sessionId,
                  actorRole: 'system',
                  eventType: (effect.payload.eventType as string) ?? 'agent.calling.unknown',
                  entityType: 'session',
                  entityId: sessionId,
                  metadata: effect.payload,
                });
                await this.deps.auditRepo.create(auditEvent);
              } catch {
                // Non-fatal: audit failure shouldn't break the session.
              }
            } else {
              logger.info('audit_log side effect', {
                sessionId,
                ...effect.payload,
              });
            }
            break;
          }

          case 'notify_oncall': {
            const session = this.deps.sessionStore.get(sessionId);
            if (!session) break;
            try {
              await escalateToHuman({
                tenantId: session.tenantId,
                sessionId,
                conversationId:
                  (effect.payload.conversationId as string | undefined) ??
                  session.machine.currentContext.conversationId,
                reason: (effect.payload.reason as import('../../skills/escalate-to-human').EscalationReason | undefined) ?? 'provider_failure',
                channel: 'inapp',
                onCallRepo: this.deps.onCallRepo,
                auditRepo: this.deps.auditRepo,
              });
            } catch (err) {
              logger.warn('escalateToHuman failed', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            break;
          }

          case 'end_session': {
            // Handled by endSession() — don't recurse here, just note it.
            logger.info('end_session side effect received', { sessionId });
            break;
          }

          case 'start_transcription': {
            // No-op for in-app (transcription handled by browser/frontend).
            break;
          }

          default:
            break;
        }
      } catch (err) {
        logger.error('Side effect execution failed', {
          sessionId,
          effectType: effect.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { ttsAudio, proposalId };
  }

  /**
   * Broadcast the current FSM state + context to all SSE clients.
   */
  private broadcastState(sessionId: string): void {
    const session = this.deps.sessionStore.get(sessionId);
    if (!session) return;
    this.pushSseEvent(sessionId, {
      state: session.machine.currentState,
      context: session.machine.currentContext,
    });
  }
}
