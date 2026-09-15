#!/usr/bin/env node
/**
 * Builds the self-contained HTML scoreboard from a rescored results JSON.
 * Pure static HTML/CSS output (no client-side JS, no external deps) — a
 * plain read-only report, one row per corpus capability.
 *
 * The two per-row annotations below (PARTIAL_GROUP, BASELINE_MOVEMENT) are
 * hand-authored from the 2026-08-29 full-sweep review (post-rescore) —
 * they encode analysis that lives in the sweep report, not anything
 * mechanically derivable from the results JSON alone.
 *
 * Usage: node scripts/ai-catalog-sweep/build-scoreboard.mjs <rescored.json> <out.html>
 */
import fs from 'node:fs';
import path from 'node:path';

const srcPath = process.argv[2];
const outPath = process.argv[3];
if (!srcPath || !outPath) {
  console.error('Usage: node build-scoreboard.mjs <rescored.json> <out.html>');
  process.exit(1);
}

const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));

// ── Root-cause group for every non-PASS, non-SKIP row (from the sweep report) ──
const PARTIAL_GROUP = {
  A03: 'Timezone gate', A33: 'Timezone gate',
  A04: 'Chat missing-field gate', A11: 'Chat missing-field gate', A27: 'Chat missing-field gate',
  A13: 'Chat missing-field gate', A14: 'Chat missing-field gate', A15: 'Chat missing-field gate',
  A12: 'Chat missing-field gate', A20: 'Chat missing-field gate', A21: 'Chat missing-field gate',
  A24: 'Chat missing-field gate', A26: 'Chat missing-field gate', A28: 'Chat missing-field gate',
  A29: 'Chat missing-field gate', A31: 'Chat missing-field gate', A41: 'Chat missing-field gate',
  A45: 'Chat missing-field gate',
  A22: 'Execution chain-ref gap', A32: 'Execution chain-ref gap', A37: 'Execution chain-ref gap',
  A48: 'Execution chain-ref gap',
  A19: 'Correct-by-design guard', A07: 'Correct-by-design guard',
  L08: 'Generic-LLM fallthrough', L11: 'Generic-LLM fallthrough', L19: 'Generic-LLM fallthrough',
  R03: 'Generic-LLM fallthrough',
  C02: 'Classification miss (relabeled)',
  A46: 'Voice-session routing miss', A49: 'Voice-session routing miss', A50: 'Voice-session routing miss',
  C01: 'Voice-session routing miss', D01: 'Voice-session routing miss',
  A05: 'Utterance/matcher mismatch',
};

const GROUP_LEGEND = [
  ['Timezone gate', 'QA tenant has no tenant_settings row -> relative-time scheduling honestly refuses (root cause of the appointment-chain stall; fixed for next run in ensureFixtures()).'],
  ['Chat missing-field gate', 'Proposal drafts with a free-text entity reference, not a resolved ID; approveProposal’s missingFieldsFor() guard correctly 400s (confirmed live). Chat has no auto entity-resolution turn the way voice-session’s FSM does.'],
  ['Execution chain-ref gap', 'Approved fine, but the execution handler could not resolve a chain-ref field (invoiceId/jobId) outside of a real proposal chain.'],
  ['Correct-by-design guard', 'The system is working as intended (48h cooldown, missing completed-unbilled-job fixture) — not a capability gap.'],
  ['Generic-LLM fallthrough', 'Request fell through to the general assistant (model ≠ data-lookup) instead of the dedicated lookup skill.'],
  ['Classification miss (relabeled)', 'Investigated and confirmed NOT a refusal — same generic-LLM-fallthrough shape as en_route’s other miss; verdict intentionally left PARTIAL rather than forced to PASS.'],
  ['Voice-session routing miss', 'The in-app voice-session surface did not route to the dedicated handler for this intent.'],
  ['Utterance/matcher mismatch', 'The literal phrase in the utterance did not match the handler’s text matcher.'],
];

