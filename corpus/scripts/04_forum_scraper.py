#!/usr/bin/env python3
"""
Step 5: JustAnswer + Plumbing Forum scraper.

Scrapes public Q&A archives from:
  - JustAnswer.com/plumbing and /hvac  (lay question + expert diagnosis)
  - Terry Love Plumbing Forum (terrylove.com) — 95,000+ threads
  - PlumbingForums.com

JustAnswer is the highest-value source: customers type exact lay-language
problem descriptions, licensed techs provide technical diagnoses. This is
the closest publicly-available analog to real inbound call transcripts.

OUTPUT
------
output/forums/
  justanswer_plumbing.jsonl   — {url, question, answer, category}
  justanswer_hvac.jsonl
  terrylove.jsonl
  plumbingforums.jsonl
  all_qa.jsonl                — merged Q&A pairs

USAGE
-----
  python3 04_forum_scraper.py
  python3 04_forum_scraper.py --source justanswer --category plumbing --pages 50
  python3 04_forum_scraper.py --source terrylove --pages 100
"""

import argparse
import json
import random
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, quote

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Install dependencies: pip install requests beautifulsoup4")
    raise

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "forums"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# JustAnswer category URL patterns
JUSTANSWER_CATEGORIES = {
    "plumbing": "https://www.justanswer.com/plumbing/",
    "hvac": "https://www.justanswer.com/hvac-air-conditioning/",
    "appliances": "https://www.justanswer.com/appliance/",
}

# High-value search queries for JustAnswer Google scraping
JUSTANSWER_QUERIES = [
    "site:justanswer.com/plumbing leaking",
    "site:justanswer.com/plumbing drain",
    "site:justanswer.com/plumbing toilet",
    "site:justanswer.com/plumbing water heater",
    "site:justanswer.com/plumbing no hot water",
    "site:justanswer.com/hvac-air-conditioning no heat",
    "site:justanswer.com/hvac-air-conditioning not cooling",
    "site:justanswer.com/hvac-air-conditioning furnace",
    "site:justanswer.com/hvac-air-conditioning ac not working",
    "site:justanswer.com/plumbing sewer smell",
    "site:justanswer.com/plumbing gurgling",
    "site:justanswer.com/plumbing low water pressure",
]


def polite_get(url: str, delay: float = 1.5) -> requests.Response | None:
    """Polite HTTP GET with retry and delay."""
    time.sleep(delay + random.uniform(0, 0.5))
    try:
        resp = requests.get(url, headers=HEADERS, timeout=20)
        if resp.status_code == 429:
            print(f"    Rate limited at {url}. Waiting 30s...")
            time.sleep(30)
            resp = requests.get(url, headers=HEADERS, timeout=20)
        resp.raise_for_status()
        return resp
    except Exception as e:
        print(f"    GET failed: {url} — {e}")
        return None


def scrape_justanswer_thread(url: str) -> dict | None:
    """Scrape a single JustAnswer Q&A thread."""
    resp = polite_get(url)
    if not resp:
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    # JustAnswer page structure varies — try multiple selectors
    question = (
        (soup.select_one(".question-text") or soup.select_one("[class*='question']") or soup.select_one("h1"))
    )
    answer = (
        soup.select_one(".answer-text") or
        soup.select_one("[class*='answer-body']") or
        soup.select_one("[class*='expert-answer']")
    )

    if not question:
        return None

    return {
        "url": url,
        "question": question.get_text(strip=True),
        "answer": answer.get_text(strip=True) if answer else None,
        "source": "justanswer",
    }


