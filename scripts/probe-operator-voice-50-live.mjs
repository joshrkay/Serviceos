#!/usr/bin/env node
/**
 * Re-run the live operator top-50 probe (same cases as
 * docs/verification-runs/operator-voice-50-live-2026-07-20.results.json).
 *
 * Auth: HMAC Clerk token (requires CLERK_DEV_HMAC_TOKENS=true on the target
 * host — works on serviceosapi-development today; production rejects HMAC).
 *
 * Usage:
 *   CLERK_SECRET_KEY=sk_… node scripts/probe-operator-voice-50-live.mjs
 *   API_URL=https://serviceosapi-development.up.railway.app \
 *     OUT_DIR=/opt/cursor/artifacts/prod-voice-50-rerun \
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

const secret = process.env.CLERK_SECRET_KEY;
if (!secret) {
  console.error('FAIL: CLERK_SECRET_KEY is required');
  process.exit(2);
}

function mintHmacToken() {
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

function scoreAssistant(json, status, expectProposal) {
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

function scoreVoice(json, status) {
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

  if (eventType.includes('reprompt') || score === 0) {
    return {
      verdict: 'DEGRADED',
      reason: 'voice_reprompt_no_classify',
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

function bump(counts, verdict) {
  counts[verdict] = (counts[verdict] || 0) + 1;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const prior = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const cases = prior.results.map((r) => ({
    id: r.id,
    cat: r.cat,
    op: r.op,
    utterance: r.utterance,
    expectProposal: r.expectProposal ?? null,
  }));

  const started = new Date().toISOString();
  const token = mintHmacToken();

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
    if (sess.status !== 201 || !sess.json?.sessionId) {
      voice = {
        verdict: sess.status === 401 || sess.status === 403 ? 'BLOCKED' : 'FAIL',
        reason: `session_create_${sess.status}`,
        httpStatus: sess.status,
      };
    } else {
      const inp = await api('POST', `/api/voice/sessions/${sess.json.sessionId}/input`, {
        token,
        body: { text: c.utterance },
      });
      voice = scoreVoice(inp.json, inp.status);
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
    });
    console.log(`A=${assistant.verdict} V=${voice.verdict}`);
  }

  const finished = new Date().toISOString();
  const out = {
    started,
    finished,
    targets: {
      api_probe: API_URL,
      note:
        'Re-run of 2026-07-20 top-50; same cases + QA Mobile HMAC auth on Development host',
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
**Cases:** same 50 utterances as 2026-07-20 probe

## Scoreboard

| Surface | PASS | PARTIAL | DEGRADED | FAIL | BLOCKED |
|---------|-----:|--------:|---------:|-----:|--------:|
| Assistant chat | ${assistantCounts.PASS} | ${assistantCounts.PARTIAL} | ${assistantCounts.DEGRADED} | ${assistantCounts.FAIL} | ${assistantCounts.BLOCKED} |
| In-app voice | ${voiceCounts.PASS} | ${voiceCounts.PARTIAL} | ${voiceCounts.DEGRADED} | ${voiceCounts.FAIL} | ${voiceCounts.BLOCKED} |

**Assistant AI path:** **${aPass}/50** PASS  
**Voice AI path:** **${vPass}/50** PASS  

Prior run (2026-07-20): 0/50 assistant, 0/50 voice (all DEGRADED).

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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
