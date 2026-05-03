#!/usr/bin/env python3
"""
Steps 2, 3, 8: Reference document fetcher.

Downloads and processes:
  - ASSE International Plumbing Dictionary PDF (4,000 terms, free)
  - ASHRAE Terminology Glossary (3,700 HVAC terms, web-scraped)
  - InterNACHI HVAC Inspection Guide PDF (bridge vocabulary)
  - InterNACHI Standards of Practice (inspection deficiency language)
  - CED Engineering HVAC Terms PDF

These are structured term glossaries — the highest-quality technical
vocabulary sources available freely.

OUTPUT
------
output/reference/
  asse_plumbing_dictionary.pdf
  asse_terms.jsonl              — {term, definition} per line
  ashrae_terms.jsonl            — {term, definition, category} per line
  internachi_hvac_guide.pdf
  internachi_sop.html
  ced_hvac_terms.pdf
  combined_glossary.jsonl       — merged, deduplicated glossary

USAGE
-----
  python3 02_reference_docs.py
  python3 02_reference_docs.py --skip-pdfs   (only scrape ASHRAE web glossary)
"""

import argparse
import json
import re
import time
from pathlib import Path
from urllib.parse import urljoin

try:
    import requests
    from bs4 import BeautifulSoup
    import pdfplumber
except ImportError:
    print("Install dependencies first: pip install -r requirements.txt")
    raise

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "reference"

SOURCES = {
    "asse_dict_pdf": {
        "url": "https://asse-plumbing.org/media/wdvjmptd/asse_plumbing_dictionary_6thed.pdf",
        "filename": "asse_plumbing_dictionary.pdf",
        "description": "ASSE International Plumbing Dictionary 6th Edition (4,000 terms)",
    },
    "internachi_hvac_pdf": {
        "url": "https://www.nachi.org/documents2012/Inspecting_HVAC_Systems-revised-July-2012.pdf",
        "filename": "internachi_hvac_guide.pdf",
        "description": "InterNACHI HVAC Systems Inspection Guide",
    },
    "ced_hvac_pdf": {
        "url": "https://www.cedengineering.com/userfiles/M05-015%20-%20Description%20of%20Useful%20HVAC%20Terms%20-%20US.pdf",
        "filename": "ced_hvac_terms.pdf",
        "description": "CED Engineering — Description of Useful HVAC Terms",
    },
    "internachi_sop": {
        "url": "https://www.nachi.org/sop.htm",
        "filename": "internachi_sop.html",
        "description": "InterNACHI Standards of Practice (deficiency language)",
    },
}

ASHRAE_BASE_URL = "https://xp20.ashrae.org/terminology/index.php"
ASHRAE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; ServiceOS-CorpusBuilder/1.0; training-data-collection)"
}


def download_file(url: str, dest: Path, description: str):
    if dest.exists():
        print(f"  Already downloaded: {dest.name}")
        return True
    print(f"  Downloading {description}...")
    try:
        resp = requests.get(url, timeout=60, headers=ASHRAE_HEADERS, stream=True)
        resp.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        print(f"  Saved: {dest.name} ({dest.stat().st_size / 1024:.0f} KB)")
        return True
    except Exception as e:
        print(f"  ERROR downloading {url}: {e}")
        return False


def extract_pdf_text(pdf_path: Path) -> list[dict]:
    """Extract text from PDF. For glossaries, attempt term/definition parsing."""
    records = []
    print(f"  Extracting text from {pdf_path.name}...")
    try:
        with pdfplumber.open(pdf_path) as pdf:
            full_text = ""
            for page in pdf.pages:
                text = page.extract_text() or ""
                full_text += text + "\n"

        # Simple heuristic: lines that look like TERM — Definition
        # ASSE dictionary uses bold terms followed by definitions
        lines = full_text.split("\n")
        current_term = None
        current_def = []

        for line in lines:
            line = line.strip()
            if not line:
                continue
            # Term detection: all-caps or title-case short phrase at line start
            if re.match(r"^[A-Z][A-Z\s\-/]{2,40}$", line) or re.match(r"^[A-Z][a-z].*:$", line):
                if current_term and current_def:
                    records.append({"term": current_term, "definition": " ".join(current_def).strip()})
                current_term = line.rstrip(":")
                current_def = []
            elif current_term:
                current_def.append(line)

        if current_term and current_def:
            records.append({"term": current_term, "definition": " ".join(current_def).strip()})

        # Fallback: store raw text blocks if term parsing yielded too little
        if len(records) < 50:
            records = [{"term": None, "definition": full_text, "raw": True}]

    except Exception as e:
        print(f"  PDF extraction error for {pdf_path.name}: {e}")

    print(f"  Extracted {len(records)} entries from {pdf_path.name}")
    return records


