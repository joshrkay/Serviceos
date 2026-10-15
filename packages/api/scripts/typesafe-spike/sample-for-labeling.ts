/**
 * Build a human-labeling sheet from real (SCRUBBED) utterances.
 *
 *   TYPESAFE_API_KEY=... npx tsx scripts/typesafe-spike/sample-for-labeling.ts \
 *     --kind frustration --input utterances.txt --out sheet.csv [--agreements 30] [--seed 1] [--threshold 0.5]
 *
 * input: one utterance per line (blank lines ignored), or JSONL with a "text" field.
 * This SENDS every utterance to api.typesafe.ai — scrub PII first (see the data-handling decision).
 * Only `--kind frustration` is wired: complexity has no binary ground truth until outcomes are labeled.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildLabelingSheet, toCsv, type JudgedRow } from '../../src/ai/spikes/typesafe/labeling-sheet';
import { baselineFrustrationJudge, typesafeFrustrationJudge } from '../../src/ai/spikes/typesafe/frustration-judges';
import { createHttpSystemOneClient } from '../../src/ai/spikes/typesafe/http-client';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function parseUtterances(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      if (l.startsWith('{')) {
        try {
          const t = (JSON.parse(l) as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        } catch {
          return l;
        }
      }
      return l;
    })
    .filter(Boolean);
}

async function main(): Promise<void> {
  const kind = arg('kind', 'frustration');
  const input = arg('input');
  const out = arg('out');
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (kind !== 'frustration') throw new Error('only --kind frustration is supported');
  if (!input || !out) throw new Error('usage: --kind frustration --input <file> --out <csv>');
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');

  const threshold = Number(arg('threshold', '0.5'));
  const agreementSample = Number(arg('agreements', '30'));
  const seed = Number(arg('seed', '1'));

  const utterances = parseUtterances(readFileSync(input, 'utf8'));
  const judge = typesafeFrustrationJudge(createHttpSystemOneClient({ apiKey }), { threshold });

  const rows: JudgedRow[] = [];
  for (const text of utterances) {
    const [base, ts] = [await baselineFrustrationJudge(text), await judge(text)];
    rows.push({ text, baseline: base.positive, typesafe: ts.positive, probability: ts.probability });
  }
  const sheet = buildLabelingSheet(rows, { agreementSample, seed });
  writeFileSync(out, toCsv(sheet));

  const count = (k: string) => sheet.filter((r) => r.kind === k).length;
  console.log(
    `utterances=${utterances.length} sheet=${sheet.length} ` +
      `typesafe_only=${count('typesafe_only')} baseline_only=${count('baseline_only')} ` +
      `agree_positive=${count('agree_positive')} agree_negative=${count('agree_negative')} -> ${out}`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
