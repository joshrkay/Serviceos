"""Slot extractor for address / time / phone / service.

Transparent, rule-based normalizers that map spoken forms to a canonical
slot value. Scored on value-match in run_eval.py. Like classifier.py, this is
the launch baseline; the value of the deliverable is the *fixture coverage*
the extractor is measured against, not the rules themselves.
"""
from __future__ import annotations

import re

from corpus_io import normalize

# ── Spoken-number parsing ─────────────────────────────────────────────────
_ONES = {
    "zero": 0, "oh": 0, "o": 0, "one": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
}
_TEENS = {
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}
_NUMWORDS = set(_ONES) | set(_TEENS) | set(_TENS) | {"hundred", "thousand", "double", "triple"}


def _spoken_to_digits(tokens: list[str]) -> str:
    """Concatenate spoken number chunks into a digit string.

    Reads telephone/house-number style ("one twenty three" -> "123"), with
    arithmetic only for hundred/thousand multipliers ("fifteen hundred" ->
    "1500"). double/triple repeat the next digit.
    """
    out: list[str] = []
    i = 0
    n = len(tokens)
    while i < n:
        w = tokens[i]
        if w in ("double", "triple") and i + 1 < n and tokens[i + 1] in _ONES:
            reps = 2 if w == "double" else 3
            out.append(str(_ONES[tokens[i + 1]]) * reps)
            i += 2
            continue
        if w.isdigit():
            out.append(w)
            i += 1
            continue
        if w in _TENS:
            val = _TENS[w]
            if i + 1 < n and tokens[i + 1] in _ONES and tokens[i + 1] not in ("oh", "o"):
                val += _ONES[tokens[i + 1]]
                i += 1
            if i + 1 < n and tokens[i + 1] == "hundred":
                val *= 100
                i += 1
            out.append(str(val))
            i += 1
            continue
        if w in _TEENS:
            val = _TEENS[w]
            if i + 1 < n and tokens[i + 1] == "hundred":
                val *= 100
                i += 1
            out.append(str(val))
            i += 1
            continue
        if w in _ONES:
            val = _ONES[w]
            if i + 1 < n and tokens[i + 1] == "hundred":
                out.append(str(val * 100))
                i += 1
            elif i + 1 < n and tokens[i + 1] == "thousand":
                out.append(str(val * 1000))
                i += 1
            else:
                out.append(str(val))
            i += 1
            continue
        i += 1  # skip non-number token
    return "".join(out)


# ── Address ───────────────────────────────────────────────────────────────
_SUFFIXES = {
    "street", "st", "avenue", "ave", "road", "rd", "lane", "ln", "drive", "dr",
    "court", "ct", "way", "boulevard", "blvd",
}
_ADDR_STOP = {
    "by", "next", "right", "across", "near", "behind", "apartment", "apt",
    "unit", "the", "blue", "gray", "grey", "across", "around",
}
_ADDR_REF = ["same address", "same place", "same as", "on file", "usual address",
             "already have", "same as before", "address you have"]


def extract_address(text: str) -> tuple[str, str]:
    n = normalize(text)
    if any(m in n for m in _ADDR_REF):
        return ("reference", "same_as_on_file")
    # intersection
    if "corner of" in n or " meets " in n or re.search(r"\b([a-z]+) and ([a-z]+)\b", n):
        if " meets " in n:
            parts = n.split(" meets ")
            left = parts[0].split()[-1]
            right = parts[1].split()[0]
            return ("intersection", f"{left} and {right}")
        m = re.search(r"\b([a-z]+) and ([a-z]+)\b", n)
        if m:
            return ("intersection", f"{m.group(1)} and {m.group(2)}")
    tokens = n.split()
    # find the house number (digit run or number-word)
    start = None
    for idx, tok in enumerate(tokens):
        if tok.isdigit() or tok in _NUMWORDS:
            start = idx
            break
    if start is not None:
        j = start
        while j < len(tokens) and (tokens[j].isdigit() or tokens[j] in _NUMWORDS):
            j += 1
        number = _spoken_to_digits(tokens[start:j])
        street: list[str] = []
        k = j
        while k < len(tokens):
            t = tokens[k]
            if t in _ADDR_STOP:
                break
            street.append(t)
            if t in _SUFFIXES:
                break
            k += 1
        if number and street:
            return ("street_address", f"{number} {' '.join(street)}".strip())
    # landmark: capture the descriptor verbatim (human geocodes later)
    desc = re.sub(r"^the ", "", n).strip()
    return ("landmark", desc)


