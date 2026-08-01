/**
 * Owner-notification taxonomy — the wire contract shared by the API (producer)
 * and the mobile app (the tap-router + foreground presenter).
 *
 * Push transport historically carried only the proposal payload
 * (`{ proposalId, kind, screen }`); this generalizes it to a typed set of
 * owner-facing notification kinds. Every notification carries `type` (what
 * happened) and `screen` (an absolute in-app deep link the client routes to,
 * validated against an allowlist on the client). The proposal fields are kept
 * optional for back-compat with the original router.
 */
import { z } from 'zod';

export const NOTIFICATION_TYPES = [
  'proposal_needs_approval',
  'proposal_executed',
  'incoming_call',
  'inbound_sms',
  'appointment_reminder',
  'appointment_cancellation',
  // Epic 6 — technician dispatch. User-targeted (the assigned tech), not
  // permission-broadcast: 'appointment_assigned' tells a tech they have a new
  // job; 'appointment_unassigned' tells a tech a job was moved off them.
  'appointment_assigned',
  'appointment_unassigned',
  'payment_received',
  'invoice_overdue',
  'lead_captured',
  'escalation',
  'emergency',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * The `data` payload delivered with every owner push. `passthrough()` keeps any
 * extra producer fields; the client reads `type` + `screen` (+ legacy
 * `proposalId`). `screen` is an absolute in-app path (e.g. `/customers/123`).
 */
export const notificationDataSchema = z
  .object({
    type: z.enum(NOTIFICATION_TYPES),
    screen: z.string().regex(/^\//, 'screen must be an absolute in-app path'),
    /** Primary entity the screen renders (customer/conversation/proposal/…). */
    entityId: z.string().optional(),
    /** Back-compat: the original proposal router keyed on these. */
    proposalId: z.string().optional(),
    kind: z.string().optional(),
  })
  .passthrough();

export type NotificationData = z.infer<typeof notificationDataSchema>;

/**
 * Types that should interrupt — present a foreground alert + sound on the
 * device rather than only setting the badge. Time-critical, owner-must-see-now.
 */
export const HIGH_PRIORITY_NOTIFICATION_TYPES: readonly NotificationType[] = [
  'incoming_call',
  'escalation',
  'emergency',
];

export function isHighPriorityNotification(type: NotificationType): boolean {
  return HIGH_PRIORITY_NOTIFICATION_TYPES.includes(type);
}
