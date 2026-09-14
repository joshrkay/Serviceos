#!/usr/bin/env node
/**
 * Re-run the operator top-50 live probe against Development.
 *
 * Case sources (CASES_PATH):
 *   - fixtures/voice/operator-voice-top-50-v2-cases.json  (cases[] — v2 corpus)
 *   - fixtures/voice/operator-voice-top-50-v3-cases.json  (cases[] — v3 corpus)
 *   - fixtures/voice/operator-voice-top-50-v4-cases.json  (cases[] — v4 corpus)
 *   - fixtures/voice/operator-voice-top-50-v5-cases.json  (cases[] — v5 corpus)
 *   - fixtures/voice/operator-voice-top-50-v6-cases.json  (cases[] — v6 corpus)
 *   - docs/verification-runs/operator-voice-50-live-2026-07-20.results.json (legacy results[])
 *   - fixtures/voice/inapp-50-cases.json (cases[] — in-app 50-case register;
 *     also loadable by packages/api/scripts/run-inapp-50.ts's hermetic
 *     harness, so a live run and a hermetic run score one register. Register
 *     cases carry an `expect` block and are scored by scoreRegisterCase, not
 *     scoreVoice — see its doc comment for what's checked vs. `unchecked`.)
 *
 * Auth: HMAC Clerk token (requires CLERK_DEV_HMAC_TOKENS=true on the target
 * host — works on serviceosapi-development today; production rejects HMAC).
 *
 * Usage:
 *   CLERK_SECRET_KEY=sk_… node scripts/probe-operator-voice-50-live.mjs
 *   CASES_PATH=fixtures/voice/operator-voice-top-50-v2-cases.json \
 *     API_URL=https://serviceosapi-development.up.railway.app \
 *     OUT_DIR=/opt/cursor/artifacts/operator-voice-50-v2 \
 *     node scripts/probe-operator-voice-50-live.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATED_CLUSTERS, gateVerdict } from './inapp-50/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_URL = (process.env.API_URL || 'https://serviceosapi-development.up.railway.app').replace(
  /\/$/,
  '',
);
const CASES_PATH =
  process.env.CASES_PATH ||
  path.join(ROOT, 'docs/verification-runs/operator-voice-50-live-2026-07-20.results.json');
const OUT_DIR =
  process.env.OUT_DIR || `/opt/cursor/artifacts/prod-voice-50-rerun-${Date.now()}`;

const TENANT_ID =
  process.env.TENANT_ID || 'b8e2dc0f-04c2-4ba0-9385-0ebcf3168052';
const CLERK_USER_ID =
  process.env.CLERK_USER_ID || 'user_3GZQEdOUZSzhUNn7pb57fW5jKyg';
const ROLE = process.env.ROLE || 'owner';

function mintHmacToken(secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      sub: CLERK_USER_ID,
      sid: `${CLERK_USER_ID}-probe-session`,
      tenant_id: TENANT_ID,
      role: ROLE,
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${API_URL}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

export function scoreAssistant(json, status, expectProposal) {
  if (status === 401 || status === 403) {
    return { verdict: 'BLOCKED', reason: `auth_${status}`, proposalType: null };
  }
  if (status >= 500) {
    return { verdict: 'FAIL', reason: `http_${status}`, proposalType: null };
  }
  const degraded = Boolean(json?.degraded);
  const fallbackStage = json?.fallbackStage ?? null;
  const model = json?.model ?? null;
  const content = json?.message?.content ?? json?.content ?? '';
  // Live assistant nests the card under message.proposal; type is UI label
  // ("Customer") while taskType is often "assistant.create_customer".
  const proposal = json?.message?.proposal ?? json?.proposal ?? null;
  const proposalType =
    proposal?.type ??
    json?.proposalType ??
    json?.proposals?.[0]?.type ??
    null;
  const proposalId = proposal?.id ?? null;
  const proposalStatus = proposal?.status ?? null;
  const taskType = json?.taskType ?? null;
  const missingFields = proposal?.missingFields ?? json?.missingFields ?? [];

  if (degraded || fallbackStage === 'error-envelope' || model === 'fallback') {
    return {
      verdict: 'DEGRADED',
      reason: 'llm_fallback_envelope',
      proposalType: null,
      proposalId: null,
      missingFields,
      degraded: true,
      fallbackStage: fallbackStage || 'error-envelope',
      content: typeof content === 'string' ? content.slice(0, 240) : '',
      model: model || 'fallback',
      taskType,
    };
  }

  const expectNeedle = (expectProposal || '').toLowerCase().replace(/_/g, '');
  const taskNeedle = (taskType || '').toLowerCase().replace(/[._]/g, '');
  const typeNeedle = (proposalType || '').toLowerCase().replace(/[_\s]/g, '');
  const taskMatchesExpect =
    !!expectNeedle &&
    (taskNeedle.includes(expectNeedle) ||
      // create_customer ↔ assistant.create_customer / Customer
      (expectNeedle.includes('customer') && (taskNeedle.includes('customer') || typeNeedle.includes('customer'))) ||
      (expectNeedle.includes('estimate') && (taskNeedle.includes('estimate') || typeNeedle.includes('estimate'))) ||
      (expectNeedle.includes('invoice') && (taskNeedle.includes('invoice') || typeNeedle.includes('invoice'))) ||
      (expectNeedle.includes('job') && (taskNeedle.includes('job') || typeNeedle.includes('job'))) ||
      (expectNeedle.includes('appointment') &&
        (taskNeedle.includes('appointment') ||
          taskNeedle.includes('schedule') ||
          typeNeedle.includes('appointment'))));

  if (proposalId && (!expectProposal || taskMatchesExpect || proposalStatus === 'Pending')) {
    return {
      verdict: 'PASS',
      reason: 'proposal_created',
      proposalType,
      proposalId,
      missingFields,
      degraded: false,
      fallbackStage,
      content: typeof content === 'string' ? content.slice(0, 240) : '',
      model,
      taskType,
    };
  }
  if (proposalId) {
    return {
      verdict: 'PARTIAL',
      reason: expectProposal ? `proposal_${proposalType}_task_${taskType}` : 'proposal_created',
      proposalType,
      proposalId,
      missingFields,
      degraded: false,
      fallbackStage,
      content: typeof content === 'string' ? content.slice(0, 240) : '',
      model,
      taskType,
    };
  }
  // Non-degraded reply without a proposal (clarification / answer / hallucinated apply)
  return {
    verdict: 'PARTIAL',
    reason: 'no_proposal_non_degraded',
    proposalType: null,
    proposalId: null,
    missingFields,
    degraded: false,
    fallbackStage,
    content: typeof content === 'string' ? content.slice(0, 240) : '',
    model,
    taskType,
  };
}

export function scoreVoice(json, status) {
  if (status === 401 || status === 403) {
    return { verdict: 'BLOCKED', reason: `auth_${status}` };
  }
  if (status >= 500 || status === 404 || status === 410) {
    return { verdict: 'FAIL', reason: `http_${status}` };
  }
  const sideEffects = json?.sideEffects ?? [];
  const types = sideEffects.map((s) => s.type);
  const audit = sideEffects.find((s) => s.type === 'audit_log');
  const eventType = audit?.payload?.eventType ?? '';
  const score = audit?.payload?.score;
  const spoken =
    json?.ttsText ||
    sideEffects.find((s) => s.type === 'tts_play')?.payload?.text ||
    '';
  const proposalIds = json?.proposalIds ?? [];
  const state = json?.state ?? null;
  const emergencyAudit = typeof eventType === 'string' && eventType.includes('emergency_dispatch');
  const emergencyOnCall = types.includes('notify_oncall');
  const infrastructureFailure = ['provider', 'quota', 'deadline', 'parse']
    .find((kind) => typeof eventType === 'string' && eventType.includes(kind));

  if (infrastructureFailure) {
    return {
      verdict: 'DEGRADED',
      reason: `voice_classifier_${infrastructureFailure}`,
      state,
      spoken: typeof spoken === 'string' ? spoken.slice(0, 240) : '',
      sideEffectTypes: types,
      httpStatus: status,
      rawSideEffects: sideEffects.slice(0, 6),
    };
  }
  if (emergencyAudit && emergencyOnCall) {
    return {
      verdict: 'PASS',
      reason: 'voice_emergency_oncall',
      state,
      spoken: typeof spoken === 'string' ? spoken.slice(0, 240) : '',
      sideEffectTypes: types,
      httpStatus: status,
      emergencyEvidence: { auditEventType: eventType, onCallNotified: true },
    };
  }
  if (eventType.includes('reprompt') || score === 0) {
    return {
      verdict: 'DEGRADED',
      reason: 'voice_reprompt_low_confidence',
      state,
      spoken: typeof spoken === 'string' ? spoken.slice(0, 240) : '',
      sideEffectTypes: types,
      httpStatus: status,
      rawSideEffects: sideEffects.slice(0, 6),
    };
  }
  if (proposalIds.length > 0) {
    return {
      verdict: 'PASS',
      reason: 'voice_proposal',
      state,
      spoken: typeof spoken === 'string' ? spoken.slice(0, 240) : '',
      sideEffectTypes: types,
      httpStatus: status,
      proposalIds,
    };
  }
  return {
    verdict: 'PARTIAL',
    reason: 'voice_no_proposal',
    state,
    spoken: typeof spoken === 'string' ? spoken.slice(0, 240) : '',
    sideEffectTypes: types,
    httpStatus: status,
  };
}

const INFRA_VOICE_REASONS = new Set([
  'voice_classifier_provider',
  'voice_classifier_deadline',
  'voice_classifier_quota',
  'voice_classifier_parse',
]);

const INFRA_ERROR_CODES = new Set([
  'LLM_PROVIDER_UNAVAILABLE',
  'BREAKER_OPEN',
  'DEADLINE_EXCEEDED',
  'PRIMARY_PROVIDER_UNAVAILABLE',
  'ALL_PROVIDERS_FAILED',
]);

/**
 * Bucket a non-PASS voice result into infra (A) vs product (B).
 * PASS / BLOCKED-from-skip are not failures — callers should filter first.
 */
