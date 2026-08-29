#!/usr/bin/env node
/**
 * AI-capability catalog live sweep — corpus-driven runner.
 *
 * Parametrizes scripts/probe-operator-voice-50-live.mjs over the full
 * ~78-intent / 53-proposal-type AI-workflow catalog (see
 * docs/ai-catalog-sweep or the scratchpad notes this was built from), per
 * three changes documented in this repo's harness analysis:
 *
 *   1. Corpus-driven sizing — no hardcoded row-count assert (the v6 probe
 *      throws unless exactly 50 rows; this runner accepts any corpus size).
 *   2. approveAndAwaitExecution tail, ported from
 *      e2e/qa-matrix/helpers/voice-flow.ts: POST /api/proposals/:id/approve
 *      with the owner HMAC token, tolerate 409 (capture-class auto-approve
 *      races), poll GET /api/proposals/:id past the 5s undo window for
 *      status executed|execution_failed + resultEntityId.
 *   3. Per-row SQL verify over a pg connection (E2E_DB_URL_READONLY, falling
 *      back to E2E_DB_URL_READWRITE with a `superuserVerify` flag when no
 *      dedicated read-only role is configured — same fallback qa-env.sh's
 *      apply_qa_defaults performs) + expectAnswer/expectRefusal scoring so
 *      lookups can fully PASS and a by-design refusal scores PASS with
 *      outcomeClass 'honest_refusal' instead of maxing out at PARTIAL.
 *
 * Auth: dev HMAC JWT (HS256, CLERK_DEV_HMAC_TOKENS=true on the target —
 * dev-only by construction, see packages/api/src/shared/config.ts). Same
 * minting scheme as scripts/probe-operator-voice-50-live.mjs and
 * e2e/qa-matrix/fixtures/tokens.ts.
 *
 * Env: source scripts/qa-env.sh's load_qa_env + apply_qa_defaults pattern
 * (.env.qa then .env.qa.local) before running, or export the same vars:
 *   E2E_API_URL, E2E_TENANT_A_ID, E2E_TENANT_A_CUSTOMER_ID,
 *   E2E_TENANT_A_JOB_ID, E2E_CLERK_HMAC_SECRET, E2E_DB_URL_READONLY
 *   (or E2E_DB_URL_READWRITE as a fallback).
 *
 * Usage:
 *   node scripts/ai-catalog-sweep/run-sweep.mjs --dry-run
 *   node scripts/ai-catalog-sweep/run-sweep.mjs --grep A01,A04,L03
 *   node scripts/ai-catalog-sweep/run-sweep.mjs --concurrency=3
 *
 * Verdict/scoring policy (documented here because it drives every row):
 *   The PASS/PARTIAL/DEGRADED/FAIL/BLOCKED verdict is computed from the
 *   API-observable lifecycle only (chat/voice response shape, proposal
 *   creation, approve/execute status) — the same rigor the ported 50-probe
 *   already applies. Per-row SQL `verify` is executed and recorded as
 *   corroborating evidence (`dbVerify.matched`), but a verify miss (0 rows,
 *   or a query error from a schema-shape assumption in corpus.json that
 *   turns out wrong) never by itself downgrades an API-level PASS to FAIL —
 *   it is surfaced as `dbVerify.matched:false` / `dbVerify.error` and the
 *   console line prints `PASS(unverified)` so a corpus authoring mistake
 *   can never masquerade as a live product failure. FAIL is reserved for
 *   actual API failures (5xx) or a definitively wrong outcome (e.g. a
 *   real mutation where an honest_refusal was expected).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ─────────────────────────────── CLI args ────────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
function argValue(flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return undefined;
}
const GREP = argValue('--grep');
const CONCURRENCY = Number(argValue('--concurrency') || process.env.CONCURRENCY || 3);

// ─────────────────────────────── env / config ─────────────────────────────

const API_URL = (process.env.E2E_API_URL || process.env.API_URL || 'https://serviceosapi-development.up.railway.app').replace(/\/$/, '');
const CORPUS_PATH = process.env.CORPUS_PATH || path.join(__dirname, 'corpus.json');
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'results');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. Source scripts/qa-env.sh (load_qa_env; apply_qa_defaults) first, or export it directly. See qa/README.md.`);
  return v;
}

const HMAC_SECRET = process.env.E2E_CLERK_HMAC_SECRET || process.env.CLERK_SECRET_KEY;
const TENANT_ID = process.env.E2E_TENANT_A_ID;
const CUSTOMER_ID = process.env.E2E_TENANT_A_CUSTOMER_ID;
const JOB_ID = process.env.E2E_TENANT_A_JOB_ID;
const DB_URL_RO = process.env.E2E_DB_URL_READONLY;
const DB_URL_RW = process.env.E2E_DB_URL_READWRITE;
const DB_URL = DB_URL_RO || DB_URL_RW;
// Determined at runtime (see detectSuperuserFallback) rather than from env
// presence alone: qa-env.sh's apply_qa_defaults mirrors READONLY=READWRITE
// when no dedicated qa_readonly role is configured, so E2E_DB_URL_READONLY
// being *set* doesn't prove it's actually a restricted role — only a live
// pg_roles check does (same technique e2e/qa-matrix/helpers/db-verifier.ts
// uses for its bypassRls detection).
let SUPERUSER_FALLBACK = false;

// ─────────────────────────────── auth ──────────────────────────────────

function mintToken(subject, role, tenantId) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      sub: subject,
      sid: `${subject}-ai-catalog-sweep-${now}`,
      tenant_id: tenantId,
      role,
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

// Owner subject reuses the qa-matrix identity (e2e/qa-matrix/fixtures/seed.ts
// already gives it an active `users` row for tenant A — no extra bootstrap).
const OWNER_SUBJECT = 'qa-matrix-user-A';
// Technician subjects are bootstrapped by ensureFixtures() below (mirrors
// scripts/ensure-qa-hmac-users.ts's own idempotent users-row pattern).
const TECH_BAKER_SUBJECT = 'ai-catalog-sweep-tech-baker'; // "Tom Baker" — reassign/crew target, not a token holder
const TECH_ACTOR_SUBJECT = 'ai-catalog-sweep-tech-actor'; // "Alex Rivera" — the technician TOKEN identity

let ownerToken;
let techToken;

// ─────────────────────────────── HTTP helper ──────────────────────────────

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

// ─────────────────────────────── DB helper ─────────────────────────────────

let dbClient;
async function getDb() {
  if (dbClient) return dbClient;
  if (!DB_URL) return null;
  dbClient = new Client({ connectionString: DB_URL });
  await dbClient.connect();
  return dbClient;
}

async function detectSuperuserFallback() {
  const c = await getDb();
  if (!c) return false;
  try {
    const r = await c.query('SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user');
    return Boolean(r.rows?.[0]?.bypass);
  } catch {
    return false;
  }
}

async function dbQuery(sql, params, tenantId) {
  const c = await getDb();
  if (!c) return { skipped: true, reason: 'no_db_url' };
  await c.query('BEGIN');
  try {
    if (tenantId) {
      await c.query(`SET LOCAL app.current_tenant_id = '${String(tenantId).replace(/'/g, "''")}'`);
    }
    const result = await c.query(sql, params);
    await c.query('COMMIT');
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────── templating ────────────────────────────────

/**
 * Resolve `{{token}}` placeholders against a flat globals object plus a
 * `ctx` map of prior-row results (`ctx.<rowId>.<dot.path>`). Returns
 * { text, unresolved } — `unresolved` lists any token that could not be
 * resolved to a defined, non-empty value, so callers can refuse to send a
 * templated utterance/SQL fragment built from a broken chain rather than
 * silently shipping the literal string "undefined".
 */
