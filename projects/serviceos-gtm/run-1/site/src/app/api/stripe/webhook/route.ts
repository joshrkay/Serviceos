import { NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/stripe';
import { processedWebhookEvents } from '@/lib/idempotency';
import {
  onTrialStarted,
  onTrialConverted,
  onPaymentPastDue,
  onPaymentFailed,
  onCanceled,
  resolveSubscriptionTransition,
  type LifecycleContext,
} from '@/lib/lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
    previous_attributes?: Record<string, unknown>;
  };
}

/** Pull common lifecycle context out of a Stripe object's metadata + top-level fields. */
function contextFrom(object: Record<string, unknown>): LifecycleContext {
  const metadata = (object.metadata as Record<string, string> | undefined) ?? {};
  return {
    email:
      (object.customer_email as string | undefined) ??
      (object.email as string | undefined) ??
      undefined,
    businessName: metadata.business_name,
    vertical: metadata.vertical,
    plan: metadata.plan,
    stripeCustomerId:
      typeof object.customer === 'string' ? object.customer : undefined,
    stripeSubscriptionId:
      typeof object.subscription === 'string'
        ? object.subscription
        : typeof object.id === 'string' && object.object === 'subscription'
          ? (object.id as string)
          : undefined,
    stripeSessionId:
      typeof object.id === 'string' && object.object === 'checkout.session'
        ? (object.id as string)
        : undefined,
  };
}

/**
 * Stripe webhook handler. Verifies the HMAC signature, is idempotent by event id,
 * and maps each event type through the lifecycle bus -> nurture engine.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Webhook secret not configured.' }, { status: 500 });
  }

  const payload = await request.text();
  const signature = request.headers.get('stripe-signature');

  const verification = verifyWebhookSignature({ payload, signatureHeader: signature, secret });
  if (!verification.valid) {
    return NextResponse.json(
      { error: `Invalid signature: ${verification.reason}` },
      { status: 400 },
    );
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  // Idempotency: skip if we have already processed this event id.
  if (processedWebhookEvents.seen(event.id)) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  const object = event.data.object;
  const ctx = contextFrom(object);

  switch (event.type) {
    case 'checkout.session.completed':
      await onTrialStarted(ctx);
      break;

    case 'customer.subscription.updated': {
      const previousStatus = (event.data.previous_attributes?.status as string | undefined) ?? undefined;
      const currentStatus = (object.status as string | undefined) ?? '';
      const transition = resolveSubscriptionTransition(previousStatus, currentStatus);
      if (transition === 'trial_converted') await onTrialConverted(ctx);
      else if (transition === 'payment_past_due') await onPaymentPastDue(ctx);
      else if (transition === 'canceled') await onCanceled(ctx);
      // no-op for transitions we don't act on
      break;
    }

    case 'customer.subscription.deleted':
      await onCanceled(ctx);
      break;

    case 'invoice.payment_failed':
      await onPaymentFailed(ctx);
      break;

    default:
      // Acknowledge unhandled events so Stripe stops retrying.
      break;
  }

  return NextResponse.json({ received: true });
}
