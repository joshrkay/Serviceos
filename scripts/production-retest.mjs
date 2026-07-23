#!/usr/bin/env node
/**
 * Production retest harness — public health + Clerk RS256 auth probe + optional voice top-50.
 *
 * Production Clerk blocks Backend API session minting. Prefer a browser-captured
 * `serviceos` JWT via `--jwt-file` (re-read before each case for the 60s template).
 *
 * Usage:
 *   node scripts/production-retest.mjs --probe v3 --jwt-file .tmp-prod-serviceos.jwt
 *   CLERK_SECRET_KEY=sk_live_… CLERK_USER_ID=user_… node scripts/production-retest.mjs --probe v3
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProbeCases, probeCasesMeta, runVoiceSessionProbe, scoreAssistant, scoreVoice } from './probe-operator-voice-50-live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD_API = (process.env.PROD_API_URL || 'https://serviceosapi-production.up.railway.app').replace(/\/$/, '');
const DEV_API = (process.env.DEV_API_URL || 'https://serviceosapi-development.up.railway.app').replace(/\/$/, '');
const PROD_WEB = (process.env.PROD_WEB_URL || 'https://serviceosweb-production.up.railway.app').replace(/\/$/, '');
const API_URL = (process.env.API_URL || PROD_API).replace(/\/$/, '');
const OUT_DIR = process.env.OUT_DIR || `/opt/cursor/artifacts/production-retest-${new Date().toISOString().slice(0, 10)}`;
const CLERK_USER_ID = process.env.CLERK_USER_ID || 'user_3GZQEdOUZSzhUNn7pb57fW5jKyg';
const CLERK_SECRET = process.env.CLERK_SECRET_KEY || process.env.E2E_CLERK_SECRET_KEY || '';

const probeArg = process.argv.includes('--probe') ? process.argv[process.argv.indexOf('--probe') + 1] : null;
const jwtFileArg = process.argv.includes('--jwt-file')
  ? process.argv[process.argv.indexOf('--jwt-file') + 1]
  : process.env.SERVICEOS_JWT_FILE || null;
const CORPUS_PATH = probeArg
  ? path.join(ROOT, `fixtures/voice/operator-voice-top-50-${probeArg}-cases.json`)
  : null;

export function loadServiceosJwtFromFile(jwtFile) {
  const resolved = path.isAbsolute(jwtFile) ? jwtFile : path.join(ROOT, jwtFile);
  const jwt = fs.readFileSync(resolved, 'utf8').trim().replace(/^["']|["']$/g, '');
  if (jwt.split('.').length !== 3) {
    throw new Error(`Invalid JWT in ${resolved} — expected 3 dot-separated parts`);
  }
  return jwt;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json, text: text.slice(0, 500) };
}

async function mintClerkServiceosJwt(secret, userId) {
  const sessionRes = await fetch('https://api.clerk.com/v1/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  const session = await sessionRes.json();
  if (!sessionRes.ok || !session.id) {
    throw new Error(`Clerk session create failed: ${sessionRes.status} ${JSON.stringify(session).slice(0, 300)}`);
  }
  const tokenRes = await fetch(`https://api.clerk.com/v1/sessions/${session.id}/tokens/serviceos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok || !tokenBody.jwt) {
    throw new Error(`Clerk serviceos token failed: ${tokenRes.status} ${JSON.stringify(tokenBody).slice(0, 300)}`);
  }
  return { jwt: tokenBody.jwt, sessionId: session.id };
}

function decodeJwtPayload(jwt) {
  const part = jwt.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function mintHmacToken(secret, userId, tenantId, role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ sub: userId, sid: `${userId}-prod-retest`, tenant_id: tenantId, role, iat: now, exp: now + 3600 }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

async function api(base, method, p, { token, body } = {}) {
  const res = await fetch(`${base}${p}`, {
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

/**
 * @param {string | (() => string)} tokenOrGetter
 *   Static JWT, or a getter re-read before each case (60s serviceos template).
 */
