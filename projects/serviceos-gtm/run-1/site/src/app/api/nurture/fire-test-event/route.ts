import { NextResponse } from 'next/server';
import { onTrialStarted } from '@/lib/lifecycle';
import { TEST_CONTACT_ALLOWLIST } from '@/lib/nurture/allowlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Demo-only endpoint for /nurture-preview: fires a `trial_started` lifecycle
 * event for a chosen test contact through the SAME onTrialStarted() hook the
 * real Stripe webhook and demo-checkout flow use, so a reviewer can watch the
 * welcome email land in the in-memory mailbox end to end.
 *
 * The `contact` must be one of the allowlisted test addresses (allowlist.ts).
 * Anything else falls back to the first allowlist entry — this endpoint never
 * enrolls a non-test address, since the send-path gate would block it anyway.
 */
export async function POST(request: Request) {
  let body: { contact?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // No/invalid JSON body is fine — fall back to the default test contact.
  }

  const requested = typeof body.contact === 'string' ? body.contact : undefined;
  const contact =
    requested && TEST_CONTACT_ALLOWLIST.includes(requested) ? requested : TEST_CONTACT_ALLOWLIST[0];

  await onTrialStarted({
    email: contact,
    businessName: 'Rivet Test Shop',
    vertical: 'HVAC',
    plan: 'shop',
    data: {
      source: 'nurture-preview.fire-test-event',
      calls_answered: 12,
      bookings_approved: 5,
      estimates_drafted: 3,
      invoices_sent: 2,
    },
  });

  return NextResponse.json({ ok: true, contact, event: 'trial_started' });
}
