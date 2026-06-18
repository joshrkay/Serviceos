/**
 * Mobile push-notification device contracts.
 *
 * Shared between the API (registration route + push-send worker) and the
 * mobile client (Capacitor `packages/web/src/native/pushClient.ts`) so both
 * sides agree on the registration payload and the enqueued push job shape.
 *
 * Tenant scoping: a device token belongs to whatever tenant the logged-in
 * user is in. `tenantId`/`userId` are NEVER taken from the request body —
 * the route derives them from `req.auth`. The body carries only the
 * platform + the opaque provider token.
 */
import { z } from 'zod';

/** Platforms a device token can come from. */
export const DEVICE_PLATFORMS = ['ios', 'android'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * `POST /api/devices` request body. Tenant + user come from auth, not here.
 * The `token` is the unified FCM registration token (see
 * `@capacitor-firebase/messaging`) — opaque to us, capped to a sane length.
 */
export const RegisterDeviceSchema = z.object({
  platform: z.enum(DEVICE_PLATFORMS),
  token: z.string().min(1).max(4096),
});
export type RegisterDeviceBody = z.infer<typeof RegisterDeviceSchema>;

/** Queue job type for an enqueued push send (the `app.ts` workerRegistry key). */
export const PUSH_NOTIFICATION_JOB_TYPE = 'push.send';

/**
 * Payload enqueued onto the queue for the push-notification worker. The
 * worker loads the tenant's device tokens (RLS-scoped) and sends to each.
 * When `userId` is set the send is narrowed to that user's devices.
 */
export const PushNotificationJobSchema = z.object({
  tenantId: z.string().uuid(),
  /** Optional: narrow the send to a single user's devices. */
  userId: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  /** Optional string-only data bag (deep-link target, entity ids, …). */
  data: z.record(z.string(), z.string()).optional(),
  /** Actor for the audit event; defaults to the system actor in the worker. */
  actorId: z.string().min(1).optional(),
  correlationId: z.string().optional(),
});
export type PushNotificationJob = z.infer<typeof PushNotificationJobSchema>;