export function classifyVoiceFailureBucket(voiceResult) {
  if (!voiceResult || voiceResult.verdict === 'PASS') return null;

  const reason = voiceResult.reason ?? '';
  const raw = voiceResult.rawSideEffects ?? [];
  let errorCode;
  let auditEventType;
  let providerPath;
  for (const effect of raw) {
    const payload = effect?.payload ?? {};
    if (payload.errorCode && !errorCode) errorCode = payload.errorCode;
    if (payload.eventType && !auditEventType) auditEventType = payload.eventType;
    if (Array.isArray(payload.providerPath) && !providerPath) {
      providerPath = payload.providerPath;
    }
  }

  const infraReason = INFRA_VOICE_REASONS.has(reason);
  const infraCode = errorCode && INFRA_ERROR_CODES.has(errorCode);
  const infraAudit =
    typeof auditEventType === 'string' &&
    (auditEventType.includes('classifier_provider') ||
      auditEventType.includes('classifier_deadline') ||
      auditEventType.includes('classifier_quota') ||
      auditEventType.includes('classifier_parse'));
  const authOrHttp =
    reason.startsWith('auth_') ||
    reason.startsWith('http_') ||
    reason === 'session_create_401';

  if (infraReason || infraCode || infraAudit || authOrHttp) {
    return {
      bucket: 'A',
      reason,
      errorCode: errorCode ?? null,
      auditEventType: auditEventType ?? null,
      providerPath: providerPath ?? null,
    };
  }

  return {
    bucket: 'B',
    reason,
    errorCode: errorCode ?? null,
    auditEventType: auditEventType ?? null,
    providerPath: providerPath ?? null,
  };
}

/**
 * Summarize probe results into infra (A) vs product (B) failure counts.
 * @param {Array<{ id?: number, voice?: object }>} results
 */
export function buildFailureTaxonomy(results) {
  const cases = [];
  let A = 0;
  let B = 0;
  for (const row of results ?? []) {
    const voice = row.voice;
    if (!voice || voice.verdict === 'PASS') continue;
    // voice_only_skipped assistant BLOCKED is irrelevant; taxonomy is voice-only
    const classified = classifyVoiceFailureBucket(voice);
    if (!classified) continue;
    if (classified.bucket === 'A') A += 1;
    else B += 1;
    cases.push({
      id: row.id,
      op: row.op,
      verdict: voice.verdict,
      ...classified,
    });
  }
  return { A, B, cases };
}

