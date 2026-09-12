/**
 * I16 (STRUCTURAL) — #1072: every telephony webhook handler that takes its
 * tenant from a CALLER-SUPPLIED identifier must check that tenant against the
 * credential that verified the request, before it writes.
 *
 * ## Why this guard exists, in one paragraph
 *
 * #1072 was filed as one bug: the signing credential came from the payload's
 * `AccountSid` and the tenant from the payload's `To`, and nothing compared
 * them. Binding the credential to the dialled number fixed that instance — and
 * review then found the same shape four more times, because these handlers
 * choose the tenant they act as from a SECOND caller-supplied field: a `?sid=`
 * (`/gather`, `/dial-result`, `/callback-message`), a `CallSid` resolved to a
 * session (`/recording`, `/voicemail-status`, `/voice/gather-fallback`), or a
 * payload alias the binding did not read (`Called` where the binding took
 * `To`). Each fix closed an instance; none closed the class. Five findings,
 * every one from review, none from the behavioural tests — which all passed,
 * every time, because they exercise the handlers that exist rather than the
 * one added next month.
 *
 * A behavioural test cannot pin this: it can only prove that today's handlers
 * refuse today's forgeries. The invariant is about a handler that does not
 * exist yet. So it is pinned structurally — add a telephony handler that
 * resolves a tenant from a session or a payload alias and writes without
 * consulting the verifying credential, and this fails the build with the
 * file:line.
 *
 * ## The rule
 *
 * For each `router.get`/`router.post` handler in the telephony webhook
 * modules: if its body binds a tenant from a session (`session.tenantId`,
 * `findByCallSid`, `store.get`) or from a payload-alias resolver
 * (`resolveTenantId`, `resolveTenantIdFallback`), then its body must also call
 * `sessionBelongsToAnotherTenant(` or `actingTenantMismatchesCredential(`.
 *
 * ## The one exception, named rather than pattern-matched away
 *
 * `resolveInboundTenantId` is NOT a payload-alias resolver: it resolves the
 * tenant from the dialled number through `phoneNumberRepo`, which is the very
 * field the credential was bound to (`twilio-webhook-credential.ts`), so the
 * agreement is structural — there is nothing to compare that is not already
 * equal. `/voice` and the fresh-session branch of `/voice/gather-fallback` use
 * it and are therefore exempt from the guard requirement. (The dev-only
 * `TWILIO_DEFAULT_TENANT_ID` seam inside that resolver is the one place this
 * can still diverge; it is refused in production/staging and is tracked on
 * #1084, not papered over here.)
 *
 * Evidence class: STRUCTURAL — the negative controls plant an unguarded
 * session-bound handler and an unguarded fallback-bound handler, and prove the
 * guard is per-handler by planting one compliant handler beside one that is
 * not.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  stripComments,
  plantTree,
  removeTree,
  toPosix,
  type Violation,
} from '../support/structural-scan';

const API_ROOT = path.resolve(__dirname, '../..');

/** The telephony webhook modules whose handlers this rule governs. */
const GOVERNED = [
  'src/routes/telephony.ts',
  'src/telephony/recording-webhook.ts',
  'src/telephony/voicemail-status-route.ts',
] as const;

