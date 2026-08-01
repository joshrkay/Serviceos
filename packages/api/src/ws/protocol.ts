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

/** UC-3 — dispatch presence read. Pushed to connections subscribed to the
 *  `dispatch` channel (targetId = board date) whenever presence changes for
 *  that (tenant, date), and once on subscribe. Carries the FULL active list —
 *  a state snapshot, so a coalesced/dropped frame is self-healing. */
export const wsServerDispatchPresenceSchema = z.object({
  kind: z.literal('dispatch.presence'),
  ...baseFields,
  channel: z.literal('dispatch'),
  date: z.string(),
  entries: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string(),
      appointmentId: z.string().nullable(),
      mode: z.enum(['viewing', 'dragging']),
    }),
  ),
});

export const wsServerFrameSchema = z.discriminatedUnion('kind', [
  wsServerHelloSchema,
  wsServerHeartbeatSchema,
  wsServerSubscribedSchema,
  wsServerErrorSchema,
  wsServerAssistantTokenSchema,
  wsServerAssistantDoneSchema,
  wsServerVoiceEventSchema,
  wsServerDispatchPresenceSchema,
]);
export type WsServerFrame = z.infer<typeof wsServerFrameSchema>;

// ---------- Client → Server ----------

/** Channels a client can subscribe to. `dispatch` targets a board date. */
export const wsChannelSchema = z.enum(['assistant', 'voice', 'dispatch']);
export type WsChannel = z.infer<typeof wsChannelSchema>;

export const wsClientSubscribeSchema = z.object({
  kind: z.literal('subscribe'),
  ...baseFields,
  channel: wsChannelSchema,
  targetId: z.string().optional(),
});

export const wsClientUnsubscribeSchema = z.object({
  kind: z.literal('unsubscribe'),
  ...baseFields,
  channel: wsChannelSchema,
  targetId: z.string().optional(),
});

export const wsClientPingSchema = z.object({
  kind: z.literal('ping'),
  ...baseFields,
});

/** UC-3 — presence heartbeat over the already-open gateway socket. Replaces
 *  the 5s HTTP PUT (which cost an RLS transaction per beat); the HTTP route
 *  remains as the ≥30s fallback for clients without a live WS. */
export const wsClientPresenceUpdateSchema = z.object({
  kind: z.literal('presence.update'),
  ...baseFields,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.enum(['viewing', 'dragging']),
  appointmentId: z.string().nullable().optional(),
  displayName: z.string().max(200).optional(),
});

export const wsClientPresenceClearSchema = z.object({
  kind: z.literal('presence.clear'),
  ...baseFields,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const wsClientFrameSchema = z.discriminatedUnion('kind', [
  wsClientSubscribeSchema,
  wsClientUnsubscribeSchema,
  wsClientPingSchema,
  wsClientPresenceUpdateSchema,
  wsClientPresenceClearSchema,
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
    case 'dispatch.presence':
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
