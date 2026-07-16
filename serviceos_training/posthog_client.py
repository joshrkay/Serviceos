"""Shared PostHog analytics client for ServiceOS training pipeline scripts.

Initializes a PostHog instance from environment variables and exposes a
module-level `client` (or None when unconfigured) plus a `capture` helper.
Register `shutdown()` with atexit so events flush automatically on exit.
"""
from __future__ import annotations

import atexit
import os
import socket

from dotenv import load_dotenv

load_dotenv()

_TOKEN = os.getenv("POSTHOG_PROJECT_TOKEN")
_HOST = os.getenv("POSTHOG_HOST", "https://us.i.posthog.com")


def _make_client():
    if not _TOKEN:
        return None
    from posthog import Posthog  # lazy: only imported when token is present

    ph = Posthog(
        _TOKEN,
        host=_HOST,
        enable_exception_autocapture=True,
    )
    atexit.register(ph.shutdown)
    return ph


client = _make_client()

# Stable, non-PII identifier for this machine/environment.
DISTINCT_ID: str = os.getenv("POSTHOG_DISTINCT_ID", socket.gethostname() or "system")


def capture(event: str, properties: dict | None = None) -> None:
    """Capture an analytics event. No-op when PostHog is not configured."""
    if client is None:
        return
    client.capture(distinct_id=DISTINCT_ID, event=event, properties=properties or {})


def capture_exception(exc: Exception) -> None:
    """Manually capture a handled exception. No-op when not configured."""
    if client is None:
        return
    client.capture_exception(exc, distinct_id=DISTINCT_ID)
