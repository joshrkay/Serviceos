# Rivet — App Store (iOS) Listing

Copy + metadata for the Apple App Store Connect listing of the Rivet
mobile app (`packages/mobile`). Source of truth for messaging is
`docs/launch/2026-06-03-rivet-gtm-brief.md`; when this disagrees with the
brief, the brief wins.

> **Positioning note (App Store guideline 3.1.1):** The Rivet app is a
> companion to the web service. Account creation and the 14-day free trial
> happen on the **web** (rivet.ai); the app signs you into an existing
> account. The app does **not** sell subscriptions through an external
> mechanism, so it does not need — and must not add — in-app purchase for
> the subscription. Keep the listing free-to-download with no in-app
> purchase items.

---

## Identity

| Field | Value |
|---|---|
| App name | **Rivet: AI for Home Services** (30-char limit — fallback: "Rivet — AI Dispatcher") |
| Subtitle | **Answer calls. Quote. Get paid.** (30-char limit) |
| Bundle ID | `com.serviceos.app` — ⚠️ see launch blockers |
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

The app puts your shop in your pocket:

• Speak an action — "just finished the Rodriguez job, bill 3 hours and the
  parts" — and Rivet drafts the invoice for you to approve.
• Approvals inbox — every quote, invoice, and follow-up waiting on you,
  with a live count. Approve, edit, or reject in one tap.
• Money dashboard — today's revenue, what's collected, and what's still
  chasing, at a glance.
• Works in the field — recordings queue offline and upload the moment
  you're back in range.

Rivet tells you the truth. Every evening you get one text: what got done,
what got paid, and what Rivet wasn't sure about today. Nothing irreversible
is ever sent to a customer without your approval.

New to Rivet? Start your 14-day free trial at rivet.ai — setup takes about
15 minutes — then sign in here. Your account works on the web and the app.

Built for the 1–3 truck shop with no office. Not for you if you've already
got a dedicated office manager and a 20-truck fleet.

## Keywords (100 chars, comma-separated, no spaces)

`hvac,plumbing,dispatcher,invoicing,quotes,field service,contractor,ai,scheduling,payments,receptionist`

## URLs

| Field | Value |
|---|---|
| Marketing URL | https://rivet.ai |
| Support URL | https://rivet.ai/download |
| Privacy Policy URL | https://rivet.ai/privacy |

## App Privacy ("nutrition label") — data collected and linked to the user

Declare in App Store Connect → App Privacy:

- **Contact info** — name, email, phone (account; via Clerk).
- **User content** — audio recordings, messages, customer/job records
  (app functionality).
- **Identifiers** — user/account ID (app functionality).
- **Usage data** — product interaction (analytics; PostHog).
- **Diagnostics** — crash/performance data.

Not used for tracking across other companies' apps; no third-party ad SDKs.
See `packages/web` Privacy Policy (`/privacy`) for the full disclosure.

## Permissions strings (already in app.json)

- Microphone: "Allow Rivet to use the microphone to capture voice actions."
  (⚠️ currently reads "ServiceOS" — see launch blockers.)
- Notifications: push for new approvals and the end-of-day digest.

## Screenshot plan (6.7" + 6.1" + 5.5" required sizes)

Capture from the app's main screens with seeded demo data:

1. Home — "Speak an action" with the greeting + money/approvals summary.
2. Approvals inbox with a live count.
3. A proposal review (quote) with Approve / Edit / Reject.
4. Money dashboard (revenue + month-to-date).
5. Messages thread.

Caption each with the value, e.g. "Approve a quote in one tap",
"See what you're owed", "Speak it — Rivet drafts the rest".

---

## Launch blockers (resolve before first submission)

- [ ] **Rebrand the binary:** `app.json` still uses `name: "ServiceOS"`,
      `slug: serviceos-mobile`, scheme `serviceos`, and the microphone
      permission string says "ServiceOS". Decide whether the bundle id
      `com.serviceos.app` ships as-is (it's user-invisible and changing it
      after release is disruptive) or is renamed before first release.
- [ ] **App icon:** `assets/icon.png` is a placeholder — replace with the
      Rivet mark before submission.
- [ ] **Apple Developer Program** membership + App Store Connect app record
      + Apple Team ID wired into `eas.json` `submit` config.
- [ ] Real screenshots captured at all required device sizes.
- [ ] Privacy Policy + Support pages live at the URLs above.
