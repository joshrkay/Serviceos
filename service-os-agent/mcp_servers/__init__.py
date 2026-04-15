"""
MCP servers for Service OS agents.

Each module in this package defines one MCP server — a named tool registry
with JSON-schema inputs/outputs, ceiling constants, and tenant-credential
binding. Servers live on the Python side because the Hybrid framework
decision (LangGraph outer + Claude Agent SDK inner) runs agents in the
Python process.

Current status (2026-04-14 vertical slice):
  - jobs_server.py   — DEFINED (read-only customer/job lookups)
  - money_server.py  — TODO (invoice draft, payment link, dunning; owns
                       the $500 ceiling constant)
  - comms_server.py  — TODO (Twilio SMS inbound/outbound)
  - schedule_server.py — TODO (appointment create/move/cancel)
  - intel_server.py  — TODO (briefing synthesis, audit query)
  - inventory_server.py — TODO (truck stock, supplier catalogs)

The servers in this package are plain Python registries for now. They
MUST conform to a minimal interface (name, list_tools, call_tool) so they
can be wrapped in a real MCP server once claude-agent-sdk is in
requirements.txt. See the `Tool` dataclass in each server for the schema
shape expected.

CEILING CONSTANTS — Decision 9 enforcement lives here, not in prompts.
Money-moving tools declare their ceilings as module-level constants that
the tool body reads at call time. Even if the agent is prompt-injected
into trying to bypass, the Python code path refuses.
"""
