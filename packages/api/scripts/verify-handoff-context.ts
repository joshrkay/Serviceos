/**
 * Verify CRM-enriched warm-transfer handoff (in-process).
 *
 * Usage:
 *   npm run verify:handoff-context
 *
 * Seeds a known customer (tags, last completed job, Gold Plan membership,
 * communication notes), fires notify_oncall through the voice-turn processor,
 * and fails if whisper / SMS / panel lack the CRM markers.
 *
 * Does not boot HTTP — exercises the same escalate path Gather + Media Streams
 * share. Exit 0 on pass, 1 on fail.
 */
import { runHandoffContextVerify } from './handoff-context-verify';

async function main(): Promise<void> {
  console.log('Verify handoff context → seeded CRM escalate path');
  const report = await runHandoffContextVerify();
  for (const c of report.verdict.checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(22)} ${c.detail}`);
  }
  if (!report.ok) {
    console.error('\n  FAIL — CRM handoff artifacts incomplete (see checks above)');
    process.exit(1);
  }
  console.log('\n  PASS — whisper/SMS/panel include membership, last service, notes, tags');
  process.exit(0);
}

main().catch((err) => {
  console.error(`  FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