def scrape_ashrae_glossary(out_dir: Path) -> list[dict]:
    """Scrape the ASHRAE terminology glossary (paginated web interface)."""
    output_file = out_dir / "ashrae_terms.jsonl"
    if output_file.exists():
        existing = sum(1 for _ in open(output_file))
        if existing > 100:
            print(f"  ASHRAE glossary already scraped ({existing} terms). Skipping.")
            return []

    print("  Scraping ASHRAE terminology glossary...")
    records = []
    letters = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + ["0-9"]

    for letter in letters:
        url = f"{ASHRAE_BASE_URL}?letter={letter}"
        try:
            resp = requests.get(url, headers=ASHRAE_HEADERS, timeout=30)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")

            # ASHRAE page structure: term in <dt> or <h3>, definition in <dd> or <p>
            # Try multiple selectors as the page structure may vary
            term_elements = soup.select("dt") or soup.select(".term") or soup.select("h4")
            for el in term_elements:
                term_text = el.get_text(strip=True)
                sibling = el.find_next_sibling("dd") or el.find_next_sibling("p")
                definition = sibling.get_text(strip=True) if sibling else ""
                if term_text and definition:
                    records.append({
                        "term": term_text,
                        "definition": definition,
                        "source": "ASHRAE Terminology Glossary",
                        "letter": letter,
                    })

            time.sleep(0.5)  # polite delay
        except Exception as e:
            print(f"  ASHRAE letter {letter}: {e}")
            continue

    # Fallback: try the full-page version
    if len(records) < 100:
        print("  ASHRAE pagination yielded few results, trying full glossary URL...")
        try:
            resp = requests.get("https://terminology.ashrae.org/", headers=ASHRAE_HEADERS, timeout=30)
            soup = BeautifulSoup(resp.text, "html.parser")
            for dt in soup.find_all("dt"):
                dd = dt.find_next_sibling("dd")
                if dt.get_text(strip=True) and dd:
                    records.append({
                        "term": dt.get_text(strip=True),
                        "definition": dd.get_text(strip=True),
                        "source": "ASHRAE Terminology Glossary",
                    })
        except Exception as e:
            print(f"  ASHRAE full-page fallback failed: {e}")

    with open(output_file, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record) + "\n")

    print(f"  Scraped {len(records)} ASHRAE terms.")
    return records


def scrape_internachi_sop(html_path: Path, out_dir: Path) -> list[dict]:
    """Parse InterNACHI Standards of Practice for deficiency descriptions."""
    output_file = out_dir / "internachi_sop_items.jsonl"
    if not html_path.exists():
        return []

    print("  Parsing InterNACHI Standards of Practice...")
    records = []

    with open(html_path, encoding="utf-8", errors="replace") as f:
        soup = BeautifulSoup(f.read(), "html.parser")

    # SOP structure: sections with plumbing/HVAC headings, bulleted deficiency items
    current_section = None
    for el in soup.find_all(["h2", "h3", "h4", "li", "p"]):
        tag = el.name
        text = el.get_text(strip=True)
        if not text:
            continue
        if tag in ("h2", "h3", "h4"):
            current_section = text
        elif tag in ("li", "p") and current_section:
            # Filter to plumbing/HVAC sections
            sec_lower = current_section.lower()
            if any(kw in sec_lower for kw in ("plumb", "hvac", "heat", "cool", "water", "drain", "electrical")):
                records.append({
                    "section": current_section,
                    "deficiency": text,
                    "source": "InterNACHI Standards of Practice",
                })

    with open(output_file, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")

    print(f"  Extracted {len(records)} SOP deficiency items.")
    return records


def merge_glossaries(out_dir: Path):
    """Merge all extracted term/definition records into one deduplicated JSONL."""
    combined_file = out_dir / "combined_glossary.jsonl"
    seen_terms: set[str] = set()
    count = 0

    with open(combined_file, "w", encoding="utf-8") as out:
        for jsonl_file in out_dir.glob("*_terms.jsonl"):
            with open(jsonl_file, encoding="utf-8") as f:
                for line in f:
                    record = json.loads(line)
                    term = (record.get("term") or "").lower().strip()
                    if not term or term in seen_terms:
                        continue
                    seen_terms.add(term)
                    out.write(line)
                    count += 1

    print(f"  Combined glossary: {count} unique terms → {combined_file.name}")


def main():
    parser = argparse.ArgumentParser(description="Reference document fetcher for plumbing/HVAC glossaries")
    parser.add_argument("--skip-pdfs", action="store_true", help="Skip PDF downloads, only scrape web sources")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Download PDFs
    if not args.skip_pdfs:
        for key, source in SOURCES.items():
            dest = OUTPUT_DIR / source["filename"]
            if download_file(source["url"], dest, source["description"]):
                if dest.suffix == ".pdf":
                    records = extract_pdf_text(dest)
                    stem = dest.stem.replace(" ", "_")
                    out_jsonl = OUTPUT_DIR / f"{stem}_terms.jsonl"
                    with open(out_jsonl, "w", encoding="utf-8") as f:
                        for r in records:
                            r["source"] = source["description"]
                            f.write(json.dumps(r) + "\n")

    # 2. Scrape ASHRAE web glossary
    scrape_ashrae_glossary(OUTPUT_DIR)

    # 3. Parse InterNACHI SOP
    sop_path = OUTPUT_DIR / "internachi_sop.html"
    if sop_path.exists():
        scrape_internachi_sop(sop_path, OUTPUT_DIR)

    # 4. Merge everything
    merge_glossaries(OUTPUT_DIR)

    print("\nReference docs complete. Files in:", OUTPUT_DIR)


if __name__ == "__main__":
    main()
