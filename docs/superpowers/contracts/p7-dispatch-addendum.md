# Phase 7 (Integrations + Beta Hardening) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-7-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent running in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-7-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 7-Hardening-A | P7-020 | parallel-eligible (no shared files with P7-028) | none |
| 7-Hardening-B | P7-028 | parallel-eligible (no shared files with P7-020) | none |

P7-020 (dependency audit) and P7-028 (tenant-timezone bucketing) touch fully disjoint file sets and can run concurrently. Both are launch-readiness items for the 2026-05-22 cutover sprint.

---

## P7-020 — Dependency audit and vulnerability fixes

**Wave:** 7-Hardening-A
**Migration number reserved:** none (no schema changes)
**Forbidden files:**
- `packages/api/src/**/*.ts` (no source changes — this is a pure deps/CI story)
- `packages/web/src/**/*.ts` (same)
- `packages/shared/**`
- `infra/**`
- `.github/workflows/**` *except* a single optional addition of a `npm audit --audit-level=high` step (see Implementation hints)
- `docs/**` (no doc churn — keep the diff strictly to lockfiles + manifests + the optional CI step)

**Allowed files (concrete list):**
- `package.json` (modify — only if a root-level dependency needs replacement)
- `package-lock.json` (regenerate)
- `packages/api/package.json` (modify — only for direct-dep upgrades or replacements)
- `packages/web/package.json` (modify — same)
- `packages/shared/package.json` (modify — same, additive only; shared is Tier 1 locked, so version bumps only, no script renames)
- `.github/workflows/ci.yml` *or* the closest existing CI workflow file (modify — add a single `npm audit --audit-level=high` step gated on PRs)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npm audit --audit-level=high && \
  cd packages/api && npx tsc --project tsconfig.build.json --noEmit && \
  cd .. && cd web && npx tsc --noEmit && \
  cd ../api && npm test -- --run --reporter=dot 2>&1 | tail -20
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- `npm audit` runs cleanly enough to produce a JSON report (network access required — the run-mode env must allow `npm` to reach the registry).

**Risk note:**
- **Lockfile churn is the highest-blast-radius part.** Prefer surgical replacements (e.g. swap `superagent` for native `fetch` in the *one* call site that uses it) over a global `npm audit fix --force`, which can pull in major-version bumps to unrelated transitive deps.
- **Deprecated `glob`** lives transitively under many tools; if no high-severity advisory is open against the installed range, you may LEAVE it and document the decision in the PR body. Do not force a version bump if it has no security advisory tied to it.
- **Deprecated `async`** same call: replace only if a high/critical advisory applies. Memory-leak warnings without a CVE are not in scope for this story.
- **CI step must not block existing PRs.** Add the `npm audit` step as `continue-on-error: false` ONLY after confirming the audit currently passes at `high`. If it doesn't, document the remaining vulns in the PR description and set the step to `continue-on-error: true` with a follow-up issue noted.

**Implementation hints:**
1. Start with `npm audit --json > /tmp/audit-before.json`. Categorize: high/critical (must fix), moderate (fix if cheap), low (defer + document).
2. For `superagent`: grep for `require\(.superagent.\)|from .superagent.` in `packages/api/src` and `packages/web/src`. If used, replace with native `fetch`. If unused (transitive only), prune via the registry-suggested resolution.
3. For each replacement, run `cd packages/api && npm test -- --run` (or `packages/web`) before committing. The verification gate runs the full suite at the end.
4. Add the CI step to whichever workflow already runs `npm install` (likely `.github/workflows/ci.yml`). Place it AFTER `npm install` and BEFORE the test job:
   ```yaml
   - name: Audit dependencies
     run: npm audit --audit-level=high
   ```
5. Capture `npm audit` output before AND after in the PR description so reviewers see what changed.

---

## P7-028 — Tenant-timezone bucketing for money dashboard + tax export

