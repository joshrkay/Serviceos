/**
 * Merge per-script verdict shards into `voice-quality-report.json`.
 * Invoked after `vitest run -c vitest.voice-quality.config.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { aggregate } from '../src/ai/voice-quality/graders/report';
import type { PerScriptVerdict } from '../src/ai/voice-quality/graders/report';

const VERDICTS_DIR = path.resolve(__dirname, '../.voice-quality-verdicts');
const REPORT_PATH = path.resolve(__dirname, '../voice-quality-report.json');

function main(): void {
  let verdicts: PerScriptVerdict[] = [];

  if (fs.existsSync(VERDICTS_DIR)) {
    const files = fs
      .readdirSync(VERDICTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const file of files) {
      const raw = fs.readFileSync(path.join(VERDICTS_DIR, file), 'utf-8');
      verdicts.push(JSON.parse(raw) as PerScriptVerdict);
    }
    fs.rmSync(VERDICTS_DIR, { recursive: true, force: true });
  }

  verdicts = verdicts.sort((a, b) => a.scriptId.localeCompare(b.scriptId));
  const report = aggregate(verdicts);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  // eslint-disable-next-line no-console
  console.log(
    `Voice quality report: ${report.totalPassed}/${report.totalScripts} scripts passed; launchGate.pass=${report.launchGate.pass}`,
  );

  if (process.env.VOICE_QUALITY_ENFORCE_LAUNCH_GATE === 'true' && !report.launchGate.pass) {
    // eslint-disable-next-line no-console
    console.error(report.launchGate.blockers.join('\n'));
    process.exit(1);
  }
}

main();
