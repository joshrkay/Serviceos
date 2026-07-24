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

/**
 * Drive the in-app voice session through disambiguation and intent confirmation
 * turns when the FSM requires them.
 */
export async function runVoiceSessionProbe(apiFn, token, sessionId, probeCase, firstTurn) {
  let voiceDisambiguationTurn;
  let voiceConfirmationTurn;

  const followUp = resolveProbeDisambiguationFollowUp(probeCase);
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
  return {
    finalVoiceTurn,
    voiceDisambiguationTurn,
    voiceConfirmationTurn,
    disambiguationFollowUp: followUp,
  };
}

/**
 * Normalize probe input from either the v2 cases file ({ cases: [...] }) or a
 * legacy results artifact ({ results: [...] }).
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
      voice = {
        ...scoreVoice(finalVoiceTurn.json, finalVoiceTurn.status),
        firstTurnState: voiceFirstTurn.json?.state ?? null,
        confirmationSent: Boolean(voiceConfirmationTurn),
        disambiguationSent: Boolean(voiceDisambiguationTurn),
        disambiguationFollowUp: voiceTurns.disambiguationFollowUp,
      };
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
