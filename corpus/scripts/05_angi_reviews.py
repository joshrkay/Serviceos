#!/usr/bin/env python3
"""
Step 6: Angi / HomeAdvisor review collector via Apify.

Pulls customer reviews for plumbing and HVAC service companies using
the Apify web scraping API. Reviews contain:
  - Customer description of the problem (lay language)
  - What the tech did (resolution in semi-technical language)
  - Rating

This is a large-scale source of natural customer language describing
home service problems and resolutions.

Apify scrapers used:
  - Angi scraper: apify/angi-scraper
  - HomeAdvisor scraper: apify/homeadvisor-scraper

REQUIREMENTS
------------
  APIFY_API_TOKEN environment variable (get free token at apify.com)
  pip install apify-client

OUTPUT
------
output/reviews/
  angi_plumbing.jsonl
  angi_hvac.jsonl
  homeadvisor_plumbing.jsonl
  homeadvisor_hvac.jsonl
  all_reviews.jsonl           — merged, normalized

USAGE
-----
  export APIFY_API_TOKEN=apify_api_xxxxx
  python3 05_angi_reviews.py
  python3 05_angi_reviews.py --platform angi --category hvac --limit 5000
"""

import argparse
import json
import os
import sys
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "reviews"

# Apify actor IDs for Angi and HomeAdvisor scrapers
APIFY_ACTORS = {
    "angi": "alizarin_refrigerator-owner/angi-scraper",
    "homeadvisor": "alizarin_refrigerator-owner/homeadvisor-scraper",
}

# Search terms to pass to the scrapers — pulls reviews for these service categories
SEARCH_QUERIES = {
    "plumbing": [
        "plumber", "plumbing repair", "drain cleaning", "water heater installation",
        "toilet repair", "pipe repair", "sewer line", "garbage disposal",
    ],
    "hvac": [
        "HVAC repair", "air conditioning repair", "furnace repair", "heat pump service",
        "AC installation", "duct cleaning", "heating repair", "thermostat installation",
    ],
}


def run_apify_actor(actor_id: str, input_data: dict, api_token: str) -> list[dict]:
    """Run an Apify actor and return results."""
    try:
        from apify_client import ApifyClient
    except ImportError:
        print("Install apify-client: pip install apify-client")
        sys.exit(1)

    client = ApifyClient(api_token)
    print(f"  Running Apify actor: {actor_id}")
    print(f"  Input: {json.dumps(input_data, indent=2)[:200]}...")

    run = client.actor(actor_id).call(run_input=input_data)
    items = list(client.dataset(run["defaultDatasetId"]).iterate_items())
    print(f"  Retrieved {len(items)} items")
    return items


def normalize_angi_review(item: dict) -> dict | None:
    """Normalize an Angi review record to standard format."""
    review_text = item.get("reviewText") or item.get("review") or item.get("comment") or ""
    if not review_text or len(review_text) < 30:
        return None
    return {
        "source": "angi",
        "company_name": item.get("businessName") or item.get("companyName"),
        "category": item.get("category") or item.get("serviceCategory"),
        "rating": item.get("rating") or item.get("overallRating"),
        "review": review_text,
        "project_description": item.get("projectDescription") or item.get("projectType"),
        "location": item.get("city") or item.get("location"),
        "date": item.get("date") or item.get("reviewDate"),
    }


def normalize_homeadvisor_review(item: dict) -> dict | None:
    """Normalize a HomeAdvisor review record to standard format."""
    review_text = item.get("reviewText") or item.get("review") or ""
    if not review_text or len(review_text) < 30:
        return None
    return {
        "source": "homeadvisor",
        "company_name": item.get("businessName") or item.get("proName"),
        "category": item.get("category"),
        "rating": item.get("rating"),
        "review": review_text,
        "project_description": item.get("projectDescription"),
        "location": item.get("location"),
        "date": item.get("date"),
    }


