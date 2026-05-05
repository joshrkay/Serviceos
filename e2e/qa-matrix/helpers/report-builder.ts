import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { MATRIX, type MatrixRow } from '../matrix';
import { artifactRoot, runRoot, type RowManifest, type Verdict } from './evidence';
import { redactUnknown, scanForSecrets, fingerprint } from './redaction';

/**
 * Agent D — Evidence Assembler.
 * Invoked by Playwright globalTeardown (see playwright.config.ts, QA_MATRIX=1).
 * Walks qa/reports/<run>/artifacts/<row-id>/manifest.json for every row and
 * emits QA-REPORT.md with a summary table, per-row detail, and backlog.
 */
export default async function buildReport(): Promise<void> {
  const runDir = runRoot();
  const artDir = artifactRoot();

  if (!existsSync(artDir)) {
    console.warn(`[qa-matrix] No artifacts directory at ${artDir}. Nothing to assemble.`);
    return;
  }

  const manifests = loadManifests(artDir);
  const md = renderReport(manifests, runDir, artDir);
  const outPath = join(runDir, 'QA-REPORT.md');
  writeFileSync(outPath, md);
  console.log(`[qa-matrix] Report written → ${outPath}`);
}

interface AssembledRow {
  row: MatrixRow;
  manifest?: RowManifest;
}

function loadManifests(artDir: string): AssembledRow[] {
  const existingDirs = new Set(readdirSync(artDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name));

  return MATRIX.map((row) => {
    if (!existingDirs.has(row.id)) return { row };
    const path = join(artDir, row.id, 'manifest.json');
    if (!existsSync(path)) return { row };
    try {
      const raw = readFileSync(path, 'utf8');
      const manifest = JSON.parse(raw) as RowManifest;
      return { row, manifest };
    } catch (err) {
      console.warn(`[qa-matrix] Could not parse manifest for ${row.id}: ${(err as Error).message}`);
      return { row };
    }
  });
}

function renderReport(rows: AssembledRow[], runDir: string, artDir: string): string {
  const commit = safe(() => execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim());
  const branch = safe(() => execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim());
  const timestamp = new Date().toISOString();

  const summary = rows.map((r) => ({
    id: r.row.id,
    module: r.row.module,
    feature: r.row.feature,
    verdict: r.manifest?.verdict ?? 'fail',
    reason: r.manifest?.failureReason ?? (r.manifest ? '' : 'no manifest (test did not run or crashed)'),
  }));

  const counts: Record<Verdict, number> = { pass: 0, fail: 0, partial: 0, na: 0 };
  for (const s of summary) counts[s.verdict as Verdict]++;

  const lines: string[] = [];
  lines.push('# QA Matrix Report');
  lines.push('');
  lines.push('## Run metadata');
  lines.push('');
  lines.push(`- Timestamp: ${timestamp}`);
  lines.push(`- Env: ${process.env.E2E_BASE_URL ?? '(local)'} (API: ${process.env.E2E_API_URL ?? '(local)'})`);
  lines.push(`- Branch: ${branch ?? '(unknown)'}`);
  lines.push(`- Commit: ${commit ?? '(unknown)'}`);
  const tenantMeta = redactUnknown({ a: process.env.E2E_TENANT_A_ID, b: process.env.E2E_TENANT_B_ID }) as { a?: string; b?: string };
  lines.push(`- Tenants: A=${tenantMeta.a ?? '(unset)'}, B=${tenantMeta.b ?? '(unset)'}`);
  lines.push('');
  lines.push(`## Summary — ${counts.pass} pass · ${counts.partial} partial · ${counts.fail} fail · ${counts.na} n/a`);
  lines.push('');
  lines.push('| ID | Module | Feature | Verdict | Notes |');
  lines.push('|----|--------|---------|---------|-------|');
  for (const s of summary) {
    lines.push(`| ${s.id} | ${s.module} | ${s.feature} | ${badge(s.verdict as Verdict)} | ${escape(s.reason)} |`);
  }
  lines.push('');

  lines.push('## Per-row detail');
  lines.push('');
  for (const r of rows) {
    lines.push(`### ${r.row.id} — ${r.row.feature}  ${badge((r.manifest?.verdict ?? 'fail') as Verdict)}`);
    lines.push('');
    lines.push(`- **Pass criteria:** ${r.row.passCriteria}`);
    if (r.row.expectedReason) lines.push(`- **Pre-run expectation:** ${r.row.expected} — ${r.row.expectedReason}`);
    if (r.manifest?.failureReason) lines.push(`- **Failure reason:** ${r.manifest.failureReason}`);
    if (r.manifest?.notes?.length) {
      for (const n of r.manifest.notes) lines.push(`- Note: ${n}`);
    }
    if (r.manifest?.artifacts.length) {
      lines.push('- Evidence:');
      for (const a of r.manifest.artifacts) {
        lines.push(`  - ${a.kind.toUpperCase()}: [${a.label}](${relative(runDir, a.path)})`);
      }
    } else {
      lines.push(`- Evidence: *none captured*`);
    }
    lines.push('');
  }

  const fails = rows.filter((r) => (r.manifest?.verdict ?? 'fail') !== 'pass');
  if (fails.length) {
    lines.push('## Backlog (remediation pointers)');
    lines.push('');
    for (const r of fails) {
      const v = r.manifest?.verdict ?? 'fail';
      const reason = r.manifest?.failureReason ?? r.row.expectedReason ?? 'needs investigation';
      lines.push(`- **${r.row.id}** — ${badge(v as Verdict)} — ${reason}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Artifacts root: \`${relative(runDir, artDir)}/\``);
  const report = lines.join('\n');
  const findings = scanForSecrets(report);
  console.log('[qa-matrix:redaction]', { hasReport: true, fp: fingerprint(report), findings: findings.length });
  if (findings.length) throw new Error(`QA report contains non-redacted secrets: ${findings.map((f) => f.name).join(', ')}`);
  return report;
}

function badge(v: Verdict): string {
  switch (v) {
    case 'pass':
      return '**PASS**';
    case 'partial':
      return '**PARTIAL**';
    case 'na':
      return '**N/A**';
    default:
      return '**FAIL**';
  }
}

function escape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}


function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