def scrape_justanswer_category(category: str, url: str, out_dir: Path, max_pages: int = 50):
    """Scrape thread listings from a JustAnswer category page."""
    output_file = out_dir / f"justanswer_{category}.jsonl"
    seen_urls: set[str] = set()

    if output_file.exists():
        with open(output_file, encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                seen_urls.add(r.get("url", ""))
        print(f"  JustAnswer/{category}: {len(seen_urls)} already scraped")

    count = 0
    with open(output_file, "a", encoding="utf-8") as out:
        for page_num in range(1, max_pages + 1):
            page_url = f"{url}?page={page_num}" if page_num > 1 else url
            resp = polite_get(page_url)
            if not resp:
                break

            soup = BeautifulSoup(resp.text, "html.parser")
            thread_links = soup.select("a[href*='/plumbing/'], a[href*='/hvac-air-conditioning/']")

            if not thread_links:
                # Try generic listing selectors
                thread_links = soup.select(".question-list a, .qa-list a, article a")

            for link in thread_links:
                href = link.get("href", "")
                if not href or "justanswer.com" not in urljoin(url, href):
                    continue
                full_url = urljoin("https://www.justanswer.com", href)
                if full_url in seen_urls:
                    continue

                record = scrape_justanswer_thread(full_url)
                if record and record.get("question"):
                    record["category"] = category
                    out.write(json.dumps(record) + "\n")
                    seen_urls.add(full_url)
                    count += 1

            print(f"    Page {page_num}: {count} records so far")
            if not soup.select_one("a[rel='next'], .next-page, [class*='pagination'] a:last-child"):
                break  # No next page

    print(f"  JustAnswer/{category}: scraped {count} threads")


def scrape_terrylove(out_dir: Path, max_pages: int = 100):
    """Scrape Terry Love Plumbing Forum (terrylove.com/forums)."""
    output_file = out_dir / "terrylove.jsonl"
    seen_urls: set[str] = set()
    base_url = "https://terrylove.com/forums/"

    if output_file.exists():
        with open(output_file) as f:
            for line in f:
                seen_urls.add(json.loads(line).get("url", ""))

    count = 0
    print("  Scraping Terry Love Plumbing Forum...")

    with open(output_file, "a", encoding="utf-8") as out:
        # Get forum index to find subforums
        resp = polite_get(base_url)
        if not resp:
            return

        soup = BeautifulSoup(resp.text, "html.parser")
        subforum_links = [
            urljoin(base_url, a["href"])
            for a in soup.select("a[href]")
            if "forums" in a.get("href", "") and a.get("href", "").startswith("/forums/")
        ]

        for subforum_url in subforum_links[:10]:  # Top 10 subforums
            for page in range(1, max_pages // 10 + 1):
                page_url = f"{subforum_url}page-{page}" if page > 1 else subforum_url
                resp = polite_get(page_url)
                if not resp:
                    break

                soup = BeautifulSoup(resp.text, "html.parser")
                thread_links = [
                    urljoin(base_url, a["href"])
                    for a in soup.select("a.title, a[href*='/threads/']")
                    if a.get("href")
                ]

                for thread_url in thread_links:
                    if thread_url in seen_urls:
                        continue
                    resp = polite_get(thread_url)
                    if not resp:
                        continue

                    thread_soup = BeautifulSoup(resp.text, "html.parser")
                    posts = thread_soup.select(".message-body, .bbWrapper, article .message-userContent")
                    if len(posts) < 2:
                        continue

                    record = {
                        "url": thread_url,
                        "question": posts[0].get_text(strip=True),
                        "answers": [p.get_text(strip=True) for p in posts[1:5]],
                        "source": "terrylove",
                    }
                    out.write(json.dumps(record) + "\n")
                    seen_urls.add(thread_url)
                    count += 1

                if count % 50 == 0:
                    print(f"    {count} threads scraped...")

    print(f"  Terry Love: {count} threads scraped")


def scrape_plumbingforums(out_dir: Path, max_pages: int = 50):
    """Scrape PlumbingForums.com"""
    output_file = out_dir / "plumbingforums.jsonl"
    seen_urls: set[str] = set()
    base_url = "https://www.plumbingzone.com/"  # PlumbingZone is the modern successor

    if output_file.exists():
        with open(output_file) as f:
            for line in f:
                seen_urls.add(json.loads(line).get("url", ""))

    count = 0
    print("  Scraping PlumbingZone forum...")

    with open(output_file, "a", encoding="utf-8") as out:
        resp = polite_get(base_url)
        if not resp:
            return

        soup = BeautifulSoup(resp.text, "html.parser")
        thread_links = [
            urljoin(base_url, a["href"])
            for a in soup.select("a[href*='/threads/'], a[href*='/topic/']")
            if a.get("href")
        ][:max_pages]

        for thread_url in thread_links:
            if thread_url in seen_urls:
                continue
            resp = polite_get(thread_url)
            if not resp:
                continue

            thread_soup = BeautifulSoup(resp.text, "html.parser")
            posts = thread_soup.select(".message-body, article .messageText, .bbWrapper")
            if len(posts) < 2:
                continue

            record = {
                "url": thread_url,
                "question": posts[0].get_text(strip=True),
                "answers": [p.get_text(strip=True) for p in posts[1:4]],
                "source": "plumbingzone",
            }
            out.write(json.dumps(record) + "\n")
            seen_urls.add(thread_url)
            count += 1

    print(f"  PlumbingZone: {count} threads scraped")


def merge_all(out_dir: Path):
    """Merge all Q&A sources into all_qa.jsonl"""
    output_file = out_dir / "all_qa.jsonl"
    count = 0
    with open(output_file, "w", encoding="utf-8") as out:
        for jsonl in out_dir.glob("*.jsonl"):
            if jsonl.name == "all_qa.jsonl":
                continue
            with open(jsonl, encoding="utf-8") as f:
                for line in f:
                    out.write(line)
                    count += 1
    print(f"\nMerged {count} Q&A records → {output_file.name}")


def main():
    parser = argparse.ArgumentParser(description="Forum scraper for plumbing/HVAC Q&A training data")
    parser.add_argument("--source", choices=["justanswer", "terrylove", "plumbingforums", "all"], default="all")
    parser.add_argument("--category", choices=["plumbing", "hvac", "appliances"], default="plumbing")
    parser.add_argument("--pages", type=int, default=50, help="Max pages to scrape per source")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    if args.source in ("justanswer", "all"):
        categories = [args.category] if args.source == "justanswer" else JUSTANSWER_CATEGORIES.keys()
        for cat, url in JUSTANSWER_CATEGORIES.items():
            if args.source == "justanswer" and cat != args.category:
                continue
            print(f"\nJustAnswer / {cat}")
            scrape_justanswer_category(cat, url, OUTPUT_DIR, max_pages=args.pages)

    if args.source in ("terrylove", "all"):
        print("\nTerry Love Plumbing Forum")
        scrape_terrylove(OUTPUT_DIR, max_pages=args.pages)

    if args.source in ("plumbingforums", "all"):
        print("\nPlumbingZone Forum")
        scrape_plumbingforums(OUTPUT_DIR, max_pages=args.pages)

    merge_all(OUTPUT_DIR)


if __name__ == "__main__":
    main()
