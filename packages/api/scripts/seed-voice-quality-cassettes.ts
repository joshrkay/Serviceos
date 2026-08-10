/**
 * Record Layer 1 cassettes for every corpus script using the script-aware
 * mock LLM (no live API keys). Run from packages/api:
 *
 *   npm run voice-quality:seed-cassettes
 *   npm run voice-quality:seed-cassettes -- --prune --dry-run   <-- ALWAYS FIRST
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
 * ── `--dry-run` IS THE REQUIRED FIRST STEP ────────────────────────────────
 *
 * A healthy `--prune` deletes tens of thousands of lines of committed
 * cassette JSON, so never run it blind. `--dry-run` performs the SAME
 * authoritative refresh and the SAME evaluation, prints the per-cassette
 * prune counts, and then writes nothing. Read that list, confirm the
 * numbers look like accretion collapse (many entries removed, at least one
 * KEPT per cassette) rather than wholesale deletion, then re-run without
 * the flag.
 *
 * Note what `--dry-run` does NOT suppress: the refresh subprocess itself
 * rewrites cassette entries exactly as `npm run voice-quality:refresh`
 * does. The flag suppresses the DESTRUCTIVE half (removing entries), which
 * is the half worth previewing.
 *
 * ── Why `--prune` shells out instead of reusing this script's own loop ────
 *
 * `--prune` deliberately does NOT reuse this script's own `record`-mode
 * loop below to establish "what's live" — an earlier version tried exactly
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
 *
 * ── Why the exit code of that subprocess is not trusted ───────────────────
 *
 * `vitest.voice-quality.config.ts` sets `passWithNoTests: true`, so a run
 * whose include-glob matches nothing exits 0 — and `execFileSync` only
 * throws on a NON-zero exit. Trusting it meant include-glob drift read as
 * "refresh succeeded" while nothing ran, after which every entry is
 * pre-cutoff and all 73 cassettes get written empty, with a cheerful
 * "Pruned 1285 superseded entries" and exit 0. The refresh is therefore
 * asserted POSITIVELY, against the JSON report the config already emits
 * (`assertRefreshCovered`), and the whole pipeline is plan-then-apply with
 * a post-prune replay verification and automatic rollback. See
 * `src/ai/voice-quality/cassette-prune.ts` for the full failure-mode list.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { loadCorpus } from '../src/ai/voice-quality/corpus/loader';
import { runScript } from '../src/ai/voice-quality/runner';
import { defaultCassettesDir } from '../src/ai/voice-quality/cassette-gateway';
import {
  applyCassettePrune,
  assertRefreshCovered,
  cassetteCandidates,
  parseSeedCassetteArgs,
  planCassettePrune,
  rollbackCassettePrune,
  type CassettePrunePlan,
} from '../src/ai/voice-quality/cassette-prune';
import {
  buildCassetteGatewayForScript,
  makeVoiceQualityDriverFactory,
} from '../test/voice-quality/voice-quality-driver-factory';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
/** Emitted by vitest.voice-quality.config.ts's `outputFile.json`. */
const REFRESH_REPORT = path.join(PACKAGE_ROOT, 'voice-quality-vitest.json');
const CORPUS_VITEST_ARGS = ['vitest', 'run', '-c', 'vitest.voice-quality.config.ts'];

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

