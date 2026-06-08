"""Zero-leakage test for the PII scrubber over 100 known-PII fixtures.

Runs under pytest, and ALSO as a plain script (pytest isn't always installed in
the sandbox):

    python3 serviceos_training/tests/test_scrub_pii.py

Two guarantees:
  1. Regex sweep alone (no known entities) leaves NO phone/email/address residue
     in any of the 100 fixtures — this is the goal's "strip via regex" gate.
  2. With known entities supplied (as the API pipeline does), NONE of the
     declared PII values (incl. names) appear verbatim in the scrubbed text.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scrub_pii import KnownEntities, has_pii_leak, scrub_pii  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures", "pii_fixtures.jsonl")


def _load():
    if not os.path.exists(FIXTURES):
        # Generate on demand so the test is self-contained.
        from gen_pii_fixtures import main as gen  # type: ignore
        gen()
    with open(FIXTURES, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def test_regex_zero_leakage():
    fixtures = _load()
    assert len(fixtures) >= 100, f"expected >=100 fixtures, got {len(fixtures)}"
    leaks = []
    for fx in fixtures:
        result = scrub_pii(fx["text"])  # no known entities — regex only
        if has_pii_leak(result.scrubbed):
            leaks.append((fx["id"], result.scrubbed))
    assert not leaks, f"phone/email/address leaked in {len(leaks)} fixtures: {leaks[:5]}"


def test_known_entity_redaction():
    fixtures = _load()
    misses = []
    for fx in fixtures:
        pii = fx["pii"]
        known = KnownEntities(
            phones=pii["phones"], emails=pii["emails"],
            names=pii["names"], addresses=pii["addresses"],
        )
        result = scrub_pii(fx["text"], known=known)
        for kind in ("phones", "emails", "addresses", "names"):
            for val in pii[kind]:
                if val in result.scrubbed:
                    misses.append((fx["id"], kind, val, result.scrubbed))
    assert not misses, f"declared PII still present in {len(misses)} cases: {misses[:5]}"


def test_does_not_overscrub_clean_text():
    clean = "My furnace is making a loud noise and the AC won't turn on."
    result = scrub_pii(clean)
    assert result.scrubbed == clean
    assert not result.has_residual_pii


def test_redacts_lowercase_addresses():
    # Real user-written text frequently lowercases (or upper-cases) addresses.
    # The regex sweep AND the residual gate must catch them regardless of case
    # (Codex P1: a case-sensitive pattern let "123 main st" through).
    for raw in (
        "i live at 123 main st",
        "ship the part to 456 elm street please",
        "456 ELM STREET",
        "789 oak ave",
    ):
        result = scrub_pii(raw)
        assert "[ADDRESS]" in result.scrubbed, f"not redacted: {raw!r} -> {result.scrubbed!r}"
        assert not has_pii_leak(result.scrubbed), f"residual leak: {raw!r} -> {result.scrubbed!r}"


def _run_as_script() -> int:
    failures = 0
    for fn in (test_regex_zero_leakage, test_known_entity_redaction, test_does_not_overscrub_clean_text, test_redacts_lowercase_addresses):
        try:
            fn()
            print(f"  ✅ {fn.__name__}")
        except AssertionError as e:
            failures += 1
            print(f"  ❌ {fn.__name__}: {e}")
    n = len(_load())
    print(f"\nPII scrub test over {n} fixtures: {'PASS' if failures == 0 else f'FAIL ({failures})'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_run_as_script())
