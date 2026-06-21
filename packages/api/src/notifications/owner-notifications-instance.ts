/**
 * Process-wide accessor for the owner-notification fan-out.
 *
 * Producer seams (inbound call/SMS, appointment reminder/cancellation, payment,
 * lead, escalation) are scattered across the codebase and constructed at
 * different times; rather than thread the service through every constructor,
 * `app.ts` registers a single {@link OwnerNotificationService} here and each
 * seam calls {@link notifyOwner}. Mirrors the existing late-bound proposal-push
 * slots. Failure-isolated: if no service is registered (e.g. a unit test that
 * didn't wire one) the call is a silent no-op.
 *
 * Tests register an instance backed by `InMemoryPushDeliveryProvider` via
 * {@link setOwnerNotifications} and assert on what would have been sent.
 */
import type { NotificationType } from '@ai-service-os/shared';
import {
  type NotificationContextMap,
  type OwnerNotificationService,
} from './owner-notification-service';

let instance: OwnerNotificationService | undefined;

/** Register (or clear, with `undefined`) the active service. Called once in `app.ts`. */
export function setOwnerNotifications(service: OwnerNotificationService | undefined): void {
  instance = service;
}

/**
 * Send an owner notification through the registered service. No-op (and never
 * throws) when none is registered. The service itself is failure-isolated.
 */
export async function notifyOwner<K extends NotificationType>(
  tenantId: string,
  type: K,
  ctx: NotificationContextMap[K],
): Promise<void> {
  await instance?.notify(tenantId, type, ctx);
}
