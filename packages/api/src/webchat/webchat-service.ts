/**
 * #1737 — the public web chat service: an anonymous visitor on a tenant's own
 * website talks to the same AI that answers the phone.
 *
 * The visitor's words go through the SAME turn pipeline as an inbound call
 * (`createVoiceTurnProcessor().speechTurn`, the untrusted-caller `telephony`
 * FSM, so the S1 proposal-type gate applies). Nothing the AI drafts runs: a
 * booking or request becomes a proposal the owner approves, exactly as on the
 * phone. This module adds only what the public path needs on top:
 *
 *   gate     tenant flag + owner toggle + per-tenant and global kill switch,
 *            embed token, allowed-origin list, bot check on session start
 *   limits   per-IP and per-session windows, per-session turn cap, message
 *            length cap, per-tenant daily turn and cost caps (D-044)
 *   hand-off lead capture (+ public booking link) and escalation to the owner
 *   audit    every session start / hand-off / escalation / cap hit
 */
import { v4 as uuidv4 } from 'uuid';
import type { VoiceSessionStore, VoiceSession } from '../ai/agents/customer-calling/voice-session-store';
import type { SideEffect } from '../ai/agents/customer-calling/types';
import type { VoiceTurnProcessor } from '../ai/voice-turn';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { LeadRepository } from '../leads/lead';
import { createLead } from '../leads/lead-service';
import { notifyOwner } from '../notifications/owner-notifications-instance';
import type { SettingsRepository } from '../settings/settings';
import type { VoiceSessionRepository } from '../voice/voice-session';
import {
  originAllowed,
  tenantIdFromToken,
  tokenMatches,
  type WebchatConfig,
  type WebchatConfigRepository,
} from './webchat-config';
import { SlidingWindowLimiter, type BotVerifier } from './webchat-guard';
import { usageDay, type WebchatUsageRepository } from './webchat-usage';

export const WEBCHAT_FLAG = 'webchat_widget';
const ACTOR_ID = 'public:webchat';
const ACTOR_ROLE = 'public';

export const MAX_MESSAGE_CHARS = 500;
export const MAX_TURNS_PER_SESSION = 40;
const SESSION_MESSAGES_PER_MINUTE = 8;
const IP_MESSAGES_PER_MINUTE = 30;
const IP_SESSIONS_PER_HOUR = 10;

export type WebchatErrorCode =
  | 'UNAVAILABLE'
  | 'ORIGIN_NOT_ALLOWED'
  | 'BOT_CHECK_FAILED'
  | 'RATE_LIMITED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ENDED'
  | 'VALIDATION_ERROR';

const STATUS: Record<WebchatErrorCode, number> = {
  UNAVAILABLE: 404,
  ORIGIN_NOT_ALLOWED: 403,
  BOT_CHECK_FAILED: 403,
  RATE_LIMITED: 429,
  SESSION_NOT_FOUND: 404,
  SESSION_ENDED: 410,
  VALIDATION_ERROR: 400,
};

