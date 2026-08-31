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
    allTurns.push({ text, status: last.status, state: last.json?.state ?? null, usage: last.json?.usage ?? null, proposalIds: Array.isArray(last.json?.proposalIds) ? last.json.proposalIds : [] });
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
    allTurns.push({ text: followUp, status: last.status, state: last.json?.state ?? null, usage: last.json?.usage ?? null, auto: true, proposalIds: Array.isArray(last.json?.proposalIds) ? last.json.proposalIds : [] });
  }
  // 2026-08-29 round-2 (A49/A50/D01) — `session.proposalIds` is supposed to
  // be cumulative server-side (create-voice-turn-processor.ts pushes onto
  // the SAME session object and every turn's response echoes it back), but
  // two failure modes were observed live: (1) A49/A50 — a turn's own array
  // held more than one id (an earlier `voice_clarification` housekeeping
  // proposal alongside the real actionable one) and the caller used only
  // `proposalIds[0]`, approving the housekeeping stub instead of the real
  // card; (2) D01 — a confusing trailing turn (state left `intent_capture`/
  // similar after the runner's own "Yes, that's correct." auto-continuation
  // fired past an already-completed booking) came back with an EMPTY
  // `proposalIds`, even though an earlier turn's array already carried the
  // real, successfully-executed proposal id (confirmed live via dbVerify —
  // the DB row existed, approved+executed, while this extraction returned
  // null). Scanning every turn and keeping the LAST non-empty array's LAST
  // id fixes both: most-recent-turn wins over a stale trailing turn, and
  // most-recent-id-within-that-turn wins over an earlier stub.
  let lastNonEmptyProposalIds = [];
  for (const t of allTurns) {
    if (Array.isArray(t.proposalIds) && t.proposalIds.length > 0) lastNonEmptyProposalIds = t.proposalIds;
  }
  return { sessionId, final: last, allTurns, proposalIds: lastNonEmptyProposalIds };
}

// ─────────────────────────────── approve + await execution ────────────────

// 2026-08-29 round-2 — poll window extended from 15 iterations (30s) to 45
// (90s): A11/A49/A50 all ended the OLD window still 'executing' (approved,
// execution worker genuinely in flight, not stuck) — 30s undershoots the
// worker's real latency under sweep-time load. Capped, not unbounded: an
// execution that hasn't reached a terminal status in 90s is itself evidence
// worth recording (`pollExhausted: true`), not something to wait out forever.
const POLL_MAX_ITERATIONS = 45;
const POLL_INTERVAL_MS = 2000;

