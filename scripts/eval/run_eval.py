"""run_eval.py — ServiceOS voice-corpus eval harness.

Runs the intent classifier + slot extractor over the frozen 20% held-out
split and writes metrics, a confusion matrix, and ranked failure modes to
eval-results/<YYYY-MM-DD>/.

Scopes (mutually exclusive; default --full):
  --full         intent accuracy + slots + edge + negatives + spanish-gap
  --edge-cases   every edge category must hit its expected_handling
  --negatives    no negative may classify as a booking intent
  --spanish      Spanish accuracy within 5pp of English

Targets: intent accuracy >= 0.92, slot F1 >= 0.88 each, unknown rate < 0.10,
edge categories pass, zero booking on negatives, Spanish within 5pp.
Exit code 0 iff the requested scope's targets are met. Also fails on
regression vs. the most recent prior eval-results run.
"""
from __future__ import annotations

import argparse
import csv
import datetime
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from corpus_io import (  # noqa: E402
    CORPUS_DIR,
    EVAL_RESULTS_DIR,
    SLOT_DIR,
    load_jsonl,
    split_of,
)
from classifier import BOOKING_INTENTS, classify_intent, handle_edge  # noqa: E402
from slots import EXTRACTORS  # noqa: E402
import posthog_client as ph  # noqa: E402

ACC_TARGET = 0.92
SLOT_F1_TARGET = 0.88
UNKNOWN_TARGET = 0.10
SPANISH_GAP_TARGET = 0.05


def _prf(tp: int, fp: int, fn: int) -> dict[str, float]:
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * p * r / (p + r) if (p + r) else 0.0
    return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f1, 4),
            "tp": tp, "fp": fp, "fn": fn}


def eval_intents(rows: list[dict], failures: list[dict]) -> dict:
    """Accuracy + per-intent P/R/F1 + confusion over the held-out split."""
    test = [r for r in rows if split_of(r["id"]) == "test"]
    labels = sorted({r["intent"] for r in rows})
    tp = defaultdict(int)
    fp = defaultdict(int)
    fn = defaultdict(int)
    confusion: dict[str, dict[str, int]] = {a: defaultdict(int) for a in labels}
    correct = 0
    unknown = 0
    for r in test:
        gold = r["intent"]
        pred = classify_intent(r["text"]).intent
        confusion.setdefault(gold, defaultdict(int))
        confusion[gold][pred] += 1
        if pred == "unknown":
            unknown += 1
        if pred == gold:
            correct += 1
            tp[gold] += 1
        else:
            fp[pred] += 1
            fn[gold] += 1
            failures.append({"kind": "intent", "id": r["id"], "lang": r.get("lang"),
                             "text": r["text"], "gold": gold, "pred": pred})
    per_intent = {lbl: _prf(tp[lbl], fp[lbl], fn[lbl]) for lbl in labels}
    n = len(test)
    return {
        "n": n,
        "accuracy": round(correct / n, 4) if n else 0.0,
        "unknown_rate": round(unknown / n, 4) if n else 0.0,
        "per_intent": per_intent,
        "confusion": {a: dict(b) for a, b in confusion.items()},
    }


def eval_lang_accuracy(rows: list[dict], lang: str) -> float:
    test = [r for r in rows if split_of(r["id"]) == "test" and r.get("lang") == lang]
    if not test:
        return 0.0
    correct = sum(1 for r in test if classify_intent(r["text"]).intent == r["intent"])
    return round(correct / len(test), 4)


def eval_slots(failures: list[dict]) -> dict:
    out: dict[str, dict] = {}
    for slot_type, extractor in EXTRACTORS.items():
        rows = load_jsonl(os.path.join(SLOT_DIR, f"{slot_type}.jsonl"))
        test = [r for r in rows if split_of(r["id"]) == "test"]
        tp = fp = fn = 0
        for r in test:
            gold = r["expected"]["value"]
            _, pred = extractor(r["text"])
            if pred == gold:
                tp += 1
            else:
                fp += 1
                fn += 1
                failures.append({"kind": f"slot:{slot_type}", "id": r["id"],
                                 "text": r["text"], "gold": gold, "pred": pred})
        out[slot_type] = {"n": len(test), **_prf(tp, fp, fn)}
    return out


