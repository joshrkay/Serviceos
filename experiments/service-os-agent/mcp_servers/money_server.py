"""
money_server — MCP server for money-moving back-office actions.

The single highest-stakes MCP server. Every tool that moves money or
sends a customer-visible message about money lives here, and every
tool enforces its ceiling at the tool layer — never in the prompt.

Tools (v1 vertical slice):
  - draft_invoice         — no ceiling (drafting is safe)
  - send_invoice          — ceiling: $500 unattended; voice confirm above
  - create_payment_link   — ceiling: $500 unattended; voice confirm above
  - send_dunning          — ceiling: $500 unattended; voice confirm above
  - issue_refund          — ALWAYS requires voice confirmation
                            (irreversible, Decision 3 "always_asks")
                            with a hard cap at $10,000 even with confirm

Each money-moving tool sets `money_ceiling_cents` on its ToolSchema.
The base server enforces the check on call_tool() before the handler
runs. Refunds additionally set `always_requires_voice_confirmation`
because they are irreversible regardless of amount.

Voice confirmation is represented as a `voice_confirmation_token`
argument. For this slice the check is presence (non-empty string); a
real implementation will validate the token against a recently spoken
prompt with a short TTL. The architectural shape — token at the tool
layer, not the prompt — is what matters.

All writes go through the TS API via ServiceOsApiClient. The Python
agent service never touches Stripe or the database directly. The TS
API enforces the proposal lifecycle, audit trail, and Stripe
webhook idempotency.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional

from clients.service_os_api import ServiceOsApiClient
from mcp_servers.ceilings import (
    MAX_UNATTENDED_CENTS,
    INVOICE_SEND_CEILING_CENTS,
    PAYMENT_LINK_CEILING_CENTS,
    DUNNING_SEND_CEILING_CENTS,
    REFUND_HARD_CAP_CENTS,
)

logger = logging.getLogger(__name__)

__all__ = [
    "MoneyServer",
    "MoneyToolSchema",
    "MoneyToolRegistration",
    "MAX_UNATTENDED_CENTS",
]


@dataclass(frozen=True)
class MoneyToolSchema:
    """Money MCP tool schema with explicit ceiling + confirmation flags.

    Attributes:
        name: Tool identifier.
        description: Short description shown to the agent.
        input_schema: JSON Schema for the input.
        money_ceiling_cents: Reject the call if `amount_cents` exceeds
            this without a `voice_confirmation_token`. None means no
            ceiling enforcement (read-only or drafting tools).
        always_requires_voice_confirmation: If True, the tool always
            requires a `voice_confirmation_token` regardless of amount.
            Used for irreversible actions per Decision 3.
        hard_cap_cents: Absolute ceiling. The call fails outright above
            this even WITH a voice confirmation token, surfacing as a
            hard escalation. None means no hard cap.
    """

    name: str
    description: str
    input_schema: Dict[str, Any]
    money_ceiling_cents: Optional[int] = None
    always_requires_voice_confirmation: bool = False
    hard_cap_cents: Optional[int] = None


@dataclass
class MoneyToolRegistration:
    schema: MoneyToolSchema
    handler: Callable[..., Awaitable[Any]]


class MoneyServer:
    """Plain-Python MCP-shaped server for money-moving operations."""

    name: str = "money_server"

    def __init__(self, api_client: ServiceOsApiClient) -> None:
        self._api = api_client
        self._tools: Dict[str, MoneyToolRegistration] = {}
        self._register_default_tools()

    # ── MCP-shaped surface ────────────────────────────────────

    def list_tools(self) -> List[MoneyToolSchema]:
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
                f"money_server.{name}: tenant_id is required — tenant isolation "
                f"enforced at the tool layer, not the prompt"
            )
        if name not in self._tools:
            raise KeyError(f"money_server has no tool named {name!r}")

        reg = self._tools[name]
        args = dict(arguments)

        # Parse amount_cents robustly (LLM JSON sometimes stringifies
        # numbers as "500.0"). Same defensive parse as jobs_server.
        amount_cents = self._parse_amount_cents(args.get("amount_cents"), name)

        # Voice confirmation token — opaque string; presence is the
        # gate for this slice. A real impl validates against a recent
        # spoken prompt with a short TTL.
        voice_token = args.get("voice_confirmation_token")
        has_voice_token = isinstance(voice_token, str) and len(voice_token.strip()) > 0

        # Hard cap: absolute ceiling, fails outright even WITH confirm.
        if reg.schema.hard_cap_cents is not None and amount_cents is not None:
            if amount_cents > reg.schema.hard_cap_cents:
                raise PermissionError(
                    f"money_server.{name}: amount {amount_cents} cents exceeds "
                    f"hard cap {reg.schema.hard_cap_cents} cents — escalation required"
                )

        # Always-confirm: irreversible actions need voice confirmation
        # regardless of amount (Decision 3 "always_asks").
        if reg.schema.always_requires_voice_confirmation and not has_voice_token:
            raise PermissionError(
                f"money_server.{name}: irreversible action requires "
                f"voice_confirmation_token regardless of amount"
            )

        # Ceiling: above ceiling requires voice confirmation.
        if reg.schema.money_ceiling_cents is not None and amount_cents is not None:
            if amount_cents > reg.schema.money_ceiling_cents and not has_voice_token:
                raise PermissionError(
                    f"money_server.{name}: amount {amount_cents} cents exceeds "
                    f"ceiling {reg.schema.money_ceiling_cents} cents — "
                    f"voice_confirmation_token required"
                )

        return await reg.handler(
            arguments=args,
            tenant_id=tenant_id,
            user_id=user_id,
        )

    @staticmethod
    def _parse_amount_cents(raw: Any, tool_name: str) -> Optional[int]:
        if raw is None:
            return None
        try:
            return int(float(raw))
        except (TypeError, ValueError) as e:
            raise ValueError(
                f"money_server.{tool_name}: amount_cents must be a number, "
                f"got {raw!r}"
            ) from e

    # ── Tool implementations ──────────────────────────────────

    def _register_default_tools(self) -> None:
        self._tools["draft_invoice"] = MoneyToolRegistration(
            schema=MoneyToolSchema(
                name="draft_invoice",
                description=(
                    "Draft an invoice against the Service OS TS API. The "
                    "draft lands in 'draft' status; sending requires a "
                    "separate send_invoice call. No ceiling because "
                    "drafting moves no money."
                ),
                input_schema={
                    "type": "object",
                    "required": ["job_id", "line_items"],
                    "properties": {
                        "job_id": {"type": "string", "minLength": 1},
                        "line_items": {"type": "array", "minItems": 1},
                        "customer_message": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
                money_ceiling_cents=None,
            ),
            handler=self._handle_draft_invoice,
        )

        self._tools["send_invoice"] = MoneyToolRegistration(
            schema=MoneyToolSchema(
                name="send_invoice",
                description=(
                    "Issue and send an invoice to the customer. Above the "
                    "platform ceiling, requires voice_confirmation_token."
                ),
                input_schema={
                    "type": "object",
                    "required": ["invoice_id", "amount_cents"],
                    "properties": {
                        "invoice_id": {"type": "string", "minLength": 1},
                        "amount_cents": {"type": "integer", "minimum": 0},
                        "send_method": {"type": "string", "enum": ["email", "sms"]},
                        "voice_confirmation_token": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
                money_ceiling_cents=INVOICE_SEND_CEILING_CENTS,
            ),
            handler=self._handle_send_invoice,
        )

        self._tools["create_payment_link"] = MoneyToolRegistration(
            schema=MoneyToolSchema(
                name="create_payment_link",
                description=(
                    "Create a Stripe payment link for an invoice. Above the "
                    "platform ceiling, requires voice_confirmation_token."
                ),
                input_schema={
                    "type": "object",
                    "required": ["invoice_id", "amount_cents"],
                    "properties": {
                        "invoice_id": {"type": "string", "minLength": 1},
                        "amount_cents": {"type": "integer", "minimum": 0},
                        "voice_confirmation_token": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
                money_ceiling_cents=PAYMENT_LINK_CEILING_CENTS,
            ),
            handler=self._handle_create_payment_link,
        )

        self._tools["send_dunning"] = MoneyToolRegistration(
            schema=MoneyToolSchema(
                name="send_dunning",
                description=(
                    "Send an overdue-invoice dunning message to the customer. "
                    "amount_cents reflects the unpaid balance; above the "
                    "platform ceiling, requires voice_confirmation_token. "
                    "tone is operator-controlled."
                ),
                input_schema={
                    "type": "object",
                    "required": ["invoice_id", "amount_cents", "tone"],
                    "properties": {
                        "invoice_id": {"type": "string", "minLength": 1},
                        "amount_cents": {"type": "integer", "minimum": 0},
                        "tone": {
                            "type": "string",
                            "enum": ["friendly", "firm", "final_notice"],
                        },
                        "voice_confirmation_token": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
                money_ceiling_cents=DUNNING_SEND_CEILING_CENTS,
            ),
            handler=self._handle_send_dunning,
        )

        self._tools["issue_refund"] = MoneyToolRegistration(
            schema=MoneyToolSchema(
                name="issue_refund",
                description=(
                    "Reverse a payment by issuing a Stripe refund. "
                    "Irreversible: ALWAYS requires voice_confirmation_token "
                    "regardless of amount, and is hard-capped at "
                    "REFUND_HARD_CAP_CENTS."
                ),
                input_schema={
                    "type": "object",
                    "required": ["payment_id", "amount_cents"],
                    "properties": {
                        "payment_id": {"type": "string", "minLength": 1},
                        "amount_cents": {"type": "integer", "minimum": 1},
                        "reason": {"type": "string"},
                        "voice_confirmation_token": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
                always_requires_voice_confirmation=True,
                hard_cap_cents=REFUND_HARD_CAP_CENTS,
            ),
            handler=self._handle_issue_refund,
        )

    async def _handle_draft_invoice(
        self,
        *,
        arguments: Dict[str, Any],
        tenant_id: str,
        user_id: str,
    ) -> Dict[str, Any]:
        # Drafts go through the proposal pipeline on the TS side.
        return await self._api.draft_proposal(
            tenant_id=tenant_id,
            user_id=user_id,
            proposal_type="draft_invoice",
            payload={
                "job_id": arguments["job_id"],
                "line_items": arguments["line_items"],
                "customer_message": arguments.get("customer_message"),
            },
            summary=f"Draft invoice for job {arguments['job_id']}",
        )

    async def _handle_send_invoice(
        self,
        *,
        arguments: Dict[str, Any],
        tenant_id: str,
        user_id: str,
    ) -> Dict[str, Any]:
        # The actual TS endpoint for issuing an invoice is
        # POST /api/invoices/:id/issue. The Python client doesn't yet
        # have a dedicated method for it; this slice models the call
        # as a proposal so the approval-gate path stays unified.
        return await self._api.draft_proposal(
            tenant_id=tenant_id,
            user_id=user_id,
            proposal_type="send_invoice",
            payload={
                "invoice_id": arguments["invoice_id"],
                "amount_cents": arguments["amount_cents"],
                "send_method": arguments.get("send_method", "email"),
            },
            summary=f"Send invoice {arguments['invoice_id']}",
        )

    async def _handle_create_payment_link(
        self,
        *,
        arguments: Dict[str, Any],
        tenant_id: str,
        user_id: str,
    ) -> Dict[str, Any]:
        return await self._api.draft_proposal(
            tenant_id=tenant_id,
            user_id=user_id,
            proposal_type="create_payment_link",
            payload={
                "invoice_id": arguments["invoice_id"],
                "amount_cents": arguments["amount_cents"],
            },
            summary=f"Create payment link for invoice {arguments['invoice_id']}",
        )

    async def _handle_send_dunning(
        self,
        *,
        arguments: Dict[str, Any],
        tenant_id: str,
        user_id: str,
    ) -> Dict[str, Any]:
        return await self._api.draft_proposal(
            tenant_id=tenant_id,
            user_id=user_id,
            proposal_type="send_dunning",
            payload={
                "invoice_id": arguments["invoice_id"],
                "amount_cents": arguments["amount_cents"],
                "tone": arguments["tone"],
            },
            summary=f"Dunning ({arguments['tone']}) for invoice {arguments['invoice_id']}",
        )

    async def _handle_issue_refund(
        self,
        *,
        arguments: Dict[str, Any],
        tenant_id: str,
        user_id: str,
    ) -> Dict[str, Any]:
        return await self._api.draft_proposal(
            tenant_id=tenant_id,
            user_id=user_id,
            proposal_type="issue_refund",
            payload={
                "payment_id": arguments["payment_id"],
                "amount_cents": arguments["amount_cents"],
                "reason": arguments.get("reason"),
            },
            summary=f"Issue refund for payment {arguments['payment_id']}",
        )