async function approveAndAwaitExecution(token, proposalId) {
  // 2026-08-29 round-2 — capture the approve call's own response instead of
  // discarding it. Every row in the A04/A20/A21/A31/A48 cluster stalled at
  // 'ready_for_review' with no visible cause: approveProposal
  // (proposals/actions.ts) can throw for several reasons (missingFieldsFor
  // still non-empty, a permission gate, an expired 48h window, ...) and the
  // OLD code never looked at this response, so every prior sweep run only
  // ever recorded "approve_no_terminal_status: ready_for_review" — true, but
  // silent about WHY. `approveCall` below is now stored on the row's
  // `approve` evidence so the next sweep either confirms or rules out the
  // missingFields-gate hypothesis directly, instead of by inference.
  const approveRes = await api('POST', `/api/proposals/${proposalId}/approve`, { token, body: {} });
  const approveCall = {
    status: approveRes.status,
    ok: approveRes.status >= 200 && approveRes.status < 300,
    error: approveRes.status >= 400 ? (approveRes.json?.error ?? approveRes.json?.message ?? approveRes.json?.missingFields ?? approveRes.json ?? null) : null,
  };
  let status = 'pending';
  let iterations = 0;
  for (let i = 0; i < POLL_MAX_ITERATIONS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    iterations = i + 1;
    const res = await api('GET', `/api/proposals/${proposalId}`, { token });
    if (res.status === 200) {
      status = res.json?.status ?? status;
      if (status === 'executed' || status === 'execution_failed' || status === 'rejected' || status === 'undone') break;
    }
  }
  const final = await api('GET', `/api/proposals/${proposalId}`, { token });
  const finalStatus = final.json?.status ?? status;
  const terminal = ['executed', 'execution_failed', 'rejected', 'undone'].includes(finalStatus);
  return {
    status: finalStatus,
    resultEntityId: final.json?.resultEntityId,
    proposalType: final.json?.proposalType,
    executionError: final.json?.executionError,
    approveCall,
    pollIterations: iterations,
    // true when every poll ran out and the LAST status observed still isn't
    // terminal (i.e. this row genuinely needed — or still needs more than —
    // the extended window, as distinct from a fast-terminal row that just
    // happens to report a low iteration count).
    pollExhausted: !terminal && iterations >= POLL_MAX_ITERATIONS,
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
    //
    // 2026-08-29 round-2 (A26 fixture gap) — confirmed root cause of A26's
    // live "A service location address is required to convert a lead —
    // provide street1, city, state, and postalCode" execution failure: this
    // INSERT never populated the leads table's address columns at all
    // (street1/city/state/postal_code/country all null on the seeded row),
    // so convert_lead's execution handler — which genuinely needs a service
    // location address to open the resulting customer's first location —
    // could never succeed no matter how the AI classified the utterance.
    // Only "Johnson" needs one (mark_lead_lost never opens a service
    // location). Backfilled on an ALREADY-seeded row too (self-healing, same
    // convention as the other fixtures in this function) so a QA tenant from
    // before this fix picks up the address on the next run without a manual
    // reset.
    const LEAD_ADDRESSES = {
      Johnson: { street1: '88 QA Sweep Lane', city: 'Scottsdale', state: 'AZ', postalCode: '85254', country: 'US' },
    };
    for (const [last, source, phone] of [
      ['Johnson', 'referral', '555-0177'],
      ['Nguyen', 'phone_call', '555-0178'],
    ]) {
      const addr = LEAD_ADDRESSES[last];
      // Find by the key idx_leads_phone_unique_open actually enforces
      // (tenant_id, phone_normalized) WHERE converted_customer_id IS NULL —
      // a prior sweep's mark_lead_lost/stage-advance leaves the row
      // open-by-index but no longer stage='new', so a stage-filtered lookup
      // misses it and the bare INSERT below collides (23505). Reuse the
      // open row and self-heal it back to the documented precondition
      // (stage='new'), same convention as the address backfill.
      const existing = await rw.query(
        'SELECT id, street1, stage FROM leads WHERE tenant_id = $1 AND last_name = $2 AND converted_customer_id IS NULL ORDER BY created_at DESC LIMIT 1',
        [TENANT_ID, last],
      );
      if ((existing.rowCount ?? 0) > 0) {
        const row = existing.rows[0];
        if (row.stage !== 'new') {
          await rw.query(
            "UPDATE leads SET stage = 'new', updated_at = now() WHERE id = $1",
            [row.id],
          );
          summary.push(`leads: reset ${last} stage '${row.stage}' -> 'new'`);
        }
        if (addr && !row.street1) {
          await rw.query(
            `UPDATE leads SET street1 = $2, city = $3, state = $4, postal_code = $5, country = $6, updated_at = now() WHERE id = $1`,
            [row.id, addr.street1, addr.city, addr.state, addr.postalCode, addr.country],
          );
          summary.push(`leads: backfilled address on existing ${last}`);
        } else if (row.stage === 'new') {
          summary.push(`leads: exists ${last}`);
        }
        continue;
      }
      await rw.query(
        `INSERT INTO leads (id, tenant_id, first_name, last_name, primary_phone, email, source, stage, street1, city, state, postal_code, country, created_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'QA', $2, $3, $4, $5, 'new', $6, $7, $8, $9, $10, 'ai-catalog-sweep-seed', now(), now())`,
        [TENANT_ID, last, phone, `qa-sweep-${last.toLowerCase()}@qa.serviceos.local`, source, addr?.street1 ?? null, addr?.city ?? null, addr?.state ?? null, addr?.postalCode ?? null, addr?.country ?? null],
      );
      summary.push(`leads: inserted ${last}${addr ? ' (with address)' : ''}`);
    }
    // Round 5 — appointment fixture normalization (same self-healing class
    // as the leads-stage reset and unreplied-review checks above): the
    // resolver rows (A11-A15/A27) document ONE unambiguous scheduled
    // appointment for the fixture customer, but each run's own
    // create_appointment executions (A03/A33) leave extra scheduled rows,
    // and every later appointment reference then gates on ambiguity
    // (live evidence: proposal 95dc9245's pendingEntityAmbiguity carried 3
    // candidates incl. a duplicated 18:00 pair). Keep the OLDEST scheduled
    // appointment (the seed's) and cancel the younger surplus — cancelled
    // rows drop out of the resolver's candidate set. Scoped strictly to the
    // fixture customer's jobs on the QA tenant.
    // Round 5 correction — the corpus's appointment rows are a designed
    // CHAIN: A03 books the tune-up ("Book {{FIXTURE_CUSTOMER}} for a
    // tune-up tomorrow at 2pm") and A11/A13/A14/A15/A27 operate on THAT
    // appointment (A11's verify literally targets ctx.A03.resultEntityId).
    // The bootstrap contract is therefore ZERO active appointments for the
    // fixture customer — a keep-oldest variant preserved a PRIOR run's A03
    // tune-up and re-ambiguated every reference against this run's one
    // (live evidence: sweep-8 A11 gated on appointmentId with two
    // near-identical tune-ups). Cancel them all; the run then creates and
    // operates on exactly one. Predicate mirrors the resolver's active set
    // (status <> 'canceled' AND scheduled_start >= now()).
    const surplusAppts = await rw.query(
      `UPDATE appointments a SET status = 'canceled', updated_at = now()
        WHERE a.tenant_id = $1
          AND a.status <> 'canceled'
          AND a.scheduled_start >= now()
          AND a.job_id IN (SELECT id FROM jobs WHERE tenant_id = $1 AND customer_id = $2)
        RETURNING a.id`,
      [TENANT_ID, CUSTOMER_ID],
    );
    summary.push(`appointments: cancelled ${surplusAppts.rowCount ?? 0} active for the fixture customer (chain-root reset)`);
    // Round 6 — the corpus needs TWO appointment sources: A03's tune-up
    // chain (created mid-run, lifecycled by A11/A12) AND a STANDING
    // appointment for the rows that run after A12's cancel (A31 notify_delay,
    // A27 confirm — on the 05:16 clean baseline these resolved the seed's
    // standing appointment). The cancel-all above removes prior-run debris
    // including any old standing row, so insert a fresh one: neutral notes
    // (never "tune-up", so A11's named reference stays unambiguous), ~5 days
    // out on the seed job.
    await rw.query(
      `INSERT INTO appointments (id, tenant_id, job_id, scheduled_start, scheduled_end, timezone, status, notes, created_by, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, now() + interval '5 days', now() + interval '5 days 1 hour', 'America/New_York', 'scheduled', 'QA Sweep standing service visit (fixture)', 'ai-catalog-sweep-seed', now(), now())`,
      [TENANT_ID, JOB_ID],
    );
    summary.push('appointments: inserted fresh standing fixture appointment');
    // Round 6 — NEW_CUSTOMER_NAME ("Priya Shah") is the create_customer
    // chain root: each run's execution mints another one, and later
    // Priya-referencing rows (A24/A29/A41) gate on ambiguity across the
    // copies. The resolver filters is_archived = false, so archiving prior
    // copies is the quarantine; this run then creates the one live Priya.
    const priyas = await rw.query(
      `UPDATE customers SET is_archived = true, updated_at = now()
        WHERE tenant_id = $1 AND is_archived = false
          AND first_name = 'Priya' AND last_name = 'Shah'
        RETURNING id`,
      [TENANT_ID],
    );
    summary.push(`customers: archived ${priyas.rowCount ?? 0} prior chain-root Priya Shah copies`);
    // Round 7 — the INVOICE chain (A01 creates a draft, A06 issues it,
    // A17/A22/A37/A38 operate on the issued one) is chain-rooted too:
    // prior runs' sweep-created drafts linger, inflate the resolver's
    // candidate set, and downstream rows can land on a stale draft
    // ("INV-0010 is 'draft'" execution failures, sweep 10). Void prior
    // drafts on the fixture customer's jobs at bootstrap — void is
    // excluded from resolution candidates (#944) and rejected by every
    // executor, and this run's A01 creates its own fresh draft afterward.
    // Round 7b (per the fix/chat-invoice-gate-coverage root cause): the
    // chain leaves ONE NON-VOID invoice PER RUN (open/paid/partially_paid,
    // never void), so a drafts-only quarantine still lets the candidate set
    // cross MAX_INVOICE_CANDIDATES (5) within a few rounds and trip the
    // resolver's overflow refusal. Keep only the two earliest-created
    // non-void invoices (the seed pair) and void every later one — this
    // run's A01 then creates its own fresh draft, keeping the set at 3.
    const staleInvoices = await rw.query(
      `UPDATE invoices i SET status = 'void', updated_at = now()
        WHERE i.tenant_id = $1
          AND i.status NOT IN ('void', 'canceled')
          AND i.job_id IN (SELECT id FROM jobs WHERE tenant_id = $1 AND customer_id = $2)
          AND i.id NOT IN (
            SELECT i2.id FROM invoices i2
              JOIN jobs j2 ON j2.id = i2.job_id AND j2.tenant_id = i2.tenant_id
             WHERE i2.tenant_id = $1 AND j2.customer_id = $2
               AND i2.status NOT IN ('void', 'canceled')
             ORDER BY i2.created_at ASC LIMIT 2
          )
        RETURNING i.id`,
      [TENANT_ID, CUSTOMER_ID],
    );
    summary.push(`invoices: voided ${staleInvoices.rowCount ?? 0} beyond the seed pair (chain-root reset)`);
    // Round 7c — NEW_CATALOG_ITEM ("QA Sweep Smart Thermostat Install") is
    // the create_catalog_item chain root (A44 mints one per run) and the
    // new catalogItem resolver (fix/catalog-item-gate) excludes only
    // archived_at IS NOT NULL rows, so prior copies must be ARCHIVED (the
    // same operation the Catalog screen's archive action performs — never
    // renamed or deleted; catalog_items has no created_by column). Archive
    // all active copies at bootstrap; this run's A44 creates the one live
    // item its own later rows reference.
    const staleCatalog = await rw.query(
      `UPDATE catalog_items SET archived_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND archived_at IS NULL
          AND name = 'QA Sweep Smart Thermostat Install'
        RETURNING id`,
      [TENANT_ID],
    );
    summary.push(`catalog_items: archived ${staleCatalog.rowCount ?? 0} prior chain-root copies`);
    // Same design one level down: NEW_JOB_SUMMARY ("QA Sweep Furnace
    // Inspection") is a per-run fabricated chain-root JOB, but the
    // resolver's job candidate query has NO status filter, so prior runs'
    // copies stay candidates forever and every job-by-name reference
    // (A16/A33/...) gates on ambiguity. Renaming is the only removal —
    // quarantine prior copies with a superseded suffix so this run's
    // creation is the one exact-title match.
    const supersededJobs = await rw.query(
      `UPDATE jobs SET summary = summary || ' [superseded ' || substr(id::text, 1, 8) || ']', updated_at = now()
        WHERE tenant_id = $1 AND customer_id = $2
          AND summary = 'QA Sweep Furnace Inspection'
        RETURNING id`,
      [TENANT_ID, CUSTOMER_ID],
    );
    summary.push(`jobs: quarantined ${supersededJobs.rowCount ?? 0} prior chain-root copies`);
    // Business timezone — confirmed root cause (2026-08-29 full sweep) of
    // A03/A33 (create_appointment / schedule_inspection) failing to draft
    // at all: routes/assistant.ts's create_appointment path honestly
    // refuses relative-time scheduling ("Cannot book — the business time
    // zone is not set") when the tenant has no tenant_settings row.
    // e2e/qa-matrix/fixtures/seed.ts never provisions tenant_settings
    // (only tenants/users/customers/service_locations/jobs), so this
    // sweep's QA tenant genuinely has none — the app deliberately has no
    // app-layer fallback zone (see packages/api/src/settings/pg-settings.ts
    // TenantIdentityUpsertFields.timezone's own comment). Mirrors the real
    // onboarding write (pg-settings.ts#upsertIdentityFields's INSERT ...
    // ON CONFLICT (tenant_id) pattern) but ON CONFLICT DO NOTHING —
    // idempotent, and never overwrites an operator's real settings if a
    // row already exists for this tenant.
    const tzExisting = await rw.query('SELECT timezone FROM tenant_settings WHERE tenant_id = $1 LIMIT 1', [TENANT_ID]);
    if ((tzExisting.rowCount ?? 0) > 0) {
      summary.push(`tenant_settings: exists (timezone=${tzExisting.rows[0].timezone})`);
    } else {
      await rw.query(
        `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now(), now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        [TENANT_ID, 'QA Sweep Test Business', 'America/New_York'],
      );
      summary.push('tenant_settings: inserted (business_name=QA Sweep Test Business, timezone=America/New_York)');
    }

    // A46 respond_to_review — 2026-08-29 round-2 fixture gap: this sweep
    // never seeded a single google_reviews row, so "Reply to the 1-star
    // review from yesterday" had genuinely nothing to draft a response for —
    // confirmed root cause of the live execution failure ("payload is
    // missing the required publicResponse component"), distinct from the
    // row's own precheck (which only self-skips when a REAL google_business
    // integration is wired; it is not, on this QA tenant, so the row is
    // meant to proceed). Self-healing: only inserts when no recent (<=1
    // star, last 7 days) review already exists, so a review this row itself
    // causes a reply to be drafted against doesn't get re-seeded forever.
    // Round 4 (A46 rerun gap): a review this sweep already REPLIED to still
    // matched the bare exists-check, so a rerun without qa:reset had nothing
    // left to respond to — the drafting path correctly refuses a duplicate
    // reply via its idempotency key ('review_response:<review row id>',
    // proposal_type review_response_proposal; live audit evidence:
    // proposal_persist_failed on session 456c9f89). The fixture's real
    // contract is "an UNREPLIED recent 1-star review exists" — count only
    // reviews whose idempotency key is unclaimed by ANY proposal (any
    // status: persist fails on any existing key, not just executed ones).
    const reviewExisting = await rw.query(
      `SELECT gr.id FROM google_reviews gr
        WHERE gr.tenant_id = $1 AND gr.rating <= 1
          AND gr.review_create_time > now() - interval '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM proposals p
             WHERE p.tenant_id = gr.tenant_id
               AND p.idempotency_key = 'review_response:' || gr.id::text
          )
        LIMIT 1`,
      [TENANT_ID],
    );
    if ((reviewExisting.rowCount ?? 0) > 0) {
      summary.push('google_reviews fixture: exists recent 1-star');
    } else {
      const reviewId = crypto.randomUUID();
      const reviewStamp = Date.now();
      await rw.query(
        `INSERT INTO google_reviews (id, tenant_id, external_review_id, location_id, reviewer_display_name, rating, comment_text, review_create_time)
         VALUES ($1, $2, $3, 'qa-sweep-location', 'QA Sweep Reviewer', 1, 'Technician showed up late and the job took way longer than quoted.', now() - interval '1 day')`,
        [reviewId, TENANT_ID, `qa-sweep-review-${reviewStamp}`],
      );
      summary.push(`google_reviews fixture: inserted 1-star review ${reviewId}`);
    }

    // A07 batch_invoice — findJobsRequiringInvoicing (invoices/invoicing-queue.ts)
    // needs a job with status='completed', money_state='estimate_accepted', an
    // ACCEPTED estimate carrying a billable (non-optional, non-grouped) line
    // item, and NO live (non-void/non-canceled) invoice yet. e2e/qa-matrix/
    // fixtures/seed.ts's one job per tenant starts 'new' and is never
    // completed/estimated, so this sweep's QA tenant genuinely has zero
    // completed-unbilled jobs — confirmed root cause of A07's proposal falling
    // through to BatchInvoiceTaskHandler's empty-candidates voice_clarification
    // branch (voice-extended-tasks.ts) instead of drafting a real batch_invoice
    // proposal. Self-healing, not merely idempotent: once a seeded job is
    // actually invoiced (by a prior sweep's approve+execute — the batch_invoice
    // execution handler fans out a real draft_invoice per job), it legitimately
    // drops out of the "requires invoicing" query, so the NOT EXISTS check below
    // mints a fresh job only when none remains unbilled — the row stays
    // provable on every run instead of only the first.
    const a07Location = await rw.query('SELECT location_id FROM jobs WHERE tenant_id = $1 AND id = $2 LIMIT 1', [TENANT_ID, JOB_ID]);
    const a07LocationId = a07Location.rows?.[0]?.location_id;
    if (!a07LocationId) {
      summary.push('batch_invoice fixture: SKIPPED — could not resolve a service_location from E2E_TENANT_A_JOB_ID');
    } else {
      const a07Unbilled = await rw.query(
        `SELECT j.id FROM jobs j
         WHERE j.tenant_id = $1 AND j.customer_id = $2 AND j.status = 'completed'
           AND j.money_state = 'estimate_accepted'
           AND j.summary LIKE 'QA Sweep Batch-Invoice Fixture%'
           AND NOT EXISTS (
             SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status NOT IN ('void', 'canceled')
           )
         LIMIT 1`,
        [TENANT_ID, CUSTOMER_ID],
      );
      if ((a07Unbilled.rowCount ?? 0) > 0) {
        summary.push(`batch_invoice fixture: exists unbilled (job ${a07Unbilled.rows[0].id})`);
      } else {
        const a07Stamp = Date.now();
        const a07JobId = crypto.randomUUID();
        const a07EstimateId = crypto.randomUUID();
        await rw.query(
          `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, status, money_state, priority, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'completed', 'estimate_accepted', 'normal', $7, now(), now())`,
          [a07JobId, TENANT_ID, CUSTOMER_ID, a07LocationId, `QA-SWEEP-A07-${a07Stamp}`, `QA Sweep Batch-Invoice Fixture ${a07Stamp}`, 'ai-catalog-sweep-seed'],
        );
        await rw.query(
          `INSERT INTO estimates (id, tenant_id, job_id, estimate_number, status, subtotal_cents, taxable_subtotal_cents, total_cents, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'accepted', $5, $5, $5, $6, now(), now())`,
          [a07EstimateId, TENANT_ID, a07JobId, `EST-A07-${a07Stamp}`, 45000, 'ai-catalog-sweep-seed'],
        );
        await rw.query(
          `INSERT INTO estimate_line_items (id, tenant_id, estimate_id, description, category, quantity, unit_price_cents, total_cents, sort_order, taxable)
           VALUES ($1, $2, $3, 'QA Sweep completed-job line item', 'labor', 1, $4, $4, 0, true)`,
          [crypto.randomUUID(), TENANT_ID, a07EstimateId, 45000],
        );
        summary.push(`batch_invoice fixture: inserted completed-unbilled job ${a07JobId} (estimate ${a07EstimateId})`);
      }
    }

    // A19/A51 send_estimate_nudge — needs a 'sent', unanswered estimate whose
    // most recent dispatch is > 48h old (SendEstimateNudgeExecutionHandler's
    // FUP-002 cooldown, proposals/execution/handlers.ts) so A19's FIRST nudge
    // this run genuinely executes instead of legitimately hitting the guard
    // (the correct-refusal case is exercised separately by A51, which nudges
    // the SAME estimate again immediately after A19 does). Uses a DEDICATED
    // customer — never FIXTURE_CUSTOMER/CUSTOMER_ID — because
    // SendEstimateNudgeTaskHandler resolves the target via a customer-anchored
    // search (voice-extended-tasks.ts): a second 'sent' estimate on the SAME
    // customer as the A02->A05->A18 chain's freshly-sent estimate would be
    // genuine ambiguity and the task would clarify instead of executing,
    // regardless of in-run timing. The SMS send path (dispatchEstimateNudge ->
    // SendService.sendEstimate; channel is hardcoded 'sms' in the execution
    // handler) requires the customer to carry BOTH primary_phone (resolveChannels
    // throws 'Cannot send SMS...' without one) and sms_consent=true (otherwise
    // the consent gate suppresses the only channel and the send throws
    // 'Estimate send failed on all channels') — both are seeded below.
    // Self-healing like the batch_invoice fixture: once A19 actually nudges
    // this estimate, it plants a fresh dispatch inside the 48h window, so the
    // NEXT run mints a brand-new eligible estimate rather than reusing one
    // that would now legitimately refuse.
    let a19CustomerId;
    const a19ExistingCust = await rw.query(
      "SELECT id FROM customers WHERE tenant_id = $1 AND display_name = 'QA Sweep Nudge Fixture' LIMIT 1",
      [TENANT_ID],
    );
    if ((a19ExistingCust.rowCount ?? 0) > 0) {
      a19CustomerId = a19ExistingCust.rows[0].id;
      summary.push('nudge fixture customer: exists');
    } else {
      a19CustomerId = crypto.randomUUID();
      await rw.query(
        `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, primary_phone, email, sms_consent, created_by, created_at, updated_at)
         VALUES ($1, $2, 'QA Sweep', 'Nudge Fixture', 'QA Sweep Nudge Fixture', $3, $4, true, $5, now(), now())`,
        [a19CustomerId, TENANT_ID, '480-555-0195', 'qa-sweep-nudge-fixture@qa.serviceos.local', 'ai-catalog-sweep-seed'],
      );
      summary.push(`nudge fixture customer: inserted ${a19CustomerId}`);
    }

    let a19LocationId;
    const a19ExistingLoc = await rw.query(
      'SELECT id FROM service_locations WHERE tenant_id = $1 AND customer_id = $2 LIMIT 1',
      [TENANT_ID, a19CustomerId],
    );
    if ((a19ExistingLoc.rowCount ?? 0) > 0) {
      a19LocationId = a19ExistingLoc.rows[0].id;
    } else {
      a19LocationId = crypto.randomUUID();
      await rw.query(
        `INSERT INTO service_locations (id, tenant_id, customer_id, label, street1, city, state, postal_code, country, created_at, updated_at)
         VALUES ($1, $2, $3, 'QA Sweep Nudge Fixture location', '1 QA Sweep Way', 'Scottsdale', 'AZ', '85254', 'US', now(), now())`,
        [a19LocationId, TENANT_ID, a19CustomerId],
      );
    }

    let a19JobId;
    const a19ExistingJob = await rw.query(
      "SELECT id FROM jobs WHERE tenant_id = $1 AND job_number = 'QA-SWEEP-NUDGE-FIXTURE' LIMIT 1",
      [TENANT_ID],
    );
    if ((a19ExistingJob.rowCount ?? 0) > 0) {
      a19JobId = a19ExistingJob.rows[0].id;
    } else {
      a19JobId = crypto.randomUUID();
      await rw.query(
        `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'QA-SWEEP-NUDGE-FIXTURE', 'QA Sweep nudge-fixture job', $5, now(), now())`,
        [a19JobId, TENANT_ID, a19CustomerId, a19LocationId, 'ai-catalog-sweep-seed'],
      );
    }

    const a19Eligible = await rw.query(
      `SELECT e.id FROM estimates e
       WHERE e.tenant_id = $1 AND e.job_id = $2 AND e.status = 'sent'
         AND (e.last_reminder_at IS NULL OR e.last_reminder_at < now() - interval '48 hours')
         AND NOT EXISTS (
           SELECT 1 FROM message_dispatches d
           WHERE d.entity_type = 'estimate' AND d.entity_id = e.id
             AND d.status NOT IN ('failed', 'bounced')
             AND d.sent_at >= now() - interval '48 hours'
         )
       ORDER BY e.created_at DESC LIMIT 1`,
      [TENANT_ID, a19JobId],
    );
    if ((a19Eligible.rowCount ?? 0) > 0) {
      summary.push(`nudge fixture estimate: exists eligible (${a19Eligible.rows[0].id})`);
    } else {
      const a19Stamp = Date.now();
      const a19EstimateId = crypto.randomUUID();
      await rw.query(
        `INSERT INTO estimates (id, tenant_id, job_id, estimate_number, status, subtotal_cents, taxable_subtotal_cents, total_cents, sent_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'sent', $5, $5, $5, now() - interval '72 hours', $6, now() - interval '72 hours', now() - interval '72 hours')`,
        [a19EstimateId, TENANT_ID, a19JobId, `EST-NUDGE-${a19Stamp}`, 50000, 'ai-catalog-sweep-seed'],
      );
      await rw.query(
        `INSERT INTO estimate_line_items (id, tenant_id, estimate_id, description, category, quantity, unit_price_cents, total_cents, sort_order, taxable)
         VALUES ($1, $2, $3, 'QA Sweep nudge fixture line item', 'labor', 1, $4, $4, 0, true)`,
        [crypto.randomUUID(), TENANT_ID, a19EstimateId, 50000],
      );
      await rw.query(
        `INSERT INTO message_dispatches (id, tenant_id, entity_type, entity_id, channel, recipient, provider, provider_message_id, status, idempotency_key, sent_at)
         VALUES ($1, $2, 'estimate', $3, 'email', $4, 'in-memory', $5, 'sent', $6, now() - interval '72 hours')`,
        [crypto.randomUUID(), TENANT_ID, a19EstimateId, 'qa-sweep-nudge-fixture@qa.serviceos.local', `mem-nudge-fixture-${a19Stamp}`, `estimate:${a19EstimateId}:email:${a19Stamp}`],
      );
      summary.push(`nudge fixture estimate: inserted fresh sent estimate ${a19EstimateId} (job ${a19JobId}) with a 72h-old dispatch so A19's first nudge this run should execute`);
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

