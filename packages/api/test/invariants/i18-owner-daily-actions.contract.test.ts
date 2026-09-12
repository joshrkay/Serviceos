/**
 * I18 — owner daily actions ↔ code contract. (PRD §5 row I18; built per §5.0c (a)+(b).)
 *
 * I18 is the product's founding promise: *"no feature ships that adds admin
 * work to the owner's day."* Its acceptance clause is
 *
 *   Given any owner-role action required on a normal day, then it is reachable
 *   by SMS, one-tap or voice — or is in a reviewed exemption list.
 *
 * Until this file existed the invariant had nothing behind it. This test makes
 * it falsifiable by pinning `docs/reference/owner-daily-actions.md` to the code,
 * the same shape `test/ai/voice-action-catalog.contract.test.ts` uses for the
 * voice catalog and `test/app/route-manifest.test.ts` uses for route exposure.
 *
 * ── The definition this test enforces ────────────────────────────────────────
 *
 * DERIVED SET — every **owner-only** route the booted app serves, from two arms
 * of deliberately different strength:
 *   (1) EXECUTED GUARDS — the guard chain Express actually runs for the route
 *       admits `owner` and refuses BOTH `dispatcher` and `technician`;
 *   (2) DECLARED IN-HANDLER — the route gates on owner inside its handler,
 *       where the walker cannot see it. Declared, then cross-checked against
 *       the mounted app and the source. See IN_HANDLER_OWNER_ROUTES.
 *
 * REQUIRED ON A NORMAL DAY — a row's `cadence`:
 *   `daily`      the ordinary flow of a day's jobs and calls forces the owner
 *                through it (the trigger is the work, not a decision to
 *                reconfigure the business);
 *   `onboarding` the tenant cannot operate until the owner does it, once;
 *   `occasional` owner-only administration no normal day forces — configuration,
 *                cleanup, deletions, team management, optional features.
 * `daily` + `onboarding` are the required set I18 governs. Each must be
 * reachable off the web or carry an `exemption_reason` — the reviewed exemption
 * list the invariant allows. `occasional` rows are still listed, because this
 * test accounts for EVERY owner-only route and fails on any it cannot find in
 * the doc. The per-row judgment is recorded in the doc's `why` column.
 *
 * ── How the derivation works, and why it is not a grep ───────────────────────
 *
 * `createApp()` is booted with no Clerk instance and no AI key, but WITH a
 * DATABASE_URL — a pool must exist or ~20 routers never mount (`app.ts` guards
 * several with `if (pool)` / `if (<pool-backed repo>)`, and the owner-only
 * `/api/entity-aliases` is one of them). pg.Pool connects lazily and this test
 * only walks the router stack, so no query is ever issued. Its real Express
 * layer stack is then walked. For every route, the guards Express would actually run are collected
 * — router-level `use` middleware registered ahead of it plus the route's own
 * stack — and each is EXECUTED against a synthetic request for `owner`,
 * `dispatcher` and `technician` in turn. A guard is recognised as a role guard
 * only by the refusal strings `requireRole` / `requirePermission` emit; whether
 * it is owner-only is then decided by what it DOES, not by what it is called.
 *
 * That matters for three reasons:
 *   - the owner gate is not one mechanism. 13 sites use `requireRole('owner')`;
 *     far more are owner-only because they demand a permission only `owner`
 *     holds in `ROLE_PERMISSIONS` (`settings:update`, `tenant:manage`,
 *     `attachments:visibility`, …). Executing both settles it uniformly;
 *   - a doc-comment naming `requireRole('owner')` is not a wiring, and a guard
 *     that never calls `next()` is not an owner gate. Both are pinned by the
 *     negative controls below;
 *   - the route table comes from the app the deploy boots, not from a fixture.
 *
 * Reachability claims are resolved against code too, never taken on trust:
 * `voice_intent:` against SUPPORTED_INTENTS ∩ INTENT_TO_PROPOSAL_TYPE (a
 * lookup-only intent cannot perform an action, so it does not count),
 * `keyword:` against the inbound-SMS registry as the booted app populated it,
 * `one_tap:` against a route the booted app actually mounts.
 *
 * THREE KNOWN LIMITS, stated rather than hidden:
 *
 *  1. In a 1–3-truck shop the owner is often the only user, so they perform
 *     plenty of actions that are not owner-ONLY and therefore never enter this
 *     inventory. §5.0c specifies this derivation ("every `role: owner` route");
 *     it is a lower bound on I18's real surface, not the whole of it.
 *  2. Arm (2) is source-declared, not executed: `asyncRoute` hides the handler
 *     inside a wrapper, and the handler cannot be safely probed (it reaches a
 *     repository and throws for unrelated reasons). It is weaker evidence, and
 *     `filesWithInHandlerOwnerChecks` fails the build when a NEW file starts
 *     gating this way so the weakness cannot spread unnoticed.
 *  3. A channel claim is checked for EXISTENCE and for UNIQUENESS across rows,
 *     not for performing that row's specific action — proving voice intent X
 *     does the same thing as HTTP route Y would need a route → action → channel
 *     map, and the two universes (Express handler vs. proposal type + execution
 *     handler) are joined nowhere in this codebase. The per-row binding is
 *     human-reviewed. See `duplicateChannelClaims` for what that does and does
 *     not close.
 */
