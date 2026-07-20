# Rivet Mobile — App Review Notes

Paste into App Store Connect → App Review Information (Notes) and mirror
the same guidance in Google Play Console → App content / testing notes.

Binary: Expo app in `packages/mobile` (`com.serviceos.app`). One app
serves **supervisor** and **technician** personas (see decision D-021).

---

## Guideline 3.1.1 — Sign-up / trial on the web (no IAP)

Rivet is a **companion** to the web product at https://rivet.ai.

- **Account creation** and the **14-day free trial** happen on the web.
- The mobile app only **signs into an existing account** (Clerk).
- The subscription is billed on the web; the app does **not** unlock paid
  features via an external purchase flow inside the binary.
- Therefore there is **no In-App Purchase** and none should be configured
  in App Store Connect / Play Billing for the subscription.

If reviewers need a fresh trial account beyond the demos below, create one
at https://rivet.ai (or ask the contact listed in App Review Information).

---

## Demo accounts (dual persona)

Provision two accounts on the same demo tenant before submission. Put the
live passwords in App Store Connect / Play confidential fields (do not
commit passwords to git).

| Persona | Suggested email | Role / mode | What they see |
|---|---|---|---|
| Supervisor | `reviewer-supervisor@rivet.ai` | owner or dispatcher | Voice actions, Approvals inbox, Money dashboard, Messages |
| Technician | `reviewer-technician@rivet.ai` | technician | Today (assigned jobs), en route / running late, voice notes, job photos, foreground GPS while Today is open |

Both accounts should share the same tenant so supervisor approvals and
technician field updates are visible end-to-end.

---

## Device / OS requirements

- **iOS:** physical iPhone recommended (push + Tap to Pay / Terminal are
  limited or unsupported on Simulator). Portrait phone; tablets not
  supported (`supportsTablet: false`).
- **Android:** API 26+ (`minSdkVersion` 26). Physical device for Bluetooth
  Terminal readers and reliable push.
- **Network:** job photos require a connection. Offline shows a reconnect
  banner. Voice recordings and capture-class approvals captured offline are
  **queued on-device** and flush automatically on reconnect (the banner shows
  "N actions waiting"); other actions still require a connection.
- **Stripe Terminal / Tap to Pay:** optional for review. Location +
  Bluetooth prompts are for Terminal and (on technician) field GPS. Deny
  is OK if not testing payments; core voice/approvals/Today still work.

---

## No in-app purchases

Confirm in App Store Connect and Play Console:

- Price: Free
- In-app products: none
- Subscriptions: none (managed on web)

---

## Feature walkthrough — supervisor

1. Sign in with the **supervisor** demo account.
2. Land on the supervisor home: money summary + approvals count + “speak
   an action”.
3. Grant **microphone** when prompted; record a short voice action (e.g.
   draft a quote/invoice). Confirm a proposal appears for review.
4. Open **Approvals** — open a proposal — **Approve** / Edit / Reject
   (nothing irreversible ships without approval).
5. Open **Money** — confirm today’s / month figures load.
6. Grant **notifications** if prompted; optional: trigger a test push from
   the backend after `POST /api/devices` registration.
7. If testing Terminal: grant **location** + **Bluetooth**, then follow
   the in-app Tap to Pay / reader flow.

## Feature walkthrough — technician

1. Sign out; sign in with the **technician** demo account.
2. Land on **Today** — assigned appointments for the tenant-local date.
3. Open a job — mark **en route** and/or **running late** (customer notice
   paths are server-side).
4. Grant **location (when in use)** — GPS samples while Today is open
   (foreground only; no iOS background location).
5. Grant **camera** — attach a **job photo** while online.
6. Grant **microphone** — capture a **voice note** while online.
7. Toggle airplane mode briefly — confirm the **reconnect banner**. A voice
   note captured offline is **saved and queued** ("N actions waiting") and
   uploads automatically on reconnect; job photos still need a connection.

---

## Contact

Use the App Review / Play Console contact email for password resets or
demo-tenant issues during review.
