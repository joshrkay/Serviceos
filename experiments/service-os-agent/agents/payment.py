"""
PaymentAgent — runs the AR loop, reconciles payments, drives dunning.

Decision mapping:
  - D2 (voice debrief primary): NOT triggered by voice capture. Wakes
    on Stripe webhook events (payment succeeded, failed) and on a
    scheduled daily AR sweep. Surfaces overdue invoices to the
    operator briefing rather than acting silently.
  - D3 (trust per action class): trust_tier="graduates_slowly" because
    every action it can take is money-moving (dunning, refunds, link
    regeneration). Refund-class actions hit money_server's
    always_requires_voice_confirmation gate.
  - D4 (stay in lane): does not draft new invoices, does not schedule
    appointments, does not send customer comms unrelated to the AR
    loop.
  - D7 (briefing): the daily AR sweep produces input for the morning
    briefing agent rather than firing customer-visible actions
    directly.
  - D9 (hard gates): mcp_tools is money_server only — payment cannot
    create invoices, cannot move jobs around, cannot edit customers.
"""

from __future__ import annotations

from agent.primitive import Agent

PAYMENT_SYSTEM_PROMPT = """You are the Payment Agent for Service OS.

Your job is narrow: keep the operator's AR balance accurate, surface
overdue invoices, draft appropriate dunning when authorized, and
reconcile incoming Stripe payments against open invoices.

You can read invoice + payment state via money_server, draft dunning
messages (with operator-controlled tone), and stage refunds for
operator approval.

Money-moving tools have hard ceilings enforced at the tool layer.
Above the ceiling, you MUST request voice_confirmation_token from the
operator. Refunds always require voice confirmation regardless of
amount — they are irreversible.

You do not draft new invoices (that is the Invoice Agent's job).
You do not contact customers about anything other than payment status.
You surface ambiguous situations to the daily briefing rather than
acting silently.

Respond with structured tool calls only.
""".strip()


PAYMENT_AGENT = Agent(
    name="payment",
    scope=(
        "Runs the AR loop: reconciles Stripe payments, surfaces overdue "
        "invoices, drafts dunning, stages refunds. Read-only on jobs and "
        "customers; write access scoped to money_server."
    ),
    system_prompt=PAYMENT_SYSTEM_PROMPT,
    memory_namespace="{tenant_id}:payment",
    mcp_tools=("money_server",),
    trust_tier="graduates_slowly",
    triggers=(
        "webhook:stripe.payment_intent.succeeded",
        "webhook:stripe.payment_intent.payment_failed",
        "webhook:stripe.checkout.session.completed",
        "schedule:cron:daily_ar_sweep",
    ),
)
