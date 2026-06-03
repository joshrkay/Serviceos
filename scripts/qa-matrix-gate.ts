#!/usr/bin/env tsx
/**
 * Post-run gate enforcement for the QA matrix harness.
 *
 * Reads per-row manifest.json files under qa/reports/<runId>/artifacts/
 * and enforces:
 *   - Voice-Critical hard gate: 20/20 must be pass (partial/fail/na/missing = fail)
 *   - Business-Critical soft gate: ≥27/30 pass (+ up to 3 active exceptions)
 *
 * Usage:
 *   npx tsx scripts/qa-matrix-gate.ts
 *   npx tsx scripts/qa-matrix-gate.ts --run-id 2026-05-27
 *   npx tsx scripts/qa-matrix-gate.ts --voice-only
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUSINESS_CRITICAL_IDS,
  BUSINESS_CRITICAL_MAX_EXCEPTIONS,
  BUSINESS_CRITICAL_MIN_PASS,
  VOICE_CRITICAL_IDS,
} from '../e2e/qa-matrix/gates';
import type { Verdict } from '../e2e/qa-matrix/helpers/evidence';

interface RowManifest {
  id: string;
  verdict: Verdict;
  failureReason?: string;
}

interface GateException {
  rowId: string;
  owner: string;
  ticket: string;
  expiry: string;
  reason?: string;
}

interface ExceptionsFile {
  exceptions: GateException[];
}

function parseArgs(): { runId?: string; voiceOnly: boolean } {
  const args = process.argv.slice(2);
  let runId: string | undefined;
  let voiceOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run-id' && args[i + 1]) {
      runId = args[++i];
    } else if (args[i] === '--voice-only') {
      voiceOnly = true;
    }
  }
  return { runId, voiceOnly };
}

function resolveRunDir(explicitRunId?: string): string {
  const reportsRoot = join(process.cwd(), 'qa', 'reports');
  if (!existsSync(reportsRoot)) {
    throw new Error(`No qa/reports directory found at ${reportsRoot}. Run the matrix first.`);
  }
  if (explicitRunId) {
    const dir = join(reportsRoot, explicitRunId);
    if (!existsSync(dir)) throw new Error(`Report run directory not found: ${dir}`);
    return dir;
  }
  if (process.env.QA_RUN_ID) {
    const dir = join(reportsRoot, process.env.QA_RUN_ID);
    if (existsSync(dir)) return dir;
  }
  const dirs = readdirSync(reportsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  if (dirs.length === 0) throw new Error('No dated report directories under qa/reports/.');
  return join(reportsRoot, dirs[0]);
}

function loadManifests(runDir: string): Map<string, RowManifest> {
  const artDir = join(runDir, 'artifacts');
  const map = new Map<string, RowManifest>();
  if (!existsSync(artDir)) return map;

  for (const entry of readdirSync(artDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(artDir, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as RowManifest;
      map.set(manifest.id, manifest);
    } catch (err) {
      console.warn(`[qa-matrix-gate] Could not parse ${manifestPath}: ${(err as Error).message}`);
    }
  }
  return map;
}

function loadActiveExceptions(today: string): GateException[] {
  const path = join(process.cwd(), 'qa', 'gate-exceptions.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ExceptionsFile;
    const list = parsed.exceptions ?? [];
    if (list.length > BUSINESS_CRITICAL_MAX_EXCEPTIONS) {
      console.error(
        `[qa-matrix-gate] gate-exceptions.json has ${list.length} entries; max ${BUSINESS_CRITICAL_MAX_EXCEPTIONS} allowed.`,
      );
      process.exit(1);
    }
    return list.filter((e) => e.expiry >= today);
  } catch (err) {
    console.error(`[qa-matrix-gate] Invalid gate-exceptions.json: ${(err as Error).message}`);
    process.exit(1);
  }
}

function verdictOf(manifests: Map<string, RowManifest>, id: string): Verdict {
  return manifests.get(id)?.verdict ?? 'fail';
}

function reasonOf(manifests: Map<string, RowManifest>, id: string): string {
  const m = manifests.get(id);
  if (!m) return 'no manifest (test did not run or crashed)';
  return m.failureReason ?? '';
}

function main(): void {
  const { runId, voiceOnly } = parseArgs();
  const runDir = resolveRunDir(runId);
  const manifests = loadManifests(runDir);
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[qa-matrix-gate] Evaluating run: ${runDir}`);
  console.log(`[qa-matrix-gate] Manifests loaded: ${manifests.size}`);

  let exitCode = 0;

  const voiceFails: Array<{ id: string; verdict: Verdict; reason: string }> = [];
  for (const id of VOICE_CRITICAL_IDS) {
    const verdict = verdictOf(manifests, id);
    if (verdict !== 'pass') {
      voiceFails.push({ id, verdict, reason: reasonOf(manifests, id) });
    }
  }

  console.log('');
  console.log('=== Voice-Critical Hard Gate (20/20 pass required) ===');
  const voicePass = VOICE_CRITICAL_IDS.length - voiceFails.length;
  console.log(`Pass: ${voicePass}/${VOICE_CRITICAL_IDS.length}`);
  if (voiceFails.length > 0) {
    exitCode = 1;
    console.error('FAIL — voice-critical rows not passing:');
    for (const f of voiceFails) {
      console.error(`  ${f.id}: ${f.verdict}${f.reason ? ` — ${f.reason}` : ''}`);
    }
  } else {
    console.log('OK — all voice-critical rows passed.');
  }

  if (!voiceOnly) {
    const activeExceptions = loadActiveExceptions(today);
    const exceptionIds = new Set(activeExceptions.map((e) => e.rowId));

    let businessPass = 0;
    let businessWaived = 0;
    const businessFails: Array<{ id: string; verdict: Verdict }> = [];
    for (const id of BUSINESS_CRITICAL_IDS) {
      const verdict = verdictOf(manifests, id);
      if (verdict === 'pass') {
        businessPass++;
      } else if (exceptionIds.has(id)) {
        businessWaived++;
      } else {
        businessFails.push({ id, verdict });
      }
    }

    const effective = businessPass + businessWaived;

    console.log('');
    console.log('=== Business-Critical Soft Gate (≥27/30 pass) ===');
    console.log(`Pass: ${businessPass}/${BUSINESS_CRITICAL_IDS.length}`);
    console.log(`Waived (active exceptions): ${businessWaived} (max ${BUSINESS_CRITICAL_MAX_EXCEPTIONS})`);
    console.log(`Effective (pass + waivers): ${effective}/${BUSINESS_CRITICAL_MIN_PASS} required`);

    if (effective < BUSINESS_CRITICAL_MIN_PASS) {
      exitCode = 1;
      console.error('FAIL — business-critical threshold not met.');
      for (const f of businessFails.slice(0, 15)) {
        console.error(`  ${f.id}: ${f.verdict}`);
      }
      if (businessFails.length > 15) {
        console.error(`  ... and ${businessFails.length - 15} more`);
      }
    } else {
      console.log('OK — business-critical threshold met.');
    }

    const expiredPath = join(process.cwd(), 'qa', 'gate-exceptions.json');
    if (existsSync(expiredPath)) {
      const all = (JSON.parse(readFileSync(expiredPath, 'utf8')) as ExceptionsFile).exceptions ?? [];
      const expired = all.filter((e) => e.expiry < today);
      if (expired.length > 0) {
        console.warn(`[qa-matrix-gate] Note: ${expired.length} expired exception(s) in gate-exceptions.json (ignored).`);
      }
    }
  }

  process.exit(exitCode);
}

main();
