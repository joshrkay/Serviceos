"""
Money-action ceilings — single source of truth.

Decision 9 mandates that hard gates on money-moving actions live at
the MCP tool layer, NOT in prompts. Every MCP server that exposes a
money-moving tool imports its ceiling from this module so there is
exactly one place in the Python service where the numbers are written
down. Changing a ceiling means changing this file, which surfaces as
a code review.

Format is integer cents (never float), matching the TS billing engine.

Ceilings are CAPS, not pricing tiers. The operator may raise their own
threshold via tenant settings (Decision 9 says "Operators can raise
their own thresholds within platform-enforced floors") but the floor
declared here can never be lowered to zero, and any value above the
declared ceiling MUST also carry a voice-confirmation token at the
tool layer.
"""

from __future__ import annotations

# Default unattended-action ceiling. Above this, the tool layer
# requires a voice-confirmation token regardless of trust tier.
MAX_UNATTENDED_CENTS: int = 50_000  # $500.00

# Operator-customizable per-action class ceilings. These are the
# platform floors — operators can raise above these, never below.
INVOICE_SEND_CEILING_CENTS: int = MAX_UNATTENDED_CENTS
PAYMENT_LINK_CEILING_CENTS: int = MAX_UNATTENDED_CENTS
DUNNING_SEND_CEILING_CENTS: int = MAX_UNATTENDED_CENTS

# Refunds are irreversible (Decision 3 trust tier "always_asks") and
# require voice confirmation regardless of amount. The ceiling exists
# only as a sanity bound — any refund attempt above this fails outright
# even with voice confirmation, surfacing as a hard escalation.
REFUND_HARD_CAP_CENTS: int = 1_000_000  # $10,000.00 — escalate above
