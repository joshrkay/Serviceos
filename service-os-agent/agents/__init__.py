"""Agent instances for the Service OS platform.

Each module in this package defines one `Agent` instance (see
`service-os-agent/agent/primitive.py`). Agents are data, not code paths.

Vertical-slice status (2026-04-14):
  - capture.CAPTURE_AGENT    — DEFINED
  - invoice.INVOICE_AGENT    — TODO (next slice)
  - payment.PAYMENT_AGENT    — TODO (next slice)
  - dunning.DUNNING_AGENT    — TODO (post-MVP)
  - comms.COMMS_AGENT        — TODO (post-Twilio wiring)
  - briefing.BRIEFING_AGENT  — TODO (post-MVP)
  - onboarding.ONBOARDING_AGENT — TODO (post-MVP)
"""

from .capture import CAPTURE_AGENT

__all__ = ["CAPTURE_AGENT"]
