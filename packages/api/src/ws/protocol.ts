/**
 * Client WebSocket protocol contract — server side.
 *
 * All frames are JSON envelopes with a `kind` discriminator. Priority
 * classes drive the bounded queue's drop/coalesce policy:
 *   terminal > control > delta > telemetry
 *
 * The web client mirrors the shape of these types (no Zod runtime on the
 * client to keep the bundle small).
 */
import { z } from 'zod';

export const wsPrioritySchema = z.enum(['terminal', 'control', 'delta', 'telemetry']);
export type WsPriority = z.infer<typeof wsPrioritySchema>;

const baseFields = {
  seq: z.number().int().nonnegative().optional(),
  correlationId: z.string().optional(),
  degraded: z.boolean().optional(),
  fallbackStage: z.string().optional(),
  retryAfterMs: z.number().int().positive().optional(),
};

// ---------- Server → Client ----------

export const wsServerHelloSchema = z.object({
  kind: z.literal('hello'),
  ...baseFields,
  serverTimeMs: z.number(),
  heartbeatIntervalMs: z.number().int().positive(),
});

export const wsServerHeartbeatSchema = z.object({
  kind: z.literal('heartbeat'),
  ...baseFields,
  serverTimeMs: z.number(),
});

export const wsServerSubscribedSchema = z.object({
  kind: z.literal('subscribed'),
  ...baseFields,
  channel: z.string(),
});

export const wsServerErrorSchema = z.object({
  kind: z.literal('error'),
  ...baseFields,
  code: z.string(),
  message: z.string(),
});

export const wsServerAssistantTokenSchema = z.object({
  kind: z.literal('assistant.token'),
  ...baseFields,
  channel: z.literal('assistant'),
  delta: z.string(),
});

export const wsServerAssistantDoneSchema = z.object({
  kind: z.literal('assistant.done'),
  ...baseFields,
  channel: z.literal('assistant'),
  finalText: z.string(),
  proposalId: z.string().optional(),
});

export const wsServerVoiceEventSchema = z.object({
  kind: z.literal('voice.event'),
  ...baseFields,
  channel: z.literal('voice'),
  sessionId: z.string(),
  event: z.string(),
  state: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});

export const wsServerFrameSchema = z.discriminatedUnion('kind', [
  wsServerHelloSchema,
  wsServerHeartbeatSchema,
  wsServerSubscribedSchema,
  wsServerErrorSchema,
  wsServerAssistantTokenSchema,
  wsServerAssistantDoneSchema,
  wsServerVoiceEventSchema,
]);
export type WsServerFrame = z.infer<typeof wsServerFrameSchema>;

// ---------- Client → Server ----------

export const wsClientSubscribeSchema = z.object({
  kind: z.literal('subscribe'),
  ...baseFields,
  channel: z.enum(['assistant', 'voice']),
  targetId: z.string().optional(),
});

export const wsClientUnsubscribeSchema = z.object({
  kind: z.literal('unsubscribe'),
  ...baseFields,
  channel: z.enum(['assistant', 'voice']),
  targetId: z.string().optional(),
});

export const wsClientPingSchema = z.object({
  kind: z.literal('ping'),
  ...baseFields,
});

export const wsClientFrameSchema = z.discriminatedUnion('kind', [
  wsClientSubscribeSchema,
  wsClientUnsubscribeSchema,
  wsClientPingSchema,
]);
export type WsClientFrame = z.infer<typeof wsClientFrameSchema>;

export function priorityForFrame(frame: WsServerFrame): WsPriority {
  switch (frame.kind) {
    case 'error':
      return 'terminal';
    case 'hello':
    case 'subscribed':
    case 'assistant.done':
      return 'control';
    case 'assistant.token':
    case 'voice.event':
      return 'delta';
    case 'heartbeat':
      return 'telemetry';
    default:
      return 'control';
  }
}

export const WS_HEARTBEAT_INTERVAL_MS = 25_000;
export const WS_IDLE_TIMEOUT_MS = 90_000;

export const WS_CLOSE_CODE = {
  normal: 1000,
  going_away: 1001,
  protocol_error: 1002,
  policy_violation: 1008,
  too_big: 1009,
  internal_error: 1011,
  try_again_later: 1013,
} as const;
