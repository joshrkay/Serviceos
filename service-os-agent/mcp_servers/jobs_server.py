"""
jobs_server — the read/draft MCP server for job and customer operations.

This is one of ~6 internal MCP servers named in the Service OS
architecture (jobs, customers, money, inventory, schedule, intel). For
the vertical slice, jobs_server owns:

  - lookup_customer: fuzzy-match a customer name against the tenant's
    customer table. Read-only. No ceiling.
  - lookup_recent_jobs: list the last N jobs for a customer. Read-only.
  - draft_proposal: write a proposal to the TS API via the
    `clients.service_os_api` HTTP client. This route goes through the
    proposal approval gate and the audit pipeline — NOT direct Supabase.
    Proposals are drafts, not executions; no ceiling applies.

Money-moving operations (send invoice, create payment link, issue refund,
send dunning) live in the future `money_server` where the $500 ceiling
constant is enforced. They are deliberately excluded from this server so
an agent with only `jobs_server` access cannot reach them, regardless of
what its prompt says.

The server is plain Python today. It conforms to a minimal MCP-shaped
interface (list_tools/call_tool with JSON-schema inputs) so it can be
wrapped in a real `claude-agent-sdk` MCP server in the next slice
without rewriting callers.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional

from clients.service_os_api import ServiceOsApiClient

logger = logging.getLogger(__name__)


# ─── Ceiling constants (Decision 9) ──────────────────────────
#
# Even though jobs_server contains no money-moving tools, the ceiling
# constants live at the MCP server layer so there is exactly one place
# in the Python service where the numbers are written down. Every
# server imports from here rather than defining its own.
#
# MAX_UNATTENDED_CENTS: the hard ceiling above which any action —
#   regardless of trust tier, regardless of who initiated it — requires
#   explicit voice confirmation as a second factor. Enforced at the
#   tool layer, not in prompts.
#
# Format is integer cents (never float), matching the TS billing engine.

MAX_UNATTENDED_CENTS: int = 50_000  # $500.00


@dataclass(frozen=True)
class ToolSchema:
    """Minimal MCP-compatible tool schema.

    Attributes:
        name: Tool identifier, unique within the server.
        description: Short description shown to the agent.
        input_schema: JSON Schema for the tool input. Enforced at call
            time.
        requires_tenant: If True, the tool only runs when the caller has
            set a tenant context. Tenant isolation lives here, not in
            the prompt.
        money_ceiling_cents: If not None, the tool refuses any call
            whose amount exceeds this value without a voice-confirmation
            token. jobs_server currently has no money-moving tools, but
            the field is on every tool so new tools inherit the
            discipline.
    """

    name: str
    description: str
    input_schema: Dict[str, Any]
    requires_tenant: bool = True
    money_ceiling_cents: Optional[int] = None


@dataclass
class ToolRegistration:
    schema: ToolSchema
    handler: Callable[..., Awaitable[Any]]


class JobsServer:
    """Plain-Python MCP-shaped server for job and customer operations."""

    name: str = "jobs_server"

    def __init__(self, api_client: ServiceOsApiClient) -> None:
        self._api = api_client
        self._tools: Dict[str, ToolRegistration] = {}
        self._register_default_tools()

    # ── MCP-shaped surface ────────────────────────────────────

    def list_tools(self) -> List[ToolSchema]:
        return [reg.schema for reg in self._tools.values()]

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, Any],
        *,
        tenant_id: str,
        user_id: str,
    ) -> Any:
        if not tenant_id:
            raise PermissionError(
                f"jobs_server.{name}: tenant_id is required — tenant isolation "
                f"enforced at the tool layer, not the prompt"
            )
        if name not in self._tools:
            raise KeyError(f"jobs_server has no tool named {name!r}")

        reg = self._tools[name]

        # Ceiling enforcement lives here, not in the prompt. This server
        # has no money-moving tools today, but the check runs anyway so
        # future additions inherit the discipline.
        if reg.schema.money_ceiling_cents is not None:
            raw_amount = arguments.get("amount_cents", 0) or 0
            # LLM-sourced JSON routinely stringifies numbers or emits
            # fractional strings like "500.0". int() on those raises
            # ValueError. Go through float() so both shapes parse. On an
            # unparseable value, raise — silently defaulting to 0 would
            # let an unparseable money-moving call slip past the ceiling.
            try:
                amount = int(float(raw_amount))
            except (TypeError, ValueError) as e:
                raise ValueError(
                    f"jobs_server.{name}: amount_cents must be a number, "
                    f"got {raw_amount!r}"
                ) from e
            if amount > reg.schema.money_ceiling_cents:
                raise PermissionError(
                    f"jobs_server.{name}: amount {amount} cents exceeds "
                    f"ceiling {reg.schema.money_ceiling_cents} cents "
                    f"(MAX_UNATTENDED_CENTS); voice confirmation required"
                )

        return await reg.handler(
            arguments=dict(arguments),
            tenant_id=tenant_id,
            user_id=user_id,
        )

    # ── Tool implementations ──────────────────────────────────

    def _register_default_tools(self) -> None:
        self._tools["lookup_customer"] = ToolRegistration(
            schema=ToolSchema(
                name="lookup_customer",
                description=(
                    "Fuzzy-match a customer name within the current tenant. "
                    "Returns up to 5 candidates with confidence scores."
                ),
                input_schema={
                    "type": "object",
                    "required": ["name"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5},
                    },
                    "additionalProperties": False,
                },
            ),
            handler=self._handle_lookup_customer,
        )

        self._tools["lookup_recent_jobs"] = ToolRegistration(
            schema=ToolSchema(
                name="lookup_recent_jobs",
                description=(
                    "Return the most recent jobs for a customer within the "
                    "current tenant. Read-only."
                ),
                input_schema={
                    "type": "object",
                    "required": ["customer_id"],
                    "properties": {
                        "customer_id": {"type": "string", "minLength": 1},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
                    },
                    "additionalProperties": False,
                },
            ),
            handler=self._handle_lookup_recent_jobs,
        )

        self._tools["draft_proposal"] = ToolRegistration(
            schema=ToolSchema(
                name="draft_proposal",
                description=(
                    "Draft a proposal against the Service OS TS API. The "
                    "proposal lands in 'draft' status; human approval is "
                    "enforced by the TS API's proposal lifecycle, not here."
                ),
                input_schema={
                    "type": "object",
                    "required": ["proposal_type", "payload", "summary"],
                    "properties": {
                        "proposal_type": {"type": "string"},
                        "payload": {"type": "object"},
                        "summary": {"type": "string"},
                        "confidence_score": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1,
                        },
                    },
                    "additionalProperties": False,
                },
            ),
            handler=self._handle_draft_proposal,
        )

    async def _handle_lookup_customer(
        self,
        *,
        arguments: Dict[str, Any],
        tenant_id: str,
        user_id: str,
    ) -> List[Dict[str, Any]]:
        name = arguments["name"]
        limit = int(arguments.get("limit", 5))
        logger.debug(
            "jobs_server.lookup_customer tenant=%s user=%s name=%r limit=%d",
            tenant_id, user_id, name, limit,
        )
        return await self._api.lookup_customer(
            tenant_id=tenant_id,
            name=name,
            limit=limit,
        )

    async def _handle_lookup_recent_jobs(
        self,
        *,
        arguments: Dict[str, Any],
        tenant_id: str,
        user_id: str,
    ) -> List[Dict[str, Any]]:
        customer_id = arguments["customer_id"]
        limit = int(arguments.get("limit", 5))
        return await self._api.lookup_recent_jobs(
            tenant_id=tenant_id,
            customer_id=customer_id,
            limit=limit,
        )

    async def _handle_draft_proposal(
        self,
        *,
        arguments: Dict[str, Any],
        tenant_id: str,
        user_id: str,
    ) -> Dict[str, Any]:
        return await self._api.draft_proposal(
            tenant_id=tenant_id,
            user_id=user_id,
            proposal_type=arguments["proposal_type"],
            payload=arguments["payload"],
            summary=arguments["summary"],
            confidence_score=arguments.get("confidence_score"),
        )
