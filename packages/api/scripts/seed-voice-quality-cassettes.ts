/**
 * Record Layer 1 cassettes for every corpus script using the script-aware
 * mock LLM (no live API keys). Run from packages/api:
 *
 *   npm run voice-quality:seed-cassettes
 *   npm run voice-quality:seed-cassettes -- --prune
 *
 * `--prune` (tooling follow-up, 2026-08-09) additionally collapses each
 * cassette's accretion history: every taxonomy change invalidates the
 * request hash for every classify_intent entry corpus-wide (the system
 * prompt is shared verbatim across every call), and neither `record` nor
 * `refresh` mode ever REMOVES a superseded entry — only adds/overwrites —
 * so cassette files grow monotonically as the taxonomy evolves
 * (`report-cassette-staleness.ts` measured depths up to 27-29 by the end
 * of one feature wave).
 *
 * `--prune` deliberately does NOT reuse this script's own `record`-mode
 * loop above to establish "what's live" — an earlier version tried exactly
 * that (a local `runScript` call in `refresh` mode) and it is UNSAFE: this
 * script's own driver-construction path does not reproduce the full
 * request graph `npm run voice-quality:refresh` (the real, vitest-driven
 * mechanism — `voice-quality.test.ts`) produces. Proven empirically: a
 * `--prune` run built on the local loop passed its own logic but then
 * broke strict replay 37/73 scripts later, because at least one script
 * (`spam-create-customer`) issues two DIFFERENT live classify_intent
 * requests that happen to share the fallback-matching (schema,
 * system-fingerprint, last-user-message) key — this script's simpler
 * `runScript` call only ever produced one of the two, so "refresh via this
 * script, then prune" discarded the one it never saw. `--prune` here
 * instead shells out to the SAME command `npm run voice-quality:refresh`
 * runs, so pruning is always keyed off the one mechanism proven (by that
 * command's own passing test suite) to reproduce the real, complete call
 * graph. See `pruneEntriesBefore`'s doc comment (cassette-staleness.ts)
 * for the full safety argument and the rejected-design writeup.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { loadCorpus } from '../src/ai/voice-quality/corpus/loader';
import { runScript } from '../src/ai/voice-quality/runner';
import { defaultCassettesDir, type CassetteFile } from '../src/ai/voice-quality/cassette-gateway';
import { pruneEntriesBefore } from '../src/ai/voice-quality/cassette-staleness';
import {
  buildCassetteGatewayForScript,
  makeVoiceQualityDriverFactory,
} from '../test/voice-quality/voice-quality-driver-factory';

const PACKAGE_ROOT = path.resolve(__dirname, '..');

async function seed(): Promise<void> {
  const scripts = loadCorpus().filter((s) => !s.layer2Only);
  if (scripts.length === 0) {
    console.error('No corpus scripts found.');
    process.exit(1);
  }

  let ok = 0;
  for (const script of scripts) {
    const driverFactory = makeVoiceQualityDriverFactory(script, 'record');
    const gatewayFactory = () => buildCassetteGatewayForScript(script, 'record');
    try {
      await runScript(script, {
        driverFactory,
        repoMode: 'memory',
        cassetteMode: 'record',
        gatewayFactory,
      });
      ok++;
      console.log(`recorded: ${script.id}`);
    } catch (err) {
      console.error(`failed: ${script.id}`, err);
      process.exit(1);
    }
  }

  console.log(`Seeded ${ok}/${scripts.length} cassettes.`);
}

/**
 * Run the real refresh mechanism (`npm run voice-quality:refresh`'s own
 * command — `vitest run -c vitest.voice-quality.config.ts` with
 * `VOICE_QUALITY_CASSETTE_MODE=refresh`) as a subprocess, then prune every
 * touched, non-layer2 cassette down to entries (re)written during that
 * pass. `cutoffIso` is captured BEFORE the subprocess runs, per
 * `pruneEntriesBefore`'s contract.
 */
function pruneCorpus(): void {
  const cutoffIso = new Date().toISOString();
  console.log(`Refreshing (cutoff ${cutoffIso}) via: vitest run -c vitest.voice-quality.config.ts`);
  execFileSync('npx', ['vitest', 'run', '-c', 'vitest.voice-quality.config.ts'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, VOICE_QUALITY_CASSETTE_MODE: 'refresh' },
    stdio: 'inherit',
  });

  const scripts = loadCorpus().filter((s) => !s.layer2Only);
  const cassettesDir = defaultCassettesDir();
  let totalPruned = 0;
  let filesTouched = 0;
  for (const script of scripts) {
    const file = path.join(cassettesDir, `${script.id}.json`);
    if (!fs.existsSync(file)) continue;
    const cassette = JSON.parse(fs.readFileSync(file, 'utf-8')) as CassetteFile;
    const { kept, pruned } = pruneEntriesBefore(cassette.entries, cutoffIso);
    if (pruned.length === 0) continue;
    // Same serialization CassetteLLMGateway.writeCassette uses (no trailing
    // newline) — keeps a --prune run's diff limited to the removed
    // entries, not a gratuitous formatting change.
    fs.writeFileSync(file, JSON.stringify({ ...cassette, entries: kept }, null, 2), 'utf-8');
    totalPruned += pruned.length;
    filesTouched++;
    console.log(`pruned ${pruned.length} superseded entr${pruned.length === 1 ? 'y' : 'ies'}: ${script.id}`);
  }
  console.log(`Pruned ${totalPruned} superseded entries across ${filesTouched} cassette(s).`);
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes('--prune')) {
    pruneCorpus();
    return;
  }
  await seed();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