/** Run the corpus suite as a subprocess. Returns true when it exited 0. */
function runCorpusSuite(env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync('npx', CORPUS_VITEST_ARGS, {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the real refresh mechanism as a subprocess, then prune every touched,
 * non-layer2 cassette down to entries (re)written during that pass.
 * `cutoffIso` is captured BEFORE the subprocess runs, per
 * `pruneEntriesBefore`'s contract.
 */
function pruneCorpus(opts: { dryRun: boolean; allowEmptying: boolean }): void {
  const scripts = loadCorpus().filter((s) => !s.layer2Only);
  if (scripts.length === 0) {
    console.error('No corpus scripts found — refusing to prune.');
    process.exit(1);
  }
  const scriptIds = scripts.map((s) => s.id);

  // Remove any leftover report first: `assertRefreshCovered` also rejects a
  // report older than the cutoff, but deleting it means an aborted run can
  // never leave a plausible-looking artifact behind either.
  fs.rmSync(REFRESH_REPORT, { force: true });

  const cutoffIso = new Date().toISOString();
  console.log(`Refreshing (cutoff ${cutoffIso}) via: ${CORPUS_VITEST_ARGS.join(' ')}`);
  const refreshOk = runCorpusSuite({ VOICE_QUALITY_CASSETTE_MODE: 'refresh' });
  if (!refreshOk) {
    console.error('Refresh pass failed — refusing to prune. Fix the corpus first.');
    process.exit(1);
  }
  // Exit code 0 is NOT sufficient (passWithNoTests) — see the module doc
  // comment. Assert the run positively, from its own report.
  assertRefreshCovered(REFRESH_REPORT, scriptIds, cutoffIso);
  console.log(`Refresh verified: ${scriptIds.length}/${scriptIds.length} corpus scripts ran and passed.`);

  const candidates = cassetteCandidates(defaultCassettesDir(), scriptIds);
  // Phase 1 — read and validate EVERY cassette; write nothing. A malformed
  // file or a would-be-emptied cassette aborts here, with nothing on disk
  // changed by the prune.
  const plan = planCassettePrune(candidates, cutoffIso, { allowEmptying: opts.allowEmptying });

  for (const f of plan.files) {
    console.log(
      `${opts.dryRun ? 'would prune' : 'pruned'} ${f.prunedCount} superseded ` +
        `entr${f.prunedCount === 1 ? 'y' : 'ies'} (${f.keptCount} kept): ${f.scriptId}`,
    );
  }
  const verb = opts.dryRun ? 'Would prune' : 'Pruned';
  console.log(
    `${verb} ${plan.totalPruned} superseded entries across ${plan.files.length} cassette(s) ` +
      `(${plan.evaluated} evaluated).`,
  );

  if (opts.dryRun) {
    console.log('--dry-run: no cassette was modified by the prune. Re-run without it to apply.');
    return;
  }
  if (plan.files.length === 0) return;

  // Phase 2 — apply, then PROVE the corpus still replays. A command that
  // deletes tens of thousands of committed lines self-verifies; if strict
  // replay breaks, every file goes back to its exact pre-prune bytes.
  applyCassettePrune(plan);
  console.log('Verifying strict replay against the pruned cassettes...');
  if (!verifyReplay(plan)) {
    process.exit(1);
  }
  console.log('Replay verified — prune kept the corpus green.');
}

function verifyReplay(plan: CassettePrunePlan): boolean {
  // Replay mode: no VOICE_QUALITY_CASSETTE_MODE override, so the suite runs
  // exactly as CI runs it.
  const env: NodeJS.ProcessEnv = { VOICE_QUALITY_CASSETTE_MODE: 'replay' };
  if (runCorpusSuite(env)) return true;
  console.error('');
  console.error('Replay FAILED against the pruned cassettes — rolling back all cassette writes.');
  rollbackCassettePrune(plan);
  console.error(`Rolled back ${plan.files.length} cassette(s) to their pre-prune contents.`);
  console.error('The prune removed entries that are still live. Do not retry blindly:');
  console.error('  1. re-run with --dry-run and read the per-cassette counts,');
  console.error('  2. check `git status` is clean before trusting the rollback.');
  return false;
}

async function main(): Promise<void> {
  const args = parseSeedCassetteArgs(process.argv.slice(2));
  if (args.mode === 'prune') {
    pruneCorpus({ dryRun: args.dryRun, allowEmptying: args.allowEmptying });
    return;
  }
  await seed();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