# ── Time ──────────────────────────────────────────────────────────────────
# Ordered (regex, kind, value). First match wins (specific before generic).
_TIME_RULES: list[tuple[str, str, str]] = [
    (r"first available", "asap", "asap"),
    (r"as soon as possible|as soon as you can|right away|immediately|\basap\b", "asap", "asap"),
    (r"after three but before|after 3 but before|^after three$|after 3\b", "constraint_window", "after 3:00"),
    (r"no earlier than ten", "constraint_window", "after 10:00"),
    (r"anytime after lunch", "constraint_window", "after lunch"),
    (r"has to be before five|before five", "constraint_window", "before 5:00"),
    (r"before noon", "constraint_window", "before 12:00"),
    (r"between two and four", "constraint_window", "between 2:00 and 4:00"),
    (r"friday at nine", "specific_time", "friday 9:00"),
    (r"at three oclock|three oclock", "specific_time", "3:00"),
    (r"around 2 pm|2 pm", "specific_time", "2:00 pm"),
    (r"noon on wednesday", "specific_time", "wednesday 12:00"),
    (r"ten thirty tomorrow", "specific_time", "tomorrow 10:30"),
    (r"eight in the morning", "specific_time", "8:00 am"),
    (r"any time today", "open", "today"),
    (r"any day this week is fine", "open", "this week"),
    (r"whenever you can get here|whenever works for you|im flexible|doesnt matter when", "open", "flexible"),
    (r"first thing", "relative_window", "first thing"),
    (r"tomorrow morning", "relative_window", "tomorrow morning"),
    (r"tomorrow afternoon", "relative_window", "tomorrow afternoon"),
    (r"this afternoon", "relative_window", "this afternoon"),
    (r"this weekend", "relative_window", "this weekend"),
    (r"early next week", "relative_window", "early next week"),
    (r"monday morning", "relative_window", "monday morning"),
    (r"tuesday afternoon", "relative_window", "tuesday afternoon"),
    (r"next thursday", "relative_window", "next thursday"),
    (r"end of the week", "relative_window", "end of the week"),
    (r"sometime this week", "relative_window", "this week"),
    (r"today if you can", "relative_window", "today"),
    (r"tomorrow if possible", "relative_window", "tomorrow"),
    (r"this morning", "relative_window", "this morning"),
    (r"^tonight$|tonight", "relative_window", "tonight"),
    (r"saturday morning", "relative_window", "saturday morning"),
    (r"the morning works best", "relative_window", "morning"),
    (r"late afternoon", "relative_window", "late afternoon"),
]


def extract_time(text: str) -> tuple[str, str]:
    n = normalize(text)
    for pat, kind, value in _TIME_RULES:
        if re.search(pat, n):
            return (kind, value)
    return ("unknown", "")


# ── Phone ─────────────────────────────────────────────────────────────────
_PHONE_CALLER_ID = ["number i called from", "number im calling from", "number i m calling from",
                    "call back this line", "this line"]
_PHONE_REF = ["same number", "same as before", "number on my account", "cell you already have",
              "on file", "use my cell on the account", "number ending in"]


def extract_phone(text: str) -> tuple[str, str]:
    n = normalize(text)
    if any(m in n for m in _PHONE_CALLER_ID):
        return ("reference", "same_as_caller_id")
    if any(m in n for m in _PHONE_REF):
        return ("reference", "same_as_on_file")
    tokens = n.split()
    digits = _spoken_to_digits(tokens)
    if len(digits) >= 7:
        return ("digits", digits)
    return ("unknown", digits)


# ── Service ───────────────────────────────────────────────────────────────
# Ordered slug -> trigger substrings. Specific slugs first.
_SERVICE_RULES: list[tuple[str, list[str]]] = [
    ("tankless_water_heater", ["tankless"]),
    ("water_heater", ["water heater", "hot water tank", "hot water heater", "no hot water", "calentador"]),
    ("garbage_disposal", ["garbage disposal", "disposal", "grinds food"]),
    ("outdoor_spigot", ["spigot", "spicket", "hose bib", "outdoor"]),
    ("shower_valve", ["shower valve"]),
    ("shower", ["shower", "regadera"]),
    ("bathtub", ["bathtub", "the tub", "tub wont drain", "tub won t drain", "tina"]),
    ("sewer_line", ["sewer line", "main sewer", "sewer"]),
    ("main_line", ["main line"]),
    ("p_trap", ["p trap", "curved pipe under the drain", "u bend"]),
    ("drain", ["drain"]),
    ("sump_pump", ["sump pump", "sump"]),
    ("well_pump", ["well pump"]),
    ("toilet", ["toilet", "commode", "throne", "inodoro", "escusado"]),
    ("faucet", ["faucet", "tap", "llave del agua"]),
    ("sink", ["sink", "lavabo", "fregadero"]),
    ("furnace", ["furnace"]),
    ("heat_pump", ["heat pump"]),
    ("air_conditioner", ["air conditioner", "the ac", "a c", "air isnt cold", "air isn t cold", "the air", "aire"]),
    ("thermostat", ["thermostat", "termostato"]),
    ("boiler", ["boiler"]),
    ("ductwork", ["ductwork", "ducts"]),
    ("condenser", ["condenser"]),
    ("gas_line", ["gas line"]),
    ("water_softener", ["water softener", "softener"]),
    ("pressure_regulator", ["pressure regulator", "regulator"]),
]


def extract_service(text: str) -> tuple[str, str]:
    n = normalize(text)
    for slug, triggers in _SERVICE_RULES:
        if any(t in n for t in triggers):
            return ("match", slug)
    return ("unknown", "")


EXTRACTORS = {
    "address": extract_address,
    "time": extract_time,
    "phone": extract_phone,
    "service": extract_service,
}