export class WebchatError extends Error {
  readonly status: number;
  constructor(readonly code: WebchatErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}

export interface WebchatServiceDeps {
  configRepo: WebchatConfigRepository;
  usageRepo: WebchatUsageRepository;
  settingsRepo: Pick<SettingsRepository, 'findByTenant'>;
  store: VoiceSessionStore;
  /** Processor for this tenant's business name (built once per tenant by the host). */
  processorFor: (businessName: string) => VoiceTurnProcessor;
  auditRepo: AuditRepository;
  leadRepo: LeadRepository;
  voiceSessionRepo?: Pick<VoiceSessionRepository, 'create'>;
  /** Platform tenant flag `webchat_widget`; resolves false for tenants not rolled out. */
  isEnabledForTenant: (tenantId: string) => Promise<boolean>;
  /** Global kill switch (env/ops). True stops every tenant's widget at once. */
  globallyKilled: () => boolean;
  botVerifier?: BotVerifier;
  /** Base URL of the public booking page (`<web origin>/book`). */
  bookingUrlFor: (tenantId: string) => string;
  now?: () => Date;
}

interface SessionMeta {
  tenantId: string;
  ip: string | undefined;
  turns: number;
  /** Set once the visitor's contact details are captured. */
  leadId?: string;
  escalated: boolean;
}

export interface StartSessionInput {
  token: string;
  origin: string | undefined;
  ip: string | undefined;
  botToken?: string;
}

export interface StartSessionResult {
  sessionId: string;
  greeting: string;
  businessName: string;
  bookingUrl: string;
  /** Hard limits the widget can show instead of discovering them by error. */
  maxMessageChars: number;
}

export interface SendMessageInput {
  token: string;
  origin: string | undefined;
  ip: string | undefined;
  sessionId: string;
  text: string;
}

export interface SendMessageResult {
  replies: string[];
  ended: boolean;
  /** The conversation was handed to a person; the visitor is told so. */
  escalated: boolean;
  /** The daily allowance is used up: the widget switches to the contact form. */
  capped: boolean;
}

export interface HandoffInput {
  token: string;
  origin: string | undefined;
  ip: string | undefined;
  sessionId: string;
  name: string;
  phone?: string;
  email?: string;
  note?: string;
  /** The visitor asked for a person rather than just leaving details. */
  requestOwner: boolean;
}

export interface HandoffResult {
  leadId: string;
  bookingUrl: string;
}

const CAPPED_REPLY =
  "Our chat assistant has reached its limit for today. Leave your details and we'll get back to you, or use the booking link.";
const ESCALATED_REPLY = "I've let the team know — someone will follow up with you shortly.";
const ASKS_FOR_PERSON =
  /\b(human|real person|live person|actual person|speak (to|with) (a |an |the )?(person|someone|owner|manager|representative)|talk (to|with) (a |an |the )?(person|someone|owner|manager|representative)|the owner)\b/i;
const ERROR_REPLY = "Sorry, I couldn't process that. You can leave your details and we'll get back to you.";

export function createWebchatService(deps: WebchatServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const sessions = new Map<string, SessionMeta>();
  const ipMessages = new SlidingWindowLimiter(IP_MESSAGES_PER_MINUTE, 60_000);
  const ipSessions = new SlidingWindowLimiter(IP_SESSIONS_PER_HOUR, 60 * 60_000);
  const sessionMessages = new SlidingWindowLimiter(SESSION_MESSAGES_PER_MINUTE, 60_000);

  async function audit(
    tenantId: string,
    eventType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: ACTOR_ID,
          actorRole: ACTOR_ROLE,
          eventType,
          entityType: 'webchat_session',
          entityId,
          metadata,
        }),
      );
    } catch {
      // Best-effort: a failed audit write must not take the visitor's chat down.
    }
  }

  /** Token + flag + toggle + kill switches + origin. Every public call starts here. */
  async function authorize(
    token: string,
    origin: string | undefined,
  ): Promise<{ config: WebchatConfig; tenantId: string }> {
    const tenantId = tenantIdFromToken(token);
    if (!tenantId) throw new WebchatError('UNAVAILABLE', 'Chat is not available');
    const config = await deps.configRepo.get(tenantId);
    if (
      !config ||
      !tokenMatches(token, config.embedToken) ||
      !config.enabled ||
      config.killedAt !== null ||
      deps.globallyKilled() ||
      !(await deps.isEnabledForTenant(tenantId))
    ) {
      // One answer for every "off" reason: no oracle for which tenants exist.
      throw new WebchatError('UNAVAILABLE', 'Chat is not available');
    }
    if (!originAllowed(origin, config.allowedOrigins)) {
      throw new WebchatError('ORIGIN_NOT_ALLOWED', 'This site is not allowed to use chat');
    }
    return { config, tenantId };
  }

  function sessionFor(tenantId: string, sessionId: string): { session: VoiceSession; meta: SessionMeta } {
    const meta = sessions.get(sessionId);
    const session = meta ? deps.store.get(sessionId) : undefined;
    if (!meta || !session || meta.tenantId !== tenantId) {
      sessions.delete(sessionId);
      throw new WebchatError('SESSION_NOT_FOUND', 'Chat session not found');
    }
    if (session.ended) throw new WebchatError('SESSION_ENDED', 'This chat has ended');
    return { session, meta };
  }

  function spoken(effects: SideEffect[]): string[] {
    return effects
      .filter((fx) => fx.type === 'tts_play' && typeof fx.payload.text === 'string')
      .map((fx) => String(fx.payload.text).trim())
      .filter((text) => text.length > 0);
  }

  async function businessNameFor(tenantId: string): Promise<string> {
    const settings = await deps.settingsRepo.findByTenant(tenantId);
    return settings?.businessName?.trim() || 'our team';
  }

  async function escalate(
    tenantId: string,
    session: VoiceSession,
    meta: SessionMeta,
    reason: string,
  ): Promise<void> {
    if (meta.escalated) return;
    meta.escalated = true;
    await audit(tenantId, 'webchat.escalated', session.id, { reason, leadId: meta.leadId ?? null });
    try {
      await notifyOwner(tenantId, 'escalation', { reason: `Web chat: ${reason}` });
    } catch {
      // The notification service is failure-isolated; never fail the turn on it.
    }
  }

  return {
    async startSession(input: StartSessionInput): Promise<StartSessionResult> {
      const { tenantId } = await authorize(input.token, input.origin);
      if (!ipSessions.allow(input.ip ?? 'unknown', now().getTime())) {
        throw new WebchatError('RATE_LIMITED', 'Too many chats started, try again later');
      }
      if (deps.botVerifier && !(await deps.botVerifier.verify({ token: input.botToken, ip: input.ip }))) {
        await audit(tenantId, 'webchat.bot_check_failed', uuidv4(), {});
        throw new WebchatError('BOT_CHECK_FAILED', 'Verification failed');
      }

      const businessName = await businessNameFor(tenantId);
      const session = deps.store.create(tenantId, 'telephony');
      session.persistChannel = 'webchat';
      // Same bootstrap as an unrecognised inbound caller. The CallSid-shaped
      // id is FSM bookkeeping only; it is deliberately NOT stored on the
      // session, so no phone-call persistence or Twilio path keys on it.
      const fsmId = `webchat-${session.id}`;
      session.machine.dispatch({ type: 'incoming_call', callSid: fsmId, from: 'webchat', to: 'webchat', tenantId });
      session.machine.dispatch({ type: 'greeted_ok' });
      session.machine.dispatch({ type: 'unknown_caller' });

      const greeting = `Hi! I'm the automated assistant for ${businessName}. How can I help?`;
      deps.store.appendTranscript(session.id, { speaker: 'agent', text: greeting, ts: Date.now() });
      sessions.set(session.id, { tenantId, ip: input.ip, turns: 0, escalated: false });

      if (deps.voiceSessionRepo) {
        await deps.voiceSessionRepo
          .create({ id: session.id, tenantId, channel: 'webchat', state: session.machine.currentState })
          .catch(() => undefined);
      }
      await audit(tenantId, 'webchat.session_started', session.id, { origin: input.origin ?? null });

      return {
        sessionId: session.id,
        greeting,
        businessName,
        bookingUrl: deps.bookingUrlFor(tenantId),
        maxMessageChars: MAX_MESSAGE_CHARS,
      };
    },

    async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
      const { config, tenantId } = await authorize(input.token, input.origin);
      const { session, meta } = sessionFor(tenantId, input.sessionId);
      const text = input.text.trim();
      if (text.length === 0 || text.length > MAX_MESSAGE_CHARS) {
        throw new WebchatError('VALIDATION_ERROR', `Message must be 1-${MAX_MESSAGE_CHARS} characters`);
      }
      const nowMs = now().getTime();
      if (
        !ipMessages.allow(input.ip ?? 'unknown', nowMs) ||
        !sessionMessages.allow(session.id, nowMs) ||
        meta.turns >= MAX_TURNS_PER_SESSION
      ) {
        throw new WebchatError('RATE_LIMITED', 'Slow down a little and try again');
      }

      // An explicit ask for a person is honoured at once, before any model
      // call (and without spending the tenant's allowance): the call pipeline
      // only fast-paths it after caller identification, which a web visitor
      // may never complete.
      if (ASKS_FOR_PERSON.test(text)) {
        meta.turns += 1;
        deps.store.appendTranscript(session.id, { speaker: 'caller', text, ts: Date.now() });
        await escalate(tenantId, session, meta, 'visitor asked for a person');
        deps.store.appendTranscript(session.id, { speaker: 'agent', text: ESCALATED_REPLY, ts: Date.now() });
        return { replies: [ESCALATED_REPLY], ended: false, escalated: true, capped: false };
      }

      // Per-tenant daily allowance, taken atomically BEFORE the model is called.
      const day = usageDay(now());
      const reserved = await deps.usageRepo.reserveTurn(tenantId, day, {
        turnCap: config.dailyTurnCap,
        costCapCents: config.dailyCostCapCents,
      });
      if (!reserved) {
        await audit(tenantId, 'webchat.daily_cap_reached', session.id, {
          turnCap: config.dailyTurnCap,
          costCapCents: config.dailyCostCapCents,
        });
        return { replies: [CAPPED_REPLY], ended: false, escalated: false, capped: true };
      }

      meta.turns += 1;
      const costBefore = session.costTracker.totals.costCents;
      let effects: SideEffect[];
      try {
        const processor = deps.processorFor(await businessNameFor(tenantId));
        effects = await processor.speechTurn({
          session,
          speechResult: text,
          callSid: session.id,
          tenantId,
        });
      } catch {
        return { replies: [ERROR_REPLY], ended: false, escalated: false, capped: false };
      }
      await deps.usageRepo.addCost(tenantId, day, Math.max(0, session.costTracker.totals.costCents - costBefore));

      const wantsPerson = effects.some((fx) => fx.type === 'notify_oncall');
      if (wantsPerson) await escalate(tenantId, session, meta, 'visitor needs a person');
      const replies = spoken(effects);
      if (wantsPerson && replies.length === 0) replies.push(ESCALATED_REPLY);
      return {
        replies,
        ended: session.ended || effects.some((fx) => fx.type === 'end_session'),
        escalated: meta.escalated,
        capped: false,
      };
    },

    /** Visitor leaves contact details (and optionally asks for a person). */
    async handoff(input: HandoffInput): Promise<HandoffResult> {
      const { tenantId } = await authorize(input.token, input.origin);
      const { session, meta } = sessionFor(tenantId, input.sessionId);
      if (!ipMessages.allow(input.ip ?? 'unknown', now().getTime())) {
        throw new WebchatError('RATE_LIMITED', 'Slow down a little and try again');
      }
      const phone = input.phone?.trim() || undefined;
      const email = input.email?.trim() || undefined;
      if (!phone && !email) {
        throw new WebchatError('VALIDATION_ERROR', 'A phone number or email is required');
      }

      const lines = session.transcript.slice(-12).join(' | ');
      const detail = [input.note?.trim(), lines].filter(Boolean).join(' || ');
      const lead = await createLead(
        {
          tenantId,
          firstName: input.name.trim() || 'Web chat visitor',
          primaryPhone: phone,
          email,
          // `web_form` is the closest existing LeadSource; adding a 'webchat'
          // source would need a leads_source_check migration beyond this slice.
          source: 'web_form',
          sourceDetail: `Web chat${detail ? `: ${detail}` : ''}`.slice(0, 497),
          createdBy: ACTOR_ID,
          actorRole: ACTOR_ROLE,
        },
        deps.leadRepo,
        deps.auditRepo,
      );
      meta.leadId = lead.id;
      if (phone) session.callerPhone = phone;
      await audit(tenantId, 'webchat.handoff', session.id, {
        leadId: lead.id,
        requestOwner: input.requestOwner,
      });
      if (input.requestOwner) await escalate(tenantId, session, meta, 'visitor asked for the owner');
      return { leadId: lead.id, bookingUrl: deps.bookingUrlFor(tenantId) };
    },

    /** The visitor closed the chat: persist the transcript row and free the session. */
    async endSession(input: { token: string; origin: string | undefined; sessionId: string }): Promise<void> {
      const { tenantId } = await authorize(input.token, input.origin);
      const { session } = sessionFor(tenantId, input.sessionId);
      session.ended = true;
      deps
        .processorFor(await businessNameFor(tenantId))
        .finalizeTerminatedSession(session, [{ type: 'end_session', payload: { reason: 'visitor_closed' } }], 'visitor_closed');
      await audit(tenantId, 'webchat.session_ended', session.id, { turns: sessions.get(session.id)?.turns ?? 0 });
      sessions.delete(session.id);
    },

    /** Forget bookkeeping for sessions the store has reaped. */
    sweep(): void {
      for (const id of sessions.keys()) {
        if (!deps.store.peek(id)) sessions.delete(id);
      }
    },
  };
}

export type WebchatService = ReturnType<typeof createWebchatService>;
