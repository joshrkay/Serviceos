import { NextResponse } from 'next/server';
import { getPlan, isPlanId, isVertical } from '@/lib/plans';
import { hasStripeKey, createCheckoutSession } from '@/lib/stripe';
import { getSiteUrl } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CheckoutBody {
  businessName?: unknown;
  yourName?: unknown;
  email?: unknown;
  vertical?: unknown;
  plan?: unknown;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let body: CheckoutBody;
  try {
    body = (await request.json()) as CheckoutBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const businessName = typeof body.businessName === 'string' ? body.businessName.trim() : '';
  const yourName = typeof body.yourName === 'string' ? body.yourName.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const vertical = body.vertical;
  const planId = body.plan;

  if (businessName.length < 2) {
    return NextResponse.json({ error: 'Business name is required.' }, { status: 400 });
  }
  if (yourName.length < 2) {
    return NextResponse.json({ error: 'Your name is required.' }, { status: 400 });
  }
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  }
  if (!isVertical(vertical)) {
    return NextResponse.json({ error: 'Please choose a valid trade.' }, { status: 400 });
  }
  if (!isPlanId(planId)) {
    return NextResponse.json({ error: 'Please choose a valid plan.' }, { status: 400 });
  }

  const plan = getPlan(planId);

  // DEMO MODE: no Stripe key configured -> route to the simulated checkout.
  if (!hasStripeKey()) {
    const qs = new URLSearchParams({
      plan: plan.id,
      email,
      business_name: businessName,
      vertical,
    });
    return NextResponse.json({ url: `/signup/demo-checkout?${qs.toString()}` });
  }

  // REAL MODE: create a Stripe Checkout Session (test-mode guardrail enforced in stripe.ts).
  const priceId = process.env[plan.priceEnvVar];
  if (!priceId) {
    return NextResponse.json(
      { error: `Stripe price id not configured (${plan.priceEnvVar}).` },
      { status: 500 },
    );
  }

  const siteUrl = getSiteUrl();
  try {
    const session = await createCheckoutSession({
      priceId,
      customerEmail: email,
      successUrl: `${siteUrl}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${siteUrl}/signup?canceled=1`,
      metadata: {
        business_name: businessName,
        vertical,
        plan: plan.id,
      },
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Checkout failed.';
    // The live-key guardrail throw surfaces here as a 500 with the guardrail message.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
