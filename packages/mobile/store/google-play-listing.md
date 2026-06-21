# Rivet — Google Play (Android) Listing

Copy + metadata for the Google Play Console listing of the Rivet mobile app
(`packages/mobile`). Messaging source of truth is
`docs/launch/2026-06-03-rivet-gtm-brief.md`.

> **Billing note:** Account creation and the 14-day free trial happen on the
> **web** (rivet.ai). The app signs into an existing account and sells
> nothing in-app, so Google Play Billing is not required for the
> subscription. Keep the app free with no in-app products.

---

## Identity

| Field | Value |
|---|---|
| App name | **Rivet: AI for Home Services** (≤30 chars) |
| Short description | **Your AI dispatcher: answer calls, quote jobs, get paid — approve in a tap.** (≤80 chars) |
| Package name | `com.serviceos.app` — ⚠️ see launch blockers |
| Category | Business |
| Tags | Productivity, Tools |
| Price | Free |
| Content rating | Everyone (complete the IARC questionnaire) |

## Full description (≤4000 chars)

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

Built for the 1–3 truck shop with no office.

## Store listing assets

| Asset | Spec |
|---|---|
| App icon | 512×512 PNG — ⚠️ placeholder today |
| Feature graphic | 1024×500 PNG — "Your AI dispatcher" + Rivet mark |
| Phone screenshots | ≥2 (target 5), 16:9 or 9:16, see plan below |

### Screenshot plan
1. Home — "Speak an action" + money/approvals summary.
2. Approvals inbox with a live count.
3. Proposal/quote review with Approve / Edit / Reject.
4. Money dashboard (revenue + month-to-date).
5. Messages thread.

Caption with the value: "Approve a quote in one tap", "See what you're
owed", "Speak it — Rivet drafts the rest".

## Data safety form (Play Console)

Declare the same categories as the iOS App Privacy label:

- **Personal info** — name, email, phone (account; Clerk). Collected,
  encrypted in transit, used for app functionality + account management.
- **Audio** — voice recordings for voice capture (app functionality).
- **Messages / customer content** — handled to draft quotes and summaries.
- **App activity / analytics** — product interaction (PostHog).
- **Identifiers** — account/user ID.

No data sold. No data shared for third-party advertising. Users can request
deletion via support@rivet.ai (link the Privacy Policy at /privacy).

## URLs

| Field | Value |
|---|---|
| Website | https://rivet.ai |
| Support email | support@rivet.ai |
| Privacy Policy | https://rivet.ai/privacy |

---

## Launch blockers (resolve before first submission)

- [ ] **Rebrand the binary** (`app.json` name/slug/scheme/permission strings
      still say "ServiceOS"; decide on `com.serviceos.app` package — note a
      package name can never change after the first Play release).
- [ ] Real app icon + feature graphic (Rivet mark).
- [ ] Google Play Developer account + `eas.json` `submit.production.android`
      service-account key.
- [ ] Real screenshots captured.
- [ ] Privacy Policy + support live at the URLs above.