def eval_edges(failures: list[dict]) -> dict:
    rows = load_jsonl(os.path.join(CORPUS_DIR, "edge_cases.jsonl"))
    per_cat: dict[str, dict[str, int]] = defaultdict(lambda: {"pass": 0, "total": 0})
    correct = 0
    for r in rows:
        pred = handle_edge(r["text"])
        gold = r["expected_handling"]
        per_cat[r["category"]]["total"] += 1
        if pred == gold:
            per_cat[r["category"]]["pass"] += 1
            correct += 1
        else:
            failures.append({"kind": "edge", "id": r["id"], "category": r["category"],
                             "text": r["text"], "gold": gold, "pred": pred})
    cats = {c: {**v, "rate": round(v["pass"] / v["total"], 4)} for c, v in per_cat.items()}
    return {
        "n": len(rows),
        "handling_accuracy": round(correct / len(rows), 4) if rows else 0.0,
        "per_category": cats,
        "all_categories_pass": all(v["pass"] == v["total"] for v in per_cat.values()),
    }


def eval_negatives(failures: list[dict]) -> dict:
    rows = load_jsonl(os.path.join(CORPUS_DIR, "negatives.jsonl"))
    booking_leaks = 0
    routing_correct = 0
    for r in rows:
        pred = classify_intent(r["text"])
        if pred.intent in BOOKING_INTENTS:
            booking_leaks += 1
            failures.append({"kind": "negative_booking_leak", "id": r["id"],
                             "text": r["text"], "pred_intent": pred.intent})
        if pred.routing == r["expected_routing"]:
            routing_correct += 1
    return {
        "n": len(rows),
        "booking_leaks": booking_leaks,
        "routing_accuracy": round(routing_correct / len(rows), 4) if rows else 0.0,
        "zero_booking": booking_leaks == 0,
    }


def load_corpora() -> list[dict]:
    rows = load_jsonl(os.path.join(CORPUS_DIR, "utterances.jsonl"))
    rows += load_jsonl(os.path.join(CORPUS_DIR, "utterances_es.jsonl"))
    return rows


def top_failures(failures: list[dict], k: int = 20) -> list[dict]:
    counts: dict[tuple, int] = defaultdict(int)
    for f in failures:
        if f["kind"] == "intent":
            counts[("intent", f["gold"], f["pred"])] += 1
        elif f["kind"].startswith("slot:"):
            counts[(f["kind"], f.get("gold", ""), f.get("pred", ""))] += 1
        elif f["kind"] == "edge":
            counts[("edge", f["category"], f["pred"])] += 1
        else:
            counts[(f["kind"], "", f.get("pred_intent", ""))] += 1
    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:k]
    return [{"mode": list(m), "count": c} for m, c in ranked]