// ── July-baseline movement (baseline.md), where a comparable op exists ──
// julyVerdict noted inline for the tooltip; movement is the coordinator's
// four-value column (improved / no-regression / not-in-gate / needs-follow-up).
const BASELINE = {
  A08: ['customer.create', 'implemented'], A24: ['customer.edit', 'implemented'],
  L07: ['customer.lookup', 'implemented'], A16: ['customer.add_note / job.add_note', 'implemented'],
  A29: ['customer.add_service_location', 'partial'], A09: ['job.create', 'implemented'],
  A03: ['job.create_scheduled', 'implemented'], A10: ['job.edit', 'implemented'],
  A11: ['job.reschedule / schedule.move_appointment', 'implemented'], A13: ['job.reassign_tech', 'implemented'],
  A02: ['estimate.create', 'implemented'], A05: ['estimate.edit', 'implemented'],
  A18: ['estimate.send', 'implemented'], A19: ['estimate.follow_up', 'implemented'],
  A01: ['invoice.create', 'implemented'], A04: ['invoice.edit', 'implemented'],
  A17: ['invoice.send', 'implemented'], L02: ['invoice.query_payment_status', 'implemented'],
  A20: ['invoice.send_payment_reminder', 'implemented'], A22: ['invoice.record_manual_payment', 'implemented'],
  L03: ['payment.query_outstanding_balance / reporting.customer_balance', 'implemented'],
  L14: ['schedule.view_today', 'implemented'], L09: ['schedule.check_availability', 'implemented'],
  C01: ['schedule.mark_en_route', 'missing'], A39: ['messaging.send_to_customer', 'missing'],
  L12: ['pricebook.lookup_price', 'partial'], A36: ['pricebook.create_edit_service', 'missing'],
  A44: ['pricebook.create_edit_service', 'missing'], L11: ['reporting.revenue_period', 'implemented'],
  L16: ['reporting.outstanding_invoices', 'implemented'], L04: ['reporting.job_status_query', 'implemented'],
  C08: ['inbound.transfer_to_human', 'implemented'], A30: ['team.clock_in_out', 'partial'],
  L17: ['team.view_tech_schedule', 'missing'],
};

function movementFor(id, adjustedVerdict) {
  const b = BASELINE[id];
  if (!b) return { label: 'not-in-gate', title: 'No comparable op in the July 62-op registry (new capability, control/lookup row, or refusal spot-check).' };
  const [op, july] = b;
  const ok = adjustedVerdict === 'PASS';
  let label;
  if (july === 'implemented') label = ok ? 'no-regression' : 'needs-follow-up';
  else label = ok ? 'improved' : 'needs-follow-up';
  // A19: PARTIAL here is a correct 48h-cooldown guard, not a broken capability
  // (see Correct-by-design guard group) -- the underlying send_estimate_nudge
  // path is proven working by A18/A19's own draft step, so this is not a
  // regression even though the verdict is PARTIAL.
  if (id === 'A19') label = 'no-regression';
  return { label, title: `July: ${op} — ${july}` };
}

