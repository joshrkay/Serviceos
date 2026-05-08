"""
Rule-based classification for ServiceOS training corpus ingestion.
Pure functions for triage, trade, fixtures, accent signals, layman heuristic.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Final

# --- Triage: ordered severity (first matching tier wins by design in classify_triage) ---

_EMERGENCY_PATTERNS: Final[tuple[tuple[str, float], ...]] = (
    ("active flood", 0.95),
    ("flooding everywhere", 0.95),
    ("water everywhere", 0.85),
    ("burst pipe", 0.95),
    ("pipe burst", 0.9),
    ("water won't stop", 0.95),
    ("can't stop the water", 0.95),
    ("cannot stop the water", 0.95),
    ("won't shut off", 0.85),
    ("gas smell", 0.95),
    ("smell gas", 0.9),
    ("natural gas", 0.75),
    ("carbon monoxide", 0.95),
    ("co detector", 0.85),
    ("co alarm", 0.85),
    ("sewer backup", 0.9),
    ("sewage backing up", 0.9),
    ("raw sewage", 0.9),
    ("electrical fire", 0.95),
    ("sparking", 0.75),
    ("submerged outlet", 0.85),
    ("standing water", 0.7),
    ("basement filling", 0.85),
    ("freezing", 0.5),  # weak alone; combined in phrases below
    ("no heat", 0.55),
    ("furnace out", 0.65),
    ("heat completely out", 0.8),
    ("below freezing", 0.5),
    ("pipes might freeze", 0.75),
)

_URGENT_PATTERNS: Final[tuple[tuple[str, float], ...]] = (
    ("no hot water", 0.85),
    ("no hot water at all", 0.9),
    ("wet drywall", 0.85),
    ("ceiling bulging", 0.85),
    ("water stain spreading", 0.8),
    ("toilet completely blocked", 0.8),
    ("only toilet", 0.65),
    ("only bathroom", 0.55),
    ("pressure dropped everywhere", 0.85),
    ("lost pressure whole house", 0.85),
    ("no water anywhere", 0.85),
    ("ac completely dead", 0.75),
    ("a/c completely dead", 0.75),
    ("no cooling", 0.65),
    ("heat wave", 0.45),
    ("extreme heat", 0.5),
    ("110 degrees", 0.45),
)

_ROUTINE_PATTERNS: Final[tuple[tuple[str, float], ...]] = (
    ("dripping faucet", 0.8),
    ("dripping tap", 0.75),
    ("running toilet", 0.8),
    ("toilet keeps running", 0.85),
    ("won't stop filling", 0.8),
    ("keeps running", 0.65),
    ("jiggling the handle", 0.65),
    ("slow drain", 0.7),
    ("slow sink", 0.65),
    ("low pressure", 0.6),
    ("one faucet", 0.55),
    ("noisy pipes", 0.65),
    ("water hammer", 0.65),
    ("garbage disposal", 0.6),
    ("disposal jammed", 0.7),
    ("toilet runs", 0.65),
    ("minor leak", 0.55),
    ("small drip", 0.55),
)

# HVAC vs plumbing keyword hints for mixed subs
_PLUMBING_TERMS: Final[frozenset[str]] = frozenset(
    {
        "toilet",
        "faucet",
        "sink",
        "drain",
        "pipe",
        "plumb",
        "water heater",
        "hot water",
        "sewer",
        "shower",
        "tub",
        "p-trap",
        "ptrap",
        "wax ring",
        "disposal",
        "sump",
        "spicket",
        "commode",
    }
)

_HVAC_TERMS: Final[frozenset[str]] = frozenset(
    {
        "furnace",
        "ac ",
        " a/c",
        "air conditioner",
        "heat pump",
        "hvac",
        "condenser",
        "evaporator",
        "refrigerant",
        "cooling",
        "heating",
        "thermostat",
        "filter",
        "duct",
        "register",
        "compressor",
    }
)

_SUBREDDIT_TRADE: Final[dict[str, str]] = {
    "plumbing": "plumbing",
    "hvac": "hvac",
    "homeimprovement": "both",
    "diy": "both",
}

# Fixture / trigger extraction
_FIXTURE_RULES: Final[tuple[tuple[str, str, str], ...]] = (
    (r"\btoilet\b", "toilet", "toilet issue"),
    (r"\brunning toilet\b", "toilet", "running toilet"),
    (r"\bfaucet\b|\btap\b|\bspicket\b", "faucet", "faucet"),
    (r"\bwater heater\b|\bhot water heater\b|\bhot water tank\b", "water_heater", "water heater"),
    (r"\bdrain\b|\bclog\b", "drain", "drain clog"),
    (r"\bgarbage disposal\b|\bdisposal\b", "disposal", "garbage disposal"),
    (r"\bshower\b", "shower", "shower"),
    (r"\bsump pump\b", "sump_pump", "sump pump"),
    (r"\bfurnace\b", "furnace", "furnace"),
    (r"\bair conditioner\b|\bac\b|\ba/c\b", "ac", "air conditioning"),
    (r"\bheat pump\b", "heat_pump", "heat pump"),
    (r"\bthermostat\b", "thermostat", "thermostat"),
)

# Accent / dialect — store short tags + matched phrase for triggers
_ACCENT_RULES: Final[tuple[tuple[str, str, str], ...]] = (
    (r"\bspicket\b|\bcommode\b|\by'?all\b|\bwarsh\b|\bwader\b", "southern_us", "southern colloquial"),
    (r"\bwooder\b", "philadelphia_nj", "mid-atlantic colloquial"),
    (r"\bwattah\b|\bwatah\b|\bheatah\b", "boston_new_england", "new england colloquial"),
    (r"\btore up\b|\bdrippin\b|\bfinna\b", "aave", "aave pattern"),
    (r"\bestá\b|\bgoteando\b|\binodoro\b|\bno funciona\b", "spanish_english", "spanish/english mix"),
    (r"\bthe main\b|\bthe valve\b|\bthe unit\b", "rural_colloquial", "rural/colloquial"),
)

_CONTRACTOR_TERMS: Final[frozenset[str]] = frozenset(
    {
        "delta p",
        "psi",
        "cfm",
        "subcool",
        "superheat",
        "manifold",
        "braze",
        "solder joint",
        "schedule 40",
        "dwv",
        "vent stack",
        "service valve",
        "low voltage",
        "condensate pump",
    }
)


@dataclass(frozen=True)
class TriageResult:
    label: str
    confidence: float
    trigger_phrases: tuple[str, ...]


def normalize_text(text: str) -> str:
    if not text:
        return ""
    nfkc = unicodedata.normalize("NFKC", text)
    return " ".join(nfkc.lower().split())


def clean_for_corpus(raw: str) -> str:
    """Strip markdown-ish noise; keep plain text for modeling."""
    if not raw:
        return ""
    t = raw
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"[*_`#]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _match_patterns(
    lowered: str, patterns: tuple[tuple[str, float], ...]
) -> tuple[float, list[str]]:
    score = 0.0
    hits: list[str] = []
    for phrase, weight in patterns:
        if phrase in lowered:
            score += weight
            hits.append(phrase)
    cap = min(1.0, score / 2.5) if score else 0.0
    return cap, hits


def classify_triage(cleaned_lower: str) -> TriageResult:
    """Emergency > urgent > routine > unknown."""
    em_s, em_hits = _match_patterns(cleaned_lower, _EMERGENCY_PATTERNS)
    ur_s, ur_hits = _match_patterns(cleaned_lower, _URGENT_PATTERNS)
    ro_s, ro_hits = _match_patterns(cleaned_lower, _ROUTINE_PATTERNS)

    # Freeze / no heat emergency combo
    if ("freezing" in cleaned_lower or "below freezing" in cleaned_lower) and (
        "no heat" in cleaned_lower or "furnace" in cleaned_lower or "heat" in cleaned_lower
    ):
        em_s = max(em_s, 0.85)
        em_hits.append("no heat in freezing temps")

    if em_s >= 0.35 or (em_hits and em_s >= 0.25):
        conf = max(0.45, min(1.0, em_s + 0.15 * min(len(em_hits), 3)))
        return TriageResult("emergency", conf, tuple(em_hits[:8]))

    if ur_s >= 0.35 or (ur_hits and ur_s >= 0.25):
        conf = max(0.45, min(1.0, ur_s + 0.12 * min(len(ur_hits), 3)))
        return TriageResult("urgent", conf, tuple(ur_hits[:8]))

    if ro_s >= 0.2 or ro_hits:
        conf = max(0.4, min(1.0, ro_s + 0.1 * min(len(ro_hits), 4)))
        return TriageResult("routine", conf, tuple(ro_hits[:8]))

    return TriageResult("unknown", 0.25, ())


def infer_trade(subreddit: str, cleaned_lower: str) -> str:
    sub = re.sub(r"^r/", "", subreddit or "", flags=re.I).lower()
    base = _SUBREDDIT_TRADE.get(sub)
    if base == "plumbing":
        return "plumbing"
    if base == "hvac":
        return "hvac"

    p_hit = sum(1 for w in _PLUMBING_TERMS if w in cleaned_lower)
    h_hit = sum(1 for w in _HVAC_TERMS if w in cleaned_lower)
    if p_hit and h_hit:
        return "both"
    if p_hit > h_hit:
        return "plumbing"
    if h_hit > p_hit:
        return "hvac"
    return "both"


def extract_fixtures_and_triggers(cleaned_lower: str) -> tuple[list[str], list[str]]:
    fixtures: set[str] = set()
    triggers: set[str] = set()
    for pattern, tag, trigger_label in _FIXTURE_RULES:
        if re.search(pattern, cleaned_lower, re.I):
            fixtures.add(tag)
            triggers.add(trigger_label)
    return sorted(fixtures), sorted(triggers)


def detect_accent_signals(cleaned_lower: str) -> tuple[list[str], list[str]]:
    """Returns (tags, human-readable trigger phrases for matched dialect patterns)."""
    tags: set[str] = set()
    phrases: set[str] = set()
    for pattern, tag, label in _ACCENT_RULES:
        if re.search(pattern, cleaned_lower, re.I):
            tags.add(tag)
            phrases.add(label)
    return sorted(tags), sorted(phrases)


def is_layman_heuristic(cleaned_lower: str) -> bool:
    hits = sum(1 for t in _CONTRACTOR_TERMS if t in cleaned_lower)
    return hits < 2


def merge_triggers(
    triage_triggers: tuple[str, ...],
    fixture_triggers: list[str],
    accent_phrases: list[str],
) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for group in (triage_triggers, tuple(fixture_triggers), tuple(accent_phrases)):
        for x in group:
            if x and x not in seen:
                seen.add(x)
                out.append(x)
    return out[:20]


def classify_record(
    *,
    cleaned_text: str,
    subreddit: str,
) -> dict[str, object]:
    """Single record classification payload for DB insert (minus ids and provenance)."""
    cleaned_lower = normalize_text(cleaned_text)
    triage = classify_triage(cleaned_lower)
    trade = infer_trade(subreddit, cleaned_lower)
    fixtures, fix_triggers = extract_fixtures_and_triggers(cleaned_lower)
    accent_tags, _accent_phrases = detect_accent_signals(cleaned_lower)
    layman = is_layman_heuristic(cleaned_lower)
    triggers = merge_triggers(triage.trigger_phrases, fix_triggers, [])

    # Boost confidence slightly when fixtures match
    conf = float(triage.confidence)
    if fixtures:
        conf = min(1.0, conf + 0.05 * min(len(fixtures), 3))

    return {
        "triage_label": triage.label,
        "confidence_score": round(conf, 4),
        "trade": trade,
        "fixture_tags": fixtures,
        "trigger_phrases": triggers,
        "accent_signals": accent_tags,
        "is_layman": layman,
    }