**Wave:** 7-Hardening-B
**Migration number reserved:** none (`tenant_settings.timezone` column already exists)
**Forbidden files:**
- `packages/api/src/db/**` (no schema changes — column exists)
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**` (`isValidTimezone` lives in `packages/api/src/shared/timezone.ts`, NOT in the shared package — do not move it)
- `packages/api/src/settings/**` (do not change the settings interface; just read `settings.timezone`)
- `packages/api/src/reports/time-credits.ts`
- `packages/api/src/reports/time-given-back.ts`
- `packages/api/src/reports/revenue-by-source.ts` (out of scope for this story — file a follow-up if the same bug exists there)

**Allowed files (concrete list):**
- `packages/api/src/reports/money-dashboard.ts` (modify — replace `Date.UTC` boundaries with tz-aware boundaries; add `tz` parameter to `resolveMonthWindow` and `computeMoneyDashboardSummary`)
- `packages/api/src/reports/tax-export.ts` (modify — same tz threading; row `date` column emitted in tenant tz)
- `packages/api/src/routes/reports.ts` (modify — load tenant settings, thread `tz` into both calls, fall back to `'America/New_York'` if missing/invalid)
- `packages/api/test/reports/money-dashboard.test.ts` (modify or new — boundary tests for LA + NY tenants)
- `packages/api/test/reports/tax-export.test.ts` (modify or new — same)
- `packages/web/src/components/reports/MoneyDashboardPage.tsx` (modify — drop client-side `monthRange` UTC computation; add tz caption)
- `packages/api/src/shared/timezone.ts` (modify ONLY if a missing helper genuinely cannot be composed from existing exports — prefer composition over new exports)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  cd packages/api && npx tsc --project tsconfig.build.json --noEmit && \
  cd ../web && npx tsc --noEmit && \
  cd ../api && npm test -- --run -t "money-dashboard|tax-export|P7-028|timezone" 2>&1 | tail -30 && \
  ! grep -nE '\bDate\.UTC\b' src/reports/money-dashboard.ts src/reports/tax-export.ts
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- `tenant_settings.timezone` column exists on the schema (verified: `packages/api/src/settings/settings.ts:36` declares `timezone: string` and the default `'America/New_York'` is set at line 345).
- `isValidTimezone` helper exists at `packages/api/src/shared/timezone.ts`.

**Risk note:**
- **DST edge case.** Use `Intl.DateTimeFormat` or the existing `wallClockMs` helper; manually computing offsets via `Date.getTimezoneOffset()` is wrong for tenants outside the runtime's local tz. The shared helper exists specifically to avoid this trap.
- **Tax-export back-compat.** Existing tax-export consumers (accountants who downloaded CSVs in the past) saw UTC dates. A US-only beta tenant in PST who already downloaded a Q4 2025 export will see *different* per-row dates after this lands. Document this in the PR body. Do NOT add a `?tz=utc` opt-out flag — that's scope creep.
- **Web caption.** The "Buckets reflect your business timezone (America/Los_Angeles)" caption must come from the same settings endpoint the rest of the page reads — don't add a new fetch.
- **Test for regression.** The negative grep in the verification gate (`! grep ... Date.UTC`) is the canary: any new `Date.UTC` use in either reports file fails the gate.

**Implementation hints:**
1. Start by reading `packages/api/src/shared/timezone.ts` end-to-end. The `wallClockMs(date, tz)` helper turns a wall-clock instant in `tz` into UTC ms. Use it to build month boundaries:
   ```ts
   function monthStartInTz(year: number, monthIndex: number, tz: string): Date {
     const probe = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0));
     if (!isValidTimezone(tz)) return probe;
     const offsetMs = wallClockMs(probe, tz) - probe.getTime();
     return new Date(probe.getTime() - offsetMs);
   }
   ```
2. The signature of `resolveMonthWindow` becomes `resolveMonthWindow(month: string, tz: string)`. Every call site (only `computeMoneyDashboardSummary` today) must pass tz.
3. In `routes/reports.ts`, the read goes:
   ```ts
   const settings = await settingsRepo.findByTenant(req.tenantId);
   const tz = settings?.timezone && isValidTimezone(settings.timezone)
     ? settings.timezone
     : 'America/New_York';
   ```
4. The web caption: read `tz` from the same `/api/settings` response the page already loads (look for `useSettings` or similar). If the page doesn't currently fetch settings, prefer adding it to the existing dashboard fetch over a separate request.
5. Write the tests FIRST. They are the spec — they should fail against the unmodified files, then pass after the production change. Use real `Date` objects with explicit ISO strings (e.g. `'2026-01-31T23:30:00-08:00'`) so the test reads naturally.

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md` § Universal pre-flight checks. Apply to every Phase 7 story before launching the dispatch agent.
