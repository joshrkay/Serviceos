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
4. The owner gets an immediate SMS with **one-tap UNDO** (cancels + apology).

Money, invoices, and other irreversible actions are **not** covered — only
`create_appointment` / `create_booking` capture-class bookings.

## How to enable

1. Open **Settings → AI approval rules** in the web app.
2. Toggle **Confirm appointments on the call**.
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