// 'guard_pass' (2026-08-29 WS-E honesty pass) — a proposal-driving row whose
// CORRECT behavior is a post-draft guard refusing execution (e.g. FUP-002's
// 48h send_estimate_nudge cooldown, proposals/execution/handlers.ts). Distinct
// from 'executes'/'draft_gated': those two both score PARTIAL on any
// execution_failed (see runRow below) because most execution_failed results
// ARE unintended bugs. A guard_pass row expects the SAME execution_failed
// shape but treats hitting the documented guard as the row's success —
// without this, a ratified-correct refusal would forever PARTIAL and there
// would be no honest way to prove the guard fires on demand.
const OUTCOME_ENUM = ['executes', 'draft_gated', 'honest_refusal', 'clarification', 'lookup_answer', 'rbac_denied', 'no_onramp_record', 'guard_pass'];

function sumUsage(usages) {
  const out = { input: 0, output: 0, total: 0 };
  for (const u of usages) {
    out.input += Number(u?.input) || 0;
    out.output += Number(u?.output) || 0;
    out.total += Number(u?.total) || 0;
  }
  return out;
}

function extractChatFields(json) {
  const proposal = json?.message?.proposal ?? json?.proposal ?? null;
  return {
    content: typeof (json?.message?.content ?? json?.content) === 'string' ? (json.message?.content ?? json.content).slice(0, 400) : '',
    model: json?.model ?? null,
    taskType: json?.taskType ?? null,
    degraded: Boolean(json?.degraded),
    proposalId: proposal?.id ?? null,
    proposalType: proposal?.type ?? json?.proposalType ?? null,
    usage: json?.usage ?? null,
    // 2026-08-29 round-2 — the client-pinned conversation id the server
    // echoes back (routes/assistant.ts's `envelope = {...result,
    // conversationId, correlationId}`). Needed so a follow-up answer turn
    // (see `looksLikeDisambiguationQuestion` / the chat branch of `runRow`)
    // can thread into the SAME conversation `findPendingClarification`
    // looks up — without it every follow-up would open a fresh thread and
    // the server would never find the pending question to answer.
    conversationId: typeof json?.conversationId === 'string' ? json.conversationId : null,
  };
}

