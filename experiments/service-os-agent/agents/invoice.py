"""
InvoiceAgent — drafts and sends invoices.

Decision mapping:
  - D2 (voice debrief primary): downstream of CaptureAgent. When a
    capture handoff classifies intent as create_invoice, the inter-
    agent graph routes to this agent.
  - D3 (trust per action class): trust_tier="graduates_slowly" because
    every tool this agent reaches is money-moving. A high-confidence
    invoice draft does NOT auto-send; the operator approves the
    proposal at the TS API layer. The platform-floor ceilings live in
    money_server, not in this agent's prompt.
  - D4 (stay in lane): system prompt is narrowly scoped to invoicing
    only — no scheduling, no customer comms beyond the invoice text,
    no estimating workflows.
  - D9 (hard gates): mcp_tools includes money_server, but the ceiling
    constants in money_server.ceilings.py are what actually enforce
    the gates. The agent has no way to bypass them even if its
    prompt were injected.
"""

from __future__ import annotations

from agent.primitive import Agent

INVOICE_SYSTEM_PROMPT = """You are the Invoice Agent for Service OS.

Your job is narrow: given a job context (customer, line items, totals),
draft an accurate invoice and stage it for operator review. You do NOT
volunteer pricing changes, suggest discounts, or coach the operator.

You have read access to job and customer data via jobs_server, and
write access to invoice operations via money_server.

Money-moving tools (send_invoice, create_payment_link, send_dunning)
have hard ceilings enforced at the tool layer. Above the ceiling, you
MUST request a voice_confirmation_token from the operator before
calling the tool. You cannot bypass this gate, and you cannot lie
about whether confirmation was obtained — the tool layer checks the
token regardless of what the prompt says.

Refunds (issue_refund) are irreversible and ALWAYS require voice
confirmation, regardless of amount.

Respond with structured tool calls only; no prose commentary outside
the tool inputs.
""".strip()


INVOICE_AGENT = Agent(
    name="invoice",
    scope=(
        "Drafts invoices from completed job context, stages them for "
        "operator approval, and (above the ceiling) requests voice "
        "confirmation before any send."
    ),
    system_prompt=INVOICE_SYSTEM_PROMPT,
    memory_namespace="{tenant_id}:invoice",
    mcp_tools=("jobs_server", "money_server"),
    trust_tier="graduates_slowly",
    triggers=(
        "handoff:capture:create_invoice",
        "schedule:cron:weekly_invoice_review",
    ),
)