function resolveTemplate(str, globals, ctx) {
  if (typeof str !== 'string') return { text: str, unresolved: [] };
  const unresolved = [];
  const text = str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, path) => {
    const segs = path.split('.');
    let val;
    if (segs[0] === 'ctx') {
      val = ctx;
      for (const s of segs.slice(1)) {
        if (val == null) break;
        val = val[s];
      }
    } else {
      val = globals[path];
    }
    if (val === undefined || val === null || val === '') {
      unresolved.push(path);
      return whole;
    }
    return String(val);
  });
  return { text, unresolved };
}

// ─────────────────────────────── voice session driver ─────────────────────

async function driveVoiceSession(token, corpusCase) {
  const turns = Array.isArray(corpusCase._resolvedUtterance)
    ? corpusCase._resolvedUtterance
    : [corpusCase._resolvedUtterance];
  const sess = await api('POST', '/api/voice/sessions', { token, body: {} });
  if (![200, 201].includes(sess.status) || !sess.json?.sessionId) {
    return { sessionCreateFailed: true, sess, allTurns: [] };
  }
  const sessionId = sess.json.sessionId;
  const allTurns = [];
  let last;
  for (const text of turns) {
    last = await api('POST', `/api/voice/sessions/${sessionId}/input`, { token, body: { text } });
    allTurns.push({ text, status: last.status, state: last.json?.state ?? null });
  }
  // Automatic FSM continuation for HITL readback turns the scripted array
  // didn't already cover (entity_resolution / entity_confirm / intent_confirm)
  // — same pattern as scripts/probe-operator-voice-50-live.mjs's
  // runVoiceSessionProbe + e2e/qa-matrix/helpers/voice-flow.ts#voiceInput,
  // merged (the ported 50-probe doesn't handle entity_confirm; voice-flow.ts
  // does).
  let guard = 0;
  while (guard++ < 4) {
    const state = last?.json?.state;
    let followUp;
    if (state === 'entity_resolution' && corpusCase.disambiguationFollowUp) {
      followUp = corpusCase.disambiguationFollowUp;
    } else if (state === 'entity_confirm' || state === 'intent_confirm') {
      followUp = "Yes, that's correct.";
    } else {
      break;
    }
    last = await api('POST', `/api/voice/sessions/${sessionId}/input`, { token, body: { text: followUp } });
    allTurns.push({ text: followUp, status: last.status, state: last.json?.state ?? null, auto: true });
  }
  return { sessionId, final: last, allTurns };
}