import { promises as fs } from 'fs';
import path from 'path';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';
import { requireRole } from '../../src/middleware/auth';
import { SUPPORTED_INTENTS } from '../../src/ai/orchestration/intent-classifier';
import { INTENT_TO_PROPOSAL_TYPE } from '../../src/workers/voice-action-router';
import {
  registerKeywordHandler,
  __resetKeywordRegistryForTests,
  type InboundSmsContext,
  type HandlerResult,
} from '../../src/sms/inbound-dispatch';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INVENTORY_PATH = path.resolve(REPO_ROOT, 'docs/reference/owner-daily-actions.md');

/** PRD §5.0c (b) — the budget. A PR that moves one of these is self-documenting. */
const OWNER_REQUIRED_DAILY_WEB_ACTIONS = 1;
const OWNER_REQUIRED_ONBOARDING_WEB_ACTIONS = 6;
const OWNER_ONLY_ROUTES = 54;

// ── Derivation ──────────────────────────────────────────────────────────────

type Layer = {
  name?: string;
  regexp: RegExp & { fast_slash?: boolean };
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Layer[];
  };
  handle?: unknown;
};

/** Same Express-4 regexp decoding as src/app-route-manifest.ts. */
function decodeLayerPath(regexp: RegExp & { fast_slash?: boolean }): string {
  if (regexp.fast_slash) return '';
  const source = regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\/\?\$$/, '')
    .replace(/\$$/, '');
  const decoded = source.replace(/\\\//g, '/');
  if (/[()[\]?+*|]/.test(decoded)) return `(dynamic: ${regexp.source})`;
  return decoded;
}

/**
 * Recognises a role guard by the refusal it emits. `requireRole` answers
 * 'Insufficient role' and `requirePermission` answers 'Insufficient
 * permissions' (middleware/auth.ts); nothing else in the app does. Recognition
 * only selects what is safe to probe — the owner-only VERDICT comes from
 * running it.
 */
function isRoleGuard(fn: unknown): fn is express.RequestHandler {
  if (typeof fn !== 'function' || fn.length !== 3) return false;
  const source = Function.prototype.toString.call(fn);
  return (
    source.includes('Insufficient role') || source.includes('Insufficient permissions')
  );
}

/** Runs a guard for one role and reports whether it called next(). */
function guardAdmits(guard: express.RequestHandler, role: string): boolean {
  let admitted = false;
  const req = {
    auth: { userId: 'probe-user', tenantId: 'probe-tenant', role },
    params: {},
    body: {},
    path: '/probe',
  } as unknown as express.Request;
  const res = {} as express.Response;
  Object.assign(res, {
    status: () => res,
    json: () => res,
    send: () => res,
  });
  try {
    guard(req, res, () => {
      admitted = true;
    });
  } catch {
    return false;
  }
  return admitted;
}

const NON_OWNER_ROLES = ['dispatcher', 'technician'] as const;

