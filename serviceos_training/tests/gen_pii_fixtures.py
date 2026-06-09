"""Generate 100 deterministic known-PII fixtures for the zero-leakage test.

Each fixture embeds real-looking PII (phones in several formats, emails, street
addresses, and names) inside trade-call style text, and records exactly which
PII values it contains so the test can assert they are gone after scrubbing.

Run:  python3 serviceos_training/tests/gen_pii_fixtures.py
Output: serviceos_training/tests/fixtures/pii_fixtures.jsonl
"""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures", "pii_fixtures.jsonl")

PHONES = [
    "(602) 555-0123", "602-555-0188", "1-480-555-0142", "+1 415 555 0190",
    "415.555.0177", "(212) 555-0144", "713-555-0166", "+14155550133",
    "1-305-555-0199", "206.555.0121",
]
EMAILS = [
    "john.doe@example.com", "sarah_h@gmail.com", "mike.jones@yahoo.com",
    "linda.park@outlook.com", "service@acme-hvac.com", "r.klein@example.org",
    "tprice99@hotmail.com", "angela.reed@example.net", "carlos.m@example.com",
    "helen@parkplumbing.co",
]
ADDRESSES = [
    "456 Oak Avenue", "88 Maple Street", "1500 Sunset Boulevard", "22 Pine Court",
    "9 Lakeview Drive", "5 River Road", "200 Market Street", "314 Birch Lane",
    "18 Cedar Court", "7 Willow Way",
]
NAMES = [
    "John Smith", "Maria Lopez", "Sandra Diaz", "Tom Bradley", "Helen Park",
    "Robert Klein", "Jennifer Wu", "Gary Olsen", "Angela Reed", "Carlos Mendez",
]

# Templates with placeholders {name} {phone} {email} {addr}. Each declares which
# PII keys it uses so the generator records them.
TEMPLATES = [
    ("My AC stopped cooling. Call me back at {phone}.", ["phone"]),
    ("This is {name} at {addr}, the water heater is leaking.", ["name", "addr"]),
    ("Please email the quote to {email}.", ["email"]),
    ("Reach me at {phone} or {email} about the furnace.", ["phone", "email"]),
    ("I'm at {addr} and my number is {phone}.", ["addr", "phone"]),
    ("Hi, {name} here. The toilet at {addr} keeps running, call {phone}.", ["name", "addr", "phone"]),
    ("Send the invoice to {email}, the panel job is done.", ["email"]),
    ("{name} requested a tech for the drain at {addr}.", ["name", "addr"]),
    ("Text me at {phone}, the breaker keeps tripping.", ["phone"]),
    ("Estimate for {addr}? Contact {name} at {email}.", ["addr", "name", "email"]),
]


def main() -> None:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    fixtures = []
    for i in range(100):
        tmpl, keys = TEMPLATES[i % len(TEMPLATES)]
        vals = {
            "name": NAMES[i % len(NAMES)],
            "phone": PHONES[(i * 3) % len(PHONES)],
            "email": EMAILS[(i * 7) % len(EMAILS)],
            "addr": ADDRESSES[(i * 5) % len(ADDRESSES)],
        }
        text = tmpl.format(**vals)
        pii = {
            "phones": [vals["phone"]] if "phone" in keys else [],
            "emails": [vals["email"]] if "email" in keys else [],
            "addresses": [vals["addr"]] if "addr" in keys else [],
            "names": [vals["name"]] if "name" in keys else [],
        }
        fixtures.append({"id": f"pii-{i + 1:03d}", "text": text, "pii": pii})

    with open(OUT, "w", encoding="utf-8") as f:
        for fx in fixtures:
            f.write(json.dumps(fx) + "\n")
    print(f"Wrote {len(fixtures)} PII fixtures -> {OUT}")


if __name__ == "__main__":
    main()