// 2026-08-29 round-2 (WS-A gap) — detect the #909 gated-reference-resolution
// loop's ONE disambiguation question (gated-reference-resolution.ts's
// `buildDisambiguationQuestion`: "Which <kind> did you mean by \"<ref>\"?"
// followed by a numbered candidate list and "Reply with the number or the
// name.", or the same-name variant "...all under the same name. Which one —
// can you give me the address or phone number?"). The runner previously had
// no way to answer this — a one-turn probe just recorded whatever the
// question's own text was as the row's final reply and moved on to approve,
// which always 400s on the still-gated field. Matched loosely (two
// alternative endings) so wording tweaks to either branch don't silently
// stop being recognized.
const DISAMBIGUATION_QUESTION_RE = /reply with the number or the name\.|can you give me the address or phone number\?/i;
function looksLikeDisambiguationQuestion(content) {
  return typeof content === 'string' && DISAMBIGUATION_QUESTION_RE.test(content);
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
    // 2026-08-29 round-2 (A05/A18 tolerate A02) — distinguish "this row's own
    // template references a dependency that never resolved a DB row" from a
    // genuine corpus-authoring typo. `ctx.<id>.dbRow` is populated only when
    // that row HAD a `verify` step AND it matched (see the ctx assignment
    // below); a dependency that ran but whose OWN dbVerify never matched
    // (e.g. because its proposal never persisted — a product-side bug, not a
    // fixture defect) leaves `ctx[id]` present but `dbRow` null/undefined.
    // Reported distinctly so the report attributes the cascade to the
    // upstream row instead of implying this row's own template is broken.
    const upstreamUnresolved = [...new Set(allUnresolved)].filter((token) => {
      const m = /^ctx\.([A-Za-z0-9_]+)\.dbRow(\.|$)/.exec(token);
      if (!m) return false;
      const upstream = ctx[m[1]];
      return upstream !== undefined && (upstream.dbRow === null || upstream.dbRow === undefined);
    });
    const genuinelyUnresolved = [...new Set(allUnresolved)].filter((t) => !upstreamUnresolved.includes(t));
    if (genuinelyUnresolved.length === 0 && upstreamUnresolved.length > 0) {
      return {
        ...row,
        verdict: 'BLOCKED',
        outcomeClass: null,
        reason: `upstream_dependency_unresolved: ${upstreamUnresolved.join(', ')} — the upstream row ran but its own dbVerify never matched a DB row (see that row's evidence for the root cause); this row's template cannot be resolved as a result, not because of anything wrong in this row's own corpus definition`,
        notes: corpusCase.notes,
      };
    }
    return { ...row, verdict: 'BLOCKED', outcomeClass: null, reason: `template_unresolved: ${[...new Set(allUnresolved)].join(', ')}`, notes: corpusCase.notes };
  }
  corpusCase._resolvedUtterance = resolved;

  const token = corpusCase.actorRole === 'technician' ? techToken : ownerToken;

  let httpStatus;
  let chatFields = {};
  let voiceOutcome;
  let sessionId;

  let answerTurn = null;
  if (corpusCase.surface === 'chat') {
    const res = await api('POST', '/api/assistant/chat', { token, body: { messages: [{ role: 'user', content: resolved[0] }], inputMode: 'text' } });
    httpStatus = res.status;
    chatFields = extractChatFields(res.json);

    // 2026-08-29 round-2 (WS-A gap, explicitly flagged as a missing runner
    // capability) — the chat surface's #909 resolution loop asks ONE
    // disambiguation question and expects the NEXT turn (same
    // conversationId, plain free text — "the number or the name",
    // findPendingClarification/applyDisambiguationAnswer in
    // routes/assistant.ts) to answer it. A one-turn probe used to just
    // record the question itself as the row's final reply and walk
    // straight into approve, which can only 400 on the still-gated field.
    // Answered ONLY when the corpus row opts in with `clarificationAnswer`
    // (the intended candidate's number or name) — absent that, the
    // question is left exactly as before so an unexpectedly-ambiguous row
    // still surfaces as evidence rather than being silently steered.
    if (
      looksLikeDisambiguationQuestion(chatFields.content) &&
      typeof corpusCase.clarificationAnswer === 'string' &&
      chatFields.conversationId
    ) {
      const follow = await api('POST', '/api/assistant/chat', {
        token,
        body: {
          messages: [{ role: 'user', content: corpusCase.clarificationAnswer }],
          inputMode: 'text',
          conversationId: chatFields.conversationId,
        },
      });
      answerTurn = { question: chatFields.content, answer: corpusCase.clarificationAnswer, status: follow.status };
      if (follow.status >= 200 && follow.status < 400) {
        httpStatus = follow.status;
        chatFields = extractChatFields(follow.json);
      }
    }
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
      // 2026-08-29 round-2 (A49/A50/D01) — `voiceOutcome.proposalIds` is the
      // LAST non-empty turn's LAST id (see driveVoiceSession), not blindly
      // the final turn's own array nor its first entry. See that function's
      // comment for the two live failure modes this replaces.
      proposalId: voiceOutcome.proposalIds?.at(-1) ?? j?.proposalIds?.[0] ?? null,
      proposalType: null,
      usage: j?.usage ?? null,
    };
    chatFields._state = j?.state ?? null;
    chatFields._proposalIds = voiceOutcome.proposalIds ?? j?.proposalIds ?? [];
    // Sum usage across every turn the voice session took (multi-turn FSM
    // rows make several classify/draft calls, not just the final one).
    const turnUsages = (voiceOutcome.allTurns ?? []).map((t) => t.usage).filter(Boolean);
    if (turnUsages.length > 0) chatFields.usage = sumUsage(turnUsages);
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
    // Widened 2026-08-29 after the full 99-row sweep: R01/R02/R04's real
    // replies ("That's an owner-level report...", "...an office-level
    // view...") are genuine lookup-dispatch RBAC refusals the narrower
    // permission|don't have access|... regex missed. Gated on isDataLookup
    // so a generic-LLM fallthrough using similar words can't false-PASS
    // (see scripts/ai-catalog-sweep/rescore.mjs's header for the C02
    // counter-example this gate exists to rule out).
    const looksLikeDenial = corpusCase.refusalHint
      ? chatFields.content.toLowerCase().includes(corpusCase.refusalHint.toLowerCase())
      : isDataLookup &&
        /permission|don't have access|not authorized|can't (share|show|see)|owner-level|office-level|ask (an owner|a dispatcher|your owner|your dispatcher)/i.test(
          chatFields.content,
        );
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
    let hintOk = corpusCase.refusalHint ? chatFields.content.toLowerCase().includes(corpusCase.refusalHint.toLowerCase()) : true;
    // C03 (2026-08-30) — 'Approve it' with NOTHING pending (this row's
    // cold-start session) is genuinely ambiguous for the classifier between
    // intent 'confirm' (bare yes) and 'approve_proposal': both are honest,
    // non-fabricating replies (transitions.ts's CONFIRM_NOTHING_PENDING_LINE
    // is itself a documented, deliberate honest-refusal branch — #846: "the
    // honest handling is a spoken re-prompt — never a voice_clarification
    // card"), so accept EITHER shape for this specific row rather than
    // widening the match generically (which could mask a real approve_
    // proposal misclassification elsewhere). refusalHint stays the PRIMARY
    // expected copy (RV-071's "tap the card...") for when a pending item
    // makes the classification unambiguous.
    if (!hintOk && corpusCase.id === 'C03' && contentOk) {
      hintOk = chatFields.content
        .toLowerCase()
        .includes("i don't have anything waiting on a yes from you just yet");
    }
    verdict = nonError && noProposal && (contentOk || chatFields._state) ? (hintOk ? 'PASS' : 'PARTIAL') : 'DEGRADED';
    outcomeClass = 'honest_refusal';
    reason = verdict === 'PASS' ? 'honest_refusal_confirmed' : 'refusal_shape_unclear';
  } else if (corpusCase.expectedOutcome === 'clarification') {
    const nonError = httpStatus >= 200 && httpStatus < 400;
    const noProposal = !proposalId;
    verdict = nonError && noProposal && (chatFields.content?.length > 0 || chatFields._state) ? 'PASS' : 'DEGRADED';
    outcomeClass = 'clarification';
    reason = verdict === 'PASS' ? 'clarification_reply' : 'no_clarification_shape';
  } else if (corpusCase.expectedOutcome === 'guard_pass') {
    // A proposal-driving row that PASSES when execution genuinely fails
    // because a documented guard fired (see OUTCOME_ENUM comment above), not
    // when it reaches 'executed'. Uses refusalHint (same field
    // honest_refusal/rbac_denied already use) to confirm the failure is the
    // EXPECTED guard, not some unrelated break.
    if (chatFields.degraded) {
      verdict = 'DEGRADED';
      outcomeClass = null;
      reason = 'llm_fallback_envelope';
    } else if (!proposalId) {
      verdict = 'PARTIAL';
      outcomeClass = null;
      reason = 'no_proposal_non_degraded';
    } else {
      approveOutcome = await approveAndAwaitExecution(token, proposalId);
      const errText = (approveOutcome.executionError || '').toLowerCase();
      const hintOk = corpusCase.refusalHint ? errText.includes(corpusCase.refusalHint.toLowerCase()) : true;
      if (approveOutcome.status === 'execution_failed' && hintOk) {
        verdict = 'PASS';
        outcomeClass = 'guard_pass';
        reason = 'guard_refusal_confirmed';
      } else if (approveOutcome.status === 'executed') {
        // The guard was expected to refuse this and didn't — a real
        // regression, not a scoring artifact, so this is FAIL rather than a
        // silent downgrade to PARTIAL.
        verdict = 'FAIL';
        outcomeClass = null;
        reason = 'guard_did_not_fire: executed';
      } else {
        verdict = 'PARTIAL';
        outcomeClass = 'guard_pass';
        reason = `execution_failed_unexpected_shape: ${approveOutcome.executionError || approveOutcome.status}`;
      }
    }
  } else {
    // executes | draft_gated — proposal-driving.
    if (chatFields.degraded) {
      verdict = 'DEGRADED';
      outcomeClass = null;
      reason = 'llm_fallback_envelope';
    } else if (!proposalId && chatFields.model === 'direct-act') {
      // 2026-08-29 round-2 (bucket-d, C01) — a DIRECT AUDITED ACT
      // (routes/assistant.ts's dedicated en_route branch: `model:
      // 'direct-act'`, `taskType: 'assistant.en_route'`) never creates a
      // proposal BY DESIGN — there is nothing to review/approve, the act
      // already happened (or, honestly, didn't — "no appointment today").
      // The generic `!proposalId → PARTIAL` branch below was written for
      // proposal-driving flows and had no carve-out for this correct,
      // deliberately-proposal-less shape, so a real PASS scored PARTIAL
      // forever. Gated strictly on `model === 'direct-act'` — never on
      // content wording alone — so a generic-LLM fallthrough claiming "done"
      // in similar words still cannot false-PASS here (same principle as
      // the isDataLookup gate above; see rescore.mjs's C02 counter-example,
      // which is exactly a generic-LLM reply that must NOT get this credit).
      const contentOk = typeof chatFields.content === 'string' && chatFields.content.length >= 5;
      verdict = contentOk ? 'PASS' : 'DEGRADED';
      outcomeClass = verdict === 'PASS' ? 'executes' : null;
      reason = verdict === 'PASS' ? 'direct_act_no_proposal_by_design' : 'direct_act_empty_reply';
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
      } else if (
        corpusCase.expectedOutcome === 'draft_gated' &&
        approveOutcome.approveCall &&
        approveOutcome.approveCall.status === 400
      ) {
        // Round 4 (D01) — a draft_gated row with approve:true exists to
        // prove the GATE, and the gate's proof IS the 400 VALIDATION_ERROR
        // from approveProposal ("cannot approve with unfilled required
        // fields"). Live evidence: proposal 639012c6 (create_appointment,
        // ready_for_review, missingFields:['customerId']) — exactly the
        // expected outcome, previously mis-scored as a poll stall. Only
        // draft_gated rows get this credit: an `executes` row whose approve
        // 400s is still a PARTIAL.
        verdict = 'PASS';
        outcomeClass = 'draft_gated';
        reason = 'approve_refused_gate_proven';
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
    usage: chatFields.usage ?? null,
    approve: approveOutcome,
    dbVerify,
    ...(answerTurn ? { answerTurn } : {}),
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
  const usageTotals = { input: 0, output: 0, total: 0, rowsWithUsage: 0 };
  for (const r of results) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    if (r.outcomeClass) countsByOutcomeClass[r.outcomeClass] = (countsByOutcomeClass[r.outcomeClass] || 0) + 1;
    if (r.usage) {
      usageTotals.input += Number(r.usage.input) || 0;
      usageTotals.output += Number(r.usage.output) || 0;
      usageTotals.total += Number(r.usage.total) || 0;
      usageTotals.rowsWithUsage += 1;
    }
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
    usageTotals,
    results: cases.filter((c) => runSet.includes(c) || resultsMap.has(c.id)).map((c) => resultsMap.get(c.id)).filter(Boolean),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `sweep-${stamp()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('\n=== Scoreboard ===');
  console.log(counts);
  console.log(countsByOutcomeClass);
  console.log('Usage totals:', usageTotals);
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
