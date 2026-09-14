#!/usr/bin/env node
/**
 * Render the in-app 50-case register (fixtures/voice/inapp-50-cases.json) as
 * the human-readable register + severity map:
 *   docs/verification-runs/inapp-50/REGISTER.md
 *
 * The JSON is the source of truth (the hermetic harness and the live probe
 * both load it); this document is generated so the two can never drift.
 *
 * Usage: node scripts/inapp-50/build-register-doc.mjs [--out <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const REGISTER = path.join(ROOT, 'fixtures/voice/inapp-50-cases.json');
const DEFAULT_OUT = path.join(ROOT, 'docs/verification-runs/inapp-50/REGISTER.md');

const SEVERITY_ORDER = ['critical', 'core', 'growth'];
const CLUSTER_LABEL = {
  scheduling: 'Scheduling (booking / reschedule / cancel / confirm / delay)',
  search: 'Search & status lookup',
  confirmations: 'Confirmations & recovery (duplicate / noisy turns)',
  estimates: 'Estimates & quote acceptance',
  invoices: 'Invoice actions',
  customers: 'Customers & leads',
  jobs: 'Jobs',
  dispatch: 'Dispatch handoff & emergency',
};

function describeExpect(expect) {
  switch (expect.outcome) {
    case 'proposal': {
      const bits = [`\`${expect.proposalType}\` proposal`];
      if (expect.status) bits.push(`status \`${expect.status}\``);
      if (expect.payloadContains) bits.push(`payload has ${Object.keys(expect.payloadContains).map((k) => `\`${k}\``).join(', ')}`);
      if (expect.missingFieldsContains) bits.push(`gated on ${expect.missingFieldsContains.map((k) => `\`${k}\``).join(', ')}`);
      if (expect.proposalCount !== undefined) bits.push(`exactly ${expect.proposalCount} proposal(s)`);
      if (expect.requireClarificationTurn) bits.push('after ONE which-one question');
      return bits.join(', ');
    }
    case 'lookup_answer':
      return 'spoken answer from the shared lookup dispatch, no proposal, session stays ready';
    case 'clarification_question':
      return 'spoken which-one question, no proposal, no silent guess';
    case 'not_found':
      return 'honest spoken not-found, no proposal, no on-call page';
    case 'direct_act':
      return 'audited direct act (en-route) with spoken confirmation, no proposal';
    case 'escalation':
      return 'immediate escalation with on-call notification';
    case 'guard':
      return 'deterministic guard line (nothing pending), no proposal';
    default:
      return expect.outcome;
  }
}

function esc(s) {
  return String(s).replace(/\|/g, '\\|');
}

export function renderRegisterDoc(register) {
  const cases = register.cases;
  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, cases.filter((c) => c.severity === s)]));
  const clusters = register.clusters ?? [...new Set(cases.map((c) => c.cluster))];

  const lines = [];
  lines.push(`# In-app 50-case register — ${register.version}`);
  lines.push('');
  lines.push(`_Generated from \`fixtures/voice/inapp-50-cases.json\` by \`scripts/inapp-50/build-register-doc.mjs\` — edit the JSON, not this file._`);
  lines.push('');
  lines.push(register.description);
  lines.push('');
  lines.push('## Severity map');
  lines.push('');
  lines.push('| Severity | Cases | Rule |');
  lines.push('|---|---:|---|');
  for (const s of SEVERITY_ORDER) {
    lines.push(`| **${s}** | ${bySeverity[s].length} | ${esc(register.severityRubric?.[s] ?? '')} |`);
  }
  lines.push('');
  lines.push('| Cluster | critical | core | growth | total |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const cl of clusters) {
    const rows = cases.filter((c) => c.cluster === cl);
    const n = (s) => rows.filter((c) => c.severity === s).length;
    lines.push(`| ${CLUSTER_LABEL[cl] ?? cl} | ${n('critical')} | ${n('core')} | ${n('growth')} | ${rows.length} |`);
  }
  lines.push('');
  lines.push('## Release gate');
  lines.push('');
  lines.push('1. `PASS === 50/50` on the hermetic run (`npm run inapp-50:run`).');
  lines.push('2. No **critical** scheduling / search / confirmations case may end `intent_capture_only` (intent detected, nothing minted or answered).');
  lines.push('3. Zero FAIL verdicts (contract violations / exceptions).');
  lines.push('');
  lines.push('`npm run check:inapp-50` evaluates the three rules on `docs/verification-runs/inapp-50/latest.json`.');
  lines.push('');
  lines.push('## The 50 cases');
  lines.push('');
  for (const cl of clusters) {
    const rows = cases.filter((c) => c.cluster === cl);
    if (rows.length === 0) continue;
    lines.push(`### ${CLUSTER_LABEL[cl] ?? cl}`);
    lines.push('');
    lines.push('| # | Key | Sev | Intent | Operator says | Must produce | Fixtures / tags |');
    lines.push('|---:|---|---|---|---|---|---|');
    for (const c of rows) {
      const says = c.turns ? c.turns.map((t) => `“${t}”`).join(' → ') : `“${c.utterance}”`;
      const extra = [
        ...(c.fixtureRefs ?? []),
        ...(c.tags ?? []).map((t) => `#${t}`),
        ...(c.disambiguationFollowUp ? [`follow-up: “${c.disambiguationFollowUp}”`] : []),
      ].join(', ');
      lines.push(`| ${c.id} | \`${c.key}\` | ${c.severity} | \`${c.intent}\` | ${esc(says)} | ${esc(describeExpect(c.expect))} | ${esc(extra)} |`);
    }
    lines.push('');
    const rationales = rows.filter((c) => c.rationale);
    if (rationales.length > 0) {
      for (const c of rationales) lines.push(`- **${c.key}** — ${c.rationale}`);
      lines.push('');
    }
  }
  lines.push('## Themes → cases');
  lines.push('');
  const themes = [
    ['Booking', ['book-01', 'book-02', 'book-03', 'book-04', 'book-05']],
    ['Rescheduling', ['resched-01']],
    ['Cancellation', ['cancel-01', 'cancel-02']],
    ['Status lookup / search', ['search-01', 'search-02', 'search-03', 'search-04', 'search-05', 'search-06', 'search-07', 'search-08', 'search-09', 'search-10']],
    ['Delay notifications', ['delay-01']],
    ['Confirmations & recovery', ['confirm-01', 'conf-01', 'conf-02', 'conf-03', 'conf-04', 'noise-01', 'noise-02']],
    ['Estimate creation', ['est-01', 'est-02', 'est-03', 'est-04']],
    ['Quote acceptance', ['search-07', 'est-05', 'est-06', 'est-07']],
    ['Invoice actions', ['inv-01', 'inv-02', 'inv-03', 'inv-04', 'inv-05', 'inv-06', 'inv-07', 'inv-08']],
    ['Dispatch handoff', ['reassign-01', 'dispatch-01', 'dispatch-02', 'dispatch-03']],
    ['Customers / jobs', ['cust-01', 'cust-02', 'cust-03', 'job-01', 'job-02']],
  ];
  lines.push('| Theme | Cases |');
  lines.push('|---|---|');
  for (const [theme, keys] of themes) {
    const known = keys.filter((k) => cases.some((c) => c.key === k));
    lines.push(`| ${theme} | ${known.map((k) => `\`${k}\``).join(', ')} |`);
  }
  lines.push('');
  lines.push('**Quote acceptance note.** Acceptance itself is a customer act on the public approval page (`/e/:id`); the operator-side in-app need is the *status* of that acceptance (`search-07`), plus sending (`est-05`), nudging (`est-06`) and recording approved scope changes (`est-07`). There is no `accept_estimate` voice intent on any surface (62-op registry rows 22/23 have no on-ramp); adding one is a follow-up, not a release blocker.');
  lines.push('');
  lines.push('## Harness seeds');
  lines.push('');
  lines.push(`Tenant timezone \`${register.harnessSeeds?.tenantTimezone}\`; fixture catalog \`${register.fixtureCatalog}\`; catalog items: ${(register.harnessSeeds?.catalogItems ?? []).map((i) => `${i.name} ($${(i.unitPriceCents / 100).toFixed(2)})`).join(', ')}. ${register.harnessSeeds?.notes ?? ''}`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : DEFAULT_OUT;
  const register = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderRegisterDoc(register));
  console.log(`wrote ${path.relative(ROOT, out)} (${register.cases.length} cases)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