function bump(counts, verdict) {
  counts[verdict] = (counts[verdict] || 0) + 1;
}

// ── Register scoring (fixtures/voice/inapp-50-cases.json) ──────────────────
//
// scoreVoice() (above) treats ANY proposal as PASS and any no-proposal turn
// as PARTIAL — fine for the legacy v2–v6 corpora (whose only expectation is
// "did *a* proposal come back"), wrong for the register: read-only lookups,
// honest not-found cases, guards, escalation and the direct-act case all
// expect ZERO proposals, and several proposal cases carry expectations
// (proposalCount, forbidSideEffects, allowedStates, stateAfterTurn, …) that
// scoreVoice never looks at. scoreRegisterCase mirrors the outcome/verdict
// rules in packages/api/src/ai/voice-quality/inapp-50/score.ts
// (evaluateExpectations) restricted to what POST /api/voice/sessions/:id/input
// actually returns: `{ state, sideEffects, ttsText, proposalIds, ended,
// trace }`. Fields the live route cannot answer — requireAuditEvents,
// payloadContains, payloadHas, missingFieldsContains, scheduledStartWeekday,
// status — are reported in the result's `unchecked` array rather than
// silently treated as passed.
//
// Not checked at all (not even as `unchecked`): expect.proposalType exact
// match. The task this module was built to fix only asks for the
// forbidProposalTypes NEGATIVE check (no forbidden type minted), which the
// live route can answer via `trace.proposalType` on the minting turn; a
// POSITIVE match against the expected type would need the same field and
// was intentionally left out of scope — see the "known gaps" note in the
// module doc comment above.

const LIVE_UNCHECKED_EXPECT_FIELDS = [
  'requireAuditEvents',
  'payloadContains',
  'payloadHas',
  'missingFieldsContains',
  'scheduledStartWeekday',
  'status',
];

function turnSideEffects(turn) {
  return turn?.json?.sideEffects ?? [];
}

function turnSideEffectTypes(turn) {
  return turnSideEffects(turn).map((e) => e.type);
}

function auditSuffixLive(event) {
  return typeof event === 'string' ? (event.split('.').slice(-1)[0] ?? event) : event;
}

function turnAuditEventTypes(turn) {
  return turnSideEffects(turn)
    .filter((e) => e.type === 'audit_log')
    .map((e) => (typeof e.payload?.eventType === 'string' ? e.payload.eventType : ''));
}

function turnSpoken(turn) {
  return (
    turn?.json?.ttsText ||
    turnSideEffects(turn).find((e) => e.type === 'tts_play')?.payload?.text ||
    ''
  );
}

function lastSpokenLive(turns) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const spoken = turnSpoken(turns[i]);
    if (spoken) return spoken;
  }
  return '';
}

function allSpokenLive(turns) {
  return turns.map(turnSpoken).filter(Boolean).join('\n');
}

function spokenHaystackLive(turns, anyTurn) {
  return anyTurn ? allSpokenLive(turns) : lastSpokenLive(turns);
}

/** Detect an escalation from turn evidence — mirrors hermetic `escalated()`. */
export function isEscalatedLive(turns) {
  return turns.some((t) => {
    const types = turnSideEffectTypes(t);
    return (
      t.json?.state === 'escalating' ||
      types.includes('notify_oncall') ||
      types.includes('escalate_with_context') ||
      types.includes('notify_tenant_emergency')
    );
  });
}

/** Detect a deliberate deterministic guard — mirrors hermetic `guarded()`. */
export function isGuardedLive(turns) {
  return turns.some((t) =>
    turnAuditEventTypes(t).some((e) => {
      const suffix = auditSuffixLive(e);
      return suffix === 'confirm_without_pending' || suffix === 'language_switched';
    }),
  );
}

/**
 * Detect a spoken lookup answer without an FSM dispatch — mirrors hermetic
 * `answered()`'s third shape (the other two, `lookup_executed` bus events and
 * `entity_not_found_operator`, are covered directly below). The live route
 * carries no busEventTypes or per-turn classifiedIntent, so this uses the
 * probe case's own `intent` (the register's single scripted intent for the
 * whole case) in place of a per-turn classified intent, and assumes the
 * session's pre-turn-1 state is `intent_capture` (true for every in-app
 * owner session — see transitions.ts `identifying`/`ask_caller` →
 * `intent_capture`).
 */
export function isAnsweredLive(probeCase, turns) {
  const intent = probeCase?.intent ?? '';
  return turns.some((t, i) => {
    if (turnAuditEventTypes(t).some((e) => auditSuffixLive(e) === 'entity_not_found_operator')) {
      return true;
    }
    const before = i === 0 ? 'intent_capture' : turns[i - 1].json?.state;
    return (
      turnSideEffectTypes(t).includes('tts_play') &&
      turnAuditEventTypes(t).length === 0 &&
      (t.json?.proposalIds?.length ?? 0) === 0 &&
      t.json?.state === before &&
      intent.startsWith('lookup_')
    );
  });
}

const LIVE_STAGE_LADDER = [
  'none',
  'intent_detected',
  'clarification_asked',
  'confirmation_asked',
  'proposal_created',
  'committed',
];

function liveStageIndex(stage) {
  const i = LIVE_STAGE_LADDER.indexOf(stage);
  return i < 0 ? -1 : i;
}

/**
 * Furthest stage reached, derived only from turn states, audit eventTypes
 * and proposalIds — the evidence the live route actually returns. Mirrors
 * `deriveStage` in packages/api/src/ai/voice-quality/inapp-50/score.ts, minus
 * `entities_resolved` (folded into `intent_detected` here; the register's
 * gate rules never key on that stage specifically).
 */
