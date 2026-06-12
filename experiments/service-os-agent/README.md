# service-os-agent/ — Prototype Python agent (NOT production, NOT deployed)

> **Status: experimental prototype. Not deployed by any pipeline. Has
> known correctness and security defects (below) — do not expose it.**

A Python/FastAPI + LangGraph prototype that turns a transcript into a
ServiceOS proposal. It pairs with `service-os-app/` and, like it, is wired
to **no deployment target**: not in `railway.toml`, the root `Dockerfile`,
or any CI workflow. The `Procfile` implies a separate Railway service that
nothing in CI actually creates.

## Known issues (reasons it is not production-ready)

- **Runtime crash on its only write path.**
  `clients/service_os_api.py` calls `json.dumps(...)` (around line 146)
  but never imports `json`, so `draft_proposal` raises `NameError` the
  first time it runs.
- **`/process` is unauthenticated.** `main.py` accepts `auth_token` as a
  plain request-body field and never verifies it; CORS defaults to an
  empty allow-list (`CORS_ALLOWED_ORIGINS` unset → `[""]`). Exposing this
  service would be an open, unauthenticated LLM/proxy endpoint.
- **Dead scaffold.** `agents/` (capture/payment/invoice) and
  `mcp_servers/` (money_server/jobs_server/ceilings) exist but are not
  imported by the runtime — `agent/graph.py` builds only a small graph and
  `main.py` invokes just that. The committed agent/MCP work is unreachable.

## The canonical agent

Production AI runs **inside `packages/api`** (the LLM gateway at
`packages/api/src/ai/gateway` and the proposal system), where every action
becomes a human-approved, audited proposal. This standalone agent does not
go through that gate.

## Before relying on this

Fix the `NameError`, add real authentication + a CORS allow-list to
`/process`, and wire (or delete) the dead `agents/`/`mcp_servers/`
scaffold — and only then give it a deployment + auth story. Until then,
keep it un-exposed.
