#!/usr/bin/env python3
"""
Step 10: LBNL HVAC Fault Detection & Diagnostics (FDD) dataset downloader.

Downloads sensor data from real HVAC systems in faulted and fault-free
states from Lawrence Berkeley National Laboratory / OpenEI.

Source: https://data.openei.org/submissions/5763

Datasets included:
  - Rooftop units (RTU)
  - Air handler units (AHU)
  - Variable air volume boxes (VAV)
  - Fan coil units (FCU)
  - Chiller plants
  - Boiler plants

Use cases for the inbound AI agent:
  - Ground fault descriptions to real sensor signatures
  - Train symptom-to-fault-code mapping
  - Validate "what causes X symptom" responses

OUTPUT
------
output/lbnl_hvac/
  dataset_index.json        — manifest of all datasets
  {dataset_name}/
    *.csv                   — raw sensor data
    metadata.json           — variable descriptions, fault labels

USAGE
-----
  python3 07_lbnl_hvac_dataset.py
  python3 07_lbnl_hvac_dataset.py --dataset rtu
"""

import argparse
import json
import os
from pathlib import Path

try:
    import requests
except ImportError:
    print("Install dependencies: pip install requests")
    raise

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "lbnl_hvac"

OPENEI_BASE = "https://data.openei.org"

# Known dataset IDs from the LBNL HVAC FDD submission
# Source: https://data.openei.org/submissions/5763
DATASETS = {
    "rtu": {
        "name": "Rooftop Unit FDD Dataset",
        "description": "Sensor data from rooftop HVAC units in faulted/fault-free states. Faults include: refrigerant undercharge, condenser fouling, evaporator fouling, compressor valve leakage, liquid line restriction, economizer stuck, TXV fault.",
        "openei_submission": "5763",
        "faults": [
            "refrigerant_undercharge",
            "refrigerant_overcharge",
            "condenser_fouling",
            "evaporator_fouling",
            "compressor_valve_leakage",
            "liquid_line_restriction",
            "economizer_damper_stuck",
            "txv_undersized",
        ],
    },
    "ahu": {
        "name": "Air Handler Unit FDD Dataset",
        "description": "AHU sensor data. Faults include: cooling coil fouling, heating coil fouling, supply fan failure, return fan failure, damper stuck, sensor drift.",
        "openei_submission": "5763",
        "faults": [
            "cooling_coil_fouling",
            "heating_coil_fouling",
            "supply_fan_failure",
            "return_fan_failure",
            "damper_stuck",
            "sensor_drift",
        ],
    },
    "vav": {
        "name": "Variable Air Volume Box FDD Dataset",
        "description": "VAV box sensor data. Faults include: damper stuck, reheat coil failure, sensor offset.",
        "openei_submission": "5763",
        "faults": ["damper_stuck", "reheat_coil_failure", "airflow_sensor_offset"],
    },
}

# GitHub repository for open-fdd (FDD Python library + datasets)
OPEN_FDD_REPO = "https://github.com/bbartling/open-fdd"
OPEN_FDD_RAW = "https://raw.githubusercontent.com/bbartling/open-fdd/main"

# Known CSV files in the open-fdd repository
OPEN_FDD_SAMPLE_FILES = [
    "data/ahu_data.csv",
    "data/rtu_data.csv",
    "data/sample_data.csv",
]


def fetch_openei_submission_index(submission_id: str) -> dict:
    """Fetch the OpenEI data submission manifest."""
    url = f"{OPENEI_BASE}/submissions/{submission_id}.json"
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"  Could not fetch OpenEI manifest: {e}")
        return {}


def download_open_fdd_samples(out_dir: Path):
    """Download sample HVAC FDD data from the open-fdd GitHub repo."""
    samples_dir = out_dir / "open_fdd_samples"
    samples_dir.mkdir(exist_ok=True)

    print("  Downloading open-fdd sample datasets...")
    for file_path in OPEN_FDD_SAMPLE_FILES:
        url = f"{OPEN_FDD_RAW}/{file_path}"
        dest = samples_dir / Path(file_path).name
        if dest.exists():
            print(f"    Already downloaded: {dest.name}")
            continue
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
            print(f"    Downloaded: {dest.name} ({dest.stat().st_size / 1024:.0f} KB)")
        except Exception as e:
            print(f"    Could not download {file_path}: {e}")