export function deriveLiveStage(probeCase, turns) {
  if (turns.length === 0) return 'none';

  let best = 'none';
  const raise = (stage) => {
    if (liveStageIndex(stage) > liveStageIndex(best)) best = stage;
  };

  turns.forEach((t, i) => {
    const audits = turnAuditEventTypes(t);
    if (audits.some((e) => auditSuffixLive(e) === 'intent_classified')) raise('intent_detected');
    if (audits.some((e) => ['entity_ambiguous', 'entity_confirm_candidate'].includes(auditSuffixLive(e)))) {
      raise('clarification_asked');
    }
    const before = i === 0 ? 'intent_capture' : turns[i - 1].json?.state;
    if (t.json?.state === 'intent_confirm' || before === 'intent_confirm') raise('confirmation_asked');
    if ((t.json?.proposalIds?.length ?? 0) > 0) raise('proposal_created');
    if (
      audits.some((e) => auditSuffixLive(e) === 'proposal_queued') ||
      (t.json?.state === 'closing' && (t.json?.proposalIds?.length ?? 0) > 0)
    ) {
      raise('committed');
    }
  });

  if (isEscalatedLive(turns)) return 'escalated';
  if (liveStageIndex(best) < liveStageIndex('proposal_created') && isAnsweredLive(probeCase, turns)) {
    return 'answered';
  }
  if (liveStageIndex(best) <= liveStageIndex('intent_detected') && isGuardedLive(turns)) return 'guarded';
  return best;
}

/**
 * `intent_capture_only` — the same rule the hermetic scorer and
 * scripts/inapp-50/lib.mjs#isIntentCaptureOnly use: furthest stage is one of
 * the three "captured but not acted on" stages, zero proposals, no answer.
 */
export function isIntentCaptureOnlyLive(probeCase, stage, finalProposalCount, turns) {
  return (
    ['intent_detected', 'clarification_asked', 'confirmation_asked'].includes(stage) &&
    finalProposalCount === 0 &&
    !isAnsweredLive(probeCase, turns)
  );
}

/**
 * Per-turn infra classification — same substrings scoreVoice() uses (401/403
 * → BLOCKED, 5xx/404/410 → FAIL, a classifier provider/quota/deadline/parse
 * audit → DEGRADED) so infra verdicts keep identical meaning across both
 * scorers. Returns null when the turn shows no infra signal.
 */
function detectInfraTurnFailure(json, status) {
  if (status === 401 || status === 403) {
    return { verdict: 'BLOCKED', reason: `auth_${status}` };
  }
  if (status >= 500 || status === 404 || status === 410) {
    return { verdict: 'FAIL', reason: `http_${status}` };
  }
  const sideEffects = json?.sideEffects ?? [];
  const audit = sideEffects.find((s) => s.type === 'audit_log');
  const eventType = audit?.payload?.eventType ?? '';
  const infrastructureFailure = ['provider', 'quota', 'deadline', 'parse'].find(
    (kind) => typeof eventType === 'string' && eventType.includes(kind),
  );
  if (infrastructureFailure) {
    return { verdict: 'DEGRADED', reason: `voice_classifier_${infrastructureFailure}` };
  }
  return null;
}

function liveSignals(probeCase, turns) {
  const audits = turns.flatMap((t) => turnAuditEventTypes(t));
  return {
    intentDetected: audits.some((e) => auditSuffixLive(e) === 'intent_classified'),
    classifierFailure: audits.some((e) => /classifier_.*_failure/.test(e)),
    clarificationMinted: turns.some((t) => t.json?.trace?.proposalType === 'voice_clarification'),
    unexpectedEscalation: isEscalatedLive(turns) && probeCase.expect?.outcome !== 'escalation',
    unexpectedGuard: isGuardedLive(turns) && probeCase.expect?.outcome !== 'guard',
  };
}

/**
 * Best-effort root-cause category for a non-PASS register case, using only
 * live-observable evidence. A simplified sibling of `deriveRootCause` in
 * packages/api/src/ai/voice-quality/inapp-50/score.ts — same five categories
 * (intent / slot_capture / proposal_generation / fallback / infra), fewer
 * signals (no resolver `trace.resolution` history, no busEventTypes).
 */
export function deriveLiveRootCause(probeCase, verdict, reason, failures, stage, turns) {
  if (verdict === 'PASS') return null;
  if (verdict === 'BLOCKED' || verdict === 'FAIL' || reason.startsWith('voice_classifier_')) {
    return { category: 'infra', detail: reason };
  }

  const signals = liveSignals(probeCase, turns);
  const failureText = failures.join('; ') || reason;

  if (signals.classifierFailure) {
    return { category: 'intent', detail: `classifier failure audit fired: ${failureText}` };
  }
  if (!signals.intentDetected && stage === 'none') {
    return { category: 'intent', detail: `no intent_classified audit observed — ${failureText}` };
  }
  if (signals.clarificationMinted) {
    return probeCase.expect?.outcome === 'proposal'
      ? {
          category: 'proposal_generation',
          detail: `voice_clarification minted instead of the expected proposal — ${failureText}`,
        }
      : {
          category: 'fallback',
          detail: `dead voice_clarification card for a ${probeCase.expect?.outcome} — ${failureText}`,
        };
  }
  if (signals.unexpectedEscalation) {
    return { category: 'fallback', detail: `unexpected escalation / on-call page — ${failureText}` };
  }
  if (signals.unexpectedGuard) {
    return { category: 'fallback', detail: `unexpected guard fired — ${failureText}` };
  }
  if (failures.some((f) => /no proposal was created/.test(f))) {
    return {
      category: 'proposal_generation',
      detail: `intent captured but nothing was minted — ${failureText}`,
    };
  }
  if (
    failures.some((f) =>
      /no lookup answer|which-one|did not escalate|no guard fired|replaced the direct act|forbidden proposal type/.test(
        f,
      ),
    )
  ) {
    return { category: 'fallback', detail: failureText };
  }
  if (failures.every((f) => /^spoken line (did not match|matched forbidden)/.test(f))) {
    return { category: 'fallback', detail: failureText };
  }
  return { category: 'proposal_generation', detail: failureText };
}

/**
 * Score one register case (fixtures/voice/inapp-50-cases.json — any case
 * with an `expect` block) against the turns runVoiceSessionProbe drove.
 * `turns` is that call's returned `turns[]` array (every turn's raw
 * `{status, json, text}`, in order, including the first).
 *
 * Verdict is PASS when every observable expectation holds, otherwise
 * PARTIAL — except an infra failure on ANY turn (classifier_* audit, 5xx,
 * 401/403), which wins outright and keeps scoreVoice's DEGRADED/FAIL/BLOCKED
 * semantics regardless of what the expectations would otherwise say.
 */
