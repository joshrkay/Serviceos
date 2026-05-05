# Agent/API Ownership Boundaries

## Single orchestration authority
- **`packages/api/` is the runtime orchestration authority** for voice decisioning, intent classification, proposal lifecycle, and approval/execution guardrails.
- **`service-os-agent/` is a caller surface only**. It may classify/extract and request proposal drafts through TS API contracts, but it must not bypass API routes or database guardrails.

## Boundaries
- `packages/api/`
  - Owns schema contracts, proposal status transitions, approval/undo/execution gates, audit logging, and tenant isolation.
  - Owns voice routing and task routing policy.
- `service-os-agent/`
  - Owns Python runtime wiring, LLM prompting nodes, and MCP adapters.
  - Uses `SERVICE_OS_API_URL` + tenant-bound auth token to call the API gateway.
  - Must not import direct DB providers for business mutations.

## Drift prevention rules
1. Any new mutation capability must land in `packages/api` first (route + guardrails + tests).
2. Python agent changes that affect payload shape must update `packages/api/test/contracts/python-agent-contract.test.ts` in the same PR.
3. Proposal generation always returns a typed proposal object and never executes state changes directly from Python.