function evidenceFor(row) {
  if (row.verdict === 'SKIP') return row.reason;
  if (row.approve && row.approve.status === 'executed' && row.approve.resultEntityId) {
    return `executed → ${row.approve.resultEntityId}`;
  }
  if (typeof row.content === 'string' && row.content.trim().length > 0) {
    const c = row.content.trim();
    return c.length > 160 ? c.slice(0, 157) + '…' : c;
  }
  if (row.approve && row.approve.executionError) return `execution_failed: ${row.approve.executionError}`;
  return row.reason || '';
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const rows = src.results.map((row) => {
  const group = PARTIAL_GROUP[row.id] || '';
  const mv = movementFor(row.id, row.verdict);
  return { ...row, group, movement: mv.label, movementTitle: mv.title, evidence: evidenceFor(row) };
});

const counts = src.counts || {};
const total = rows.length;
const movementCounts = rows.reduce((acc, r) => { acc[r.movement] = (acc[r.movement] || 0) + 1; return acc; }, {});

const verdictClass = { PASS: 'v-pass', PARTIAL: 'v-partial', SKIP: 'v-skip', DEGRADED: 'v-degraded', FAIL: 'v-degraded', BLOCKED: 'v-degraded' };
const movementClass = { improved: 'm-improved', 'no-regression': 'm-noregress', 'not-in-gate': 'm-notingate', 'needs-follow-up': 'm-followup' };

const tableRows = rows
  .map((r) => {
    const vClass = verdictClass[r.verdict] || '';
    const mClass = movementClass[r.movement] || '';
    const groupCell = r.group ? `<span class="group">${esc(r.group)}</span>` : '';
    return `      <tr>
        <td class="id">${esc(r.id)}</td>
        <td>${esc(r.intent)}</td>
        <td class="surface">${esc(r.surface)}</td>
        <td class="expected">${esc(r.expectedOutcome)}</td>
        <td><span class="verdict ${vClass}">${esc(r.verdict)}</span>${groupCell}</td>
        <td class="evidence">${esc(r.evidence)}</td>
        <td><span class="movement ${mClass}" title="${esc(r.movementTitle)}">${esc(r.movement)}</span></td>
      </tr>`;
  })
  .join('\n');

const legendRows = GROUP_LEGEND.map(([name, desc]) => `        <li><strong>${esc(name)}</strong> — ${esc(desc)}</li>`).join('\n');

const generatedAt = new Date().toISOString();

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Capability Catalog — Live Sweep Scoreboard</title>
<style>
  :root {
    --bg: #f7f7f8; --panel: #ffffff; --text: #1b1d1f; --muted: #5b6068; --border: #e2e4e8;
    --pass-bg: #e6f6ea; --pass-fg: #146c2e; --partial-bg: #fff6e0; --partial-fg: #8a5a00;
    --skip-bg: #eceef1; --skip-fg: #565c66; --degraded-bg: #fde8e8; --degraded-fg: #a3241f;
    --improved-bg: #e6f6ea; --improved-fg: #146c2e; --noregress-bg: #eaf1fb; --noregress-fg: #1c4e8a;
    --notingate-bg: #eceef1; --notingate-fg: #565c66; --followup-bg: #fff1e0; --followup-fg: #9a4b00;
    --code-bg: #f0f1f3;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #16181c; --panel: #1e2126; --text: #e7e9ec; --muted: #9aa1ab; --border: #2c313a;
      --pass-bg: #163826; --pass-fg: #6fd08c; --partial-bg: #3a2f10; --partial-fg: #e8bd63;
      --skip-bg: #262a31; --skip-fg: #aab0ba; --degraded-bg: #3a1a1a; --degraded-fg: #f0908c;
      --improved-bg: #163826; --improved-fg: #6fd08c; --noregress-bg: #16283a; --noregress-fg: #86b6ef;
      --notingate-bg: #262a31; --notingate-fg: #aab0ba; --followup-bg: #3a2a10; --followup-fg: #eab06b;
      --code-bg: #23262c;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  header { padding: 24px 28px 18px; border-bottom: 1px solid var(--border); background: var(--panel); }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
  .tallies { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .tally { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; }
  .tally .n { font-size: 18px; font-weight: 700; }
  .tally .l { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  .legend { margin: 10px 0 0; padding-left: 20px; font-size: 13px; }
  .legend li { margin-bottom: 4px; }
  main { padding: 20px 28px 60px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  thead th { position: sticky; top: 0; background: var(--code-bg); text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 10px 12px; border-bottom: 1px solid var(--border); }
  tbody td { padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--code-bg); }
  td.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; white-space: nowrap; }
  td.surface, td.expected { color: var(--muted); white-space: nowrap; }
  td.evidence { max-width: 480px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--text); }
  .verdict { display: inline-block; padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 11px; letter-spacing: .02em; }
  .v-pass { background: var(--pass-bg); color: var(--pass-fg); }
  .v-partial { background: var(--partial-bg); color: var(--partial-fg); }
  .v-skip { background: var(--skip-bg); color: var(--skip-fg); }
  .v-degraded { background: var(--degraded-bg); color: var(--degraded-fg); }
  .group { display: block; margin-top: 3px; font-size: 11px; color: var(--muted); }
  .movement { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; white-space: nowrap; cursor: help; }
  .m-improved { background: var(--improved-bg); color: var(--improved-fg); }
  .m-noregress { background: var(--noregress-bg); color: var(--noregress-fg); }
  .m-notingate { background: var(--notingate-bg); color: var(--notingate-fg); }
  .m-followup { background: var(--followup-bg); color: var(--followup-fg); }
  footer { padding: 18px 28px 40px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--border); }
  footer code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>AI Capability Catalog — Live Sweep Scoreboard</h1>
  <div class="sub">dev (serviceosapi-development.up.railway.app) · ${total} rows · rescored ${esc(src.rescoredAt || generatedAt)} · source: <code>${esc(path.basename(srcPath))}</code></div>
  <div class="tallies">
    <div class="tally"><div class="n">${counts.PASS ?? 0}</div><div class="l">Pass</div></div>
    <div class="tally"><div class="n">${counts.PARTIAL ?? 0}</div><div class="l">Partial</div></div>
    <div class="tally"><div class="n">${counts.SKIP ?? 0}</div><div class="l">Skip (by design)</div></div>
    <div class="tally"><div class="n">${counts.DEGRADED ?? 0}</div><div class="l">Degraded</div></div>
    <div class="tally"><div class="n">${movementCounts['improved'] || 0}</div><div class="l">Improved vs July</div></div>
    <div class="tally"><div class="n">${movementCounts['no-regression'] || 0}</div><div class="l">No regression</div></div>
    <div class="tally"><div class="n">${movementCounts['needs-follow-up'] || 0}</div><div class="l">Needs follow-up</div></div>
  </div>
  <details>
    <summary>Root-cause group legend (PARTIAL rows)</summary>
    <ul class="legend">
${legendRows}
    </ul>
  </details>
</header>
<main>
<table>
  <thead>
    <tr>
      <th>ID</th><th>Intent</th><th>Surface</th><th>Expected</th><th>Verdict</th><th>Evidence</th><th>July movement</th>
    </tr>
  </thead>
  <tbody>
${tableRows}
  </tbody>
</table>
</main>
<footer>
  Generated by <code>scripts/ai-catalog-sweep/build-scoreboard.mjs</code> from <code>${esc(path.basename(srcPath))}</code> (rescored offline from <code>${esc(src.rescoredFrom || '')}</code>, no new LLM calls). Filed issues: {{ISSUES}}
</footer>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log('Wrote', outPath, `(${rows.length} rows)`);