export function scoreRegisterCase(probeCase, turns) {
  const expect = probeCase?.expect ?? {};
  const unchecked = LIVE_UNCHECKED_EXPECT_FIELDS.filter((f) => expect[f] !== undefined);

  for (const turn of turns) {
    const infra = detectInfraTurnFailure(turn.json, turn.status);
    if (infra) {
      const stage = deriveLiveStage(probeCase, turns);
      const finalProposalCount = turns[turns.length - 1]?.json?.proposalIds?.length ?? 0;
      return {
        verdict: infra.verdict,
        reason: infra.reason,
        stage,
        intentCaptureOnly: isIntentCaptureOnlyLive(probeCase, stage, finalProposalCount, turns),
        rootCause: deriveLiveRootCause(probeCase, infra.verdict, infra.reason, [infra.reason], stage, turns),
        proposals: (turns[turns.length - 1]?.json?.proposalIds ?? []).map((id) => ({ id })),
        failures: [infra.reason],
        unchecked,
      };
    }
  }

  const finalTurn = turns[turns.length - 1];
  const finalState = finalTurn?.json?.state ?? null;
  const finalProposalIds = finalTurn?.json?.proposalIds ?? [];
  const failures = [];

  switch (expect.outcome) {
    case 'proposal':
      if (finalProposalIds.length === 0) failures.push('no proposal was created');
      break;
    case 'lookup_answer':
      if (finalProposalIds.length !== 0) failures.push('a proposal was minted for a lookup');
      break;
    case 'clarification_question':
      if (finalProposalIds.length !== 0) {
        failures.push('a proposal was minted instead of a clarification question');
      }
      if (!/more than one|which one|which /i.test(allSpokenLive(turns))) {
        failures.push('no which-one clarification was asked');
      }
      break;
    case 'not_found':
      if (finalProposalIds.length !== 0) failures.push('a proposal was minted for a not-found reference');
      break;
    case 'guard':
      if (!isGuardedLive(turns)) failures.push('no guard fired');
      break;
    case 'direct_act':
      if (finalProposalIds.length !== 0) failures.push('a proposal replaced the direct act');
      break;
    case 'escalation':
      if (!isEscalatedLive(turns)) failures.push('the case did not escalate');
      break;
    default:
      break;
  }

  if (expect.proposalCount !== undefined && finalProposalIds.length !== expect.proposalCount) {
    failures.push(`proposalCount ${finalProposalIds.length} ≠ expected ${expect.proposalCount}`);
  }

  if (expect.forbidProposalTypes) {
    const traceAvailable = turns.some((t) => t.json?.trace !== undefined);
    if (!traceAvailable) {
      unchecked.push('forbidProposalTypes');
    } else {
      const observedTypes = turns.map((t) => t.json?.trace?.proposalType).filter((t) => typeof t === 'string');
      for (const type of expect.forbidProposalTypes) {
        if (observedTypes.includes(type)) {
          failures.push(`forbidden proposal type '${type}' was minted`);
        }
      }
    }
  }

  if (expect.spokenMatches) {
    const hay = spokenHaystackLive(turns, expect.anyTurn);
    if (!new RegExp(expect.spokenMatches, 'i').test(hay)) {
      failures.push(`spoken line did not match /${expect.spokenMatches}/i: "${hay}"`);
    }
  }
  if (expect.forbidSpoken) {
    const hay = allSpokenLive(turns);
    if (new RegExp(expect.forbidSpoken, 'i').test(hay)) {
      failures.push(`spoken line matched forbidden /${expect.forbidSpoken}/i`);
    }
  }

  const seenSideEffects = new Set(turns.flatMap((t) => turnSideEffectTypes(t)));
  for (const fx of expect.requireSideEffects ?? []) {
    if (!seenSideEffects.has(fx)) failures.push(`required side effect '${fx}' never fired`);
  }
  for (const fx of expect.forbidSideEffects ?? []) {
    if (seenSideEffects.has(fx)) failures.push(`forbidden side effect '${fx}' fired`);
  }

  if (expect.allowedStates && !expect.allowedStates.includes(finalState)) {
    failures.push(`final state '${finalState}' ∉ [${expect.allowedStates.join(', ')}]`);
  }

  if (expect.stateAfterTurn) {
    for (const [turnKey, wanted] of Object.entries(expect.stateAfterTurn)) {
      const turn = turns[Number(turnKey) - 1];
      if (!turn) failures.push(`turn ${turnKey} was never sent`);
      else if (turn.json?.state !== wanted) {
        failures.push(`state after turn ${turnKey} = '${turn.json?.state}' ≠ '${wanted}'`);
      }
    }
  }

  if (expect.requireClarificationTurn) {
    const followUp = resolveProbeDisambiguationFollowUp(probeCase);
    const sent = Boolean(
      followUp &&
        turns.some(
          (t, i) => i > 0 && t.text === followUp && turns[i - 1]?.json?.state === 'entity_resolution',
        ),
    );
    if (!sent) failures.push('no disambiguation follow-up was asked for (and answered)');
  }

  const stage = deriveLiveStage(probeCase, turns);
  const intentCaptureOnly = isIntentCaptureOnlyLive(probeCase, stage, finalProposalIds.length, turns);
  const verdict = failures.length === 0 ? 'PASS' : 'PARTIAL';
  const reason = failures[0] ?? `${expect.outcome}:${stage}`;

  return {
    verdict,
    reason,
    stage,
    intentCaptureOnly,
    rootCause: deriveLiveRootCause(probeCase, verdict, reason, failures, stage, turns),
    proposals: finalProposalIds.map((id) => ({ id })),
    failures,
    unchecked,
  };
}

/** True when a loaded probe case is a register case (carries an `expect` block). */
export function isRegisterProbeCase(probeCase) {
  return probeCase != null && typeof probeCase.expect === 'object' && probeCase.expect !== null;
}

/**
 * Build one `cases[]` row shaped like the hermetic run artifact (see
 * docs/plans/2026-09-09-inapp-50-cases-plan.md "Run artifact") so
 * scripts/inapp-50/build-dashboard.mjs and scripts/inapp-50/triage-report.mjs
 * can consume a live register run the same way they consume a hermetic one.
 */