/**
 * Whether the CHAIN — not any one guard in it — is owner-only.
 *
 * Reaching the handler means passing every guard in order, so a role reaches
 * the route iff it is admitted by all of them; it is refused iff at least one
 * refuses it. Asking instead whether any SINGLE guard is owner-only misses a
 * route composed of guards that are each individually permissive:
 * `requireRole('owner','dispatcher')` then `requireRole('owner','technician')`
 * admits only `owner`, yet neither guard alone refuses both non-owner roles.
 * That route would drop out of the inventory silently and the doc and budget
 * checks would never fire on it — the dangerous direction, since the whole
 * point is to catch owner work nobody wrote down. Pinned by the composed
 * negative control below. (Found in review of #1073 by xhawk-ai.)
 *
 * Caveat worth knowing if this ever stops matching reality: `guards` includes
 * router-level `use` middleware registered ahead of the route without checking
 * that the `use` mount path covers it. No router in the app attaches a role
 * guard via `use` today (every one is per-route), so the set is exact; a
 * path-scoped `router.use('/admin', requireRole('owner'))` would need the mount
 * comparison added here before this stayed true.
 */
function isOwnerOnly(guards: express.RequestHandler[]): boolean {
  if (guards.length === 0) return false;
  const chainAdmits = (role: string): boolean =>
    guards.every((guard) => guardAdmits(guard, role));
  return chainAdmits('owner') && NON_OWNER_ROLES.every((role) => !chainAdmits(role));
}

/**
 * Walks a booted app and returns `METHOD /path` for every route whose executed
 * guard chain is owner-only. Express 4: `app.router` throws, so `_router` is
 * the only way in (same note as src/app-route-manifest.ts).
 */
export function deriveOwnerOnlyRoutes(app: express.Express): string[] {
  const root = (app as unknown as { _router?: { stack?: Layer[] } })._router;
  if (!root?.stack) {
    throw new Error(
      'Could not read the Express router stack. If Express was upgraded past 4.x, ' +
        'this derivation needs updating (5.x exposes `app.router` instead of `_router`).',
    );
  }

  const found: string[] = [];
  const walk = (
    stack: Layer[],
    prefix: string,
    inherited: express.RequestHandler[],
  ): void => {
    // Guards accumulate in registration order: a `use` only covers routes
    // registered after it, which is exactly Express's own semantics.
    const pending = [...inherited];
    for (const layer of stack) {
      if (layer.name === 'query' || layer.name === 'expressInit') continue;

      if (layer.route) {
        const guards = [...pending, ...layer.route.stack.map((sub) => sub.handle)].filter(
          isRoleGuard,
        );
        if (!isOwnerOnly(guards)) continue;
        const methods = Object.keys(layer.route.methods)
          .map((m) => m.toUpperCase())
          .sort()
          .join('|');
        const paths = Array.isArray(layer.route.path)
          ? layer.route.path
          : [layer.route.path];
        for (const p of paths) found.push(`${methods} ${prefix}${p}`);
        continue;
      }

      const nested = (layer.handle as { stack?: Layer[] } | undefined)?.stack;
      if (nested) {
        walk(nested, prefix + decodeLayerPath(layer.regexp), pending);
        continue;
      }
      if (isRoleGuard(layer.handle)) pending.push(layer.handle);
    }
  };

  walk(root.stack, '', []);
  return [...found].sort();
}

/**
 * Routes that gate on owner INSIDE the handler, where the guard walker cannot
 * see them.
 *
 * `asyncRoute(fn)` returns a wrapper whose source contains neither refusal
 * string, and `fn` itself cannot be safely executed by a probe (it would reach
 * a repository, and it throws for unrelated reasons — a missing param, a
 * missing canonical user — so "did it admit the owner?" is not answerable by
 * running it). So this arm is DECLARED, and then checked from two sides so the
 * declaration cannot rot:
 *
 *   - the route must actually be mounted by the booted app (it cannot be
 *     fictional, or left behind after a route is deleted);
 *   - the file must still contain an unconditional owner comparison (it cannot
 *     be left behind after the check moves into a middleware guard).
 *
 * And `inHandlerOwnerCheckFiles` below fails the build when any NEW file starts
 * gating on owner this way, so a future one cannot slip in unnoticed.
 *
 * This is weaker evidence than the executed-guard arm and is labelled as such.
 * (Codex, #1073: `PATCH /api/entity-aliases/:id/deactivate` is owner-only —
 * "Owner-only revoke path for learned tenant aliases" — and the first version
 * of this test missed it on both counts, being DB-gated at the mount AND
 * in-handler at the check.)
 */
const IN_HANDLER_OWNER_ROUTES: ReadonlyArray<{ route: string; source: string }> = [
  {
    route: 'PATCH /api/entity-aliases/:id/deactivate',
    source: 'packages/api/src/routes/entity-aliases.ts',
  },
];