def previous_metrics() -> dict | None:
    if not os.path.isdir(EVAL_RESULTS_DIR):
        return None
    today = datetime.date.today().isoformat()
    dirs = sorted(d for d in os.listdir(EVAL_RESULTS_DIR)
                  if os.path.isdir(os.path.join(EVAL_RESULTS_DIR, d)) and d != today)
    for d in reversed(dirs):
        path = os.path.join(EVAL_RESULTS_DIR, d, "metrics.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
    return None


def write_outputs(metrics: dict, confusion: dict, failures: list[dict]) -> str:
    today = datetime.date.today().isoformat()
    out_dir = os.path.join(EVAL_RESULTS_DIR, today)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, indent=2, sort_keys=True)
    labels = sorted(set(confusion) | {p for row in confusion.values() for p in row})
    with open(os.path.join(out_dir, "confusion.csv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["gold\\pred", *labels])
        for g in labels:
            w.writerow([g, *[confusion.get(g, {}).get(p, 0) for p in labels]])
    with open(os.path.join(out_dir, "failures.jsonl"), "w", encoding="utf-8") as fh:
        for f in failures:
            fh.write(json.dumps(f) + "\n")
    return out_dir


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--full", action="store_true")
    g.add_argument("--edge-cases", action="store_true")
    g.add_argument("--negatives", action="store_true")
    g.add_argument("--spanish", action="store_true")
    args = ap.parse_args()
    scope = "edge-cases" if args.edge_cases else "negatives" if args.negatives else \
            "spanish" if args.spanish else "full"

    failures: list[dict] = []
    corpora = load_corpora()
    intents = eval_intents(corpora, failures)
    slots = eval_slots(failures)
    edges = eval_edges(failures)
    negatives = eval_negatives(failures)
    en_acc = eval_lang_accuracy(corpora, "en")
    es_acc = eval_lang_accuracy(corpora, "es")
    spanish_gap = round(abs(en_acc - es_acc), 4)

    metrics = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": scope,
        "intent": {k: v for k, v in intents.items() if k != "confusion"},
        "slots": slots,
        "edges": {k: v for k, v in edges.items() if k != "per_category"} | {"per_category": edges["per_category"]},
        "negatives": negatives,
        "language": {"en_accuracy": en_acc, "es_accuracy": es_acc, "spanish_gap": spanish_gap},
        "corpus_counts": {
            "utterances_en": sum(1 for r in corpora if r.get("lang") == "en"),
            "utterances_es": sum(1 for r in corpora if r.get("lang") == "es"),
            "edge_cases": edges["n"],
            "negatives": negatives["n"],
            "slots": {k: v["n"] for k, v in slots.items()},
        },
        "top_failure_modes": top_failures(failures),
        "targets": {
            "intent_accuracy": ACC_TARGET,
            "slot_f1": SLOT_F1_TARGET,
            "unknown_rate_max": UNKNOWN_TARGET,
            "spanish_gap_max": SPANISH_GAP_TARGET,
        },
    }

    out_dir = write_outputs(metrics, intents["confusion"], failures)

    # ── Target checks per scope ──
    problems: list[str] = []
    regression_detected = False
    if scope in ("full",):
        if intents["accuracy"] < ACC_TARGET:
            problems.append(f"intent accuracy {intents['accuracy']} < {ACC_TARGET}")
        if intents["unknown_rate"] >= UNKNOWN_TARGET:
            problems.append(f"unknown rate {intents['unknown_rate']} >= {UNKNOWN_TARGET}")
        for st, m in slots.items():
            if m["f1"] < SLOT_F1_TARGET:
                problems.append(f"slot[{st}] F1 {m['f1']} < {SLOT_F1_TARGET}")
        if not edges["all_categories_pass"]:
            problems.append("edge categories not all passing")
        if not negatives["zero_booking"]:
            problems.append(f"{negatives['booking_leaks']} negative booking leak(s)")
        if spanish_gap > SPANISH_GAP_TARGET:
            problems.append(f"spanish gap {spanish_gap} > {SPANISH_GAP_TARGET}")
        prev = previous_metrics()
        if prev and prev.get("intent", {}).get("accuracy", 0) - intents["accuracy"] > 1e-9:
            prior_acc = prev["intent"]["accuracy"]
            problems.append(f"REGRESSION: accuracy {intents['accuracy']} < prior {prior_acc}")
            regression_detected = True
            ph.capture("eval_regression_detected", {
                "scope": scope,
                "current_accuracy": intents["accuracy"],
                "prior_accuracy": prior_acc,
            })
    elif scope == "edge-cases":
        if not edges["all_categories_pass"]:
            problems.append("edge categories not all passing")
    elif scope == "negatives":
        if not negatives["zero_booking"]:
            problems.append(f"{negatives['booking_leaks']} negative booking leak(s)")
    elif scope == "spanish":
        if spanish_gap > SPANISH_GAP_TARGET:
            problems.append(f"spanish gap {spanish_gap} > {SPANISH_GAP_TARGET}")

    print(f"[eval:{scope}] -> {out_dir}")
    print(f"  intent accuracy={intents['accuracy']} unknown={intents['unknown_rate']} (n={intents['n']})")
    print(f"  slots: " + " ".join(f"{k}.f1={v['f1']}(n={v['n']})" for k, v in slots.items()))
    print(f"  edges: handling_acc={edges['handling_accuracy']} all_pass={edges['all_categories_pass']}")
    print(f"  negatives: booking_leaks={negatives['booking_leaks']} routing_acc={negatives['routing_accuracy']}")
    print(f"  language: en={en_acc} es={es_acc} gap={spanish_gap}")

    slot_f1_values = [v["f1"] for v in slots.values()]
    ph.capture("eval_run_completed", {
        "scope": scope,
        "intent_accuracy": intents["accuracy"],
        "unknown_rate": intents["unknown_rate"],
        "utterance_count": intents["n"],
        "min_slot_f1": min(slot_f1_values) if slot_f1_values else None,
        "edges_all_pass": edges["all_categories_pass"],
        "negative_booking_leaks": negatives["booking_leaks"],
        "spanish_gap": spanish_gap,
        "passed": len(problems) == 0,
        "regression_detected": regression_detected,
        "failure_count": len(problems),
    })

    if problems:
        print("[FAIL] " + "; ".join(problems))
        return 1
    print(f"[PASS] scope '{scope}' meets all targets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
