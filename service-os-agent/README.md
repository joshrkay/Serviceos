# service-os-agent/ — Prototype Python agent (NOT production, NOT deployed)

> **Status: experimental prototype. Not deployed by any pipeline. Has
> known correctness and security defects (below) — do not expose it.**

A Python/FastAPI + LangGraph prototype that turns a transcript into a
ServiceOS proposal. It pairs with `service-os-app/` and, like it, is wired
to **no deployment target**: not in `railway.toml`, the root `Dockerfile`,
or any CI workflow. The `Procfile` implies a separate Railway service that
nothing in CI actually creates.

## Known issues (reasons it is not production-ready)

- **Dead scaffold.** `agents/` (capture/payment/invoice) and
  `mcp_servers/` (money_server/jobs_server/ceilings) exist but are not
  imported by the runtime — `agent/graph.py` builds only a small graph and
  `main.py` invokes just that. The committed agent/MCP work is unreachable.

## The canonical agent

Production AI runs **inside `packages/api`** (the LLM gateway at
`packages/api/src/ai/gateway` and the proposal system), where every action
becomes a human-approved, audited proposal. This standalone agent does not
go through that gate.

## Hardening already applied

- **`NameError` fixed.** `clients/service_os_api.py` now imports `json`, so
  `draft_proposal` no longer crashes on its write path.
- **`/process` requires auth.** The endpoint is gated behind
  `AGENT_SERVICE_TOKEN` (sent as `Authorization: Bearer <token>`, compared in
  constant time). It is **fail-closed**: if `AGENT_SERVICE_TOKEN` is unset the
  endpoint returns 503, never open. CORS now filters empties from
  `CORS_ALLOWED_ORIGINS`, so an unset value yields `[]` (no origins) rather
  than `[""]`. `/health` stays open for probes.

## Before relying on this

Wire (or delete) the dead `agents/`/`mcp_servers/` scaffold — and only then
give it a real deployment story. It still bypasses the canonical
proposal/audit gate, so keep it un-exposed and out of the deploy pipeline.