/**
 * Every file with an UNCONDITIONAL `req.auth.role` owner comparison — the shape
 * that makes a whole route owner-only.
 *
 * A conditional one (`targetId !== actor.id && req.auth!.role !== 'owner'`, as
 * in `routes/users.ts`) does NOT make a route owner-only: a technician reaches
 * it for their own record, so it is self-service with an owner escalation, and
 * it correctly stays out of the inventory. The distinction is the `&&`, so the
 * scan records every hit and the assertion below classifies them.
 */
async function filesWithInHandlerOwnerChecks(): Promise<string[]> {
  const srcRoot = path.resolve(__dirname, '../../src');
  const pattern = /req\.auth!?\??\.role\s*[!=]==\s*'owner'/;
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const text = await fs.readFile(full, 'utf8');
      if (pattern.test(text)) {
        found.push(path.relative(path.resolve(__dirname, '../../../..'), full));
      }
    }
  };

  await walk(srcRoot);
  return found.sort();
}

/** Every `METHOD /path` the booted app mounts, owner-only or not. */
function allMountedRoutes(app: express.Express): Set<string> {
  const root = (app as unknown as { _router?: { stack?: Layer[] } })._router;
  const all = new Set<string>();
  const walk = (stack: Layer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path)
          ? layer.route.path
          : [layer.route.path];
        for (const method of Object.keys(layer.route.methods)) {
          for (const p of paths) all.add(`${method.toUpperCase()} ${prefix}${p}`);
        }
        continue;
      }
      const nested = (layer.handle as { stack?: Layer[] } | undefined)?.stack;
      if (nested) walk(nested, prefix + decodeLayerPath(layer.regexp));
    }
  };
  walk(root?.stack ?? [], '');
  return all;
}

// ── Channels ────────────────────────────────────────────────────────────────

/**
 * Probes the REAL inbound-SMS registry the booted app populated. There is no
 * "list registered keywords" export, so registration is used as the oracle:
 * `registerKeywordHandler` throws on a duplicate unless `overwrite` is set, so
 * a throw means the token is already claimed. A probe that does NOT throw
 * claims the token, which is why each token is probed exactly once and the
 * registry is reset in afterAll.
 */
function keywordIsRegistered(token: string): boolean {
  const probe = {
    keywords: [token],
    handle: async (_ctx: InboundSmsContext): Promise<HandlerResult> => ({
      handled: false,
    }),
  };
  try {
    registerKeywordHandler(probe);
    return false;
  } catch (err) {
    if (err instanceof Error && err.message.includes('duplicate keyword registration'))
      return true;
    throw err;
  }
}

const VOICE_ACTION_INTENTS = new Set(
  SUPPORTED_INTENTS.filter((intent) => intent in INTENT_TO_PROPOSAL_TYPE),
);

/**
 * Channel claims must be unique across the inventory.
 *
 * `channelReaches` answers "does this channel exist?", not "does this channel
 * perform THIS row's action" — it never sees the row's route. So a row could
 * name a real-but-unrelated channel (marking some other daily route
 * `voice_intent:add_catalog_item`), stay green, and drop itself out of
 * `ownerRequiredDailyWebActions`. Uniqueness closes the realistic version of
 * that — copy-paste drift, and reusing a channel another row already owns.
 *
 * It does NOT close the general case, and nothing here pretends otherwise:
 * proving that voice intent X performs the same business action as HTTP route Y
 * would need a route → action → channel map, and no such map exists in this
 * codebase — a route reaches its action through an Express handler, an intent
 * through a proposal type and an execution handler, and the two universes are
 * joined nowhere. **The route ↔ channel binding in each row is therefore
 * human-reviewed, not derived**, and that is a stated ceiling of this contract
 * rather than a gap someone forgot. (Raised in review of #1073 by Codex.)
 */
function duplicateChannelClaims(rows: InventoryRow[]): string[] {
  const claimedBy = new Map<string, string>();
  const duplicates: string[] = [];
  for (const row of rows) {
    if (!row.smsReachable) continue;
    const prior = claimedBy.get(row.reachedVia);
    if (prior !== undefined) {
      duplicates.push(`${row.reachedVia} claimed by both ${prior} and ${row.route}`);
    } else {
      claimedBy.set(row.reachedVia, row.route);
    }
  }
  return duplicates;
}

