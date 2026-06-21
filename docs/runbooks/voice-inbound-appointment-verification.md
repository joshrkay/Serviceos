# Runbook — Verify inbound voice appointment-setting (live call)

**Purpose:** prove, with a real phone call, that the AI voice agent answers an
inbound call to a tenant's number, captures the caller's reason for visit, and
books an appointment **after human approval**. This is the telephony leg that CI
cannot run; the automated proof is
`packages/api/test/integration/voice-inbound-appointment.test.ts` (real-Postgres
routing + reason persistence + approval gate).

## What this certifies

- **Routing:** a call to the tenant's provisioned DID reaches *that tenant's* AI
  agent (dialed-number → tenant via `tenant_integrations.provider_data->>'phoneE164'`).
- **Reason capture:** the spoken reason ("…my water heater is leaking") lands on
  the booked appointment's `notes`.
- **Human-approval gate:** no appointment exists until the proposal is approved.

> **Path note.** The path that actually books today is the **Twilio Gather**
> voice path (`POST /api/telephony/voice` → `/api/telephony/gather`). The VAPI
> webhook path records call sessions/activation but does **not** create
> appointments yet — do not use it to certify booking. (Tracked as deferred
> follow-up in the plan.)

## Prerequisites

- A running environment (Railway deploy, or local API+web with a public
  callback URL, e.g. an `ngrok`/tunnel pointing at `/api/telephony/voice`).
- **Real Twilio credentials** with billing enabled. Twilio *test* credentials
  cannot place or receive real calls — use live/trial creds and a real DID.
- A test tenant whose onboarding has reached the phone step.
- Trust settings such that a voice `create_appointment` proposal lands in
  **review** (supervisor present / not auto-approving), so you can observe the
  approval gate. If the tenant auto-approves, temporarily disable it for the run.
- A second phone to place the inbound call from.

## Procedure

### 1. Claim a number with the picker
1. In onboarding, open the **Phone** step.
2. Under **"Pick your own number"**, enter an area code → **Search**.
3. Choose a candidate → **Claim**.
4. Confirm provisioning completes: `tenant_integrations` for this tenant shows
   `status = 'full_readiness'` and `provider_data->>'phoneE164'` = the claimed
   number. (Fallback "let us pick a number for you" is fine if search is
   unavailable.)

### 2. Place the inbound call
5. From the second phone, call the claimed number.
6. When the agent answers, say (clearly):
   > "I need someone to come out next Tuesday at 2 pm — my water heater is leaking."

### 3. Observe the proposal (gate)
7. In the app's review inbox, a **create_appointment** proposal appears for this
   tenant, showing the **resolved** date/time (in the tenant timezone) and the
   reason ("water heater is leaking"). The read-back to the caller should state
   the resolved time, not the raw phrase.
8. **Before approving**, confirm there is **no** appointment yet for the tenant
   (UI calendar empty for that slot, or DB query in step 10 returns 0). This is
   the human-approval gate.

### 4. Approve and verify
9. Approve the proposal. After the ~5s undo window, the execution worker books it.
10. Verify the appointment persisted with the reason. Via the app: the calendar
    shows the appointment at the resolved time. Via DB (read-only):
    ```sql
    SELECT scheduled_start, scheduled_end, timezone, status, notes
    FROM appointments
    WHERE tenant_id = '<TENANT_ID>'
    ORDER BY created_at DESC
    LIMIT 1;
    ```
    Expect: `notes` contains the spoken reason (e.g. "Leaking water heater"),
    `status = 'scheduled'`, times stored UTC, `timezone` = the tenant's zone.

## Evidence to capture
- Screenshot of the proposal card (resolved time + reason).
- Screenshot of the booked appointment on the calendar.
- The DB row from step 10 (proves `notes` carries the reason).
- The call recording/transcript (optional, for the read-back).

## Troubleshooting
- **Agent doesn't answer / "not in service":** the dialed number didn't resolve
  to a tenant. Check `provider_data->>'phoneE164'` matches the DID and that the
  number's Twilio Voice URL points at `…/api/telephony/voice`. Check after-hours
  mode isn't sending the call to voicemail.
- **No proposal appears:** check intent classification — the utterance must
  classify as `create_appointment` with a resolvable time. "Sometime Tuesday"
  (no time) intentionally becomes a `voice_clarification`, not a booking.
- **Proposal booked without review:** the tenant is auto-approving; disable it
  for the run to exercise the gate.
- **Reason missing from the appointment:** ensure the deploy includes the
  reason-persistence fix (execution handler persists `notes ?? summary`).

## Related
- Automated proof (CI): `packages/api/test/integration/voice-inbound-appointment.test.ts`
- Picker UI contract: `packages/web/src/components/onboarding/v2/steps/PhoneStep.test.tsx`
- Picker mobile layout: `e2e/onboarding-phone-picker-mobile.spec.ts`
- Plan: `docs/plans/2026-06-14-001-feat-voice-appointment-verification-and-phone-picker-plan.md`