def generate_fault_description_pairs(out_dir: Path):
    """
    Generate structured fault→customer-description training pairs.
    Maps technical HVAC faults to how a customer would describe the symptom.
    """
    pairs = [
        {
            "fault_code": "refrigerant_undercharge",
            "system": "central_ac",
            "technical_description": "Refrigerant charge below design level. Suction pressure low, superheat high, system capacity reduced.",
            "customer_symptoms": [
                "AC is running but not cooling the house",
                "It's been running all day and can't reach the temperature",
                "The outside unit is running but the air is barely cold",
                "There's ice forming on the copper pipes",
                "My electric bill went up but it's not cooling any better",
            ],
            "urgency": "TIER_3_SAME_DAY_URGENT",
        },
        {
            "fault_code": "condenser_fouling",
            "system": "central_ac",
            "technical_description": "Condenser coil blocked by debris, dirt, or vegetation. Head pressure elevated, efficiency reduced.",
            "customer_symptoms": [
                "The outside unit looks really dirty, fins are all clogged",
                "AC not cooling as well as it used to",
                "The outside unit is hot to the touch on the top",
                "There's a lot of stuff built up on the outside unit",
            ],
            "urgency": "TIER_4_SCHEDULE",
        },
        {
            "fault_code": "compressor_failure",
            "system": "central_ac",
            "technical_description": "Compressor unable to pump refrigerant. May be mechanical failure, electrical failure, or locked rotor.",
            "customer_symptoms": [
                "The outside unit just hums and clicks but doesn't really run",
                "I can hear a loud clicking from the outside unit over and over",
                "The fan on top of the outside unit spins but it's not cooling",
                "Outside unit keeps tripping the breaker",
                "There's a burning smell from the outside unit",
            ],
            "urgency": "TIER_3_SAME_DAY_URGENT",
        },
        {
            "fault_code": "failed_capacitor",
            "system": "central_ac",
            "technical_description": "Run or start capacitor failed. Compressor or condenser fan will not start without capacitor.",
            "customer_symptoms": [
                "The outside unit hums loudly for a second then shuts off",
                "The fan on top of the outside unit isn't spinning",
                "AC keeps trying to turn on and off over and over",
            ],
            "urgency": "TIER_3_SAME_DAY_URGENT",
        },
        {
            "fault_code": "clogged_condensate_drain",
            "system": "central_ac",
            "technical_description": "Condensate drain line blocked. Pan overflows, float switch trips, unit shuts down.",
            "customer_symptoms": [
                "Water is dripping from the ceiling in my hallway near the AC",
                "There's water all over the floor under the AC unit in the attic",
                "My AC stopped working and I found water in the pan under it",
                "Water is flooding out of the closet where the AC is",
            ],
            "urgency": "TIER_3_SAME_DAY_URGENT",
        },
        {
            "fault_code": "dirty_flame_sensor",
            "system": "furnace_gas",
            "technical_description": "Flame sensor coated with oxide layer. Cannot confirm flame presence, gas valve shuts within seconds of ignition.",
            "customer_symptoms": [
                "Furnace lights then shuts off after a few seconds over and over",
                "I can hear it click and see it light but then it shuts right back off",
                "Furnace starts then stops repeatedly without heating the house",
                "The furnace cycles on and off every few minutes",
            ],
            "urgency": "TIER_3_SAME_DAY_URGENT",
        },
        {
            "fault_code": "cracked_heat_exchanger",
            "system": "furnace_gas",
            "technical_description": "Heat exchanger crack allows combustion gases (CO) to enter supply air stream. Life-safety hazard.",
            "customer_symptoms": [
                "I smell something like exhaust or burning when the heat is on",
                "My CO detector went off when the furnace was running",
                "Everyone in the house has had headaches since we turned on the heat",
                "There's a strange smell from the vents when the furnace runs",
            ],
            "urgency": "TIER_1_EVACUATE",
            "life_safety": True,
        },
        {
            "fault_code": "failed_igniter",
            "system": "furnace_gas",
            "technical_description": "Hot surface igniter cracked or burned out. Cannot initiate combustion.",
            "customer_symptoms": [
                "Furnace won't turn on at all, just clicks and nothing happens",
                "The heat isn't coming on — I can hear it try to start but nothing",
                "Furnace makes a clicking sound but never actually lights",
            ],
            "urgency": "TIER_3_SAME_DAY_URGENT",
        },
        {
            "fault_code": "stuck_reversing_valve",
            "system": "heat_pump",
            "technical_description": "Reversing valve stuck in one mode. Heat pump unable to switch between heating and cooling.",
            "customer_symptoms": [
                "The heat pump is blowing cold air in heat mode",
                "We switched from heat to cool and now it blows the wrong temperature",
                "In the winter the heat pump was blowing cold air",
            ],
            "urgency": "TIER_3_SAME_DAY_URGENT",
        },
        {
            "fault_code": "failed_defrost_board",
            "system": "heat_pump",
            "technical_description": "Defrost control board failure. Unit cannot initiate defrost cycle. Ice accumulates on outdoor coil.",
            "customer_symptoms": [
                "The whole outside unit is covered in a thick layer of ice",
                "The outside unit is completely frozen solid",
                "There's ice built up all over the outdoor unit and it won't heat",
            ],
            "urgency": "TIER_3_SAME_DAY_URGENT",
        },
    ]

    output_file = out_dir / "fault_symptom_pairs.jsonl"
    with open(output_file, "w", encoding="utf-8") as f:
        for pair in pairs:
            f.write(json.dumps(pair) + "\n")

    print(f"  Generated {len(pairs)} fault-symptom training pairs → {output_file.name}")
    return pairs