export function buildRegisterCaseRow(probeCase, score) {
  return {
    key: probeCase.key ?? `case-${probeCase.id}`,
    cluster: probeCase.cluster ?? null,
    severity: probeCase.severity ?? null,
    verdict: score.verdict,
    reason: score.reason,
    stage: score.stage,
    rootCause: score.rootCause,
    proposals: score.proposals,
    unchecked: score.unchecked,
  };
}

/**
 * Summarize a register run's `cases[]` rows via the SAME gate rules the
 * hermetic harness uses (scripts/inapp-50/lib.mjs#gateVerdict) — imported,
 * not reimplemented, so a live run and a hermetic run can never disagree on
 * what "release-ready" means. `register` is the raw parsed register JSON
 * (fixtures/voice/inapp-50-cases.json) so rule 1 (PASS === 50) and rule 2's
 * cluster lookup use the register as ground truth, not the run's own copy.
 */
export function summarizeRegisterRun(caseRows, register) {
  return gateVerdict({ cases: caseRows }, register);
}

/** List of critical scheduling/search/confirmations cases stuck intent_capture_only. */
function gatedIntentCaptureOnlyKeys(gate, caseRows) {
  const byKey = new Map(caseRows.map((c) => [c.key, c]));
  return gate.summary.intentCaptureOnlyCritical.filter((key) =>
    GATED_CLUSTERS.includes(byKey.get(key)?.cluster),
  );
}

/**
 * Markdown block for a register run: per-cluster table, per-severity table,
 * the critical scheduling/search/confirmations intent-capture-only list, and
 * a gate line — the same three rules scripts/inapp-50/lib.mjs#gateVerdict
 * checks against the hermetic artifact.
 */
export function renderRegisterSummaryMarkdown(gate, caseRows) {
  const s = gate.summary;
  const verdictRow = (counts) =>
    `${counts.PASS} | ${counts.PARTIAL} | ${counts.DEGRADED} | ${counts.FAIL}`;

  const clusterRows = Object.entries(s.byCluster)
    .map(([cluster, counts]) => `| ${cluster} | ${verdictRow(counts)} |`)
    .join('\n');
  const severityRows = Object.entries(s.bySeverity)
    .map(([severity, counts]) => `| ${severity} | ${verdictRow(counts)} |`)
    .join('\n');
  const gatedKeys = gatedIntentCaptureOnlyKeys(gate, caseRows);

  return [
    '### Register — per cluster',
    '',
    '| Cluster | PASS | PARTIAL | DEGRADED | FAIL |',
    '|---|---:|---:|---:|---:|',
    clusterRows || '| (none) | 0 | 0 | 0 | 0 |',
    '',
    '### Register — per severity',
    '',
    '| Severity | PASS | PARTIAL | DEGRADED | FAIL |',
    '|---|---:|---:|---:|---:|',
    severityRows || '| (none) | 0 | 0 | 0 | 0 |',
    '',
    '**Critical scheduling/search/confirmations cases stuck `intent_capture_only`:** ' +
      (gatedKeys.length ? gatedKeys.map((k) => `\`${k}\``).join(', ') : 'none'),
    '',
    `**Gate:** ${gate.pass ? 'PASS' : 'FAIL'}` + (gate.pass ? '' : ` — ${gate.reasons.join('; ')}`),
  ].join('\n');
}

/** Default Smith fixture follow-up when a case is tagged ambiguous-name. */
export const DEFAULT_AMBIGUOUS_NAME_FOLLOW_UP = '104 Cedar';

/**
 * Resolve the follow-up utterance for an ambiguous entity-resolution turn.
 * Explicit `disambiguationFollowUp` on the case wins; ambiguous-name tags fall
 * back to the QA Smith fixture address hint.
 */
export function resolveProbeDisambiguationFollowUp(probeCase) {
  if (typeof probeCase.disambiguationFollowUp === 'string') {
    return probeCase.disambiguationFollowUp;
  }
  if (Array.isArray(probeCase.tags) && probeCase.tags.includes('ambiguous-name')) {
    return DEFAULT_AMBIGUOUS_NAME_FOLLOW_UP;
  }
  return null;
}

/** Hard cap on turns a single probe case may drive (register + legacy). */
const MAX_PROBE_TURNS = 6;

/**
 * Drive the in-app voice session through disambiguation and intent
 * confirmation turns when the FSM requires them, and — for register cases
 * (fixtures/voice/inapp-50-cases.json, identified by an `expect` block or a
 * scripted `turns` array) — through the register's own scripted turns first.
 *
 * Legacy corpora (v2–v6: no `expect`, no `turns` array) take the ORIGINAL
 * single-shot code path unchanged, so their behaviour stays byte-identical;
 * only the return value gains a `turns` array (every turn's raw response, in
 * order) alongside the pre-existing fields the legacy callers already read.
 */
