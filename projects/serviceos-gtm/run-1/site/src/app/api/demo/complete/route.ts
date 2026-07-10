import { NextResponse } from 'next/server';
import { onTrialStarted } from '@/lib/lifecycle';
import { getPlan } from '@/lib/plans';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Demo-mode completion. Runs the SAME onTrialStarted() hook the real Stripe
 * `checkout.session.completed` webhook fires, so the lifecycle + nurture path is
 * exercised identically without any Stripe keys.
 */
export async function POST(request: Request) {
  let body: { plan?: unknown; email?: unknown; businessName?: unknown; vertical?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const plan = getPlan(body.plan);
  const email = typeof body.email === 'string' ? body.email : undefined;
  const businessName = typeof body.businessName === 'string' ? body.businessName : undefined;
  const vertical = typeof body.vertical === 'string' ? body.vertical : undefined;

  await onTrialStarted({
    email,
    businessName,
    vertical,
    plan: plan.id,
    stripeSessionId: 'demo_session',
    data: { demo: true },
  });

  return NextResponse.json({ ok: true });
}
