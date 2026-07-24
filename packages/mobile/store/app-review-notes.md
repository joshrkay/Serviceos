# Rivet Mobile — App Review Notes

Paste into App Store Connect → App Review Information (Notes) and mirror
the same guidance in Google Play Console → App content / testing notes.

Binary: Expo app in `packages/mobile` (`com.serviceos.app`). One app
serves **supervisor** and **technician** personas (see decision D-021).

---

## Guideline 3.1.1 — Sign-up / trial on the web (no IAP)

Rivet is a **companion** to the web product at https://therivetapp.com.

- **Account creation** and the **14-day free trial** happen on the web.
- The mobile app only **signs into an existing account** (Clerk).
- The subscription is billed on the web; the app does **not** unlock paid
  features via an external purchase flow inside the binary.
- Therefore there is **no In-App Purchase** and none should be configured
  in App Store Connect / Play Billing for the subscription.

If reviewers need a fresh trial account beyond the demos below, create one
at https://therivetapp.com (or ask the contact listed in App Review
Information).

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

## Account deletion (guideline 5.1.1(v))

Settings → **Delete account** offers fully in-app deletion: a warning step,
an explicit destructive confirmation, then the account is deleted (access
revoked, sign-in disabled) and the app returns to the sign-in screen. A sole
workspace owner is asked to transfer ownership first so a business can't be
orphaned; the demo tenant has both personas, so deletion is testable with
the technician account. Note for review testing: a deleted demo account
cannot sign back in — please use the technician account last, or ask the
review contact to re-provision it.

---

## Call customer (click-to-call) — what to expect

The "Call customer" action does **not** open an in-app calling UI and the
app declares no VoIP/audio background modes. Tapping it POSTs to our
backend, which places a **server-side Twilio PSTN call**: it first rings
the signed-in user's **callback number** (set in Settings), then bridges
that call to the customer with the business caller-ID. The app itself
never captures or plays call audio.

During review this flow cannot complete end-to-end: the demo tenant's
customers use **synthetic (+1 555…) phone numbers**, so the bridge will
not reach a real person. It is safe to tap — expect either an immediate
in-app confirmation (call initiated) or a friendly error, and no charge
or real call to any third party. To observe the ring-back leg, enter a
real phone number you control as the callback number in Settings first.

---

## Contact

Use the App Review / Play Console contact email for password resets or
demo-tenant issues during review.
