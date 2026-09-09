#!/usr/bin/env tsx
/**
 * Run the in-app 50-case register against the REAL in-app voice pipeline.
 *
 *   npx tsx scripts/run-inapp-50.ts                 # print the scoreboard
 *   npx tsx scripts/run-inapp-50.ts --write         # + persist run artifacts
 *   npx tsx scripts/run-inapp-50.ts --batch 2       # cases 11..20
 *   npx tsx scripts/run-inapp-50.ts --only book-01,search-02
 *   npx tsx scripts/run-inapp-50.ts --json          # RunResult on stdout
 *
 * Hermetic: no database, no network, no LLM provider. Exit code 1 when the
 * release gate fails, so it can be dropped straight into CI.
 */
import {
  casesForBatch,
  casesForKeys,
  loadRegister,
  type RegisterCase,
} from '../src/ai/voice-quality/inapp-50/register';
import { runRegister } from '../src/ai/voice-quality/inapp-50/runner';
import { formatScoreboard, writeRunArtifacts } from '../src/ai/voice-quality/inapp-50/report';

interface Cli {
  batch: number | null;
  only: string[] | null;
  write: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): Cli {
  const cli: Cli = { batch: null, only: null, write: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') cli.write = true;
    else if (arg === '--json') cli.json = true;
    else if (arg === '--batch') cli.batch = Number(argv[++i]);
    else if (arg.startsWith('--batch=')) cli.batch = Number(arg.slice('--batch='.length));
    else if (arg === '--only') cli.only = String(argv[++i]).split(',').map((k) => k.trim());
    else if (arg.startsWith('--only=')) {
      cli.only = arg.slice('--only='.length).split(',').map((k) => k.trim());
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: tsx scripts/run-inapp-50.ts [--batch N] [--only k1,k2] [--write] [--json]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`run-inapp-50: unknown argument '${arg}'`);
    }
  }
  if (cli.batch !== null && cli.only !== null) {
    throw new Error('run-inapp-50: --batch and --only are mutually exclusive');
  }
  return cli;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const register = loadRegister();

  let cases: readonly RegisterCase[] = register.cases;
  if (cli.batch !== null) cases = casesForBatch(register, cli.batch);
  else if (cli.only) cases = casesForKeys(register, cli.only);

  const result = await runRegister(register, {
    cases,
    // A `--only` slice is not a batch: it must never merge into latest.json
    // as if it were one of the five canonical ten-case windows.
    batch: cli.batch,
  });

  if (cli.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(formatScoreboard(result, register.cases.length));

  // The release gate is a statement about all fifty cases, so a partial run
  // can only ever be judged on what it actually ran — unless it was merged
  // into latest.json, in which case the merged fifty are authoritative.
  let gatePass = cases.length === register.cases.length
    ? result.summary.gate.pass
    : result.cases.every((c) => c.verdict === 'PASS');

  if (cli.write) {
    if (cli.only) {
      process.stderr.write(
        'run-inapp-50: --only is a debugging slice; artifacts are NOT written for it.\n',
      );
    } else {
      const written = writeRunArtifacts(register, result);
      process.stdout.write(`wrote ${written.runPath}\nwrote ${written.latestPath}\n`);
      gatePass = written.latest.summary.gate.pass;
      if (cli.batch !== null) {
        process.stdout.write(
          `latest.json now holds ${written.latest.summary.total} case(s): ` +
            (written.latest.summary.gate.pass
              ? 'GATE PASS\n'
              : `GATE FAIL — ${written.latest.summary.gate.reasons.join(' | ')}\n`),
        );
      }
    }
  }

  process.exitCode = gatePass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(
    `run-inapp-50 failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
