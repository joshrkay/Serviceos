# Book on the call (D-015 autonomous booking)

How a shop turns on **in-call appointment confirmation** so callers leave
with a held, confirmed time without waiting for an owner mid-call.

## What it does

When **Confirm appointments on the call** is enabled
(`tenant_settings.autonomous_booking_enabled`):

1. The AI receptionist classifies a booking request and places a **24h hold**
   on the slot (when customer + job + spoken time resolve).
2. If every **D-015** gate passes (confidence, clean entities, business hours,
   no emergency/negotiation/vulnerability flags, hold live), the booking
   **auto-approves** after the normal 5-second undo window.
3. The customer hears a **confirmed** line and can receive SMS confirmation.
4. The owner gets an immediate SMS with **one-tap UNDO** (cancels + apology), sent to
   the owner cell (`tenant_settings.owner_phone`) and naming the customer and time. The
   link opens a confirm page; the booking is undone only when the owner taps **Undo
   booking** (link previews cannot cancel it). No owner cell, no auto-approval.

Money, invoices, and other irreversible actions are **not** covered — only
`create_appointment` / `create_booking` capture-class bookings.

## How to enable

1. Make sure the owner's cell number is set (**Settings → Business profile**). Without it
   the toggle has no effect: every booking waits for review (`owner_cell_missing`).
2. Open **Settings → AI approval rules** in the web app and toggle
   **Confirm appointments on the call**.
3. Optionally set the confidence threshold (0.90–0.99, default 0.95).
4. Save.

Default for existing tenants remains **OFF** (trust posture). New shops
should be shown this toggle during onboarding if product prioritizes
on-call conversion.

## Platform kill switch

Ops can disable the lane for every tenant without a settings sweep:

```bash
AUTONOMOUS_BOOKING_DISABLED=true
```

Stamped reason: `platform_disabled` (distinct from `tenant_not_opted_in`).

## When a call does not auto-confirm

The AI still **speaks honestly** — reserved pending team confirmation — and
leaves a draft/held booking for the owner. Common ineligible reasons:

- Tenant has not opted in
- No owner cell on file (`owner_cell_missing`); a backup supervisor's mobile does not count
- The owner UNDO SMS cannot be sent (`undo_channel_unavailable`: no SMS provider, no
  one-tap signing secret `ONE_TAP_APPROVE_SECRET`, or `PUBLIC_API_URL` not an https,
  non-localhost origin in production)
- The caller-ID match is not STIR A-attested, or the customer was created on this call
  (`no_verified_customer`)
- The slot conflicts with the customer's or technician's other appointments, or the
  conflict check is not wired (`slot_conflict`)
- The same slot was already auto-booked on this call (`duplicate_booking`)
- The caller is speaking Spanish (`language_unsupported`; the confirmation copy is
  English-only)
- The intent was matched by a fixed phrase rule rather than the model, so there is no
  model confidence (`below_threshold`)
- Confidence below threshold
- Missing customer / job / time resolution
- Slot outside business hours
- Negotiation / emergency / vulnerability flags on the session
- Platform kill switch

## Related code

- Lane: `packages/api/src/proposals/autonomous-lane.ts`
- Live speech + upgrade: `packages/api/src/ai/voice-turn/inbound-booking-completion.ts`
- Hold: `packages/api/src/ai/scheduling/place-hold.ts`
- UI: `packages/web/src/components/settings/AIApprovalRulesSheet.tsx`
- Decision: `docs/decisions.md` D-015