/** Resolves a `reached_via` claim against code. Unknown prefix → not reached. */
function channelReaches(reachedVia: string, mountedRoutes: Set<string>): boolean {
  const separator = reachedVia.indexOf(':');
  if (separator < 0) return false;
  const kind = reachedVia.slice(0, separator);
  const value = reachedVia.slice(separator + 1);
  if (!value) return false;

  switch (kind) {
    case 'voice_intent':
      // Must be speakable AND produce a proposal: a lookup_* intent is
      // read-only, so it can never stand in for an action.
      return VOICE_ACTION_INTENTS.has(value as (typeof SUPPORTED_INTENTS)[number]);
    case 'keyword':
      return keywordIsRegistered(value.toLowerCase());
    case 'one_tap':
      return [...mountedRoutes].some((route) => route.endsWith(` ${value}`));
    default:
      return false;
  }
}

// ── The doc ─────────────────────────────────────────────────────────────────

interface InventoryRow {
  route: string;
  cadence: 'daily' | 'onboarding' | 'occasional';
  why: string;
  smsReachable: boolean;
  reachedVia: string;
  exemptionReason: string;
}

interface Inventory {
  rows: InventoryRow[];
  budget: Record<string, number>;
}

function sliceBetween(md: string, marker: string): string {
  const begin = md.indexOf(`<!-- BEGIN machine-readable: ${marker} -->`);
  const end = md.indexOf(`<!-- END machine-readable: ${marker} -->`);
  if (begin < 0 || end < 0) {
    throw new Error(
      `owner-daily-actions: machine-readable markers for '${marker}' not found`,
    );
  }
  return md.slice(begin, end);
}

async function loadInventory(): Promise<Inventory> {
  const md = await fs.readFile(INVENTORY_PATH, 'utf8');

  const table = sliceBetween(md, 'owner-daily-actions');
  const rows: InventoryRow[] = [];
  for (const line of table.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined).split('|');
    if (cells.length !== 6) continue;
    const [route, cadence, why, smsReachable, reachedVia, exemptionReason] = cells.map(
      (c) => c.trim().replace(/^`|`$/g, '').trim(),
    );
    if (route === 'route' || /^-+$/.test(route)) continue; // header + separator
    rows.push({
      route,
      cadence: cadence as InventoryRow['cadence'],
      why,
      smsReachable: smsReachable === 'true',
      reachedVia: reachedVia || 'none',
      exemptionReason,
    });
  }

  const budgetBlock = sliceBetween(md, 'owner-daily-actions-budget');
  const jsonStart = budgetBlock.indexOf('{');
  const jsonEnd = budgetBlock.lastIndexOf('}');
  const budget = JSON.parse(budgetBlock.slice(jsonStart, jsonEnd + 1)) as Record<
    string,
    number
  >;

  return { rows, budget };
}

