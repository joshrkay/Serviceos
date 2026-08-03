#!/usr/bin/env npx tsx
/**
 * admin-voice-coverage.ts — gate: ≥90% of day-in-the-life admin tasks are
 * voice-completable against the live speakable catalog.
 *
 *   npx tsx packages/api/scripts/admin-voice-coverage.ts
 *   npx tsx packages/api/scripts/admin-voice-coverage.ts --gate
 *   npx tsx packages/api/scripts/admin-voice-coverage.ts --json
 *   npx tsx packages/api/scripts/admin-voice-coverage.ts --markdown
 *
 * Exit: 0 ok · 1 gate fail · 2 error
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeAdminVoiceCoverage,
  buildSpeakableCatalogFactsFromCode,
  ADMIN_TASK_INVENTORY_VERSION,
} from '../src/ai/voice-quality/admin-tasks';

const argv = process.argv.slice(2);
const gate = argv.includes('--gate');
const asJson = argv.includes('--json');
const asMarkdown = argv.includes('--markdown');

function main(): void {
  const facts = buildSpeakableCatalogFactsFromCode();
  const report = computeAdminVoiceCoverage(facts);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          inventoryVersion: report.inventoryVersion,
          totalTasks: report.totalTasks,
          voiceCompletable: report.voiceCompletable,
          humanOnly: report.humanOnly,
          voiceCompletableRatio: report.voiceCompletableRatio,
          humanOnlyRatio: report.humanOnlyRatio,
          gatePassed: report.gatePassed,
          humanOnlyIds: report.humanOnlyIds,
          brokenSpeakable: report.brokenSpeakable.map((r) => ({
            id: r.task.id,
            reason: r.reason,
          })),
          tasks: report.results.map((r) => ({
            id: r.task.id,
            title: r.task.title,
            mode: r.task.mode,
            humanOnly: r.task.humanOnly,
            voiceCompletable: r.voiceCompletable,
            reason: r.reason,
            criticalPathId: r.task.criticalPathId,
            intents: r.task.intents,
            proposalType: r.resolvedProposalType ?? r.task.proposalType,
          })),
        },
        null,
        2,
      ),
    );
  } else if (asMarkdown) {
    printMarkdown(report);
  } else {
    console.log(`\n📋 Admin voice coverage (inventory v${ADMIN_TASK_INVENTORY_VERSION})\n`);
    for (const line of report.summaryLines) console.log(line);
    console.log('');
  }

  const outPath = process.env.ADMIN_VOICE_COVERAGE_OUT;
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          inventoryVersion: report.inventoryVersion,
          voiceCompletableRatio: report.voiceCompletableRatio,
          humanOnlyRatio: report.humanOnlyRatio,
          gatePassed: report.gatePassed,
          humanOnlyIds: report.humanOnlyIds,
          brokenSpeakable: report.brokenSpeakable.map((r) => r.task.id),
          summaryLines: report.summaryLines,
        },
        null,
        2,
      ),
    );
    console.error(`Wrote ${outPath}`);
  }

  if (gate && !report.gatePassed) {
    console.error(
      `\n❌ admin-voice coverage gate failed: ` +
        `${(report.voiceCompletableRatio * 100).toFixed(1)}% voice-completable ` +
        `(need ≥${(report.minVoiceRatio * 100).toFixed(0)}%), ` +
        `human-only ${(report.humanOnlyRatio * 100).toFixed(1)}% ` +
        `(budget ≤${(report.maxHumanOnlyRatio * 100).toFixed(0)}%)` +
        (report.brokenSpeakable.length
          ? `, broken: ${report.brokenSpeakable.map((r) => r.task.id).join(', ')}`
          : ''),
    );
    process.exit(1);
  }
  if (gate) {
    console.error(
      `\n✅ admin-voice coverage gate passed ` +
        `(${(report.voiceCompletableRatio * 100).toFixed(1)}% voice / ` +
        `${(report.humanOnlyRatio * 100).toFixed(1)}% human-only)`,
    );
  }
}

function printMarkdown(report: ReturnType<typeof computeAdminVoiceCoverage>): void {
  console.log('# Tradesperson admin tasks — AI voice coverage\n');
  console.log(
    `Inventory **v${report.inventoryVersion}** · ` +
      `**${(report.voiceCompletableRatio * 100).toFixed(1)}%** voice-completable ` +
      `(${report.voiceCompletable}/${report.totalTasks}) · ` +
      `human-only **${(report.humanOnlyRatio * 100).toFixed(1)}%** ` +
      `([${report.humanOnlyIds.join(', ')}]) · Gate: **${report.gatePassed ? 'PASS' : 'FAIL'}**\n`,
  );
  console.log(
    'Product intent: cut admin time via AI voice with **owner approve-in-seconds** ' +
      'for money/comms — not unattended money execution.\n',
  );
  console.log('| Id | Title | Mode | Voice? | Evidence |');
  console.log('|----|-------|------|--------|----------|');
  for (const r of report.results) {
    const v = r.voiceCompletable ? 'yes' : r.task.humanOnly ? 'human-only' : '**NO**';
    console.log(
      `| \`${r.task.id}\` | ${r.task.title.replace(/\|/g, '\\|')} | ${r.task.mode} | ${v} | ${r.reason.replace(/\|/g, '\\|')} |`,
    );
  }
  console.log('');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(2);
}
