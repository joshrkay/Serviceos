# Coverage Sweep Runbook (Lever 3)

A single Playwright spec that walks every authenticated route in the SPA and
asserts the basics: page loads, no console errors, primary buttons are wired,
and data fetches return 2xx.

This is "Lever 3" of the QA strategy. It is intentionally cheap and dumb —
it catches the entire class of "tests pass, browser broken" bugs that 4,898
unit / integration tests missed on 2026-05-11. The journey tests (Lever 2)
remain the canonical multi-step regression catchers.

## What it catches

Concrete bug classes from the 2026-05-11 QA report this sweep would have caught:

- **BUG-1** — Sign-out button has an `onClick` literal that does nothing
  (or the handler was wired to the wrong Clerk hook). The button-wiring
  audit flags the button as having no fiber-level click handler.
- **BUG-4** — "New invoice" / "Edit" button rendered as a JSX literal with
  NO `onClick` prop at all. Same fiber inspection catches it.
- **BUG-8** — `/contracts/:id`, `/settings/language`, or any other route
  not registered in `routes.ts` → the SPA renders nothing / 404. The
  sweep calls `page.goto()` and asserts the page does NOT redirect away
  to `/` or render an empty body.
- The whole class of "data fetch on this page silently 500s" — every
  network call from the page is recorded and asserted non-failing.

## What it does NOT catch

- Multi-step user flows. A wizard step that silently fails to advance, an
  estimate save that produces a corrupted row, a payment link that
  generates the wrong amount — those are caught by the journey tests in
  `e2e/journeys/*.spec.ts` (Lever 2).
- Server-side regressions on routes the sweep doesn't visit. Backend-only
  contract tests and the QA matrix cover those.
- Visual regressions / styling drift. Use `npm run e2e:qa-matrix` and the
  design-review skill for those.

## How to run locally

The sweep is opt-in. The default `npm run e2e` does **not** run it.

```bash
# One-shot, against local dev servers (API + web auto-started by Playwright)
npm run e2e:coverage-sweep
```

Requirements:

- `packages/api` and `packages/web` either dev-runnable, OR
- `E2E_BASE_URL=https://serviceos-dev.up.railway.app` (and `E2E_API_URL`)
  pointing at a deployed environment that has Clerk wired.
- `VITE_CLERK_PUBLISHABLE_KEY` exported into the web dev server's env,
  otherwise the SPA throws at module load (P0-026 guard) — the spec
  detects this and skips.
- For full coverage: also export `E2E_CLERK_PUBLISHABLE_KEY` +
  `E2E_CLERK_SECRET_KEY` so Clerk testing tokens are minted. Without
  them, the sweep runs in degraded mode: every protected route redirects
  to `/login`, which proves the shell renders but does NOT exercise the
  authenticated pages. See `clerk-testing-tokens-runbook.md`.

## Output

- Pass/fail per route printed to stdout at the end of the run.
- Failure screenshots → `qa/reports/2026-05-11/coverage-sweep/<route>.png`.
- Summary table → `qa/reports/2026-05-11/coverage-sweep/results.txt`.

## How to add a route to the sweep

One-liner: append a `SweepRoute` entry to `SWEEP_ROUTES` in
`e2e/helpers/coverage-sweep-routes.ts`. Example:

```ts
{ path: '/inventory', label: 'inventory', category: 'app' },
```

For dynamic routes, use the exported `FIXTURE_ID` UUID and add
`allowApiStatuses: [404]` so a fresh DB doesn't fail the run. Example:

```ts
{
  path: `/widgets/${FIXTURE_ID}`,
  label: 'widget-detail',
  category: 'app',
  allowApiStatuses: [404],
},
```

If a route renders a Clerk-owned widget (login/signup) whose buttons live
inside a shadow root we cannot inspect, set `skipButtonAudit: true`.

## Known limitations

- The button-wiring audit relies on reading React fiber props via the
  internal `__reactProps$*` key React injects on host elements. This is
  React 17+ specific (the repo uses React 18). A future React major may
  rename the property — the audit will start flagging false positives,
  but the test failures will be loud and easy to fix.
- We tolerate `401` responses when running without Clerk creds — the
  sweep's auth state is "anonymous" then and the API correctly refuses.
  This is the trade-off that lets the sweep skip cleanly on a fresh
  clone without credentials.
- We tolerate per-route 404 statuses on dynamic-id pages (configured via
  `allowApiStatuses`). The PAGE itself must still render — only the data
  fetch is allowed to 404.
- The console-error allowlist is deliberately tiny (3 entries). Each is
  documented inline in `coverage-sweep-routes.ts`. Resist the urge to
  add more — every entry is a potential mask over a real bug.
- We do NOT verify token-gated public routes (`/pay/:id`, `/e/:id`,
  `/portal/:token`, `/public/feedback/:token`) because there's no
  deterministic fixture token. Those are covered by journey tests.

## Why this is "cheap and dumb"

The whole sweep is ~28 routes × ~4 assertions each = roughly 100 spot-checks
per run. It does not understand the domain. It does not validate that the
data is correct, that the workflows succeed, or that the UI looks right.

That is its strength: it cannot be fooled by a clever mock, it doesn't drift
when the data shape changes, and adding a route to it is one line. The
journey tests are surgical; the sweep is broad-spectrum. We need both.

## Maintenance

- When you add a new route to `packages/web/src/routes.ts`, also add it
  to `e2e/helpers/coverage-sweep-routes.ts`. The router unit test
  (`packages/web/src/routes.test.ts`) can be extended to enforce parity
  in a future story.
- Console-error allowlist changes go through code review. If a real bug
  hides behind a permissive allowlist entry, removing it is the fix.
