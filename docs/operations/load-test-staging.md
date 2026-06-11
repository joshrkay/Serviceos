# Staging Load Test (P7-025)

## Goal

Validate ~50 concurrent operator sessions against staging without error-rate regression.

## Prerequisites

- Staging API URL and valid Clerk test tokens
- k6 installed locally (`go install` or package manager)

## Suggested profile

Use scenarios under [tests/chaos](../../tests/chaos/) as a template:

1. Ramp to 50 VUs over 2 minutes
2. Hold 5 minutes on mixed read endpoints (`GET /api/jobs`, `GET /api/invoices`, `GET /api/customers`)
3. Ramp down 1 minute

## Success criteria

- p95 latency under 2s for list endpoints
- Error rate under 1% (excluding intentional 401 without token)
- No Postgres connection pool exhaustion in API logs

## Record results

Append date, git SHA, and summary to `docs/verification-runs/` when complete.