async function runVoiceProbe(tokenOrGetter, casesPath) {
  const source = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const cases = loadProbeCases(source);
  const corpus = probeCasesMeta(source, casesPath);
  const assistantCounts = { PASS: 0, PARTIAL: 0, DEGRADED: 0, FAIL: 0, BLOCKED: 0 };
  const voiceCounts = { PASS: 0, PARTIAL: 0, DEGRADED: 0, FAIL: 0, BLOCKED: 0 };
  const results = [];
  const resolveToken = typeof tokenOrGetter === 'function' ? tokenOrGetter : () => tokenOrGetter;

  for (const c of cases) {
    const token = resolveToken();
    const apiBound = (method, p, opts) => api(API_URL, method, p, { ...opts, token });

    process.stdout.write(`#${c.id} ${c.op}… `);
    const chat = await apiBound('POST', '/api/assistant/chat', {
      body: { messages: [{ role: 'user', content: c.utterance }], inputMode: 'text' },
    });
    const assistant = { httpStatus: chat.status, ...scoreAssistant(chat.json, chat.status, c.expectProposal) };
    assistantCounts[assistant.verdict] = (assistantCounts[assistant.verdict] ?? 0) + 1;

    const sess = await apiBound('POST', '/api/voice/sessions', { body: {} });
    let voice;
    if (sess.status !== 201 || !sess.json?.sessionId) {
      voice = {
        verdict: sess.status === 401 || sess.status === 403 ? 'BLOCKED' : 'FAIL',
        reason: `session_create_${sess.status}`,
        httpStatus: sess.status,
      };
    } else {
      const voiceFirstTurn = await apiBound('POST', `/api/voice/sessions/${sess.json.sessionId}/input`, {
        body: { text: c.utterance },
      });
      const voiceTurns = await runVoiceSessionProbe(apiBound, token, sess.json.sessionId, c, voiceFirstTurn);
      const finalVoiceTurn = voiceTurns.finalVoiceTurn;
      voice = {
        ...scoreVoice(finalVoiceTurn.json, finalVoiceTurn.status),
        firstTurnState: voiceFirstTurn.json?.state ?? null,
      };
    }
    voiceCounts[voice.verdict] = (voiceCounts[voice.verdict] ?? 0) + 1;
    results.push({ id: c.id, cat: c.cat, op: c.op, utterance: c.utterance, assistant, voice });
    console.log(`A=${assistant.verdict} V=${voice.verdict}`);
  }

  return { corpus, assistantCounts, voiceCounts, results };
}