/** Binds a tenant from something the CALLER chose. */
const TENANT_FROM_CALLER = [
  /session\??\.tenantId/,
  /findByCallSid\(/,
  /store\.get\(/,
  /resolveTenantIdFallback\(/,
  /deps\.resolveTenantId\(/,
] as const;

/** The two shapes of the check. Either satisfies the rule. */
const GUARD_CALLS = [
  /sessionBelongsToAnotherTenant\(/,
  /actingTenantMismatchesCredential\(/,
] as const;

interface Handler {
  readonly rel: string;
  /** e.g. `post '/gather'` — enough to name it in a failure. */
  readonly name: string;
  readonly line: number;
  /** Comment-stripped body text. */
  readonly body: string;
}

/**
 * Walk from `start` and return the index just past the block that opens at the
 * first `{` following the first `=>`. Quote, template and escape states are
 * tracked so a brace inside a string or a TwiML template cannot end the block
 * early — these files are full of both.
 */
function endOfHandlerBody(code: string, start: number): number | null {
  const arrow = code.indexOf('=>', start);
  if (arrow < 0) return null;
  let i = code.indexOf('{', arrow);
  if (i < 0) return null;

  let depth = 0;
  let state: 'code' | 'single' | 'double' | 'template' = 'code';
  // `${` inside a template returns to code; this counts how deep.
  const templateStack: number[] = [];

  for (; i < code.length; i += 1) {
    const c = code[i];
    if (c === '\\') { i += 1; continue; }

    if (state === 'code') {
      if (c === "'") { state = 'single'; continue; }
      if (c === '"') { state = 'double'; continue; }
      if (c === '`') { state = 'template'; continue; }
      if (c === '{') { depth += 1; continue; }
      if (c === '}') {
        depth -= 1;
        if (depth === 0) return i + 1;
        if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
          templateStack.pop();
          state = 'template';
        }
        continue;
      }
      continue;
    }
    if (state === 'single' && c === "'") { state = 'code'; continue; }
    if (state === 'double' && c === '"') { state = 'code'; continue; }
    if (state === 'template') {
      if (c === '`') { state = 'code'; continue; }
      if (c === '$' && code[i + 1] === '{') {
        templateStack.push(depth);
        depth += 1;
        state = 'code';
        i += 1;
      }
    }
  }
  return null;
}

/** Every route handler registered in `text`, with its body. */
export function extractHandlers(rel: string, text: string): Handler[] {
  const code = stripComments(text);
  const registration = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2/g;
  const handlers: Handler[] = [];
  let m: RegExpExecArray | null;

  while ((m = registration.exec(code)) !== null) {
    const end = endOfHandlerBody(code, m.index);
    if (end === null) continue;
    handlers.push({
      rel,
      name: `${m[1]} '${m[3]}'`,
      line: code.slice(0, m.index).split('\n').length,
      body: code.slice(m.index, end),
    });
  }
  return handlers;
}

/** Handlers that bind a caller-chosen tenant but never check it. */
export function unguardedHandlers(
  files: readonly { rel: string; text: string }[],
): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    for (const handler of extractHandlers(file.rel, file.text)) {
      const bindsCallerTenant = TENANT_FROM_CALLER.some((rx) => rx.test(handler.body));
      if (!bindsCallerTenant) continue;
      const guarded = GUARD_CALLS.some((rx) => rx.test(handler.body));
      if (guarded) continue;
      out.push({
        at: `${handler.rel}:${handler.line}`,
        file: handler.rel,
        line: handler.line,
        snippet: `${handler.name} binds a caller-supplied tenant without sessionBelongsToAnotherTenant/actingTenantMismatchesCredential`,
      });
    }
  }
  return out;
}

function readGoverned(): { rel: string; text: string }[] {
  return GOVERNED.map((rel) => ({
    rel,
    text: fs.readFileSync(path.join(API_ROOT, rel), 'utf8'),
  }));
}

describe('I16 — a telephony handler may not act as a caller-chosen tenant unchecked (#1072)', () => {
  it('every governed handler that binds a caller-supplied tenant consults the verifying credential', () => {
    const violations = unguardedHandlers(readGoverned());
    expect(
      violations.map((v) => `${v.at}  ${v.snippet}`),
      'a telephony handler resolves a tenant from a session or payload alias and never checks it ' +
        'against the credential that verified the request — this is the #1072 class, see the header',
    ).toEqual([]);
  });

  it('the governed modules exist and actually contain handlers (the guard is scanning something)', () => {
    const handlers = readGoverned().flatMap((f) => extractHandlers(f.rel, f.text));
    // If a refactor moves these routes, this fails loudly rather than the
    // guard silently passing over an empty set.
    expect(handlers.length).toBeGreaterThanOrEqual(6);
    expect(handlers.filter((h) => TENANT_FROM_CALLER.some((rx) => rx.test(h.body))).length)
      .toBeGreaterThanOrEqual(5);
  });

  describe('negative controls — the guard must catch a planted violation', () => {
    const compliant = `
      router.post('/ok', async (req: Request, res: Response) => {
        const session = deps.store.findByCallSid(body.CallSid);
        if (sessionBelongsToAnotherTenant(req, session, tenantId)) {
          res.status(403).end();
          return;
        }
        await repo.write({ tenantId: session.tenantId, twiml: \`<Say>{ok}</Say>\` });
      });
    `;

    it('flags a handler that binds a tenant from a session and writes with no check', () => {
      const dir = plantTree('i16-session', {
        'planted.ts': `
          router.post('/hijackable', async (req: Request, res: Response) => {
            const session = deps.store.findByCallSid(body.CallSid);
            const tenantId = session?.tenantId;
            await repo.write({ tenantId });
          });
        `,
      });
      try {
        const text = fs.readFileSync(path.join(dir, 'planted.ts'), 'utf8');
        const found = unguardedHandlers([{ rel: 'planted.ts', text }]);
        expect(found).toHaveLength(1);
        expect(found[0]!.snippet).toContain("post '/hijackable'");
      } finally {
        removeTree(dir);
      }
    });

    it('flags a handler that binds a tenant from the payload-alias fallback with no check', () => {
      const dir = plantTree('i16-fallback', {
        'planted.ts': `
          router.post('/alias', async (req: Request, res: Response) => {
            const to = body.Called ?? body.To ?? '';
            const tenantId = await deps.resolveTenantIdFallback({ to, from });
            await repo.write({ tenantId });
          });
        `,
      });
      try {
        const text = fs.readFileSync(path.join(dir, 'planted.ts'), 'utf8');
        expect(unguardedHandlers([{ rel: 'planted.ts', text }])).toHaveLength(1);
      } finally {
        removeTree(dir);
      }
    });

    it('is per-handler: a compliant handler beside an unguarded one does not cover for it', () => {
      // The failure mode this rules out is real — the guard splits handlers by
      // brace matching precisely so a check in a NEIGHBOURING handler (or in a
      // helper below the last one) cannot satisfy the rule for this one.
      const dir = plantTree('i16-mixed', {
        'planted.ts': `
          ${compliant}
          router.post('/bad', async (req: Request, res: Response) => {
            const tenantId = await deps.resolveTenantId({ to: body.To, from: body.From });
            await repo.write({ tenantId });
          });
        `,
      });
      try {
        const text = fs.readFileSync(path.join(dir, 'planted.ts'), 'utf8');
        const found = unguardedHandlers([{ rel: 'planted.ts', text }]);
        expect(found).toHaveLength(1);
        expect(found[0]!.snippet).toContain("post '/bad'");
      } finally {
        removeTree(dir);
      }
    });

    it('does not flag a handler that touches no caller-chosen tenant', () => {
      const dir = plantTree('i16-inert', {
        'planted.ts': `
          router.get('/health', (_req: Request, res: Response) => {
            res.status(200).json({ ok: true });
          });
        `,
      });
      try {
        const text = fs.readFileSync(path.join(dir, 'planted.ts'), 'utf8');
        expect(unguardedHandlers([{ rel: 'planted.ts', text }])).toEqual([]);
      } finally {
        removeTree(dir);
      }
    });

    it('does not flag the named exception: a tenant resolved from the bound dialled number', () => {
      const dir = plantTree('i16-exempt', {
        'planted.ts': `
          router.post('/voice', async (req: Request, res: Response) => {
            const tenantId = await resolveInboundTenantId({ to, from, callSid, deps });
            await adapter.handleInbound({ callSid, from, to, tenantId });
          });
        `,
      });
      try {
        const text = fs.readFileSync(path.join(dir, 'planted.ts'), 'utf8');
        expect(unguardedHandlers([{ rel: 'planted.ts', text }])).toEqual([]);
      } finally {
        removeTree(dir);
      }
    });
  });

  it('the media-stream upgrade binds its credential to the session tenant, not the payload', () => {
    // Not a router handler, so it is outside the rule above — but it is the
    // same property: the upgrade must hand the credential resolver the tenant
    // from its in-process session rather than trusting the presented
    // AccountSid alone.
    const rel = 'src/telephony/media-streams/twilio-mediastream-server.ts';
    const code = stripComments(fs.readFileSync(path.join(API_ROOT, rel), 'utf8'));
    expect(code, `${toPosix(rel)} must read the session's tenant`).toMatch(
      /sessionTenantId\s*=\s*session\.tenantId/,
    );
    expect(code, `${toPosix(rel)} must pass it to the credential resolver`).toMatch(
      /authTokenGetter\([\s\S]{0,400}tenantId:\s*sessionTenantId/,
    );
  });
});