export async function runVoiceSessionProbe(apiFn, token, sessionId, probeCase, firstTurn) {
  const followUp = resolveProbeDisambiguationFollowUp(probeCase);
  const isRegisterCase =
    probeCase != null && typeof probeCase.expect === 'object' && probeCase.expect !== null;
  const hasScriptedTurns = Array.isArray(probeCase?.turns) && probeCase.turns.length > 1;

  if (!isRegisterCase && !hasScriptedTurns) {
    // ── Legacy path (v2–v6) — untouched, byte-identical to before ────────
    let voiceDisambiguationTurn;
    let voiceConfirmationTurn;

    if (firstTurn.json?.state === 'entity_resolution' && followUp) {
      voiceDisambiguationTurn = await apiFn('POST', `/api/voice/sessions/${sessionId}/input`, {
        token,
        body: { text: followUp },
      });
    }

    const afterDisambiguation = voiceDisambiguationTurn ?? firstTurn;
    if (afterDisambiguation.json?.state === 'intent_confirm') {
      voiceConfirmationTurn = await apiFn('POST', `/api/voice/sessions/${sessionId}/input`, {
        token,
        body: { text: 'yes' },
      });
    }

    const finalVoiceTurn = voiceConfirmationTurn ?? afterDisambiguation;
    const turns = [firstTurn];
    if (voiceDisambiguationTurn) turns.push(voiceDisambiguationTurn);
    if (voiceConfirmationTurn) turns.push(voiceConfirmationTurn);
    return {
      finalVoiceTurn,
      voiceDisambiguationTurn,
      voiceConfirmationTurn,
      disambiguationFollowUp: followUp,
      turns,
    };
  }

  // ── Register-aware driving ──────────────────────────────────────────────
  // 1. Send the register's remaining scripted turns (turns[0] was already
  //    sent as firstTurn by the caller), always — a scripted script is the
  //    case itself, not an auto follow-up.
  // 2. Then, unless autoConfirm === false, apply the auto follow-ups:
  //    disambiguation → disambiguationFollowUp (once), and
  //    entity_confirm / intent_confirm → "yes" (looped, since a resolved
  //    ambiguity can land in entity_confirm before intent_confirm).
  // Capped at MAX_PROBE_TURNS total turns (including firstTurn).
  const firstText =
    Array.isArray(probeCase?.turns) && probeCase.turns.length > 0
      ? probeCase.turns[0]
      : probeCase?.utterance;
  const turns = [{ ...firstTurn, text: firstText }];
  let voiceDisambiguationTurn;
  let voiceConfirmationTurn;

  const send = async (text) => {
    const raw = await apiFn('POST', `/api/voice/sessions/${sessionId}/input`, {
      token,
      body: { text },
    });
    const turn = { ...raw, text };
    turns.push(turn);
    return turn;
  };

  const scriptedTurns = Array.isArray(probeCase?.turns) ? probeCase.turns : null;
  if (scriptedTurns) {
    for (let i = 1; i < scriptedTurns.length && turns.length < MAX_PROBE_TURNS; i += 1) {
      await send(scriptedTurns[i]);
    }
  }

  if (probeCase?.autoConfirm !== false) {
    let disambiguationSent = false;
    while (turns.length < MAX_PROBE_TURNS) {
      const state = turns[turns.length - 1].json?.state;
      if (state === 'entity_resolution' && followUp && !disambiguationSent) {
        disambiguationSent = true;
        voiceDisambiguationTurn = await send(followUp);
        continue;
      }
      if (state === 'entity_confirm' || state === 'intent_confirm') {
        voiceConfirmationTurn = await send('yes');
        if (voiceConfirmationTurn.json?.state === state) break; // no progress
        continue;
      }
      break;
    }
  }

  const finalVoiceTurn = turns[turns.length - 1];
  return {
    finalVoiceTurn,
    voiceDisambiguationTurn,
    voiceConfirmationTurn,
    disambiguationFollowUp: followUp,
    turns,
  };
}

/**
 * Normalize probe input from either the v2 cases file ({ cases: [...] }), a
 * legacy results artifact ({ results: [...] }), or the in-app 50-case
 * register (fixtures/voice/inapp-50-cases.json — same shape as the v2+
 * corpora plus key/cluster/severity/intent/turns/autoConfirm/expect).
 * Register-only fields are preserved verbatim when present so
 * runVoiceSessionProbe and scoreRegisterCase can drive/score against the
 * register contract; their absence (v2–v6 corpora) leaves every downstream
 * code path byte-identical to before.
 */
export function loadProbeCases(source) {
  const rows = Array.isArray(source?.cases)
    ? source.cases
    : Array.isArray(source?.results)
      ? source.results
      : null;
  if (!rows) {
    throw new Error('CASES_PATH must contain a top-level "cases" or "results" array');
  }
  if (rows.length !== 50) {
    throw new Error(`Expected exactly 50 probe cases, got ${rows.length}`);
  }
  return rows.map((row, index) => {
    const id = row.id ?? index + 1;
    if (typeof row.utterance !== 'string' || row.utterance.trim().length === 0) {
      throw new Error(`Case #${id} is missing utterance`);
    }
    return {
      id,
      cat: row.cat ?? 'unknown',
      op: row.op ?? 'unknown',
      utterance: row.utterance,
      expectProposal: row.expectProposal ?? null,
      ...(Array.isArray(row.fixtureRefs) ? { fixtureRefs: row.fixtureRefs } : {}),
      ...(Array.isArray(row.tags) ? { tags: row.tags } : {}),
      ...(typeof row.disambiguationFollowUp === 'string'
        ? { disambiguationFollowUp: row.disambiguationFollowUp }
        : {}),
      // ── Register-only fields (fixtures/voice/inapp-50-cases.json) ──────
      ...(typeof row.key === 'string' ? { key: row.key } : {}),
      ...(typeof row.cluster === 'string' ? { cluster: row.cluster } : {}),
      ...(typeof row.severity === 'string' ? { severity: row.severity } : {}),
      ...(typeof row.intent === 'string' ? { intent: row.intent } : {}),
      ...(Array.isArray(row.turns) ? { turns: row.turns } : {}),
      ...(typeof row.autoConfirm === 'boolean' ? { autoConfirm: row.autoConfirm } : {}),
      ...(row.expect && typeof row.expect === 'object' ? { expect: row.expect } : {}),
    };
  });
}

export function probeCasesMeta(source, casesPath) {
  if (source?.version && source?.label) {
    return { version: source.version, label: source.label, casesPath };
  }
  return { version: 'v1-legacy', label: '2026-07-20 results artifact', casesPath };
}

