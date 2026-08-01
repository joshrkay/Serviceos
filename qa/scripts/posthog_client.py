"""Shared PostHog analytics client for ServiceOS QA scripts."""
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
    from posthog import Posthog

    ph = Posthog(
        _TOKEN,
        host=_HOST,
        enable_exception_autocapture=True,
    )
    atexit.register(ph.shutdown)
    return ph


client = _make_client()

DISTINCT_ID: str = os.getenv("POSTHOG_DISTINCT_ID", socket.gethostname() or "system")


def capture(event: str, properties: dict | None = None) -> None:
    if client is None:
        return
    client.capture(distinct_id=DISTINCT_ID, event=event, properties=properties or {})


def capture_exception(exc: Exception) -> None:
    if client is None:
        return
    client.capture_exception(exc, distinct_id=DISTINCT_ID)
