/**
 * build-manifest.ts — regenerates CORPUS_MANIFEST.md from the corpus files
 * actually committed to the repo. Backs `pnpm corpus:manifest`.
 *
 * T6-F06: CORPUS_MANIFEST.md used to be hand-maintained prose that drifted
 * from reality (it claimed 1,820 EN / 3,617 total rows and "byte-identical"
 * regeneration well after the file actually held 4,854 mixed-schema rows).
 * This script is the only thing that should ever write that file — every
 * count below is computed from `data/corpus/*` via the same
 * readJsonl/listJsonl helpers `validate-corpus.ts` and `pii-leakage.ts` use,
 * so the manifest can't silently drift from the data again.
 *
 * Idempotent: re-running with no data change produces byte-identical output.
 *
 * Run: pnpm corpus:manifest
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_DIR, REPO_ROOT, readJsonl, listJsonl } from './lib';

const MANIFEST_PATH = join(REPO_ROOT, 'CORPUS_MANIFEST.md');

interface UtteranceRow {
  source?: string;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function countBehaviors(): number {
  const yaml = readFileSync(join(CORPUS_DIR, 'behaviors.yaml'), 'utf8');
  return (yaml.match(/^\s*-\s+id:\s*[a-z_]+\s*$/gm) ?? []).length;
}

function main(): void {
  const behaviorCount = countBehaviors();
  const utterances = readJsonl<UtteranceRow>(join(CORPUS_DIR, 'utterances.jsonl'));
  const utterancesEs = readJsonl<Record<string, unknown>>(join(CORPUS_DIR, 'utterances_es.jsonl'));
  const edgeCases = readJsonl<Record<string, unknown>>(join(CORPUS_DIR, 'edge_cases.jsonl'));
  const negatives = readJsonl<Record<string, unknown>>(join(CORPUS_DIR, 'negatives.jsonl'));

  const slotFiles = listJsonl(join(CORPUS_DIR, 'slot_fixtures')).sort();
  const slotCounts = slotFiles.map((f) => ({ name: f.split('/').pop() as string, rows: readJsonl(f).length }));

  // Provenance breakdown: every utterances.jsonl row accounted for, incl.
  // the 3,034 legacy-derived rows a hand-written manifest previously omitted.
  const bySource = new Map<string, number>();
  for (const r of utterances) {
    const key = r.source ?? '(missing)';
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }

  const total =
    utterances.length +
    utterancesEs.length +
    edgeCases.length +
    negatives.length +
    slotCounts.reduce((s, c) => s + c.rows, 0);

  const slotRows = slotCounts
    .map(
      (c) =>
        `| \`data/corpus/slot_fixtures/${c.name}\` | ${fmt(c.rows)} | en | Hand-authored (\`build-slots.ts\`) | internal-synthetic |`,
    )
    .join('\n');

  const sourceRows = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([src, n]) => `| \`${src}\` | ${fmt(n)} | ${((100 * n) / utterances.length).toFixed(1)}% |`)
    .join('\n');

  const md = `# CORPUS MANIFEST

Every committed voice-corpus data file: source, count, license. Regenerated
by \`scripts/data-pipeline/build-manifest.ts\` (\`pnpm corpus:manifest\`) from
the actual committed files — do not hand-edit the counts below; re-run the
script instead. All data is synthetic and PII-free (verified by
\`pnpm test:pii-leakage\`).

## Data files

| File | Rows | Lang | Source | License |
|------|-----:|------|--------|---------|
| \`data/corpus/behaviors.yaml\` | ${behaviorCount} behaviors | — | Hand-authored, aligned to \`packages/shared/src/enums.ts\` \`ProposalType\` + \`VOICE_INBOUND_ASSISTANTS\` | internal |
| \`data/corpus/utterances.jsonl\` | ${fmt(utterances.length)} | en | Deterministic expansion of \`seeds/templates.en.json\` (\`utt_en_*\` rows) merged with the T6-F01-migrated legacy corpus (\`legacy-*\` rows — see provenance breakdown below) | internal-synthetic |
| \`data/corpus/utterances_es.jsonl\` | ${fmt(utterancesEs.length)} | es | Deterministic expansion of \`seeds/templates.es.json\` (native US-Latino phrasing + code-switch) | internal-synthetic |
| \`data/corpus/edge_cases.jsonl\` | ${fmt(edgeCases.length)} | en | Hand-authored phonetic/disfluent transcripts (\`build-edge-negatives.ts\`) | internal-synthetic |
| \`data/corpus/negatives.jsonl\` | ${fmt(negatives.length)} | en | Hand-authored non-intent scripts (\`build-edge-negatives.ts\`) | internal-synthetic |
${slotRows}
| **Total labeled examples** | **${fmt(total)}** | | | |

## Provenance breakdown — \`utterances.jsonl\`

The T6-F01 migration gave every legacy-schema row (no prior CI validation
ever ran against them — see \`docs/plans/2026-07-18-003-fix-corpus-integrity-plan.md\`)
a stable \`legacy-<sha1>\` id and the canonical shape, preserving \`slots\`/
\`confidence\` rather than dropping them. Breakdown by \`source\`:

| Source | Rows | Share |
|--------|-----:|------:|
${sourceRows}

## Seed files (generator inputs)

| File | Purpose | License |
|------|---------|---------|
| \`data/corpus/seeds/fillers.json\` | Service / time / synthetic-persona / address filler banks | internal-synthetic |
| \`data/corpus/seeds/templates.en.json\` | English seed templates per intent | internal-synthetic |
| \`data/corpus/seeds/templates.es.json\` | Spanish + code-switch seed templates per intent | internal-synthetic |

## Pre-existing corpus (not modified by this pass)

| File | Purpose | Source |
|------|---------|--------|
| \`corpus/data/vocabulary.json\` | Lay→technical plumbing/HVAC vocabulary | ASSE/ASHRAE glossaries, r/Plumbing, r/HVAC (see file \`_meta\`) |
| \`corpus/data/triage-rules.json\` | Emergency tiers + trigger phrases | Internal triage policy |
| \`serviceos_training/\` | Reddit ingestion pipeline (Academic Torrents) | Public Reddit archive — see \`serviceos_training/README.md\` |
| \`packages/api/src/ai/voice-quality/corpus/golden/*.json\` | ~40 golden conversation fixtures driving the live agent eval | Internal |

## Pipeline & harness (code)

| Path | Role |
|------|------|
| \`scripts/data-pipeline/generate-utterances.ts\` | Deterministic utterance generator (writes the EN staging file merge-corpus.ts folds in) |
| \`scripts/data-pipeline/merge-corpus.ts\` | Merges generated EN rows with frozen \`legacy-*\` rows into \`utterances.jsonl\` (\`corpus:merge\`) |
| \`scripts/data-pipeline/migrate-legacy-utterances.ts\` | One-off, idempotent legacy-schema -> canonical-schema migration (T6-F01) |
| \`scripts/data-pipeline/build-edge-negatives.ts\` | Edge + negative fixture builder |
| \`scripts/data-pipeline/build-slots.ts\` | Slot fixture builder |
| \`scripts/data-pipeline/build-manifest.ts\` | Regenerates this file (\`corpus:manifest\`) |
| \`scripts/data-pipeline/validate-corpus.ts\` | Schema + floor validation (\`test:corpus-schema\`) |
| \`scripts/data-pipeline/dedup.ts\` | Exact/near duplicate detection (\`test:dedup\`) |
| \`scripts/data-pipeline/dedup-utterances.ts\` | Exact/near duplicate gate for \`utterances.jsonl\` (\`corpus:dedup\`) |
| \`scripts/data-pipeline/pii-leakage.ts\` | PII guard, HARD STOP (\`test:pii-leakage\`) |
| \`scripts/eval/run_eval.py\` | Eval orchestrator (\`eval:full\` / \`:edge-cases\` / \`:negatives\` / \`:spanish\`) |
| \`scripts/eval/classifier.py\` | Bilingual rule-based intent classifier + routing |
| \`scripts/eval/slots.py\` | Address/time/phone/service extractors |
| \`scripts/eval/corpus_io.py\` | IO, normalization, frozen split |

## Provenance & ethics

- No real Reddit user attribution; no scraped copyrighted text is committed here.
- All personas, phone numbers (\`555\` blocks), addresses, and names are fictional.
- Reproducibility: \`pnpm corpus:build\` regenerates the synthetic (\`utt_en_*\`)
  portion deterministically from seeds and merges the frozen \`legacy-*\` rows
  back in (\`corpus:merge\`) — it is content-equivalent, not byte-identical,
  since legacy rows are preserved data rather than derived from seeds.
`;

  writeFileSync(MANIFEST_PATH, md, 'utf8');
  console.error(`[manifest] wrote ${MANIFEST_PATH} (${fmt(total)} total labeled examples)`);
}

main();