const REQUIRED_CADENCES = new Set(['daily', 'onboarding']);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('I18: owner daily actions ↔ code contract', () => {
  let app: AppWithLifecycle;
  let derived: string[];
  let mounted: Set<string>;
  let inventory: Inventory;
  let prevEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    // Same hermetic boot as test/app/route-manifest.test.ts: no Postgres, no
    // Clerk instance, no AI key.
    prevEnv = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      DATABASE_URL: process.env.DATABASE_URL,
      AI_PROVIDER_API_KEY: process.env.AI_PROVIDER_API_KEY,
      CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    // A pool must EXIST or ~20 routers never mount — `app.ts` guards several
    // with `if (pool)` / `if (<pool-backed repo>)`, and `/api/entity-aliases`
    // (owner-only) is one of them. pg.Pool connects lazily, so constructing it
    // opens no socket, and this test only walks the router stack: no query is
    // ever issued against this URL. Booting without it derived a route set that
    // silently excluded every DB-gated owner surface. (Codex, #1073.)
    process.env.DATABASE_URL = 'postgres://i18-contract:unused@127.0.0.1:1/unused';
    delete process.env.AI_PROVIDER_API_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    resetConfig();

    app = createApp();
    // Two arms, deliberately distinct in strength: routes proven owner-only by
    // EXECUTING their guards, plus the declared in-handler ones the walker
    // cannot see. Both are checked against the doc; the second is additionally
    // checked for still being mounted and still containing its check.
    derived = [
      ...deriveOwnerOnlyRoutes(app),
      ...IN_HANDLER_OWNER_ROUTES.map((r) => r.route),
    ].sort();
    mounted = allMountedRoutes(app);
    inventory = await loadInventory();
  });

  afterAll(async () => {
    __resetKeywordRegistryForTests();
    await app.gracefulDrain('i18-contract-test');
    resetConfig();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('derives a non-vacuous owner-only route set from the booted app', () => {
    // A derivation that silently returned [] would make every comparison below
    // pass. Pin a floor and a route known to be owner-gated by each mechanism:
    // requireRole('owner') and an owner-only permission.
    expect(derived.length).toBeGreaterThan(40);
    expect(derived).toContain('PUT /api/onboarding/identity'); // requireRole('owner')
    expect(derived).toContain('PUT /api/settings/'); // requirePermission('settings:update')
  });

  it('keeps every declared in-handler owner route mounted and still gated', async () => {
    // The declaration cannot be fictional: the app must really mount it.
    for (const { route } of IN_HANDLER_OWNER_ROUTES) {
      expect(
        mounted,
        `${route} is declared in-handler owner-only but not mounted`,
      ).toContain(route);
    }
    // …and it cannot be stale: the check must still be in the source. If it
    // moved into a middleware guard, the executed-guard arm now covers it and
    // this declaration must be deleted, or the route is counted twice.
    for (const { route, source } of IN_HANDLER_OWNER_ROUTES) {
      const text = await fs.readFile(path.resolve(REPO_ROOT, source), 'utf8');
      expect(text, `${route}: ${source} no longer gates on owner in the handler`).toMatch(
        /req\.auth!?\??\.role\s*[!=]==\s*'owner'/,
      );
      expect(
        deriveOwnerOnlyRoutes(app),
        `${route} is now guard-gated — remove it from IN_HANDLER_OWNER_ROUTES`,
      ).not.toContain(route);
    }
  });

  it('notices any NEW route that gates on owner inside its handler', async () => {
    // The walker cannot see these, so the build has to. A new file here means:
    // decide whether its check is unconditional (the route is owner-only → it
    // belongs in the inventory and in IN_HANDLER_OWNER_ROUTES) or conditional
    // (self-service with an owner escalation → not owner-only, annotate here).
    expect(await filesWithInHandlerOwnerChecks()).toEqual([
      // Unconditional — owner-only. Declared in IN_HANDLER_OWNER_ROUTES.
      'packages/api/src/routes/entity-aliases.ts',
      // Conditional (`targetId !== actor.id && … !== 'owner'`): a technician
      // reaches these for their OWN record, so they are self-service with an
      // owner escalation, not owner-only actions. Deliberately not inventory.
      'packages/api/src/routes/users.ts',
    ]);
  });

  it('lists each route exactly once, and exactly as many rows as routes', () => {
    // Both divergence checks below compare SETS, which silently collapse a
    // route listed twice — and a duplicate is not harmless: the two copies can
    // carry contradictory cadence or reachability, and the cadence counts are
    // taken from the ROWS while the route budget is taken from `derived`, so a
    // duplicate `daily` copy claiming an otherwise-unused intent could ride
    // along once the JSON counts were updated to match. Pin the row count to
    // the route count so the two can never drift. (Codex, #1073.)
    const seen = new Set<string>();
    const duplicates = inventory.rows
      .map((r) => r.route)
      .filter((route) => (seen.has(route) ? true : (seen.add(route), false)));
    expect(duplicates).toEqual([]);
    expect(inventory.rows).toHaveLength(derived.length);
  });

  it('lists every owner-only route in code (no undocumented owner surface)', () => {
    const documented = new Set(inventory.rows.map((r) => r.route));
    const missingFromDoc = derived.filter((route) => !documented.has(route));
    // If this fails, an owner-only route was added without a line in
    // docs/reference/owner-daily-actions.md saying whether the owner's day now
    // costs more. That line is the I18 review.
    expect(missingFromDoc).toEqual([]);
  });

  it('lists no route the code does not serve (no rotted doc row)', () => {
    const inCode = new Set(derived);
    const stale = inventory.rows
      .map((r) => r.route)
      .filter((route) => !inCode.has(route));
    expect(stale).toEqual([]);
  });

  it('gives every row a cadence and a reason', () => {
    for (const row of inventory.rows) {
      expect(['daily', 'onboarding', 'occasional'], `${row.route} cadence`).toContain(
        row.cadence,
      );
      expect(row.why.length, `${row.route} has no why`).toBeGreaterThan(0);
    }
  });

  it('resolves every sms_reachable: true claim against a real channel', () => {
    const claimed = inventory.rows.filter((r) => r.smsReachable);
    expect(claimed.length).toBeGreaterThan(0);
    for (const row of claimed) {
      expect(
        channelReaches(row.reachedVia, mounted),
        `${row.route} → ${row.reachedVia}`,
      ).toBe(true);
    }
  });

  it('binds each channel claim to exactly one action', () => {
    expect(duplicateChannelClaims(inventory.rows)).toEqual([]);
  });

  it('leaves reached_via as none wherever sms_reachable is false', () => {
    for (const row of inventory.rows) {
      if (row.smsReachable) continue;
      expect(row.reachedVia, `${row.route}`).toBe('none');
    }
  });

  it('puts every unreachable required action in the reviewed exemption list', () => {
    // I18's own escape hatch: reachable by SMS/one-tap/voice, OR reviewed and
    // written down with a reason. Nothing required may be silently web-only.
    const unreviewed = inventory.rows.filter(
      (r) =>
        REQUIRED_CADENCES.has(r.cadence) &&
        !r.smsReachable &&
        r.exemptionReason.length === 0,
    );
    expect(unreviewed.map((r) => r.route)).toEqual([]);
  });

  // ── PRD §5.0c (b): the budget ──────────────────────────────────────────────

  it('holds the owner-required daily web-action budget', () => {
    const ownerRequiredDailyWebActions = inventory.rows.filter(
      (r) => r.cadence === 'daily' && !r.smsReachable,
    );
    expect(ownerRequiredDailyWebActions).toHaveLength(OWNER_REQUIRED_DAILY_WEB_ACTIONS);
  });

  it('holds the owner-required onboarding web-action budget', () => {
    const ownerRequiredOnboardingWebActions = inventory.rows.filter(
      (r) => r.cadence === 'onboarding' && !r.smsReachable,
    );
    expect(ownerRequiredOnboardingWebActions).toHaveLength(
      OWNER_REQUIRED_ONBOARDING_WEB_ACTIONS,
    );
  });

  it('holds the owner-only route budget', () => {
    expect(derived).toHaveLength(OWNER_ONLY_ROUTES);
  });

  it('keeps the budget block in the doc equal to the derived counts', () => {
    const count = (cadence: string): number =>
      inventory.rows.filter((r) => r.cadence === cadence).length;
    expect(inventory.budget).toEqual({
      ownerOnlyRoutes: derived.length,
      daily: count('daily'),
      onboarding: count('onboarding'),
      occasional: count('occasional'),
      ownerRequiredDailyWebActions: inventory.rows.filter(
        (r) => r.cadence === 'daily' && !r.smsReachable,
      ).length,
      ownerRequiredOnboardingWebActions: inventory.rows.filter(
        (r) => r.cadence === 'onboarding' && !r.smsReachable,
      ).length,
    });
  });
  /**
   * Negative controls (PRD §8.0 — a STRUCTURAL test without them proves only
   * that today's tree is today's tree). Each plants the exact failure this
   * contract exists to catch and asserts the machinery catches it. Nested so
   * they run against the SAME booted app: the keyword probe below is only
   * meaningful while the registry createApp() populated is still live.
   */
  describe('negative controls', () => {
    it('catches a planted owner-only route that is not in the doc', async () => {
      const planted = express();
      const router = express.Router();
      // The real guard, not a stand-in.
      router.get('/planted', requireRole('owner'), (_req, res) => res.json({}));
      planted.use('/api/planted-surface', router);

      const plantedRoutes = deriveOwnerOnlyRoutes(planted);
      expect(plantedRoutes).toContain('GET /api/planted-surface/planted');

      const documented = new Set((await loadInventory()).rows.map((r) => r.route));
      const missingFromDoc = plantedRoutes.filter((route) => !documented.has(route));
      // This is the assertion the real contract makes; here it must FIND the
      // divergence, which proves it is not vacuous there.
      expect(missingFromDoc).toEqual(['GET /api/planted-surface/planted']);
    });

    it('does not count a route that only mentions the guard in a comment', () => {
      const planted = express();
      const router = express.Router();
      router.get('/comment-only', (_req, _res, _next) => {
        // requireRole('owner') — and the words Insufficient role / Insufficient
        // permissions — appear here in prose only. Nothing guards this route.
      });
      planted.use('/api/planted-surface', router);

      // The handler's SOURCE matches the guard-recognition strings, so string
      // matching alone would count it. Executing it does not admit the owner, so
      // the derivation correctly does not.
      expect(deriveOwnerOnlyRoutes(planted)).toEqual([]);
    });

    it('does not count a route reachable by a non-owner role', () => {
      const planted = express();
      const router = express.Router();
      router.get('/shared', requireRole('owner', 'dispatcher'), (_req, res) =>
        res.json({}),
      );
      planted.use('/api/planted-surface', router);

      expect(deriveOwnerOnlyRoutes(planted)).toEqual([]);
    });

    /**
     * Composed owner-only: NEITHER guard rejects both non-owner roles on its
     * own, but the CHAIN does — dispatcher fails the second, technician fails
     * the first, and only owner passes both. A route like this is owner-only at
     * runtime, so it must be derived; missing it would drop an owner web action
     * out of the inventory silently, and the doc and budget checks would never
     * fire on it. (xhawk-ai review, #1073: the first implementation asked
     * whether ANY SINGLE guard was owner-only, and missed exactly this.)
     */
    it('counts a route made owner-only by the chain, not by one guard', () => {
      const planted = express();
      const router = express.Router();
      router.get(
        '/composed',
        requireRole('owner', 'dispatcher'),
        requireRole('owner', 'technician'),
        (_req, res) => res.json({}),
      );
      planted.use('/api/planted-surface', router);

      expect(deriveOwnerOnlyRoutes(planted)).toEqual([
        'GET /api/planted-surface/composed',
      ]);
    });

    it('catches two rows claiming the same channel', () => {
      const row = (route: string, reachedVia: string): InventoryRow => ({
        route,
        cadence: 'daily',
        why: 'planted',
        smsReachable: true,
        reachedVia,
        exemptionReason: '',
      });
      // The literal drift Codex named: a second row helping itself to a
      // channel that already belongs to the catalog row, which would quietly
      // remove it from ownerRequiredDailyWebActions.
      const planted = [
        row('POST /api/catalog/items/', 'voice_intent:add_catalog_item'),
        row('POST /api/some/other/surface', 'voice_intent:add_catalog_item'),
      ];
      expect(duplicateChannelClaims(planted)).toHaveLength(1);
      // An unreachable row carries no claim, so it can never collide.
      expect(
        duplicateChannelClaims([
          { ...row('POST /a', 'none'), smsReachable: false },
          { ...row('POST /b', 'none'), smsReachable: false },
        ]),
      ).toHaveLength(0);
    });

    it('rejects a reached_via claim no channel actually reaches', () => {
      expect(channelReaches('voice_intent:definitely_not_an_intent', mounted)).toBe(
        false,
      );
      // A real, supported intent — but lookup-only, so it is read-only and can
      // never stand in for performing the action.
      expect(channelReaches('voice_intent:lookup_invoices', mounted)).toBe(false);
      expect(channelReaches('keyword:zzz-not-a-registered-keyword', mounted)).toBe(false);
      expect(channelReaches('one_tap:/public/proposals/not-mounted', mounted)).toBe(
        false,
      );
      expect(channelReaches('none', mounted)).toBe(false);
      expect(channelReaches('telepathy:just-know', mounted)).toBe(false);
    });

    it('resolves a claim every channel really does reach', () => {
      expect(channelReaches('voice_intent:add_catalog_item', mounted)).toBe(true);
      // 'y' is an APPROVE token the proposal-reply handler registers at boot.
      expect(channelReaches('keyword:Y', mounted)).toBe(true);
      expect(channelReaches('one_tap:/public/proposals/one-tap-approve', mounted)).toBe(
        true,
      );
      expect(channelReaches('one_tap:/public/proposals/one-tap-undo', mounted)).toBe(
        true,
      );
    });

    it('does not parse a route mentioned in the doc outside the machine-readable block', async () => {
      const { rows } = await loadInventory();
      const routes = rows.map((r) => r.route);
      // The doc's closing prose names these; only table rows inside the markers
      // are inventory.
      expect(routes).not.toContain('GET /api/nonexistent');
    });
  });
});
