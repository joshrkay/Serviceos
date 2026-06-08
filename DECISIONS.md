# Decisions — Onboarding Launch-Readiness Pass

Material decisions made during the funnel/activation pass, with rationale.

## D1. Map the spec onto the real architecture (not literal compliance)
The launch spec assumes Next.js `app/(onboarding)/` route groups, `supabase/migrations/`,
`pnpm test:*` scripts, and Vapi. This repo is **npm workspaces + Vite/React-Router +
Express + in-code migrations (`packages/api/src/db/schema.ts`) + Twilio**. We mapped
the spec's intent onto the real stack and documented every mapping in FUNNEL.md.
Confirmed with the requester before building.

- "Vapi" → Twilio (the real voice provider). "Vapi webhook signature" is Twilio
  signature verification, which already exists and is enforced
  (`telephony/twilio-signature.ts`, `requireTwilioSignature`).
- Spec wizard steps → real steps (`identity`/`phone`/`ai_check`); `wizard_step_calendar`
  has no analog and is deferred.
- `pnpm test:*` → additive npm scripts of the same name (`test:funnel`, `test:webhooks`,
  `test:provisioning`, `test:rls`, `test:activation`, `test:e2e:onboarding`).

## D2. Stripe stays the source of truth for plan / trial / payment
The spec names `plan`, `trial_ends_at`, `payment_status` columns. The app already
derives all billing state from Stripe (`tenants.subscription_status`,
`stripe_subscription_id`, kept fresh by the signature-verified, idempotent
`customer.subscription.*` webhook). We **did not** add denormalized columns —
a second source of truth is a data-integrity risk and the existing mirror already
carries `past_due`. `trial_to_paid` was already wired; the past-due banner reads the
existing `subscription_status`. Confirmed with the requester.

## D3. Count-based activation, not caller-identity
`first_real_call_received` must fire on the first *real* (non-test) inbound call.
The `onSessionEnded` hook receives only `{ tenantId, channel }`, and `voice_sessions`
stores no caller number — so "is this caller the owner's verified phone?" can't be
answered there without threading the `From` through the telephony adapter and adding
a column. We use a count-based rule (test call = inbound #1; first real call = the
next; threshold drops to 1 if the test call was skipped). Documented in FUNNEL.md;
the identity-based variant is deferred (BLOCKED.md). This ships the milestone now
with correct once-per-tenant idempotency.

## D4. One additive migration only (`146_tenant_settings_activated_at`)
The only schema change is a nullable `activated_at TIMESTAMPTZ` on `tenant_settings`
— the once-per-tenant activation marker. `ADD COLUMN IF NOT EXISTS`, additive, no
DROP/narrowing, inherits the table's existing FORCE-RLS `tenant_isolation` policy.
Registered in the migration-immutability snapshot (`migration-immutability.test.ts`).
Past-due needs no column (reuses `subscription_status`); the count-based activation
rule avoids needing a `test_call_from_e164` column.

## D5. Per-step funnel events are client-side; activation + conversion are server-side
Step *views* and *completions* are UI moments; emitting them server-side from the
polled `/status` route would double-count (3s poll) and miss the `signup`/`test_call`
steps that have no mutation route. They're emitted client-side from `OnboardingShell`,
deduped with ref `Set`s, and the completion ref is **seeded on first load** so a
resumed session doesn't replay completions for already-done steps. The activation
(`first_real_call_received`) and conversion (`trial_to_paid`) events stay server-side
where idempotency lives and no browser is present.

## D6. `wizard_completed` coexists with `onboarding_completed`
The existing `onboarding_completed` event keeps firing (downstream dashboards key off
it); `wizard_completed` (the spec name) is emitted alongside it. No existing event was
renamed or removed — breaking event names is a downstream dashboard break (forbidden).

## D7. No new npm dependencies
All work reuses packages already in the tree: `posthog-node` / `posthog-js`
(analytics, already wired), `twilio` (signature), the existing
`MessageDeliveryProvider` (activation email), `pg`, `vitest`, `@playwright/test`.
**Zero new dependencies added**, so there is nothing to justify here beyond this note.

## D9. "Go fully literal" — build Vapi + voice + calendar for real (constraints lifted)
After the launch gate rejected the Twilio-only mapping, the requester chose to **go
fully literal** and explicitly lifted the spec's "no new dependencies" and
"Vapi/Twilio account-config out of scope" constraints. Consequences:

- **Vapi built for real**, but via the **REST API over `fetch`** (no SDK) — so it
  remains technically zero-new-npm-dependency, off-by-default without `VAPI_API_KEY`,
  and injectable for mock-only tests. Assistant is created + linked to the
  provisioned Twilio number; `vapi_assistant_id` stored; a signature-verified,
  idempotent `/webhooks/vapi/:tenantId` route drives identity-based activation.
- **Voice config + calendar choice + business-profile extras** built end-to-end
  (server endpoints + persistence + web UI + tests).
- **The framework was deliberately NOT rewritten** to Next.js/Supabase. That would
  delete the working, 6000-test Express/Vite app (and the spec's "no deletion of
  existing tests" rule). "Fully literal" was interpreted as "build the literal
  FEATURES on the proven stack", not "re-platform". This is the one place the
  literal architecture was intentionally not matched; documented here and in
  LAUNCH_REPORT.md.
- Identity-based activation (caller ≠ verified phone) is now the **primary** path
  (Vapi webhook); the count-based heuristic remains as the Twilio-only fallback.
  Both share the `activated_at` check-and-set, so no double-fire.

## D8. npm script mapping (the spec's `pnpm test:*` don't exist)
`test:funnel`/`test:webhooks`/`test:provisioning` map to **unit** targets so they
run without Docker in any environment. `test:rls`/`test:activation` map to the
testcontainers integration config (Docker-gated). `test:e2e:onboarding` maps to the
existing Playwright onboarding journey. See package.json.
