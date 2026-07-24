# Rivet — Google Play (Android) Listing

Copy + metadata for the Google Play Console listing of the Rivet mobile app
(`packages/mobile`). Messaging source of truth is
`docs/launch/2026-06-03-rivet-gtm-brief.md`.

> **Billing note:** Account creation and the 14-day free trial happen on the
> **web** (therivetapp.com). The app signs into an existing account and sells
> nothing in-app, so Google Play Billing is not required for the
> subscription. Keep the app free with no in-app products.

See also `app-review-notes.md` for reviewer walkthrough + demo accounts.

---

## Identity

| Field | Value |
|---|---|
| App name | **Rivet: AI for Home Services** (≤30 chars) |
| Short description | **Your AI dispatcher: answer calls, quote jobs, get paid — approve in a tap.** (≤80 chars) |
| Package name | `com.serviceos.app` (kept — package names cannot change after first Play release) |
| Category | Business |
| Tags | Productivity, Tools |
| Price | Free |
| Content rating | Everyone (complete the IARC questionnaire) |

## Full description (≤4000 chars)

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

Built for the 1–3 truck shop with no office.

## Store listing assets

| Asset | Spec |
|---|---|
| App icon | 512×512 PNG (Play) / 1024×1024 in `assets/icon.png` for Expo |
| Feature graphic | 1024×500 PNG — "Your AI dispatcher" + Rivet mark |
| Adaptive icon | `assets/adaptive-icon.png` (wired in `app.json`) |
| Notification icon | `assets/notification-icon.png` (white silhouette; tint `#1F5FD6`) |
| Phone screenshots | ≥2 (target 5–6), 16:9 or 9:16, see plan below |

### Screenshot plan
1. Supervisor home — "Speak an action" + money/approvals summary.
2. Approvals inbox with a live count.
3. Proposal/quote review with Approve / Edit / Reject.
4. Money dashboard (revenue + month-to-date).
5. Technician Today — assigned jobs + status actions.
6. Job photo / voice note capture (connected state).

Caption with the value: "Approve a quote in one tap", "See what you're
owed", "Speak it — Rivet drafts the rest".

## Data safety form (Play Console)

Declare:

- **Personal info** — name, email, phone (account; Clerk). Collected,
  encrypted in transit, used for app functionality + account management.
- **Photos and videos** — job photos captured with the camera.
- **Audio files** — voice actions and field voice notes (microphone).
- **Location** — precise location while the technician Today surface is
  open (field GPS) and for Tap to Pay / Stripe Terminal. Not collected
  continuously in the background.
- **Messages / customer content** — handled to draft quotes and summaries.
- **Identifiers** — account/user ID.
- **App info and performance** — crash diagnostics where the platform
  provides them.

**Not collected on mobile:** product-analytics SDKs (no PostHog or similar
in `packages/mobile`).

No data sold. No data shared for third-party advertising. Users can delete
their account **in-app** (Settings → Delete account), which permanently
revokes access; business records created for the workspace are retained for
bookkeeping/audit per the Privacy Policy at /privacy. Support:
support@rivet.ai.

## Permissions (binary)

Declared / requested via Expo plugins in `app.json`:

- Microphone — voice actions and field voice notes.
- Camera — job photos (barcode scanning disabled).
- Location (when in use) — tech GPS + Tap to Pay / Terminal.
- Bluetooth — Stripe Terminal readers.
- Notifications — approvals, job updates, digests.

## URLs

| Field | Value |
|---|---|
| Website | https://therivetapp.com |
| Support email | support@rivet.ai |
| Privacy Policy | https://therivetapp.com/privacy |

---

## Launch blockers (resolve before first submission)

- [ ] **`eas init`** — fills `extra.eas.projectId` (repo keeps `""` until then).
- [ ] Google Play Developer account + replace
      `eas.json` `submit.production.android.serviceAccountKeyPath`
      (`REPLACE_WITH_PLAY_SERVICE_ACCOUNT.json`) and keep `track: internal`.
- [ ] Production `EXPO_PUBLIC_API_URL` + `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`
      on EAS (see `eas.env.example` — no secrets in repo).
- [ ] Real Rivet mark / feature graphic before public listing (scaffold
      PNGs are present for builds).
- [ ] Real screenshots captured.
- [ ] Privacy Policy + support live at the URLs above.
- [ ] Dual demo accounts provisioned for review (see `app-review-notes.md`).