async function main() {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) {
    throw new Error('CLERK_SECRET_KEY is required');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const source = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const cases = loadProbeCases(source);
  const corpus = probeCasesMeta(source, CASES_PATH);

  const started = new Date().toISOString();
  const token = mintHmacToken(secret);

  const platform = {};
  for (const [label, url] of [
    ['api_dev_health', 'https://serviceosapi-development.up.railway.app/health'],
    ['api_prod_health', 'https://serviceosapi-production.up.railway.app/health'],
    ['api_target_ai', `${API_URL}/api/health/ai`],
  ]) {
    try {
      const res = await fetch(url);
      platform[label] = { status: res.status, body: (await res.text()).slice(0, 400) };
    } catch (e) {
      platform[label] = { status: 0, body: String(e) };
    }
  }

  const me = await api('GET', '/api/me', { token });
  if (me.status !== 200) {
    console.error('Auth failed /api/me', me.status, me.json);
    process.exit(1);
  }
  console.log('Auth OK tenant=', me.json.tenant_id, 'user=', me.json.user_id);

  const assistantCounts = { PASS: 0, PARTIAL: 0, DEGRADED: 0, FAIL: 0, BLOCKED: 0 };
  const voiceCounts = { PASS: 0, PARTIAL: 0, DEGRADED: 0, FAIL: 0, BLOCKED: 0 };
  const results = [];
  const registerCaseRows = [];

  for (const c of cases) {
    process.stdout.write(`#${c.id} ${c.op}… `);

    const chat = await api('POST', '/api/assistant/chat', {
      token,
      body: {
        messages: [{ role: 'user', content: c.utterance }],
        inputMode: 'text',
      },
    });
    const assistant = {
      httpStatus: chat.status,
      ...scoreAssistant(chat.json, chat.status, c.expectProposal),
    };
    bump(assistantCounts, assistant.verdict);

    const sess = await api('POST', '/api/voice/sessions', { token, body: {} });
    let voice;
    let voiceFirstTurn;
    let voiceConfirmationTurn;
    let voiceDisambiguationTurn;
    if (sess.status !== 201 || !sess.json?.sessionId) {
      voice = {
        verdict: sess.status === 401 || sess.status === 403 ? 'BLOCKED' : 'FAIL',
        reason: `session_create_${sess.status}`,
        httpStatus: sess.status,
      };
      if (isRegisterProbeCase(c)) {
        registerCaseRows.push(
          buildRegisterCaseRow(c, {
            verdict: voice.verdict,
            reason: voice.reason,
            stage: 'none',
            rootCause: { category: 'infra', detail: voice.reason },
            proposals: [],
            unchecked: [],
          }),
        );
      }
    } else {
      voiceFirstTurn = await api('POST', `/api/voice/sessions/${sess.json.sessionId}/input`, {
        token,
        body: { text: c.utterance },
      });
      const voiceTurns = await runVoiceSessionProbe(
        api,
        token,
        sess.json.sessionId,
        c,
        voiceFirstTurn,
      );
      voiceConfirmationTurn = voiceTurns.voiceConfirmationTurn;
      voiceDisambiguationTurn = voiceTurns.voiceDisambiguationTurn;
      const finalVoiceTurn = voiceTurns.finalVoiceTurn;
      // Register cases (an `expect` block) score through scoreRegisterCase,
      // which honours the register's outcome/proposalCount/state/side-effect
      // contract; legacy v2–v6 cases keep the original scoreVoice path
      // ("any proposal id = PASS") untouched.
      const registerScore = isRegisterProbeCase(c) ? scoreRegisterCase(c, voiceTurns.turns) : null;
      voice = {
        ...(registerScore ?? scoreVoice(finalVoiceTurn.json, finalVoiceTurn.status)),
        firstTurnState: voiceFirstTurn.json?.state ?? null,
        confirmationSent: Boolean(voiceConfirmationTurn),
        disambiguationSent: Boolean(voiceDisambiguationTurn),
        disambiguationFollowUp: voiceTurns.disambiguationFollowUp,
      };
      if (registerScore) {
        registerCaseRows.push(buildRegisterCaseRow(c, registerScore));
      }
    }
    bump(voiceCounts, voice.verdict);

    results.push({
      id: c.id,
      cat: c.cat,
      op: c.op,
      utterance: c.utterance,
      expectProposal: c.expectProposal,
      assistant,
      voice,
      voiceFirstTurn: voiceFirstTurn
        ? { httpStatus: voiceFirstTurn.status, state: voiceFirstTurn.json?.state ?? null }
        : undefined,
      voiceConfirmationTurn: voiceConfirmationTurn
        ? {
            httpStatus: voiceConfirmationTurn.status,
            state: voiceConfirmationTurn.json?.state ?? null,
          }
        : undefined,
      voiceDisambiguationTurn: voiceDisambiguationTurn
        ? {
            httpStatus: voiceDisambiguationTurn.status,
            state: voiceDisambiguationTurn.json?.state ?? null,
          }
        : undefined,
    });
    console.log(`A=${assistant.verdict} V=${voice.verdict}`);
  }

  const finished = new Date().toISOString();
  const registerGate = registerCaseRows.length > 0 ? summarizeRegisterRun(registerCaseRows, source) : null;
  const out = {
    started,
    finished,
    corpus,
    targets: {
      api_probe: API_URL,
      note: `${corpus.label} (${corpus.version}) via ${path.relative(ROOT, CASES_PATH)}`,
    },
    tenant: {
      id: TENANT_ID,
      clerkUser: CLERK_USER_ID,
      label: 'QA Mobile tenant',
    },
    platform,
    auth: { meStatus: me.status, me: me.json },
    assistantCounts,
    voiceCounts,
    results,
    // Hermetic-shaped cases[] + gate — only present for a register run
    // (fixtures/voice/inapp-50-cases.json), so build-dashboard.mjs and
    // triage-report.mjs can consume a live run the same way they consume a
    // hermetic one.
    ...(registerGate ? { cases: registerCaseRows, summary: registerGate.summary, gate: registerGate } : {}),
  };

  const resultsPath = path.join(OUT_DIR, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(out, null, 2));

  const aPass = assistantCounts.PASS;
  const vPass = voiceCounts.PASS;
  const report = `# Operator Voice Top-50 — Live Re-run

**When:** ${started} → ${finished}
**Host:** ${API_URL}
**Corpus:** ${corpus.label} (${corpus.version})
**Cases file:** \`${path.relative(ROOT, CASES_PATH)}\`

## Scoreboard

| Surface | PASS | PARTIAL | DEGRADED | FAIL | BLOCKED |
|---------|-----:|--------:|---------:|-----:|--------:|
| Assistant chat | ${assistantCounts.PASS} | ${assistantCounts.PARTIAL} | ${assistantCounts.DEGRADED} | ${assistantCounts.FAIL} | ${assistantCounts.BLOCKED} |
| In-app voice | ${voiceCounts.PASS} | ${voiceCounts.PARTIAL} | ${voiceCounts.DEGRADED} | ${voiceCounts.FAIL} | ${voiceCounts.BLOCKED} |

**Assistant AI path:** **${aPass}/50** PASS
**Voice AI path:** **${vPass}/50** PASS
${registerGate ? `\n${renderRegisterSummaryMarkdown(registerGate, registerCaseRows)}\n` : ''}
Raw: \`${resultsPath}\`
`;
  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), report);
  console.log('\n' + report);
  console.log('Wrote', resultsPath);

  // Exit 1 if still zero assistant passes (same failure class as before)
  if (aPass === 0 && voiceCounts.PASS === 0) {
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
