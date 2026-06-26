---
title: "React component tests that pass in isolation but fail in CI (hidden fetch order + clock boundaries)"
date: 2026-06-26
track: bug
problem_type: test-failures
module: packages/web
tags: ["vitest", "react-testing-library", "jsdom", "mockResolvedValueOnce", "fake-timers", "flaky", "ci"]
related:
  - docs/solutions/test-failures/shared-db-integration-test-grant-pollution.md
---

## Problem
Two `packages/web` tests passed locally (and when run as a single file) but
turned the CI `test` job red. Both are the same shape: a jsdom/RTL component
test whose green result depended on a timing assumption that only holds in
isolation. Neither was caused by the production code under review — they were
latent traps the branch's first CI run exposed.

## Symptoms
- `CustomerDetail.test.tsx` › "lists service locations" — `Unable to find an
  element with the text: /100 Main St/`. The rendered DOM showed the page but
  the Service Locations list was empty ("No service locations yet").
- `PendingProposalsCard.test.tsx` › "expiry countdown" — asserted
  `/Expires in 2h/` but the DOM rendered `Expires in 3h 0m`.
- Both reproduced **only** under load/ordering that differs between a single
  local file run and the full CI suite.

## What Didn't Work
- Running the single test file locally — both passed, hiding the bug. The
  isolation is exactly what masks it.
- Re-running CI hoping for flake — deterministic on CI, so it never cleared.

## Solution

### Trap 1 — a one-shot mock eaten by an unmocked child's effect
`CustomerDetail` renders a self-fetching child (`CustomerRecordsPanel`, added by
US-069) that calls `apiFetch` in its own `useEffect`. React runs **child effects
before parent effects**, so the child's fetch is the *first* `apiFetch` call —
and it consumed the test's one-shot `mockResolvedValueOnce` that was meant for
the parent's `loadLocations`. The locations fetch then got the fallback `[]`.

The test already mocked *every other* self-fetching panel for this exact reason;
US-069 just forgot to mock the new one.

```ts
// fix: mock the self-contained child like its siblings
vi.mock('../../components/customers/CustomerRecordsPanel', () => ({
  CustomerRecordsPanel: () => <div>CustomerRecordsPanel</div>,
}));
```

### Trap 2 — a floor-rounded relative time on an exact-unit boundary
```ts
// before — flaky: 0ms vs >0ms elapsed flips the floored minute
const inThreeHours = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
// ... component does: mins = Math.floor((expiresAt - Date.now()) / 60000)
expect(screen.getByText(/Expires in 2h/)).toBeInTheDocument();
```
The component recomputes `Date.now()` at render, a hair after the test computed
`expiresAt`. With `Math.floor` and an **exact-hour** offset: if >0ms elapsed the
diff floors to `179` min → `"2h 59m"` (matches `/2h/`); if the two `Date.now()`
calls land in the **same millisecond** (fast CI / coarse timer) the diff is
exactly `180` min → `"3h 0m"` (does not match).

```ts
// after — freeze the clock + use a non-boundary offset
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-06-21T10:00:00.000Z'));
try {
  const expiresAt = new Date(Date.now() + (2 * 60 + 30) * 60 * 1000).toISOString(); // +2h30m
  // ...render...
  expect(screen.getByText('Expires in 2h 30m')).toBeInTheDocument();
} finally {
  vi.useRealTimers();
}
```

## Why This Works
- Trap 1: mocking the child removes its stray `apiFetch`, so the parent's
  one-shot mock is the first (and only) call again. Child-before-parent effect
  ordering is a React invariant, so an unmocked self-fetching child will *always*
  race ahead of the parent's fetch.
- Trap 2: a frozen clock makes both `Date.now()` reads identical, and a
  non-boundary offset (`2h30m`) means floor/ceil rounding can't flip the
  displayed unit. The flake came entirely from a real, advancing clock crossing
  an exact display-unit boundary.

## Prevention
- When a test uses `mockResolvedValueOnce` (order-dependent), prefer a URL-keyed
  `mockImplementation` so the assertion doesn't depend on call order — or mock
  every self-fetching child so the component-under-test owns all the fetches.
- Adding a self-fetching child component? Update the parent component's test to
  mock it (grep the test for the sibling-panel mock block — it exists for this
  reason).
- Never assert a `Math.floor`/`Math.ceil`-rounded relative time computed from a
  live `Date.now()` plus an offset that is an **exact multiple of the displayed
  unit**. Freeze time (`vi.useFakeTimers` + `setSystemTime`) and/or pick an
  offset that isn't on a unit boundary. (A sibling, `EstimateApprovalPage`'s day
  countdown, is safe precisely because it uses `Math.ceil` at *day* granularity:
  `ceil(N.0) === ceil(N - ε) === N`.)
- Meta-lesson: "passes when I run just this file" is not proof. Run the full
  workspace suite (`npm run test`) before claiming green — isolation hides
  ordering- and clock-sensitive failures that CI runs head-on.
