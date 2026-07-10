/**
 * Lifecycle event bus.
 *
 * A small typed layer that every trial/subscription state transition flows
 * through. It (a) logs a structured event and (b) forwards to the nurture engine
 * hook. Stripe webhooks and the demo-mode completion endpoint both call the same
 * on* hooks, so demo mode exercises the exact same path real Stripe events do.
 *
 * The lifecycle "state machine" is intentionally thin: it maps an incoming
 * subscription status transition to a canonical lifecycle event type.
 */

import { notifyNurture } from './nurture/trigger';

export type LifecycleEventType =
  | 'trial_started'
  | 'trial_converted'
  | 'payment_past_due'
  | 'payment_failed'
  | 'canceled';

export interface LifecycleContext {
  email?: string;
  businessName?: string;
  vertical?: string;
  plan?: string;
  /** Stripe object ids for traceability. */
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeSessionId?: string;
  /** Any extra structured data to attach. */
  data?: Record<string, unknown>;
}

export interface LifecycleEvent extends LifecycleContext {
  type: LifecycleEventType;
  at: string;
}

async function emit(type: LifecycleEventType, ctx: LifecycleContext): Promise<LifecycleEvent> {
  const event: LifecycleEvent = {
    type,
    at: new Date().toISOString(),
    ...ctx,
  };

  // (a) structured log
  console.log(
    JSON.stringify({
      source: 'lifecycle',
      event: type,
      email: ctx.email,
      businessName: ctx.businessName,
      vertical: ctx.vertical,
      plan: ctx.plan,
      stripeCustomerId: ctx.stripeCustomerId,
      stripeSubscriptionId: ctx.stripeSubscriptionId,
      stripeSessionId: ctx.stripeSessionId,
      at: event.at,
    }),
  );

  // (b) nurture engine hook
  await notifyNurture(event);

  return event;
}

export function onTrialStarted(ctx: LifecycleContext): Promise<LifecycleEvent> {
  return emit('trial_started', ctx);
}

export function onTrialConverted(ctx: LifecycleContext): Promise<LifecycleEvent> {
  return emit('trial_converted', ctx);
}

export function onPaymentPastDue(ctx: LifecycleContext): Promise<LifecycleEvent> {
  return emit('payment_past_due', ctx);
}

export function onPaymentFailed(ctx: LifecycleContext): Promise<LifecycleEvent> {
  return emit('payment_failed', ctx);
}

export function onCanceled(ctx: LifecycleContext): Promise<LifecycleEvent> {
  return emit('canceled', ctx);
}

/**
 * State machine: map a Stripe `customer.subscription.updated` status transition
 * to a lifecycle event type. Returns null when the transition is not one we act
 * on (so the webhook can no-op cleanly).
 *
 * Rules:
 *   trialing -> active   => trial_converted
 *   * -> past_due        => payment_past_due
 *   * -> canceled        => canceled  (usually delivered via subscription.deleted)
 */
export function resolveSubscriptionTransition(
  previousStatus: string | undefined,
  currentStatus: string,
): LifecycleEventType | null {
  if (currentStatus === 'past_due') return 'payment_past_due';
  if (currentStatus === 'canceled') return 'canceled';
  if (previousStatus === 'trialing' && currentStatus === 'active') return 'trial_converted';
  return null;
}