// ─────────────────────────────── approve + await execution ────────────────

async function approveAndAwaitExecution(token, proposalId) {
  await api('POST', `/api/proposals/${proposalId}/approve`, { token, body: {} });
  let status = 'pending';
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await api('GET', `/api/proposals/${proposalId}`, { token });
    if (res.status === 200) {
      status = res.json?.status ?? status;
      if (status === 'executed' || status === 'execution_failed' || status === 'rejected' || status === 'undone') break;
    }
  }
  const final = await api('GET', `/api/proposals/${proposalId}`, { token });
  return {
    status: final.json?.status ?? status,
    resultEntityId: final.json?.resultEntityId,
    proposalType: final.json?.proposalType,
    executionError: final.json?.executionError,
  };
}

// ─────────────────────────────── fixture bootstrap ─────────────────────────

async function ensureFixtures() {
  const c = await getDb();
  if (!c || !DB_URL_RW) {
    return { skipped: true, reason: 'no E2E_DB_URL_READWRITE — cannot ensure technician/lead fixtures' };
  }
  const rw = new Client({ connectionString: DB_URL_RW });
  await rw.connect();
  const summary = [];
  try {
    // Technicians: "Tom Baker" (reassign/crew target) and "Alex Rivera" (the
    // technician TOKEN identity used by C01/R01-R05). Mirrors
    // scripts/ensure-qa-hmac-users.ts's idempotent users-row pattern.
    for (const [subject, first, last] of [
      [TECH_BAKER_SUBJECT, 'Tom', 'Baker'],
      [TECH_ACTOR_SUBJECT, 'Alex', 'Rivera'],
    ]) {
      const existing = await rw.query('SELECT id FROM users WHERE tenant_id = $1 AND clerk_user_id = $2 LIMIT 1', [TENANT_ID, subject]);
      if ((existing.rowCount ?? 0) > 0) {
        summary.push(`users: exists ${subject}`);
        continue;
      }
      await rw.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'technician', $4, $5, now(), now())`,
        [TENANT_ID, subject, `${subject}@qa.serviceos.local`, first, last],
      );
      summary.push(`users: inserted ${subject} (${first} ${last})`);
    }
    // Leads: "Johnson" (convert_lead) and "Nguyen" (mark_lead_lost) — no AI
    // on-ramp creates a lead, so this sweep seeds them directly (same
    // posture e2e/qa-matrix/fixtures/seed.ts uses for its job/location rows).
    for (const [last, source, phone] of [
      ['Johnson', 'referral', '555-0177'],
      ['Nguyen', 'phone_call', '555-0178'],
    ]) {
      const existing = await rw.query(
        "SELECT id FROM leads WHERE tenant_id = $1 AND last_name = $2 AND stage = 'new' LIMIT 1",
        [TENANT_ID, last],
      );
      if ((existing.rowCount ?? 0) > 0) {
        summary.push(`leads: exists ${last}`);
        continue;
      }
      await rw.query(
        `INSERT INTO leads (id, tenant_id, first_name, last_name, primary_phone, email, source, stage, created_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'QA', $2, $3, $4, $5, 'new', 'ai-catalog-sweep-seed', now(), now())`,
        [TENANT_ID, last, phone, `qa-sweep-${last.toLowerCase()}@qa.serviceos.local`, source],
      );
      summary.push(`leads: inserted ${last}`);
    }
  } finally {
    await rw.end();
  }
  return { summary };
}

// ─────────────────────────────── safety prechecks ──────────────────────────

async function checkGoogleIntegrationWired(tenantId) {
  const r = await dbQuery(
    "SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'google_business' LIMIT 1",
    [tenantId],
    tenantId,
  );
  if (r.error || r.skipped) return { wired: 'unknown', detail: r.error || r.reason };
  return { wired: r.rowCount > 0 };
}

async function checkOwnerPhoneSafe(tenantId) {
  const r = await dbQuery('SELECT owner_phone FROM tenant_settings WHERE tenant_id = $1 LIMIT 1', [tenantId], tenantId);
  if (r.error || r.skipped) return { safe: false, detail: r.error || r.reason };
  const phone = r.rows?.[0]?.owner_phone;
  if (!phone) return { safe: false, detail: 'owner_phone not set' };
  // NANP 555-01xx/555-02xx range is reserved for fictional use — the same
  // safe-number convention e2e/qa-matrix/fixtures/seed.ts relies on.
  const safe = /555[\s.-]?0[12]\d{2}/.test(phone);
  return { safe, detail: phone };
}

// ─────────────────────────────── scoring ───────────────────────────────────

const OUTCOME_ENUM = ['executes', 'draft_gated', 'honest_refusal', 'clarification', 'lookup_answer', 'rbac_denied', 'no_onramp_record'];

function extractChatFields(json) {
  const proposal = json?.message?.proposal ?? json?.proposal ?? null;
  return {
    content: typeof (json?.message?.content ?? json?.content) === 'string' ? (json.message?.content ?? json.content).slice(0, 400) : '',
    model: json?.model ?? null,
    taskType: json?.taskType ?? null,
    degraded: Boolean(json?.degraded),
    proposalId: proposal?.id ?? null,
    proposalType: proposal?.type ?? json?.proposalType ?? null,
  };
}

async function runRow(corpusCase, ctx) {
  const row = { id: corpusCase.id, intent: corpusCase.intent, surface: corpusCase.surface, expectedOutcome: corpusCase.expectedOutcome };

  if (corpusCase.skip) {
    return { ...row, verdict: 'SKIP', outcomeClass: 'no_onramp_record', reason: corpusCase.skip.reason, notes: corpusCase.notes };
  }

  const globals = {
    tenantId: TENANT_ID,
    customerId: CUSTOMER_ID,
    jobId: JOB_ID,
    FIXTURE_CUSTOMER: ctx.__fixture_customer_name,
    FIXTURE_JOB: ctx.__fixture_job_summary,
    ...(ctx.__template_vars || {}), // corpus.json's top-level templateVars (fabricated fixture constants — NEW_CUSTOMER_NAME etc.)
    ...(corpusCase.vars || {}), // per-row overrides, if any
  };

  // Safety prechecks (self-skip rather than risk an un-verified real side effect).
  if (corpusCase.precheck === 'google_integration') {
    const g = await checkGoogleIntegrationWired(TENANT_ID);
    if (g.wired !== false) {
      return { ...row, verdict: 'SKIP', outcomeClass: 'no_onramp_record', reason: `respond_to_review precheck: google_business integration wired=${g.wired} — self-skipped to avoid a real Google reply`, notes: corpusCase.notes };
    }
  }
  if (corpusCase.precheck === 'owner_phone_safe') {
    const p = await checkOwnerPhoneSafe(TENANT_ID);
    if (!p.safe) {
      return { ...row, verdict: 'SKIP', outcomeClass: 'no_onramp_record', reason: `emergency_dispatch precheck: tenant_settings.owner_phone not verified as a safe 555-pattern test number (${p.detail}) — self-skipped to avoid a real SMS page`, notes: corpusCase.notes };
    }
  }

  // Resolve templated utterance(s).
  const rawUtterance = corpusCase.utterance;
  const utteranceArr = Array.isArray(rawUtterance) ? rawUtterance : [rawUtterance];
  const resolved = [];
  const allUnresolved = [];
  for (const u of utteranceArr) {
    const r = resolveTemplate(u, globals, ctx);
    resolved.push(r.text);
    allUnresolved.push(...r.unresolved);
  }
  if (allUnresolved.length > 0) {
    return { ...row, verdict: 'BLOCKED', outcomeClass: null, reason: `template_unresolved: ${[...new Set(allUnresolved)].join(', ')}`, notes: corpusCase.notes };
  }
  corpusCase._resolvedUtterance = resolved;

  const token = corpusCase.actorRole === 'technician' ? techToken : ownerToken;

  let httpStatus;
  let chatFields = {};
  let voiceOutcome;
  let sessionId;

  if (corpusCase.surface === 'chat') {
    const res = await api('POST', '/api/assistant/chat', { token, body: { messages: [{ role: 'user', content: resolved[0] }], inputMode: 'text' } });
    httpStatus = res.status;
    chatFields = extractChatFields(res.json);
  } else if (corpusCase.surface === 'voice-session') {
    voiceOutcome = await driveVoiceSession(token, corpusCase);
    if (voiceOutcome.sessionCreateFailed) {
      return { ...row, verdict: voiceOutcome.sess.status === 401 || voiceOutcome.sess.status === 403 ? 'BLOCKED' : 'FAIL', outcomeClass: null, reason: `session_create_${voiceOutcome.sess.status}`, notes: corpusCase.notes };
    }
    sessionId = voiceOutcome.sessionId;
    httpStatus = voiceOutcome.final?.status;
    const j = voiceOutcome.final?.json;
    chatFields = {
      content: typeof j?.ttsText === 'string' ? j.ttsText.slice(0, 400) : '',
      model: 'voice-session',
      taskType: null,
      degraded: false,
      proposalId: j?.proposalIds?.[0] ?? null,
      proposalType: null,
    };
    chatFields._state = j?.state ?? null;
    chatFields._proposalIds = j?.proposalIds ?? [];
  } else {
    return { ...row, verdict: 'FAIL', outcomeClass: null, reason: `unknown surface ${corpusCase.surface}`, notes: corpusCase.notes };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return { ...row, verdict: 'BLOCKED', outcomeClass: null, reason: `auth_${httpStatus}`, notes: corpusCase.notes };
  }
  if (httpStatus >= 500) {
    return { ...row, verdict: 'FAIL', outcomeClass: null, reason: `http_${httpStatus}`, notes: corpusCase.notes };
  }

  const proposalId = chatFields.proposalId;
  let approveOutcome = null;

  // ── Score against the row's expectedOutcome ──────────────────────────
  let verdict;
  let outcomeClass;
  let reason;

  if (corpusCase.expectedOutcome === 'lookup_answer' || corpusCase.expectedOutcome === 'rbac_denied') {
    const isDataLookup = chatFields.model === 'data-lookup' || chatFields.taskType?.startsWith('assistant.lookup') || chatFields.taskType?.startsWith('assistant.query');
    const contentOk = typeof chatFields.content === 'string' && chatFields.content.length >= 10;
    const regexOk = corpusCase.answerRegex ? new RegExp(corpusCase.answerRegex, 'i').test(chatFields.content) : true;
    const looksLikeDenial = corpusCase.refusalHint
      ? chatFields.content.toLowerCase().includes(corpusCase.refusalHint.toLowerCase())
      : /permission|don't have access|not authorized|can't (share|show|see)/i.test(chatFields.content);
    if (corpusCase.expectedOutcome === 'rbac_denied') {
      verdict = httpStatus === 403 || (contentOk && looksLikeDenial) ? 'PASS' : contentOk ? 'PARTIAL' : 'DEGRADED';
      outcomeClass = 'rbac_denied';
      reason = verdict === 'PASS' ? 'rbac_refusal_copy' : 'no_clear_rbac_refusal';
    } else {
      verdict = !chatFields.degraded && isDataLookup && contentOk && regexOk ? 'PASS' : !chatFields.degraded && contentOk ? 'PARTIAL' : 'DEGRADED';
      outcomeClass = 'lookup_answer';
      reason = verdict === 'PASS' ? 'data_lookup_answer' : 'lookup_answer_not_confirmed';
    }
  } else if (corpusCase.expectedOutcome === 'honest_refusal') {
    const nonError = httpStatus >= 200 && httpStatus < 400;
    const noProposal = !proposalId;
    const contentOk = typeof chatFields.content === 'string' && chatFields.content.length >= 5;
    const hintOk = corpusCase.refusalHint ? chatFields.content.toLowerCase().includes(corpusCase.refusalHint.toLowerCase()) : true;
    verdict = nonError && noProposal && (contentOk || chatFields._state) ? (hintOk ? 'PASS' : 'PARTIAL') : 'DEGRADED';
    outcomeClass = 'honest_refusal';
    reason = verdict === 'PASS' ? 'honest_refusal_confirmed' : 'refusal_shape_unclear';
  } else if (corpusCase.expectedOutcome === 'clarification') {
    const nonError = httpStatus >= 200 && httpStatus < 400;
    const noProposal = !proposalId;
    verdict = nonError && noProposal && (chatFields.content?.length > 0 || chatFields._state) ? 'PASS' : 'DEGRADED';
    outcomeClass = 'clarification';
    reason = verdict === 'PASS' ? 'clarification_reply' : 'no_clarification_shape';
  } else {
    // executes | draft_gated — proposal-driving.
    if (chatFields.degraded) {
      verdict = 'DEGRADED';
      outcomeClass = null;
      reason = 'llm_fallback_envelope';
    } else if (!proposalId) {
      verdict = 'PARTIAL';
      outcomeClass = null;
      reason = 'no_proposal_non_degraded';
    } else if (corpusCase.approve === false || corpusCase.expectedOutcome === 'draft_gated' && corpusCase.approve !== true) {
      verdict = 'PASS';
      outcomeClass = 'draft_gated';
      reason = 'proposal_created_draft_only';
    } else {
      approveOutcome = await approveAndAwaitExecution(token, proposalId);
      if (approveOutcome.status === 'executed') {
        verdict = 'PASS';
        outcomeClass = corpusCase.expectedOutcome === 'draft_gated' ? 'draft_gated' : 'executes';
        reason = 'proposal_executed';
      } else if (approveOutcome.status === 'execution_failed') {
        verdict = 'PARTIAL';
        outcomeClass = 'draft_gated';
        reason = `execution_failed: ${approveOutcome.executionError || 'unknown'}`;
      } else {
        verdict = 'PARTIAL';
        outcomeClass = 'draft_gated';
        reason = `approve_no_terminal_status: ${approveOutcome.status}`;
      }
    }
  }

  // ── DB verify (corroborating evidence only — never downgrades to FAIL) ──
  let dbVerify = null;
  if (corpusCase.verify) {
    const resultEntityId = approveOutcome?.resultEntityId ?? chatFields.proposalId;
    const vGlobals = { ...globals, resultEntityId, proposalId };
    const whereResolved = resolveTemplate(corpusCase.verify.whereShape, vGlobals, ctx);
    if (whereResolved.unresolved.length === 0) {
      const sql = `SELECT * FROM ${corpusCase.verify.table} WHERE ${whereResolved.text}`;
      const q = await dbQuery(sql, [], TENANT_ID);
      if (q.error) {
        dbVerify = { table: corpusCase.verify.table, whereShape: corpusCase.verify.whereShape, sql, matched: false, error: q.error, superuserVerify: SUPERUSER_FALLBACK };
      } else if (q.skipped) {
        dbVerify = { table: corpusCase.verify.table, whereShape: corpusCase.verify.whereShape, sql, matched: false, skipped: true, reason: q.reason };
      } else {
        dbVerify = { table: corpusCase.verify.table, whereShape: corpusCase.verify.whereShape, sql, rowCount: q.rowCount, matched: q.rowCount > 0, superuserVerify: SUPERUSER_FALLBACK, sampleRow: q.rows?.[0] ?? null };
        ctx[corpusCase.id] = { ...(ctx[corpusCase.id] || {}), dbRow: q.rows?.[0] ?? null };
      }
    } else {
      dbVerify = { table: corpusCase.verify.table, matched: false, error: `template_unresolved: ${whereResolved.unresolved.join(', ')}` };
    }
  }

  ctx[corpusCase.id] = {
    ...(ctx[corpusCase.id] || {}),
    resultEntityId: approveOutcome?.resultEntityId ?? chatFields.proposalId ?? null,
    proposalId,
    proposalType: chatFields.proposalType ?? approveOutcome?.proposalType ?? null,
  };

  return {
    ...row,
    verdict,
    outcomeClass,
    reason,
    httpStatus,
    model: chatFields.model,
    taskType: chatFields.taskType,
    content: chatFields.content,
    proposalId,
    proposalType: chatFields.proposalType,
    sessionId,
    voiceState: chatFields._state,
    approve: approveOutcome,
    dbVerify,
    notes: corpusCase.notes,
  };
}

// ─────────────────────────────── dependency-ordered pool ──────────────────
//
// runAllWithSeed (below, near main()) is the single pool implementation —
// it takes a seeded ctx (fixture globals resolved once at startup) rather
// than an empty one, so there is deliberately only one of these.

function compactLine(c, r) {
  if (!r) return `#${c.id} ${c.intent} [${c.surface}] …`;
  const verified = r.dbVerify ? (r.dbVerify.matched ? '' : '(unverified)') : '';
  return `#${r.id} ${r.intent} [${r.surface}] expect=${r.expectedOutcome} -> ${r.verdict}${verified} (${r.reason || ''})`;
}

// ─────────────────────────────── corpus loading / validation ──────────────

function loadCorpus() {
  const source = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  const cases = Array.isArray(source.cases) ? source.cases : null;
  if (!cases) throw new Error('corpus.json must have a top-level "cases" array');
  const ids = new Set();
  const problems = [];
  for (const c of cases) {
    if (!c.id) problems.push('row missing id');
    if (ids.has(c.id)) problems.push(`duplicate id ${c.id}`);
    ids.add(c.id);
    if (!c.skip) {
      if (!c.intent) problems.push(`${c.id}: missing intent`);
      if (!['chat', 'voice-session'].includes(c.surface)) problems.push(`${c.id}: surface must be chat|voice-session, got ${c.surface}`);
      if (!OUTCOME_ENUM.includes(c.expectedOutcome)) problems.push(`${c.id}: expectedOutcome '${c.expectedOutcome}' not in ${OUTCOME_ENUM.join('|')}`);
      if (!c.utterance) problems.push(`${c.id}: missing utterance`);
    }
    if (c.dependsOn && !cases.find((x) => x.id === c.dependsOn)) problems.push(`${c.id}: dependsOn '${c.dependsOn}' not found in corpus`);
  }
  return { source, cases, problems };
}

function matchesGrep(c, grep) {
  if (!grep) return true;
  const needles = grep.split(',').map((s) => s.trim());
  return needles.some((n) => c.id === n || c.id.startsWith(n) || c.intent === n || (c.intent || '').includes(n));
}

function expandWithDependencies(selected, all) {
  const byId = new Map(all.map((c) => [c.id, c]));
  const set = new Map(selected.map((c) => [c.id, c]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of [...set.values()]) {
      if (c.dependsOn && !set.has(c.dependsOn) && byId.has(c.dependsOn)) {
        set.set(c.dependsOn, { ...byId.get(c.dependsOn), _autoIncludedForDependency: true });
        changed = true;
      }
    }
  }
  return [...set.values()];
}

// ─────────────────────────────── main ──────────────────────────────────────

async function main() {
  const { source, cases, problems } = loadCorpus();
  console.log(`Corpus: ${source.version || '?'} "${source.label || ''}" — ${cases.length} rows (${CORPUS_PATH})`);

  if (problems.length > 0) {
    console.error(`Corpus validation FAILED (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('Corpus validation OK (ids unique, required fields present, dependsOn resolves, expectedOutcome enum valid).');

  if (!TENANT_ID || !CUSTOMER_ID || !JOB_ID) {
    // requireEnv throws with a descriptive message for whichever var is missing.
    requireEnv(!TENANT_ID ? 'E2E_TENANT_A_ID' : !CUSTOMER_ID ? 'E2E_TENANT_A_CUSTOMER_ID' : 'E2E_TENANT_A_JOB_ID');
  }
  if (!HMAC_SECRET) throw new Error('Missing E2E_CLERK_HMAC_SECRET (or CLERK_SECRET_KEY)');

  ownerToken = mintToken(OWNER_SUBJECT, 'owner', TENANT_ID);
  techToken = mintToken(TECH_ACTOR_SUBJECT, 'technician', TENANT_ID);

  // Auth sanity (both dry-run and live).
  const me = await api('GET', '/api/me', { token: ownerToken });
  console.log(`Auth check: GET /api/me -> ${me.status}${me.status === 200 ? ` (tenant=${me.json?.tenant_id ?? me.json?.tenantId})` : ''}`);
  if (me.status !== 200) {
    console.error('Auth FAILED — CLERK_DEV_HMAC_TOKENS likely not enabled on the target, or E2E_CLERK_HMAC_SECRET does not match the deployed CLERK_SECRET_KEY.');
    process.exit(1);
  }

  // DB reachability.
  let dbOk = false;
  if (DB_URL) {
    try {
      const c = await getDb();
      await c.query('SELECT 1');
      dbOk = true;
      SUPERUSER_FALLBACK = await detectSuperuserFallback();
      console.log(`DB check: connected (${SUPERUSER_FALLBACK ? 'superuser/bypassRLS role — superuserVerify=true (no dedicated qa_readonly role configured)' : 'restricted role'})`);
    } catch (err) {
      console.error(`DB check FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.error('DB check: no E2E_DB_URL_READONLY or E2E_DB_URL_READWRITE set — per-row SQL verify will be skipped.');
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: corpus + auth + DB reachability validated, no AI calls made.');
    if (dbClient) await dbClient.end().catch(() => {});
    const summary = {
      started: new Date().toISOString(),
      mode: 'dry-run',
      corpus: { version: source.version, label: source.label, casesPath: CORPUS_PATH, rowCount: cases.length },
      auth: { meStatus: me.status },
      db: { reachable: dbOk, superuserVerify: SUPERUSER_FALLBACK },
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, `dry-run-${stamp()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`Wrote ${outPath}`);
    process.exit(me.status === 200 && dbOk ? 0 : 1);
  }

  // Fixture bootstrap (technicians + leads) — live runs only.
  const fixtureResult = await ensureFixtures();
  console.log(`Fixture bootstrap: ${JSON.stringify(fixtureResult)}`);

  // Live fixture read: seeded customer/job names for template substitution.
  const custRow = await dbQuery('SELECT display_name, primary_phone FROM customers WHERE id = $1', [CUSTOMER_ID], TENANT_ID);
  const jobRow = await dbQuery('SELECT summary FROM jobs WHERE id = $1', [JOB_ID], TENANT_ID);
  const fixtureCustomerName = custRow.rows?.[0]?.display_name || 'the primary QA customer';
  const fixtureJobSummary = jobRow.rows?.[0]?.summary || 'the primary QA job';
  console.log(`Fixture customer: "${fixtureCustomerName}" / job: "${fixtureJobSummary}"`);

  let runSet = cases;
  if (GREP) {
    const selected = cases.filter((c) => matchesGrep(c, GREP));
    runSet = expandWithDependencies(selected, cases);
    console.log(`--grep "${GREP}": ${selected.length} row(s) selected, ${runSet.length - selected.length} pulled in as dependency context.`);
  }

  const ctxSeed = {
    __fixture_customer_name: fixtureCustomerName,
    __fixture_job_summary: fixtureJobSummary,
    __template_vars: source.templateVars || {},
  };
  const started = new Date().toISOString();
  const resultsMap = await runAllWithSeed(runSet, CONCURRENCY, ctxSeed);
  const finished = new Date().toISOString();

  const results = [...resultsMap.values()];
  const counts = {};
  const countsByOutcomeClass = {};
  for (const r of results) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    if (r.outcomeClass) countsByOutcomeClass[r.outcomeClass] = (countsByOutcomeClass[r.outcomeClass] || 0) + 1;
  }

  const out = {
    started,
    finished,
    corpus: { version: source.version, label: source.label, casesPath: path.relative(ROOT, CORPUS_PATH), rowCount: cases.length, ranCount: runSet.length },
    targets: { api: API_URL, note: `${source.label || ''} via ${path.relative(ROOT, CORPUS_PATH)}` },
    tenant: { id: TENANT_ID, label: 'QA matrix tenant A (.env.qa.local)', ownerSubject: OWNER_SUBJECT, techSubject: TECH_ACTOR_SUBJECT },
    auth: { meStatus: me.status },
    db: { reachable: dbOk, superuserVerify: SUPERUSER_FALLBACK },
    fixtureBootstrap: fixtureResult,
    fixtures: { customerName: fixtureCustomerName, jobSummary: fixtureJobSummary },
    grep: GREP || null,
    concurrency: CONCURRENCY,
    counts,
    countsByOutcomeClass,
    results: cases.filter((c) => runSet.includes(c) || resultsMap.has(c.id)).map((c) => resultsMap.get(c.id)).filter(Boolean),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `sweep-${stamp()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('\n=== Scoreboard ===');
  console.log(counts);
  console.log(countsByOutcomeClass);
  console.log(`Wrote ${outPath}`);

  if (dbClient) await dbClient.end().catch(() => {});
}

// runAll needs the ctx seeded with fixture globals before the pool starts.
async function runAllWithSeed(cases, concurrency, ctxSeed) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const results = new Map();
  const pending = new Map(cases.map((c) => [c.id, c]));
  const ctx = { ...ctxSeed };
  let active = 0;

  return await new Promise((resolve) => {
    function canRun(c) {
      return !c.dependsOn || results.has(c.dependsOn) || !byId.has(c.dependsOn);
    }
    function pump() {
      if (pending.size === 0 && active === 0) {
        resolve(results);
        return;
      }
      let launched = false;
      for (const [id, c] of pending) {
        if (active >= concurrency) break;
        if (!canRun(c)) continue;
        pending.delete(id);
        active++;
        launched = true;
        runRow(c, ctx)
          .then((r) => {
            results.set(id, r);
            active--;
            console.log(compactLine(c, r));
            pump();
          })
          .catch((err) => {
            const r = { id: c.id, intent: c.intent, surface: c.surface, expectedOutcome: c.expectedOutcome, verdict: 'FAIL', outcomeClass: null, reason: `runner_error: ${err instanceof Error ? err.message : String(err)}` };
            results.set(id, r);
            active--;
            console.log(compactLine(c, r));
            pump();
          });
      }
      if (!launched && active === 0 && pending.size > 0) {
        for (const [id, c] of pending) {
          results.set(id, { id: c.id, intent: c.intent, surface: c.surface, expectedOutcome: c.expectedOutcome, verdict: 'BLOCKED', outcomeClass: null, reason: 'dependency_unresolved' });
          console.log(compactLine(c, results.get(id)));
        }
        pending.clear();
        resolve(results);
      }
    }
    pump();
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
