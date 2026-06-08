"""PII scrubber for the ServiceOS Reddit training corpus.

Ported from the canonical TypeScript scrubber
``packages/api/src/ai/training/scrub.ts`` so the Python ingestion pipeline
applies the SAME deterministic redaction rules as the API. Two layers + a
fail-loud residual gate, no model calls:

  1. Entity-based redaction (when known entities are supplied): exact-match
     replacement of known phones/emails/names/addresses with stable
     placeholders, before the regex sweep.
  2. Deterministic regex sweep: phone (E.164 + national + colloquial), email,
     street addresses (``<number> <name> <suffix>``).
  3. Post-scrub gate: re-run the sweep on the output plus digit-run / all-caps
     heuristics. Any signal sets ``has_residual_pii = True``.

This module is pure (no I/O) and is what ``02_reddit_processor.py`` calls before
a row is persisted. ``test_scrub_pii.py`` asserts zero leakage on 100 fixtures.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

# ── Regex layer (mirrors scrub.ts) ──────────────────────────────────────────

PHONE_REGEX = re.compile(
    "|".join(
        [
            # E.164-ish: + then country code and digits with optional separators
            r"\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?[\s.\-]?\d{1,4}[\s.\-]?\d{1,9}",
            # (415) 555-0123 / (415)555-0123
            r"\(\d{3}\)\s?\d{3}[\s.\-]?\d{4}",
            # 1-415-555-0123 (leading 1, separator required)
            r"\b1[\s.\-]\d{3}[\s.\-]\d{3}[\s.\-]\d{4}\b",
            # 415-555-0123 / 415.555.0123 (separator required)
            r"\b\d{3}[\s.\-]\d{3}[\s.\-]\d{4}\b",
        ]
    )
)

EMAIL_REGEX = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

_STREET_SUFFIXES = [
    "St", "Street", "Ave", "Avenue", "Blvd", "Boulevard", "Rd", "Road",
    "Ln", "Lane", "Dr", "Drive", "Ct", "Court", "Pl", "Place",
    "Ter", "Terrace", "Way", "Pkwy", "Parkway", "Hwy", "Highway",
    "Cir", "Circle", "Trl", "Trail",
]
# Case-insensitive (re.IGNORECASE): real user-written text frequently lowercases
# addresses ("123 main st", "456 elm street"). Both the street-name words and the
# suffix must match regardless of case — detect_residual_pii() and has_pii_leak()
# reuse this regex, so a case-sensitive pattern would let lowercase addresses slip
# past the zero-PII gate.
ADDRESS_REGEX = re.compile(
    r"\b\d+\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,3})\s+(?:%s)\b\.?"
    % "|".join(_STREET_SUFFIXES),
    re.IGNORECASE,
)

# ── Residual heuristics (the fail-loud gate) ────────────────────────────────
_PLACEHOLDER_REGEX = re.compile(r"\[[A-Z_]+\]")
_DIGIT_RUN_REGEX = re.compile(r"[0-9]{7,}")
_ALL_CAPS_NAME_REGEX = re.compile(r"\b[A-Z]{2,}\s+[A-Z]{2,}\s+[A-Z]{2,}\b")


@dataclass
class KnownEntities:
    phones: Iterable[str] = field(default_factory=list)
    emails: Iterable[str] = field(default_factory=list)
    names: Iterable[str] = field(default_factory=list)
    addresses: Iterable[str] = field(default_factory=list)


@dataclass
class ScrubResult:
    text: str
    scrubbed: str
    redactions: list[dict]
    has_residual_pii: bool
    residual_signals: list[str]


def _replace_literal(text: str, needle: str, placeholder: str, kind: str, redactions: list[dict]) -> str:
    if not needle:
        return text
    pattern = re.compile(re.escape(needle), re.IGNORECASE)

    def _sub(m: re.Match) -> str:
        redactions.append({"kind": kind, "matched": m.group(0), "placeholder": placeholder,
                           "start": m.start(), "end": m.end()})
        return placeholder

    return pattern.sub(_sub, text)


def _replace_regex(text: str, regex: re.Pattern, placeholder: str, kind: str, redactions: list[dict]) -> str:
    def _sub(m: re.Match) -> str:
        redactions.append({"kind": kind, "matched": m.group(0), "placeholder": placeholder,
                           "start": m.start(), "end": m.end()})
        return placeholder

    return regex.sub(_sub, text)


def detect_residual_pii(scrubbed: str) -> list[str]:
    signals: list[str] = []
    placeholderless = _PLACEHOLDER_REGEX.sub("", scrubbed)
    if _DIGIT_RUN_REGEX.search(placeholderless):
        signals.append("digit_run_ge_7")
    if _ALL_CAPS_NAME_REGEX.search(placeholderless):
        signals.append("all_caps_name_run")
    if PHONE_REGEX.search(placeholderless):
        signals.append("residual_phone_match")
    if EMAIL_REGEX.search(placeholderless):
        signals.append("residual_email_match")
    if ADDRESS_REGEX.search(placeholderless):
        signals.append("residual_address_match")
    return signals


def scrub_pii(text: str, known: KnownEntities | None = None, fail_on_residual: bool = False) -> ScrubResult:
    """Scrub PII from ``text``. Pure function — no I/O."""
    redactions: list[dict] = []
    working = text
    known = known or KnownEntities()

    # Layer 1: entity-based
    for phone in known.phones:
        working = _replace_literal(working, phone, "[CALLER_PHONE]", "known_phone", redactions)
    for email in known.emails:
        working = _replace_literal(working, email, "[CALLER_EMAIL]", "known_email", redactions)
    for name in known.names:
        working = _replace_literal(working, name, "[CALLER_NAME]", "known_name", redactions)
    for address in known.addresses:
        working = _replace_literal(working, address, "[CALLER_ADDRESS]", "known_address", redactions)

    # Layer 2: regex sweep (address before phone — address has a leading number)
    working = _replace_regex(working, ADDRESS_REGEX, "[ADDRESS]", "address", redactions)
    working = _replace_regex(working, EMAIL_REGEX, "[EMAIL]", "email", redactions)
    working = _replace_regex(working, PHONE_REGEX, "[PHONE]", "phone", redactions)

    # Layer 3: residual gate
    residual_signals = detect_residual_pii(working)
    has_residual = len(residual_signals) > 0
    if has_residual and fail_on_residual:
        raise ValueError(f"scrub_pii: residual PII detected ({', '.join(residual_signals)})")

    return ScrubResult(text=text, scrubbed=working, redactions=redactions,
                       has_residual_pii=has_residual, residual_signals=residual_signals)


def has_pii_leak(scrubbed: str) -> bool:
    """True if any phone/email/address regex still matches the scrubbed text
    (placeholders ignored). Used by the zero-leakage test."""
    placeholderless = _PLACEHOLDER_REGEX.sub("", scrubbed)
    return bool(
        PHONE_REGEX.search(placeholderless)
        or EMAIL_REGEX.search(placeholderless)
        or ADDRESS_REGEX.search(placeholderless)
    )