def main():
    parser = argparse.ArgumentParser(description="LBNL HVAC FDD dataset downloader")
    parser.add_argument("--dataset", choices=list(DATASETS.keys()) + ["all"], default="all")
    parser.add_argument("--skip-download", action="store_true", help="Skip downloads, only generate fault-symptom pairs")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Save dataset manifest
    manifest_file = OUTPUT_DIR / "dataset_index.json"
    with open(manifest_file, "w", encoding="utf-8") as f:
        json.dump({
            "source": "Lawrence Berkeley National Laboratory HVAC FDD",
            "openei_url": "https://data.openei.org/submissions/5763",
            "github": OPEN_FDD_REPO,
            "datasets": DATASETS,
        }, f, indent=2)
    print(f"Saved dataset index → {manifest_file.name}")

    if not args.skip_download:
        # Download open-fdd samples (GitHub, no auth required)
        download_open_fdd_samples(OUTPUT_DIR)

        # Attempt OpenEI manifest fetch
        print("\nFetching OpenEI submission metadata...")
        manifest = fetch_openei_submission_index("5763")
        if manifest:
            (OUTPUT_DIR / "openei_manifest.json").write_text(json.dumps(manifest, indent=2))
            print("  Saved OpenEI manifest")

            # Download linked files from manifest
            files = manifest.get("files", []) or manifest.get("resources", [])
            for file_info in files[:20]:
                url = file_info.get("url") or file_info.get("downloadURL")
                name = file_info.get("name") or Path(url).name if url else None
                if url and name:
                    dest = OUTPUT_DIR / name
                    if not dest.exists():
                        try:
                            print(f"  Downloading {name}...")
                            resp = requests.get(url, timeout=60, stream=True)
                            resp.raise_for_status()
                            with open(dest, "wb") as f:
                                for chunk in resp.iter_content(65536):
                                    f.write(chunk)
                            print(f"    Saved: {name}")
                        except Exception as e:
                            print(f"    Failed: {name} — {e}")
        else:
            print("  OpenEI manifest not available. Visit https://data.openei.org/submissions/5763 to download manually.")

    # Always generate fault-symptom pairs (no external fetch required)
    print("\nGenerating fault→symptom training pairs...")
    generate_fault_description_pairs(OUTPUT_DIR)

    print("\nLBNL HVAC dataset processing complete.")


if __name__ == "__main__":
    main()
