# Launch Day Runbook

Single document the on-call engineer opens on cutover day. Cross-references
the per-system runbooks (`alerting.md`, `rollback.md`,
`migration-discipline.md`, `voice-capacity.md`, `launch-quality-bar.md`).
This document only adds the cutover sequence; it does not duplicate
those runbooks' content.

**Target date:** 2026-05-22 (per `docs/pre-launch-hardening-2026-05-16.md`).

---

## T-24h — pre-flight (engineer on duty)

These are gates. If any FAIL, do not cut over.

1. **Launch quality bar**

   ```bash
   cd packages/api && npm run launch-quality-check
   ```

   Must show `12/12 PASS`. The most common gap is **H5 voice capacity** — if
   it fails, run the load test against staging first:

   ```bash
   STAGING_WS_URL=wss://api.staging.serviceos.com/api/telephony/stream \
     npx tsx packages/api/scripts/voice-load-test.ts --max 50 --ramp 60 --hold 300
   ```

   Then update `packages/api/.launch-quality-acks.json`:
   ```json
   { "voice_capacity_run": "2026-05-21T18:00:00Z" }
   ```

   Re-run `launch-quality-check` to confirm 12/12.

2. **TypeScript production build**

   ```bash
   cd packages/api && npx tsc --project tsconfig.build.json --noEmit
   ```

   Must exit 0. CI runs this, but verify locally to catch a stale `node_modules`.

3. **Test suite — voice/AI/verticals neighborhood**

   ```bash
   cd packages/api && npx vitest run \
     test/workers/ test/routes/ test/ai/ test/voice/ test/verticals/ \
     test/webhooks/ test/auth/
   ```

   Expect ~1900 tests, all green.

4. **Operator-voice golden-path proof**

   ```bash
   cd packages/api && npx vitest run \
     test/voice/operator-voice-golden-path.test.ts
   ```

   This is the launch-promise test. 7 tests must pass — covers
   create_invoice / create_appointment / record_payment / add_note /
   draft_estimate / lookup_jobs for an HVAC tenant with the seeded pack
   active.

5. **`npm audit`**

   ```bash
   npm audit
   ```

   Must show **0 critical, 0 high**. Moderates in `vite` / `vitest` / `yaml`
   are accepted dev-only debt (see commit `a2d5efe`).

---

## T-2h — staging cutover rehearsal

1. **Deploy current branch to staging**

   ```bash
   railway up --service api --environment staging
   ```

2. **Run the smoke**

   ```bash
   API_BASE_URL=https://api.staging.serviceos.com  bash scripts/smoke.sh
   ```

   Exit 0 = HTTP probes + operator-voice classifier dry-run both pass.

3. **Manual smoke — onboarding flow**

   In the staging UI, sign up a new tenant end-to-end:

   - Identity step → fills tenant name + timezone
   - Pack step → activates HVAC (or plumbing)
   - Phone step → claims a Twilio number
   - Billing step → completes Stripe checkout (Stripe TEST mode)
   - TestCall step → makes a test call; verify the agent answers in
     under 2 seconds, classifies a single intent, and greets back

4. **Manual smoke — operator voice path**

   Sign in as the tenant owner. From the chat:

   ```
   "Create an invoice for Mrs Lee for 450 dollars cash"
   ```

   A `Customer` proposal card should render with the parsed entities and a
   single-tap approve button. NOTHING should auto-execute.

5. **Resilience-flag flip rehearsal**

   Per decision #2 in `pre-launch-hardening-2026-05-16.md`, flip
   the four gateway flags ON in staging:

   - `gateway.breaker_enforcement`
   - `gateway.retry_enabled`
   - `gateway.fallback_enabled`
   - `gateway.tenant_quota_enforced`

   Hold for 2 hours. Open Sentry; any error rate increase = abort cutover.

---

## T-0 — production cutover

1. **Tag the release**

   ```bash
   git tag launch-2026-05-22
   git push origin launch-2026-05-22
   ```

2. **Promote the branch to main**

   - Open a PR from `claude/voice-ai-services-launch-MOHDW` → `main`.
   - Land via merge commit (not squash) so individual security fixes stay
     greppable in `git log`.

3. **Deploy to production**

   ```bash
   railway up --service api --environment production
   ```

   Railway's `preDeployCommand` runs migrations before traffic flips. Watch
   the deploy logs; an error here means rollback immediately
   (`docs/runbooks/rollback.md`).

4. **Post-deploy verification**

   ```bash
   API_BASE_URL=https://api.serviceos.com  bash scripts/smoke.sh
   ```

   Within 5 minutes of cutover. Exit 0 = healthy.

5. **Flip the resilience flags in production**

   Same four flags as staging. Hold and watch Sentry for 1 hour. Error
   budget intact = launch is green.

---

## Day-1 sweep (post-launch)

- Monitor Sentry for the four wrapped paths (see `alerting.md`) — payment
  webhook, proposal execution, voice agent, action router.
- Watch Twilio webhook delivery dashboard for failed retries.
- Pull the first 5 inbound call recordings (with consent) and grade
  classifier output by hand. File regressions as `voice-quality/{bucket}`
  scripts under `packages/api/src/ai/voice-quality/corpus/scripts/`.

---

## Defer-to-week-2

These are documented gaps that are not launch blockers. Address only
after the first 100 customer-calls complete cleanly:

- **D3-5** Media Streams transcript regression — synthetic corpus already
  covers; add 10 real-call anonymized fixtures from week-1 traffic.
- **D5-1** Settings stubs (Reminders, Team members, Roles).
- **D5-4** Tenant TZ bucketing for money-dashboard + tax-export (US-only
  beta, see TODOS.md).
- **D4-2** ElevenLabs TTS provider rollout (Deepgram STT lands at cutover;
  ElevenLabs is week-2 per decision #3).
- Six remaining `npm audit` moderates (`vite` / `vitest` / `yaml` semver-
  major upgrades).

---

## Rollback decision tree

If any T-0 gate FAILs:

1. **`preDeployCommand` migration error** → rollback (`rollback.md` §1–3).
   Do NOT attempt to manually fix the migration in prod.

2. **Smoke fails after deploy** → rollback. Then investigate the failing
   layer (HTTP vs voice) against staging.

3. **Sentry P1 within first hour** → assess per `alerting.md`. If voice-
   agent or proposal-executor path, rollback. If isolated payment-
   webhook or transient, hold and investigate.

4. **Operator voice produces wrong proposal type** → this means the
   vertical pack didn't reach the classifier. Verify:

   - The tenant has an active pack (`SELECT * FROM tenant_pack_activations
     WHERE tenant_id = $1 AND status = 'active'`).
   - `DEEPGRAM_API_KEY` and `OPENAI_API_KEY` / `AI_PROVIDER_API_KEY` are
     set in Railway prod env vars.
   - `verticalPromptResolver` invalidation runs on pack changes
     (`grep invalidateVerticalPromptCache` in `app.ts`).

   If those are fine and the issue persists, rollback and file a regression
   case from the recorded call.

---

## Reference

- `docs/pre-launch-hardening-2026-05-16.md` — dispatch list this runbook
  closes the loop on.
- `docs/runbooks/alerting.md` — Sentry rules + Slack routing.
- `docs/runbooks/rollback.md` — detailed rollback procedure.
- `docs/runbooks/migration-discipline.md` — schema-change guardrails.
- `docs/runbooks/voice-capacity.md` — H5 load-test ceiling tracking.
- `docs/runbooks/launch-quality-bar.md` — the 12-item gate this runbook
  enforces at T-24h.
