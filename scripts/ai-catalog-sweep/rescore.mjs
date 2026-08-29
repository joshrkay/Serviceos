#!/usr/bin/env node
/**
 * Offline re-scorer — re-applies corrected honest_refusal/rbac_denied
 * detection to an EXISTING results JSON's already-stored replies. Makes
 * ZERO new network/DB/LLM calls; only recomputes verdict/reason from
 * fields already captured per row (content, model, taskType, httpStatus).
 *
 * Two patterns investigated after the 2026-08-29 full sweep (99 rows):
 *
 * 1. RBAC-refusal copy widened (R01 lookup_revenue, R02 lookup_digest,
 *    R04 lookup_catalog — all technician-token rows expecting rbac_denied).
 *    Their stored replies ("That's an owner-level report. Ask an owner or
 *    dispatcher on your team to pull it up.", "...an office-level view...")
 *    all carry `model: 'data-lookup'` / `taskType: assistant.lookup.*` —
 *    i.e. the request genuinely dispatched to the lookup skill, which
 *    enforced the permission gate and replied in its own words. The
 *    original scorer's regex (permission|don't have access|not
 *    authorized|can't share/show/see) just didn't recognize this phrasing.
 *    Genuine scorer false-negative — corrected here AND in run-sweep.mjs's
 *    live scoring for future runs.
 *
 * 2. C02 (en_route, owner token, honest_refusal expected) was investigated
 *    and is NOT the same pattern, despite looking similar in the original
 *    report. Its `taskType` is `assistant.general` / `model` a plain LLM
 *    id — the identical shape to C01's generic-LLM fallthrough, NOT the
 *    dedicated identity-refusal branch (routes/assistant.ts's en_route
 *    handler replies with `taskType: 'assistant.en_route'`, `model:
 *    'direct-act'`). The content itself ("Make sure to check the job
 *    details, customer preferences... Stay safe on the road!") is generic
 *    en-route advice, not a refusal of any kind. Forcing this to PASS
 *    would misrepresent a real intent-classification miss as a confirmed
 *    refusal, so C02's verdict is deliberately left PARTIAL — only its
 *    `reason` is relabeled here to name the real cause, for report clarity.
 *
 * Usage: node scripts/ai-catalog-sweep/rescore.mjs <results.json>
 */
import fs from 'node:fs';
import path from 'node:path';

const srcPath = process.argv[2];
if (!srcPath) {
  console.error('Usage: node scripts/ai-catalog-sweep/rescore.mjs <results.json>');
  process.exit(1);
}

// Kept in sync by hand with the widened check in run-sweep.mjs's runRow
// (rbac_denied branch) — duplicated rather than imported so this script
// can never accidentally trigger run-sweep.mjs's live main().
const RBAC_REFUSAL_RE =
  /permission|don't have access|not authorized|can't (share|show|see)|owner-level|office-level|ask (an owner|a dispatcher|your owner|your dispatcher)/i;

const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));

let flips = 0;
let relabeled = 0;
const results = src.results.map((row) => {
  if (row.expectedOutcome === 'rbac_denied' && row.verdict !== 'PASS') {
    const contentOk = typeof row.content === 'string' && row.content.length >= 5;
    const isLookupDispatch = row.model === 'data-lookup';
    const matches = contentOk && RBAC_REFUSAL_RE.test(row.content);
    if (row.httpStatus === 403 || (contentOk && isLookupDispatch && matches)) {
      flips += 1;
      return {
        ...row,
        verdict: 'PASS',
        reason: 'rbac_refusal_copy_widened',
        rescoreNote:
          "Widened RBAC-refusal copy match ('owner-level'/'office-level report' phrasing, gated on model==='data-lookup' so a generic-LLM fallthrough using similar words can't false-PASS) — confirmed 2026-08-29 as a genuine lookup-dispatch refusal the original narrow regex missed.",
      };
    }
  }
  if (row.id === 'C02') {
    relabeled += 1;
    return {
      ...row,
      reason: 'generic_llm_fallthrough_not_refusal',
      rescoreNote:
        "Investigated 2026-08-29: taskType 'assistant.general' / a plain chat model — the same shape as C01's generic-LLM fallthrough, NOT the dedicated assistant.en_route identity-refusal branch (taskType 'assistant.en_route', model 'direct-act'). Verdict intentionally left PARTIAL: the content is generic en-route advice, not a refusal of any kind — flipping it to PASS would misrepresent a real classification miss as a confirmed refusal.",
    };
  }
  return row;
});

const counts = {};
const countsByOutcomeClass = {};
for (const r of results) {
  counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  if (r.outcomeClass) countsByOutcomeClass[r.outcomeClass] = (countsByOutcomeClass[r.outcomeClass] || 0) + 1;
}

const out = {
  ...src,
  rescoredFrom: path.basename(srcPath),
  rescoredAt: new Date().toISOString(),
  rescoreSummary: {
    flips,
    relabeled,
    rulesApplied: [
      'rbac_refusal_copy_widened: R01/R02/R04 flipped PARTIAL -> PASS (model===data-lookup + owner-level/office-level copy)',
      'C02: reason relabeled to generic_llm_fallthrough_not_refusal; verdict deliberately left PARTIAL (see rescoreNote)',
    ],
  },
  counts,
  countsByOutcomeClass,
  results,
};

const dir = path.dirname(srcPath);
const base = path.basename(srcPath, '.json');
const outPath = path.join(dir, `${base}-rescored.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log('Rescore flips (PARTIAL -> PASS):', flips);
console.log('Rows relabeled (verdict unchanged):', relabeled);
console.log('Adjusted counts:', counts);
console.log('Adjusted countsByOutcomeClass:', countsByOutcomeClass);
console.log('Wrote', outPath);