async function runAuthenticatedProbe(jwt, report) {
  const claims = decodeJwtPayload(jwt);
  report.auth.jwt_iss = claims.iss;
  report.auth.jwt_sub = claims.sub;
  report.auth.jwt_tenant_id = claims.tenant_id ?? claims.public_metadata?.tenant_id ?? null;
  report.auth.jwt_role = claims.role ?? null;

  for (const [label, base] of [
    ['prod_me', PROD_API],
    ['dev_me', DEV_API],
  ]) {
    const me = await api(base, 'GET', '/api/me', { token: jwt });
    report.auth[label] = { status: me.status, body: me.json };
  }

  if (report.auth.prod_me.status === 200 && CORPUS_PATH && fs.existsSync(CORPUS_PATH)) {
    console.log(`\nRunning voice probe on ${API_URL} corpus ${probeArg}…`);
    const tokenOrGetter = jwtFileArg
      ? () => loadServiceosJwtFromFile(jwtFileArg)
      : jwt;
    report.probe = await runVoiceProbe(tokenOrGetter, CORPUS_PATH);
  } else if (CORPUS_PATH) {
    report.probe = { skipped: true, reason: `auth blocked: prod /api/me ${report.auth.prod_me.status}` };
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();
  const report = { started, targets: { prodApi: PROD_API, prodWeb: PROD_WEB, devApi: DEV_API }, checks: {}, auth: {}, probe: null };

  // Public / health
  for (const [label, url] of [
    ['prod_api_health', `${PROD_API}/health`],
    ['prod_api_ai', `${PROD_API}/api/health/ai`],
    ['prod_api_ai_completion', `${PROD_API}/api/health/ai/completion`],
    ['dev_api_ai', `${DEV_API}/api/health/ai`],
    ['prod_web_root', `${PROD_WEB}/`],
    ['prod_web_login', `${PROD_WEB}/login`],
    ['prod_web_health', `${PROD_WEB}/health`],
  ]) {
    report.checks[label] = await fetchJson(url);
  }

  // Web Clerk key mode — prefer app.therivetapp.com when probing production
  const webEnvUrl = process.env.PROD_WEB_ENV_URL || 'https://app.therivetapp.com/env.js';
  const envJs = await fetchJson(webEnvUrl);
  const pkMatch = envJs.text?.match(/VITE_CLERK_PUBLISHABLE_KEY:\s*"([^"]+)"/);
  report.checks.prod_web_clerk_pk = pkMatch?.[1] ? pkMatch[1].slice(0, 12) + '…' : null;
  report.checks.prod_web_clerk_mode = pkMatch?.[1]?.startsWith('pk_live_')
    ? 'live'
    : pkMatch?.[1]?.startsWith('pk_test_')
      ? 'test'
      : 'unknown';

  report.auth.agent_clerk_secret_prefix = CLERK_SECRET ? CLERK_SECRET.slice(0, 8) + '…' : 'missing';

  if (jwtFileArg) {
    try {
      const jwt = loadServiceosJwtFromFile(jwtFileArg);
      report.auth.jwt_source = jwtFileArg;
      await runAuthenticatedProbe(jwt, report);
    } catch (err) {
      report.auth.error = err instanceof Error ? err.message : String(err);
    }
  } else if (!CLERK_SECRET) {
    report.auth.error = 'CLERK_SECRET_KEY missing — cannot mint JWT (use --jwt-file for production)';
  } else if (CLERK_SECRET.startsWith('sk_test_') && API_URL.includes('production')) {
    report.auth.error =
      'CLERK_SECRET_KEY is sk_test_ but API_URL is production — use --jwt-file with a browser serviceos JWT (or sk_live_ + sign-in token flow). Refusing to mint.';
    if (CORPUS_PATH) {
      report.probe = { skipped: true, reason: 'auth blocked: sk_test_ cannot authenticate to production' };
    }
  } else {
    try {
      const minted = await mintClerkServiceosJwt(CLERK_SECRET, CLERK_USER_ID);
      report.auth.clerk_session = minted.sessionId;
      report.auth.jwt_source = 'clerk_backend_session_mint';

      const claims = decodeJwtPayload(minted.jwt);
      const hmac = mintHmacToken(
        CLERK_SECRET,
        CLERK_USER_ID,
        claims.tenant_id || '00000000-0000-0000-0000-000000000000',
        'owner',
      );
      const hmacMe = await api(PROD_API, 'GET', '/api/me', { token: hmac });
      report.auth.prod_me_hmac = { status: hmacMe.status, body: hmacMe.json };

      await runAuthenticatedProbe(minted.jwt, report);
    } catch (err) {
      report.auth.error = err instanceof Error ? err.message : String(err);
    }
  }

  report.finished = new Date().toISOString();
  const outPath = path.join(OUT_DIR, 'production-retest.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  const md = `# Production retest — ${report.started}

**API:** ${PROD_API}  
**Web:** ${PROD_WEB}  
**Raw:** \`${outPath}\`

## Platform

| Check | Status |
|-------|--------|
| API /health | ${report.checks.prod_api_health?.status} |
| API /api/health/ai | ${report.checks.prod_api_ai?.status} |
| AI completion probe | ${report.checks.prod_api_ai_completion?.json?.completionProbe?.ok ? 'ok' : 'fail'} |
| Web root | ${report.checks.prod_web_root?.status} |
| Web Clerk mode | ${report.checks.prod_web_clerk_mode} |

## Auth

| Path | Status |
|------|--------|
| Agent Clerk secret | ${report.auth.agent_clerk_secret_prefix} |
| JWT source | ${report.auth.jwt_source ?? 'n/a'} |
| Prod /api/me (RS256 serviceos JWT) | ${report.auth.prod_me?.status ?? 'n/a'} |
| Dev /api/me (same JWT) | ${report.auth.dev_me?.status ?? 'n/a'} |
| Prod /api/me (HMAC) | ${report.auth.prod_me_hmac?.status ?? 'n/a'} |

${report.probe?.assistantCounts ? `## Voice probe (${probeArg})\n\nAssistant PASS: ${report.probe.assistantCounts.PASS}/50\nVoice PASS: ${report.probe.voiceCounts.PASS}/50` : report.probe?.skipped ? `## Voice probe\n\nSkipped: ${report.probe.reason}` : ''}

${report.auth.error ? `\n**Auth error:** ${report.auth.error}` : ''}
`;
  fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), md);
  console.log('\n' + md);
  console.log('Wrote', outPath);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { decodeJwtPayload, runVoiceProbe };
