"""
Agent primitive — the data shape of a Service OS back-office agent.

The Service OS platform is "a platform that instantiates task-specific
agents", per the 2026-04-14 Idea Crystallization doc. Each agent owns one
back-office function (capture, invoicing, AR/dunning, scheduling, customer
comms, tax partitioning, briefing, onboarding). This module defines the
primitive they are all instances of.

Design intent:
  - Agents are DATA, not hardcoded code paths. This is what distinguishes
    "agent platform" from "AI-enhanced backend" in the retrospective.
  - The `mcp_tools` field names MCP servers the agent is allowed to use.
    The MCP tool layer, not the prompt, enforces ceilings and tenant
    credential binding (Decision 9).
  - The `trust_tier` maps onto Decision 3's per-action-class autonomy:
      - "autonomous"       → capture/record; executes without review
      - "graduates_fast"   → customer comms; auto-approves after operator
                             trust is earned on this class
      - "graduates_slowly" → money-moving actions; may stay gated forever
      - "always_asks"      → irreversible actions; confirmation required
                             regardless of trust earned
  - `memory_namespace` is the slice of tenant-scoped synthesized memory
    this agent owns (Decision 8). The synthesis pipeline federates
    namespaces per tenant; each agent only reads/writes its own slice by
    default.
  - `triggers` enumerates what wakes the agent up: `voice_capture`,
    `inbound_sms`, `schedule:cron:...`, `webhook:stripe.*`, etc. The
    LangGraph outer graph dispatches on these; the Claude Agent SDK runs
    the inner loop (per the Hybrid framework decision).

Acceptance contract for this primitive lives in
`packages/api/test/decisions/decisions.test.ts` (D3, D4, D7, D8, D9, A1).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Tuple


TrustTier = Literal[
    "autonomous",
    "graduates_fast",
    "graduates_slowly",
    "always_asks",
]


@dataclass(frozen=True)
class Agent:
    """A named, task-specific back-office agent.

    Attributes:
        name: Canonical identifier used in logs, audit trail, and the
            LangGraph node map. Must be unique per tenant runtime.
        scope: One-sentence description of what this agent is allowed to
            do. Used in the system prompt and in the founding-sentence
            filter check.
        system_prompt: The full system prompt the agent runs with. Kept
            separate from prose so it can be versioned and A/B tested.
        memory_namespace: The namespace under which this agent's
            synthesized memory lives. Format: "<tenant_id>:<agent_name>".
            Actual tenant substitution happens at runtime.
        mcp_tools: Names of MCP servers this agent may call. Enforcement
            happens at the tool layer, not in the prompt.
        trust_tier: Per-action-class autonomy tier (see module docstring).
        triggers: Event types that wake the agent. Consumed by the
            LangGraph dispatcher.
    """

    name: str
    scope: str
    system_prompt: str
    memory_namespace: str
    mcp_tools: Tuple[str, ...]
    trust_tier: TrustTier
    triggers: Tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("Agent.name must not be empty")
        if not self.scope:
            raise ValueError("Agent.scope must not be empty")
        if not self.system_prompt:
            raise ValueError("Agent.system_prompt must not be empty")
        if not self.memory_namespace:
            raise ValueError("Agent.memory_namespace must not be empty")
        if not self.triggers:
            raise ValueError("Agent.triggers must not be empty")
        if self.trust_tier not in (
            "autonomous",
            "graduates_fast",
            "graduates_slowly",
            "always_asks",
        ):
            raise ValueError(
                f"Agent.trust_tier must be a valid TrustTier, got {self.trust_tier!r}"
            )


# Founding sentence — enforced in docs/decisions.md via D12 test, and
# surfaced here so every agent definition can import and check itself
# against it during review.
FOUNDING_SENTENCE = "You learned the trade. We'll run the business."
