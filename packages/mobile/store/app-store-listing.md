# Rivet — App Store (iOS) Listing

Copy + metadata for the Apple App Store Connect listing of the Rivet
mobile app (`packages/mobile`). Source of truth for messaging is
`docs/launch/2026-06-03-rivet-gtm-brief.md`; when this disagrees with the
brief, the brief wins.

> **Positioning note (App Store guideline 3.1.1):** The Rivet app is a
> companion to the web service. Account creation and the 14-day free trial
> happen on the **web** (therivetapp.com); the app signs you into an existing
> account. The app does **not** sell subscriptions through an external
> mechanism, so it does not need — and must not add — in-app purchase for
> the subscription. Keep the listing free-to-download with no in-app
> purchase items.

See also `app-review-notes.md` for App Review walkthrough + demo accounts.

---

## Identity

| Field | Value |
|---|---|
| App name | **Rivet: AI for Home Services** (30-char limit — fallback: "Rivet — AI Dispatcher") |
| Subtitle | **Answer calls. Quote. Get paid.** (30-char limit) |
| Bundle ID | `com.serviceos.app` (kept; user-invisible — changing after release is disruptive) |
| Primary category | Business |
| Secondary category | Productivity |
| Price | Free (subscription managed on the web) |
| Age rating | 4+ |

## Promotional text (170 chars, updatable without review)

> Your AI dispatcher in your pocket. Speak an action between jobs and Rivet
> drafts the quote, sends the invoice, and chases payment. Approve in a tap.

## Description (≤4000 chars)

Rivet is the AI back office for solo HVAC and plumbing operators. You
learned the trade — Rivet runs the business.

The app puts your shop in your pocket — one binary for supervisors and
technicians:

• Speak an action — "just finished the Rodriguez job, bill 3 hours and the
  parts" — and Rivet drafts the invoice for you to approve.
• Approvals inbox — every quote, invoice, and follow-up waiting on you,
  with a live count. Approve, edit, or reject in one tap.
• Money dashboard — today's revenue, what's collected, and what's still
  chasing, at a glance.
• Technician Today — assigned jobs, en route / running late, voice notes,
  and job photos when you're connected.
• Needs a connection for voice and photos — if you drop offline, Rivet
  shows a reconnect banner; capture resumes when you're back online.

Rivet tells you the truth. Every evening you get one text: what got done,
what got paid, and what Rivet wasn't sure about today. Nothing irreversible
is ever sent to a customer without your approval.

New to Rivet? Start your 14-day free trial at therivetapp.com — setup takes about
15 minutes — then sign in here. Your account works on the web and the app.

Built for the 1–3 truck shop with no office. Not for you if you've already
got a dedicated office manager and a 20-truck fleet.

## Keywords (100 chars, comma-separated, no spaces)

`hvac,plumbing,dispatcher,invoicing,quotes,field service,contractor,ai,scheduling,payments,receptionist`

## URLs

| Field | Value |
|---|---|
| Marketing URL | https://therivetapp.com |
| Support URL | https://therivetapp.com/download |
| Privacy Policy URL | https://therivetapp.com/privacy |

## App Privacy ("nutrition label") — data collected and linked to the user

Declare in App Store Connect → App Privacy:

- **Contact info** — name, email, phone (account; via Clerk).
- **User content** — voice audio, job photos, messages, customer/job records
  (app functionality).
- **Location** — precise location when the technician Today surface is open
  (field GPS) and when enabling Tap to Pay / Stripe Terminal readers. Not
  used for continuous background tracking (`isIosBackgroundLocationEnabled`
  is false).
- **Identifiers** — user/account ID (app functionality).
- **Diagnostics** — crash/performance data from the platform where available.

**Not collected on mobile:** product-analytics SDKs (no PostHog or similar
in `packages/mobile`). Not used for tracking across other companies' apps;
no third-party ad SDKs.

Permissions the binary requests (see `app.json`):

- **Microphone** — voice actions and field voice notes.
- **Camera** — job photos (barcode scanning disabled).
- **Location (when in use)** — tech GPS while Today is open + Tap to Pay /
  Terminal.
- **Bluetooth / local network** — Stripe Terminal card readers.
- **Notifications** — approvals, job updates, end-of-day digest.

See `packages/web` Privacy Policy (`/privacy`) for the full disclosure.

## Screenshot plan (6.7" + 6.1" + 5.5" required sizes)

Capture from both personas with seeded demo data:

1. Supervisor home — "Speak an action" with money/approvals summary.
2. Approvals inbox with a live count.
3. A proposal review (quote) with Approve / Edit / Reject.
4. Money dashboard (revenue + month-to-date).
5. Technician Today — assigned jobs + status actions.
6. Job photo / voice note capture (connected state).

Caption each with the value, e.g. "Approve a quote in one tap",
"See what you're owed", "Speak it — Rivet drafts the rest".

---

## Launch blockers (resolve before first submission)

- [ ] **`eas init`** — fills `extra.eas.projectId` (kept as `""` placeholder
      in repo until then).
- [ ] **Apple Developer Program** membership + App Store Connect app record
      + Apple Team ID wired into `eas.json` `submit.production.ios`
      (`REPLACE_WITH_*` placeholders).
- [ ] Real Rivet mark replacing placeholder `assets/*.png` before public
      store screenshots (scaffold PNGs are present for builds).
- [ ] Real screenshots captured at all required device sizes.
- [ ] Privacy Policy + Support pages live at the URLs above.
- [ ] Dual demo accounts provisioned for App Review (see
      `app-review-notes.md`).