def collect_angi(api_token: str, service_category: str, limit: int, out_dir: Path):
    """Collect Angi reviews for a service category."""
    output_file = out_dir / f"angi_{service_category}.jsonl"
    queries = SEARCH_QUERIES.get(service_category, [service_category])

    all_records = []
    for query in queries:
        actor_input = {
            "searchQuery": query,
            "maxReviews": limit // len(queries),
            "includeReviews": True,
        }
        try:
            items = run_apify_actor(APIFY_ACTORS["angi"], actor_input, api_token)
            for item in items:
                record = normalize_angi_review(item)
                if record:
                    record["search_query"] = query
                    all_records.append(record)
        except Exception as e:
            print(f"  Angi actor error for query '{query}': {e}")

    with open(output_file, "w", encoding="utf-8") as f:
        for r in all_records:
            f.write(json.dumps(r) + "\n")

    print(f"  Saved {len(all_records)} Angi reviews → {output_file.name}")


def collect_homeadvisor(api_token: str, service_category: str, limit: int, out_dir: Path):
    """Collect HomeAdvisor reviews for a service category."""
    output_file = out_dir / f"homeadvisor_{service_category}.jsonl"
    queries = SEARCH_QUERIES.get(service_category, [service_category])

    all_records = []
    for query in queries:
        actor_input = {
            "searchQuery": query,
            "maxItems": limit // len(queries),
        }
        try:
            items = run_apify_actor(APIFY_ACTORS["homeadvisor"], actor_input, api_token)
            for item in items:
                record = normalize_homeadvisor_review(item)
                if record:
                    record["search_query"] = query
                    all_records.append(record)
        except Exception as e:
            print(f"  HomeAdvisor actor error for query '{query}': {e}")

    with open(output_file, "w", encoding="utf-8") as f:
        for r in all_records:
            f.write(json.dumps(r) + "\n")

    print(f"  Saved {len(all_records)} HomeAdvisor reviews → {output_file.name}")


def merge_reviews(out_dir: Path):
    """Merge all review files into all_reviews.jsonl"""
    output_file = out_dir / "all_reviews.jsonl"
    count = 0
    with open(output_file, "w", encoding="utf-8") as out:
        for jsonl in out_dir.glob("*.jsonl"):
            if jsonl.name == "all_reviews.jsonl":
                continue
            with open(jsonl, encoding="utf-8") as f:
                for line in f:
                    out.write(line)
                    count += 1
    print(f"\nMerged {count} reviews → {output_file.name}")


def main():
    parser = argparse.ArgumentParser(description="Angi/HomeAdvisor review collector via Apify")
    parser.add_argument("--platform", choices=["angi", "homeadvisor", "all"], default="all")
    parser.add_argument("--category", choices=["plumbing", "hvac", "all"], default="all")
    parser.add_argument("--limit", type=int, default=10_000, help="Max reviews to collect per platform+category")
    args = parser.parse_args()

    api_token = os.environ.get("APIFY_API_TOKEN")
    if not api_token:
        print("""
APIFY_API_TOKEN environment variable not set.

To use this script:
  1. Sign up at https://apify.com (free tier: $5/month credits)
  2. Get your API token from: https://console.apify.com/account/integrations
  3. Export it: export APIFY_API_TOKEN=apify_api_xxxxx
  4. Re-run this script

Alternative (no API key required):
  Use the Apify web console at apify.com to run the actors manually and
  download the dataset as JSONL, then place in output/reviews/.
""")
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    categories = ["plumbing", "hvac"] if args.category == "all" else [args.category]

    for category in categories:
        print(f"\nCollecting {category} reviews...")
        if args.platform in ("angi", "all"):
            collect_angi(api_token, category, args.limit, OUTPUT_DIR)
        if args.platform in ("homeadvisor", "all"):
            collect_homeadvisor(api_token, category, args.limit, OUTPUT_DIR)

    merge_reviews(OUTPUT_DIR)


if __name__ == "__main__":
    main()
