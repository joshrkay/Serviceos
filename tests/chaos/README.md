# Chaos / Load Test Harness (k6)

Scenarios that exercise the resilience layer end-to-end. Each scenario sets
chaos knobs on the API via the `/internal/chaos` admin endpoint
(gated by `CHAOS_PROVIDER_ENABLED=true`), drives traffic, and checks
that p95 latency, error rate, and breaker / queue behavior match
expectations.

Scenarios are *not* part of CI — they are run manually against staging
during ramp gates and during incident replay.

## Running

```
k6 run -e API_URL=https://staging.api.example.com tests/chaos/scenarios/error-storm.ts
```

## Required environment

- `CHAOS_PROVIDER_ENABLED=true` on the target API (staging only).
- `CHAOS_ADMIN_TOKEN` — bearer token accepted by the chaos endpoint.

## Pass criteria

Recorded as k6 thresholds inside each scenario file. A scenario is green
when:
- p95 end-to-end latency stays under the documented bound;
- breaker transitions through `closed → open → half-open → closed`;
- no unbounded memory growth (process RSS observed via `/metrics`);
- per-tenant SLOs do not regress more than 5% during noisy-neighbor.
