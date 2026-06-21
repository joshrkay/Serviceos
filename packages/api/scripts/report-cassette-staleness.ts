/**
 * Report voice-quality cassette staleness — a deterministic, offline view of
 * how much the corpus leans on the replay gateway's drift fallback (which is
 * otherwise silent). No LLM calls and no pipeline run: it only reads the
 * committed cassette JSON.
 *
 * Usage:
 *   npm run voice-quality:staleness              # print report + write JSON, exit 0
 *   npm run voice-quality:staleness -- --strict  # also exit 1 if any cassette is stale
 *
 * Refresh stale cassettes with `npm run voice-quality:refresh` (needs an AI key).
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadCorpus, loadLayer2Corpus } from '../src/ai/voice-quality/corpus/loader';
import type { CassetteEntry } from '../src/ai/voice-quality/cassette-gateway';
import {
  analyzeCassetteStaleness,
  formatStalenessReport,
  DEFAULT_THRESHOLDS,
  type CassetteInput,
} from '../src/ai/voice-quality/cassette-staleness';

const CASSETTES_DIR = path.resolve(__dirname, '../src/ai/voice-quality/corpus/cassettes');
const OUT_PATH = path.resolve(__dirname, '../voice-quality-cassette-staleness.json');

function loadCassettes(): CassetteInput[] {
  // Layer-2-only scripts don't run in the launch gate; exclude them so the
  // staleness picture matches the gate (same filter as check-voice-quality-cassettes).
  const layer2OnlyIds = new Set([
    ...loadLayer2Corpus().map((s) => s.id),
    ...loadCorpus().filter((s) => s.layer2Only).map((s) => s.id),
  ]);

  const files = fs
    .readdirSync(CASSETTES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const inputs: CassetteInput[] = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(CASSETTES_DIR, file), 'utf-8')) as {
      scriptId?: string;
      entries?: unknown;
    };
    const scriptId =
      typeof parsed.scriptId === 'string' ? parsed.scriptId : path.basename(file, '.json');
    if (layer2OnlyIds.has(scriptId)) continue;
    inputs.push({
      scriptId,
      entries: Array.isArray(parsed.entries) ? (parsed.entries as CassetteEntry[]) : [],
    });
  }
  return inputs;
}

function main(): void {
  if (!fs.existsSync(CASSETTES_DIR)) {
    console.error(`Cassettes directory not found: ${CASSETTES_DIR}`);
    process.exit(1);
  }
  const strict = process.argv.includes('--strict');
  const report = analyzeCassetteStaleness(loadCassettes(), new Date(), DEFAULT_THRESHOLDS);

  // eslint-disable-next-line no-console
  console.log(formatStalenessReport(report));
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

  if (strict && report.staleCassettes > 0) {
    console.error(
      `\n${report.staleCassettes} cassette(s) exceed staleness thresholds — ` +
        `refresh with VOICE_QUALITY_CASSETTE_MODE=refresh when convenient.`,
    );
    process.exit(1);
  }
}

main();
