"""Unit tests for corpus classification rules."""

import pytest

from corpus_classification import (
    classify_record,
    classify_triage,
    clean_for_corpus,
    detect_accent_signals,
    extract_fixtures_and_triggers,
    infer_trade,
    is_layman_heuristic,
    normalize_text,
)


def test_normalize_text_collapses_whitespace():
    assert normalize_text("  Hello   World  ") == "hello world"


def test_clean_for_corpus_strips_markdown_link():
    raw = "See [this guide](http://x.com) for help"
    assert "http" not in clean_for_corpus(raw)
    assert "this guide" in clean_for_corpus(raw)


def test_triage_emergency_flood():
    r = classify_triage("my basement is flooding and water won't stop")
    assert r.label == "emergency"
    assert r.confidence >= 0.4


def test_triage_urgent_no_hot_water():
    r = classify_triage("we have no hot water at all since yesterday")
    assert r.label == "urgent"


def test_triage_routine_running_toilet():
    r = classify_triage("toilet keeps running all night won't stop filling the tank")
    assert r.label == "routine"


def test_triage_unknown_empty():
    r = classify_triage("")
    assert r.label == "unknown"


def test_infer_trade_plumbing_sub():
    assert infer_trade("Plumbing", "toilet leak") == "plumbing"


def test_infer_trade_hvac_sub():
    assert infer_trade("HVAC", "weird noise from furnace") == "hvac"


def test_infer_trade_diy_mixed_keywords():
    text = normalize_text("furnace won't start and also toilet is clogged")
    assert infer_trade("DIY", text) == "both"


def test_fixtures_toilet():
    f, t = extract_fixtures_and_triggers(normalize_text("running toilet all night"))
    assert "toilet" in f


def test_accent_southern_spicket():
    tags, _ = detect_accent_signals(normalize_text("the spicket outside is leaking"))
    assert "southern_us" in tags


def test_is_layman_true_for_homeowner():
    assert is_layman_heuristic(normalize_text("my faucet drips")) is True


def test_is_layman_false_for_jargon():
    low = normalize_text("measure subcool at the service valve manifold gauge psi")
    assert is_layman_heuristic(low) is False


def test_classify_record_full_pipeline():
    out = classify_record(
        cleaned_text="My toilet keeps running; water won't stop filling",
        subreddit="Plumbing",
    )
    assert out["triage_label"] in ("routine", "urgent", "emergency", "unknown")
    assert out["trade"] == "plumbing"
    assert isinstance(out["fixture_tags"], list)
    assert isinstance(out["trigger_phrases"], list)
    assert 0 <= float(out["confidence_score"]) <= 1


@pytest.mark.parametrize(
    "text,expected",
    [
        ("sewer backup in the basement", "emergency"),
        ("wet drywall behind the sink", "urgent"),
        ("slow drain in kitchen sink", "routine"),
    ],
)
def test_triage_parametrized(text, expected):
    r = classify_triage(normalize_text(text))
    assert r.label == expected
