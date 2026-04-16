"""Agent instances for the Service OS platform.

Each module in this package defines one `Agent` instance (see
`service-os-agent/agent/primitive.py`). Agents are data, not code paths.

Vertical-slice status:
  - capture.CAPTURE_AGENT    — DEFINED (step 0 slice #1)
  - invoice.INVOICE_AGENT    — DEFINED (step 0 slice #2)
  - payment.PAYMENT_AGENT    — DEFINED (step 0 slice #2)
  - comms.COMMS_AGENT        — TODO (post-Twilio wiring)
  - dispatch.DISPATCH_AGENT  — TODO (post-MVP)
  - briefing.BRIEFING_AGENT  — TODO (D7 morning briefing)
  - onboarding.ONBOARDING_AGENT — TODO (D1 onboarding flow)
"""

from .capture import CAPTURE_AGENT
from .invoice import INVOICE_AGENT
from .payment import PAYMENT_AGENT

__all__ = ["CAPTURE_AGENT", "INVOICE_AGENT", "PAYMENT_AGENT"]
