# Dependency Audit Policy

**Status:** active
**Gate:** `.github/workflows/dependency-audit.yml` → `npm run check:dependency-audit`
**Exceptions:** `.github/dependency-exceptions.json`
**Implementation:** `scripts/check-dependency-audit.ts`

## Why this exists

Until this policy landed, nothing in CI looked at dependency advisories.
`npm run lint` is a log-safety grep plus `tsc --noEmit`, and `pr-checks.yml`
never ran `npm audit`. A high-severity advisory in the production tree could
sit there indefinitely without any signal — and one was: see the seeded
exception below.

## The rule

| Severity | Behaviour |
|---|---|
| `critical` | **Always fails.** Cannot be excepted. |
| `high` | Fails **unless** a matching, unexpired exception exists. |
| `moderate`, `low`, `info` | Reported. Never fails. |

Scope is the **production** tree (`npm audit --omit=dev`). Dev-only advisories
are reported in a separate non-blocking step: they do not ship, so they must not
be able to block a release. That is a deliberate trade-off, not an oversight —
a compromised build-time dependency is a real risk, but it is a supply-chain
problem to address with lockfile review and provenance, not by making every
release hostage to a `vitest` transitive advisory.

Three further rules keep the file honest:

- **An expired exception fails the build.** Exceptions are time-boxed, so they
  cannot become permanent by neglect.
- **An exception matching no current finding fails the build.** Once an advisory
  is remediated its exception must be deleted, so the file never accumulates
  entries that imply risk that no longer exists.
- **Every advisory on a package must be excepted individually.** npm reports one
  entry per vulnerable package, and that entry can carry several advisory IDs.
  A package is excepted only when *all* of its advisories have their own
  unexpired entry. Without this, a single documented advisory would exempt every
  other advisory on the same package, and a newly published GHSA against an
  already-excepted package would pass silently. A finding that reports no
  advisory ID at all can never be excepted — there is nothing to attest to.

### Known scope gap: `packages/mobile`

The gate audits the **root** tree only. `packages/mobile` is not a root
workspace and carries its own lockfile, so it is not covered. Its production
tree currently reports 22 high and 1 critical advisory, almost all transitive
through the Expo SDK toolchain (`@expo/cli`, `@expo/config-plugins`,
`expo-router`, `tar`, `ws`, …) — clearing them means moving the Expo SDK major,
which per `.github/dependabot.yml` is treated as a migration rather than a
dependency bump.

Extending the gate to mobile is deliberately **not** done here: it would land
red on arrival with ~23 entries that all resolve to one Expo upgrade, which is
exactly the rubber-stamp exception list this policy is designed to avoid. Do it
as part of that upgrade. Dependabot does watch `/packages/mobile`, so the
advisories are not invisible.

## Adding an exception

Only for a `high` you have decided not to remediate right now. Every field is
mandatory — the gate rejects an incomplete entry.

```json
{
  "package": "react-router",
  "advisory": "GHSA-qwww-vcr4-c8h2",
  "owner": "web",
  "rationale": "Why this is not exploitable here, or why the fix is not viable yet. Be specific about the code path.",
  "mitigation": "What compensates in the meantime.",
  "expires": "2026-10-23"
}
```

- `advisory` is the GHSA ID, the last path segment of the advisory URL. Package
  name alone is not enough to match: a second advisory against the same package
  must be judged on its own.
- `expires` is `YYYY-MM-DD`, and the expiry date itself is still valid — the
  build fails the day *after*. Default to 90 days. A longer window needs a
  reason in the rationale.
- `owner` is the team or area accountable for revisiting it.

## Current exceptions

### `react-router` — GHSA-qwww-vcr4-c8h2 (high), expires 2026-10-23

Seeded when the policy landed, so the gate starts truthful rather than
red-on-arrival.

The advisory is a CSRF bypass in React Router's **RSC** (React Server
Components) request handler, where an action can execute before the 400
response is returned. `packages/web` is a client-rendered Vite SPA: it has no
RSC entrypoint, no server request handler, and no `react-router/rsc` import, so
the vulnerable path is not reachable in this build.

The vulnerable range is `7.12.0 - 8.2.0` and the pin is `^7.0.0` resolving to
`7.18.1`. The fix landed in **8.3.0**, so remediation is a React Router
v7 → v8 **major migration**, not a patch bump — deliberately out of scope for
the sprint that introduced this gate, and tracked separately.

Revisit by the expiry: either complete the v8 migration or re-justify with a
fresh reachability check.

## Related

- `.github/dependabot.yml` — scheduled update PRs, so the default path to
  clearing an advisory is an upgrade rather than an exception.
- `docs/quality/engineering-baseline-2026-07-25.md` — records "high production
  vulnerabilities outside exceptions" as a tracked metric.
