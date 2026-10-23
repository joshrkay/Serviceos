/**
 * Type-checked scanner for raw `pg` access (raw-pg audit 2026-10-23, §3.3).
 *
 * The app connects to Postgres as a privileged principal, so RLS only
 * enforces on a client that went through `applyTenantContext` (the
 * PgBaseRepository / withTenantTransaction family). Every OTHER way of reaching
 * the database runs as that principal, where tenant isolation is whatever the
 * query remembered to write. This module finds those ways, so the
 * `raw-pool-rls` guard can hold each one to a reviewed allowlist entry.
 *
 * ## Why the TypeScript checker and not a grep
 *
 * The audit's own inputs show a name match failing: `.query(` missed
 * `pool.query<T>(`; pools arrive as `lockPool`, `deps.pool`, `db`
 * (`currentTenantContext()?.client ?? pool`) and `target`; and under types such
 * as `Pick<Pool, 'query'>`. So a member reference counts when the checker
 * resolves it to a declaration in `@types/pg` (or `pg`), and it is classified
 * by the class that declares that member:
 *
 * | Declaring owner        | Access kind       |
 * |------------------------|-------------------|
 * | `Pool` (`query`)       | `pool.query`      |
 * | `Pool` (`connect`)     | `pool.connect`    |
 * | `ClientBase \| Pool`   | `ambient-or-pool` |
 * | `Client` (`connect`)   | `client.connect`  |
 * | `ClientBase` only      | (not listed — governed by the checkout it came from) |
 * | any non-call reference | `indirect`        |
 *
 * A member is found through a literal name (`pool.query`, `pool['query']`), a
 * key whose type is one string literal (`pool[K]` with `K = 'query' as const`)
 * or a computed destructuring key. A key the checker cannot narrow to one
 * literal (`pool[k]`, `k: keyof Pool`) on a pg-typed receiver is `indirect`.
 *
 * ## Checkouts, and who gets the client
 *
 * For every `connect()` checkout the scan follows the checked-out client
 * through its function (`analyseClientUse`):
 *
 * - the SQL run on it, and whether a context helper (`CONTEXT_HELPERS`) took
 *   it before the first effect query (R-order, `order`);
 * - every other call that RECEIVES it (as an argument, or inside an object
 *   literal argument), and every other way it escapes (`<alias x>`,
 *   `<object>`, `<return>`).
 *
 * A call whose callee is a PARAMETER of an enclosing function (`run(client)`
 * in `systemLookup(pool, run)`, `fn(client, lease)` in `withLock`,
 * `options.beforeStep(client)`), made before any context helper took the
 * client, makes that function a RAW-CHECKOUT HELPER: it hands its principal
 * checkout to code its caller supplies. Every call that resolves to a helper
 * by symbol — directly, through an import alias, or through an interface or
 * base-class member the helper implements — is a site of its own:
 * `checkout-callback` (`withClient` for `PgBaseRepository.withClient`, the
 * original helper), whose SQL, R-order and handoffs come from the callback
 * the caller passes. A caller that only passes its OWN parameter through
 * (`lookupVia(pool, run) { return systemLookup(pool, run) }`) becomes a
 * helper too, so the closure is computed to a fixpoint. Any other call
 * receiving the client is a named HANDOFF, reported by callee text so the
 * guard can require it in the entry's `handsOffTo`; the scan also opens that
 * function's body one hop for SQL (and for parameter callbacks of its own).
 *
 * Plus two rules on the same Program:
 *
 * - `any-receiver`: `.query`/`.connect` on a receiver typed `any`, which would
 *   otherwise blind the typed rule (`pool as any`, or an unresolved import).
 * - `guc-only`: a string or template literal that sets a policy GUC
 *   (`set_config('app.current_tenant_id', …)` in any case, `SET [LOCAL|SESSION]
 *   app.…`, quoted or not). Setting the GUC without the runtime role looks
 *   RLS-safe and is not (audit F4).
 *
 * ## Pure in its roots
 *
 * `findPgAccess` sees exactly the files it is given. That is what lets the
 * guard's negative controls point it at a planted temp tree and watch it fail
 * (`plantProgramInputs`), the same way `structural-scan.ts` guards do.
 *
 * AST walking ignores comments by construction, and only SQL literals that
 * reach a `query(` call (or a callback / delegate the client is handed to)
 * feed the tables check. What it still cannot see is listed in
 * docs/solutions/architecture-patterns/raw-pg-rls-structural-guard.md.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export type PgAccessKind =
  | 'pool.query'
  | 'pool.connect'
  | 'ambient-or-pool'
  | 'client.connect'
  /** A call to `PgBaseRepository.withClient` (the original raw-checkout helper). */
  | 'withClient'
  /**
   * A call to any other raw-checkout helper (the callback runs on the helper's
   * principal checkout), or a `pool.on('connect' | …)` listener.
   */
  | 'checkout-callback'
  /**
   * A Pool reaching a `.query`/`.connect` the typed rule cannot classify: an
   * `as unknown as …` cast, or a structurally typed parameter (`{ query }`, a
   * local `Queryable`, `ClientBase`) a Pool is passed to.
   */
  | 'pool-escape'
  | 'guc-only'
  /** A pg member (or raw-checkout helper) referenced without being called: `.bind`, an assignment, destructuring. */
  | 'indirect'
  /** `.query`/`.connect` on an `any`-typed receiver. */
  | 'any-receiver';

/** Where a checkout (or a helper callback) established context, relative to its first effect. */
export interface CheckoutOrder {
  /** The variable(s) the client is bound to, or null when it is not bound to one. */
  readonly clientVar: string | null;
  /** Line of the first context-helper call that takes the client, or null. */
  readonly contextLine: number | null;
  /** The first query on the client that is not BEGIN / SAVEPOINT / an advisory lock. */
  readonly firstEffect: { readonly line: number; readonly sql: string } | null;
  /** A context helper took the client before any effect query (and the client is tracked). */
  readonly contextFirst: boolean;
}

export interface PgAccessSite {
  /** Posix path relative to the scan's `baseDir`, e.g. `src/voice/voice-gate.ts`. */
  readonly file: string;
  readonly line: number;
  /** Nearest named function: `Class.method`, `fnName`, `createApp.check`, or `POST /route`. */
  readonly fn: string;
  readonly access: PgAccessKind;
  /** The pg declaring owner(s) joined by `|`, or the raw-checkout helper's name. */
  readonly owner: string;
  /** The trimmed source line, for the failure message. */
  readonly snippet: string;
  /** SQL literal texts this access runs (template substitutions shown as `${…}`). */
  readonly sql: readonly string[];
  /** Some SQL names its table through a substitution (`FROM "${table}"`). */
  readonly dynamicSql: boolean;
  /** On `pool.connect`, `withClient` and `checkout-callback`. */
  readonly order?: CheckoutOrder;
  /**
   * On checkouts and helper calls: where else the client goes. A callee's text
   * (`watchSessionLease`, `this.helper`, `new Thing`), `<alias x>`,
   * `<object>`, `<return>`, or `callback <text>` for a callback the scan
   * cannot open. Sorted, unique.
   */
  readonly handoffs?: readonly string[];
}

export interface PgAccessScanOptions {
  /** Only files under this directory are scanned; paths are reported relative to it. */
  readonly baseDir: string;
  /** Policy GUC names R-guc watches (without the `app.` prefix). */
  readonly gucNames?: readonly string[];
}

/** The RLS policy GUCs in `db/schema.ts`; the guard pins this against the schema. */
export const DEFAULT_GUC_NAMES: readonly string[] = [
  'current_tenant_id',
  'system_lookup',
  'portal_token_lookup',
];

/**
 * Helpers that establish context on a client they are handed. R-order accepts
 * a checkout once one of these takes the checked-out client, and a client
 * handed to one is not a handoff. Matched by name AND by the file that
 * declares it, so a same-named local function does not count.
 */
export const CONTEXT_HELPERS: ReadonlyArray<{ readonly name: string; readonly file: string }> = [
  { name: 'applyTenantContext', file: 'db/rls-runtime-role.ts' },
  { name: 'applyCrossTenantRole', file: 'db/rls-runtime-role.ts' },
  { name: 'runInTenantTransaction', file: 'commands/command-runner.ts' },
  // executeAudited's whole body is runInTenantTransaction(command.client, …):
  // BEGIN + applyTenantContext before the state change and the audit insert.
  { name: 'executeAudited', file: 'commands/command-runner.ts' },
  { name: 'seedDemoTenantFromFixture', file: 'demo/fixture.ts' },
];

const PG_DECL_RE = /[\\/]node_modules[\\/](@types[\\/])?pg[\\/]/;
const PG_MEMBERS = new Set(['query', 'connect']);
const LISTENER_METHODS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
/** Pool events whose listener receives a client, and at which argument. */
const POOL_CLIENT_EVENTS: Readonly<Record<string, number>> = { connect: 0, acquire: 0, remove: 0, release: 1, error: 1 };
/** Statements that do not touch a table, so they may precede the context helper. */
const TX_CONTROL_RE =
  /^\s*(BEGIN\b|START\s+TRANSACTION\b|SAVEPOINT\b|RELEASE\s+SAVEPOINT\b|SELECT\s+pg_(try_)?advisory_(xact_)?lock(_shared)?\s*\()/i;
const DYNAMIC_TABLE_RE = /\b(FROM|JOIN|INTO|UPDATE|TABLE|USING|TRUNCATE|COPY)\s+(ONLY\s+)?"?\$\{/i;
/** One table reference: an optionally quoted, optionally schema-qualified identifier. */
const TABLE_NAME_SRC = '"?([a-z_][a-z0-9_]*)"?(?:\\."?([a-z_][a-z0-9_]*)"?)?';
const TABLE_REF_RE = new RegExp(
  `\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|USING|COPY|TRUNCATE(?:\\s+TABLE)?)\\s+(?:ONLY\\s+)?(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?${TABLE_NAME_SRC}`,
  'gi',
);
/** `, next_table` after a FROM item (a comma join), skipping an optional alias. */
const COMMA_ITEM_RE = new RegExp(`^(?:\\s+(?:AS\\s+)?([a-z_][a-z0-9_]*))?\\s*,\\s*(?:ONLY\\s+)?${TABLE_NAME_SRC}`, 'i');
/** Words that end a FROM item rather than alias it. */
const SQL_CLAUSE_WORDS = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'on', 'using', 'group', 'order',
  'limit', 'offset', 'for', 'having', 'window', 'union', 'except', 'intersect', 'returning', 'set', 'lateral',
  'values', 'select', 'and', 'or', 'as', 'when', 'then', 'else', 'end', 'do', 'fetch',
]);

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** `rootNames` + compiler options for the production build program (`tsconfig.build.json`). */
export function loadBuildProgramInputs(apiDir: string): {
  rootNames: string[];
  compilerOptions: ts.CompilerOptions;
} {
  const configPath = path.join(apiDir, 'tsconfig.build.json');
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
  if (cfg.error) throw new Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, apiDir);
  return { rootNames: parsed.fileNames, compilerOptions: scanOptions(parsed.options) };
}

/**
 * Inputs for a planted negative-control tree in a temp dir. `pg` must resolve
 * to the real typings there, or every planted `pool` silently becomes `any`
 * (R-any is the backstop, and the guard has a sanity control for it).
 */
export function plantProgramInputs(
  dir: string,
  apiDir: string,
): { rootNames: string[]; compilerOptions: ts.CompilerOptions } {
  const repoNodeModules = path.resolve(apiDir, '../../node_modules');
  const { compilerOptions: base } = loadBuildProgramInputs(apiDir);
  const rootNames: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) rootNames.push(abs);
    }
  };
  walk(dir);
  return {
    rootNames,
    compilerOptions: {
      ...base,
      baseUrl: dir,
      paths: { pg: [path.join(repoNodeModules, '@types/pg/index.d.ts')] },
      typeRoots: [path.join(repoNodeModules, '@types')],
    },
  };
}

function scanOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  // The scan only needs the checker: no emit, and no rootDir/outDir so a
  // planted tree outside the package is not an error worth reporting.
  const { rootDir: _rootDir, outDir: _outDir, declaration: _d, declarationMap: _dm, sourceMap: _sm, ...rest } =
    options;
  return { ...rest, noEmit: true };
}

/** Build a Program over `rootNames` and scan it. */
export function findPgAccess(
  rootNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
  opts: PgAccessScanOptions,
): PgAccessSite[] {
  const program = ts.createProgram({ rootNames: [...rootNames], options: scanOptions(compilerOptions) });
  return findPgAccessInProgram(program, opts);
}

/** Scan an existing Program (lets a caller build the large one once). */
export function findPgAccessInProgram(program: ts.Program, opts: PgAccessScanOptions): PgAccessSite[] {
  return new PgAccessScan(program.getTypeChecker(), path.resolve(opts.baseDir)).run(
    program,
    opts.gucNames ?? DEFAULT_GUC_NAMES,
  );
}

// ─── small AST helpers ──────────────────────────────────────────────────────

/** Through parentheses, `!`, `as`, `<T>` and `satisfies`. */
function strip(e: ts.Expression): ts.Expression {
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isSatisfiesExpression(e)
    ) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

/** Through parentheses, `!` and casts: the expression a cast hides, and whether there was one. */
function uncast(e: ts.Expression): { inner: ts.Expression; cast: boolean } {
  let cast = false;
  for (;;) {
    if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) {
      cast = true;
      e = e.expression;
    } else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
      e = e.expression;
    } else {
      return { inner: e, cast };
    }
  }
}

function isWrapper(n: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n)
  );
}

function isUndefinedExpr(e: ts.Expression): boolean {
  return (ts.isIdentifier(e) && e.text === 'undefined') || e.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(e);
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
}

function isFunctionLikeWithBody(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    (ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n)) &&
    !!n.body
  );
}

function enclosingFunctionLike(node: ts.Node): ts.Node {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isConstructorDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)
    ) {
      return p;
    }
    p = p.parent;
  }
  return node.getSourceFile();
}

/** The identifier a `connect()` call's client is bound to (`const c = await pool.connect()`). */
function checkoutBinding(call: ts.CallExpression): ts.Identifier | null {
  let p: ts.Node = call.parent;
  while (ts.isAwaitExpression(p) || isWrapper(p)) p = p.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name;
  if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(p.left)
  ) {
    return p.left;
  }
  return null;
}

// ─── the scan ───────────────────────────────────────────────────────────────

/** A callee hanging off a parameter: `run`, `options.beforeStep`, `deps.hooks.insideFence`. */
interface ParamRoot {
  /** The function that declares the parameter. */
  readonly fn: ts.SignatureDeclaration;
  readonly index: number;
  readonly path: readonly string[];
  /** Reached through `const x = deps.x ?? <function>`: the default runs too. */
  readonly viaDefault: boolean;
}

/** Where a raw-checkout helper's caller supplies the callback that receives the client. */
interface Slot {
  readonly param: number;
  readonly path: readonly string[];
  /** Argument positions at which the helper passes the client to the callback. */
  readonly clientArgs: readonly number[];
}

interface Helper {
  readonly name: string;
  /**
   * Declarations a call to it can resolve to (its own, and the interface or
   * base members it implements). Matched by declaration, not symbol: a member
   * read through `this` resolves to an instantiated copy of the symbol.
   */
  readonly decls: ReadonlySet<ts.Node>;
  readonly memberName: string;
  readonly slots: Slot[];
  readonly withClient: boolean;
}

interface ClientUse {
  sql: string[];
  contextPos: number | null;
  effect: { pos: number; sql: string } | null;
  handoffs: Set<string>;
  /** Parameter callbacks handed the client before any context helper took it. */
  params: Array<{ root: ParamRoot; clientArgs: number[] }>;
}

type CallbackValue =
  | { kind: 'none' }
  | { kind: 'fn'; fn: ts.FunctionLikeDeclaration }
  | { kind: 'param'; root: ParamRoot; text: string }
  | { kind: 'opaque'; text: string };

class PgAccessScan {
  private readonly helpers = new Map<ts.Node, Helper>();
  private changed = false;
  /** Every call in the scanned files, by the name its callee is spelled with. */
  private readonly callsByName = new Map<string, ts.CallExpression[]>();
  /** Local names of imports, so a renamed import of a helper is found. */
  private readonly importLocals: ts.Identifier[] = [];
  /**
   * Functions with a parameter the typed rule cannot classify a `.query` on
   * (`db: { query }`, `c: ClientBase`), and the SQL run through it: a Pool
   * passed there is a pool-escape.
   */
  private readonly structural = new Map<ts.Node, { fn: ts.SignatureDeclaration; slots: Array<{ index: number; path: readonly string[]; sql: string[] }> }>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly baseDir: string,
  ) {}

  run(program: ts.Program, gucNames: readonly string[]): PgAccessSite[] {
    const gucAlt = gucNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const gucRes = [
      new RegExp(`set_config\\(\\s*'app\\.(${gucAlt})'`, 'i'),
      new RegExp(`\\bSET\\s+(?:(?:LOCAL|SESSION)\\s+)?"?app\\.(${gucAlt})\\b`, 'i'),
      new RegExp(`^app\\.(${gucAlt})$`),
    ];
    const files = program.getSourceFiles().filter((sf) => {
      if (sf.isDeclarationFile) return false;
      const abs = path.resolve(sf.fileName);
      return abs.startsWith(this.baseDir + path.sep) && !PG_DECL_RE.test(abs);
    });
    const sites: PgAccessSite[] = [];

    // Pass 1: pg members, checkouts, R-any, R-guc; index calls for pass 2.
    for (const sf of files) {
      const visit = (node: ts.Node): void => {
        this.visitMember(node, sites);
        if (ts.isCallExpression(node)) {
          this.indexCall(node);
          this.notePoolListener(node, sites);
          this.noteUnclassifiedMember(node, sites);
          const callee = node.expression;
          const memberName = ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
              ? callee.argumentExpression.text
              : null;
          if (memberName && PG_MEMBERS.has(memberName)) {
            const receiver = (callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
            if (this.checker.getTypeAtLocation(receiver).flags & ts.TypeFlags.Any) {
              sites.push(this.site(callee, 'any-receiver', 'any', { sql: this.queryArgSql(node) }));
            }
          }
        }
        if (ts.isImportSpecifier(node) || (ts.isImportClause(node) && node.name)) {
          this.importLocals.push(ts.isImportSpecifier(node) ? node.name : node.name!);
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
          const text = literalText(node);
          if (gucRes.some((re) => re.test(text))) sites.push(this.site(node, 'guc-only', 'literal', { sql: [text] }));
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    // Pass 2: calls to raw-checkout helpers, to a fixpoint (a pass-through
    // wrapper, or a callback that hands the client to its own caller's
    // parameter, makes a new helper whose calls must be read too).
    const results = new Map<ts.CallExpression, PgAccessSite | null>();
    const seen = new Map<ts.CallExpression, string>();
    const calleeSymbols = new Map<ts.CallExpression, ts.Symbol | undefined>();
    do {
      this.changed = false;
      const helpers = [...this.helpers.values()];
      const candidates = new Set<ts.CallExpression>();
      for (const h of helpers) for (const n of this.helperNames(h)) for (const c of this.callsByName.get(n) ?? []) candidates.add(c);
      for (const call of candidates) {
        if (!calleeSymbols.has(call)) calleeSymbols.set(call, this.calleeSymbol(call));
        const symbol = calleeSymbols.get(call);
        const matched = this.helpersOf(symbol, helpers);
        if (!matched.length) continue;
        const signature = JSON.stringify(matched.map((h) => [h.name, h.slots]));
        if (seen.get(call) === signature) continue;
        seen.set(call, signature);
        results.set(call, this.helperCallSite(call, matched));
      }
    } while (this.changed);
    for (const site of results.values()) if (site) sites.push(site);
    this.structuralEscapes(sites);

    // Pass 3: a helper referenced without being called hides its callers.
    this.indirectHelperReferences(files, sites);

    return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  }

  private site(node: ts.Node, access: PgAccessKind, owner: string, extra: Partial<PgAccessSite> = {}): PgAccessSite {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const sql = extra.sql ?? [];
    return {
      file: toPosix(path.relative(this.baseDir, path.resolve(sf.fileName))),
      line: line + 1,
      fn: functionName(node, sf),
      access,
      owner,
      snippet: (sf.text.split('\n')[line] ?? '').trim().slice(0, 200),
      sql,
      dynamicSql: sql.some((s) => DYNAMIC_TABLE_RE.test(s)),
      ...(extra.order ? { order: extra.order } : {}),
      ...(extra.handoffs ? { handoffs: extra.handoffs } : {}),
    };
  }

  // ── pg member references ──────────────────────────────────────────────

  private visitMember(node: ts.Node, sites: PgAccessSite[]): void {
    const member = this.pgMemberReference(node);
    if (!member) return;
    const ownerText = member.owners.join('|');
    if (!member.called) {
      sites.push(this.site(node, 'indirect', ownerText));
      return;
    }
    const call = node.parent as ts.CallExpression;
    const access = classifyCall(member.name, member.owners);
    if (access === 'pool.query' || access === 'ambient-or-pool') {
      sites.push(this.site(node, access, ownerText, { sql: this.queryArgSql(call) }));
    } else if (access === 'pool.connect' || access === 'client.connect') {
      const analysis = this.analyseCheckout(call);
      sites.push(
        this.site(node, access, ownerText, {
          sql: analysis.sql,
          handoffs: analysis.handoffs,
          ...(access === 'pool.connect' ? { order: analysis.order } : {}),
        }),
      );
    }
  }

  /** The string-literal values a key expression's type narrows to, or null when it does not. */
  private literalNames(expr: ts.Expression): string[] | null {
    if (ts.isStringLiteralLike(expr)) return [expr.text];
    const t = this.checker.getTypeAtLocation(expr);
    const parts = t.isUnion() ? t.types : [t];
    const names: string[] = [];
    for (const p of parts) {
      if (!p.isStringLiteral()) return null;
      names.push(p.value);
    }
    return names;
  }

  private isNumericKey(expr: ts.Expression): boolean {
    if (ts.isStringLiteralLike(expr)) return false;
    const t = this.checker.getTypeAtLocation(expr);
    const parts = t.isUnion() ? t.types : [t];
    return parts.every((p) => (p.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike)) !== 0);
  }

  /** pg owners of `query`/`connect` on a receiver type (to judge a key the checker cannot narrow). */
  private pgOwnersOfType(t: ts.Type): string[] {
    const owners = new Set<string>();
    for (const m of PG_MEMBERS) for (const o of pgOwners(t.getProperty(m))) owners.add(o);
    return [...owners].sort();
  }

  private pgMemberReference(node: ts.Node): { name: string; owners: string[]; called: boolean } | null {
    if (ts.isBindingElement(node)) {
      // `const { query } = pool`, `{ ['query']: q }` — resolve through the destructured type.
      const prop = node.propertyName ?? node.name;
      let names: string[] | null;
      if (ts.isIdentifier(prop) || ts.isStringLiteralLike(prop)) {
        if (!PG_MEMBERS.has(prop.text)) return null;
        names = [prop.text];
      } else if (ts.isComputedPropertyName(prop)) names = this.literalNames(prop.expression);
      else return null;
      const parentType = this.checker.getTypeAtLocation(node.parent);
      if (names === null || names.length > 1) {
        const owners = this.pgOwnersOfType(parentType);
        return owners.length ? { name: '[computed]', owners, called: false } : null;
      }
      if (!PG_MEMBERS.has(names[0])) return null;
      const owners = pgOwners(parentType.getProperty(names[0]));
      return owners.length ? { name: names[0], owners, called: false } : null;
    }
    let name: string;
    let symbol: ts.Symbol | undefined;
    if (ts.isPropertyAccessExpression(node) && PG_MEMBERS.has(node.name.text)) {
      name = node.name.text;
      symbol = this.checker.getSymbolAtLocation(node.name);
    } else if (ts.isElementAccessExpression(node)) {
      // `rows[0]`, `arr[i]`: a numeric key never names a pg member (and
      // skipping it keeps the checker off every array read in the tree).
      if (ts.isNumericLiteral(node.argumentExpression) || this.isNumericKey(node.argumentExpression)) return null;
      const names = this.literalNames(node.argumentExpression);
      const receiverType = this.checker.getTypeAtLocation(node.expression);
      if (names === null || (names.length > 1 && names.some((n) => PG_MEMBERS.has(n)))) {
        // A key the checker cannot narrow to one name, on a pg-typed receiver.
        const owners = this.pgOwnersOfType(receiverType);
        return owners.length ? { name: '[key]', owners, called: false } : null;
      }
      if (names.length !== 1 || !PG_MEMBERS.has(names[0])) return null;
      name = names[0];
      symbol =
        (ts.isStringLiteralLike(node.argumentExpression)
          ? this.checker.getSymbolAtLocation(node.argumentExpression)
          : undefined) ?? receiverType.getProperty(name);
    } else {
      return null;
    }
    const owners = pgOwners(symbol);
    if (!owners.length) return null;
    const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
    return { name, owners, called };
  }

  // ── SQL extraction ────────────────────────────────────────────────────

  private queryArgSql(call: ts.CallExpression): string[] {
    return literalsOf(call.arguments[0], this.checker);
  }

  // ── checkouts and the client's travels ────────────────────────────────

  /**
   * For a `connect()` call: the SQL run on the checked-out client, where it
   * goes, and whether a context helper took it before its first effect query
   * (R-order). A parameter callback handed the client before context makes the
   * enclosing function a raw-checkout helper.
   */
  private analyseCheckout(call: ts.CallExpression): {
    sql: string[];
    order: CheckoutOrder;
    handoffs: string[];
  } {
    const sf = call.getSourceFile();
    const region = enclosingFunctionLike(call);
    const binding = checkoutBinding(call);
    const clientSym = binding ? this.checker.getSymbolAtLocation(binding) : undefined;
    const use = this.analyseClientUse(region, clientSym ? new Set([clientSym]) : new Set(), call.getEnd(), {
      broadSql: false,
      followDelegates: true,
    });
    for (const p of use.params) this.registerSlot(p.root, p.clientArgs);
    return {
      sql: use.sql,
      handoffs: [...use.handoffs].sort(),
      order: orderOf(sf, binding ? binding.text : null, use, !!clientSym),
    };
  }

  /** `client`, `client!`, `client ?? other`, `cond ? client : other`: an expression that may BE the client. */
  private isClientExpr(e: ts.Expression | undefined, clients: ReadonlySet<ts.Symbol>): boolean {
    if (!e || clients.size === 0) return false;
    const s = strip(e);
    if (ts.isBinaryExpression(s) && isLogicalOperator(s.operatorToken.kind)) {
      return (
        this.isClientExpr(s.right, clients) ||
        (s.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken && this.isClientExpr(s.left, clients))
      );
    }
    if (ts.isConditionalExpression(s)) return this.isClientExpr(s.whenTrue, clients) || this.isClientExpr(s.whenFalse, clients);
    if (!ts.isIdentifier(s)) return false;
    const sym = this.checker.getSymbolAtLocation(s);
    return !!sym && clients.has(sym);
  }

  private objectHoldsClient(e: ts.Expression, clients: ReadonlySet<ts.Symbol>): boolean {
    const s = strip(e);
    return (
      ts.isObjectLiteralExpression(s) &&
      s.properties.some((p) => {
        if (ts.isShorthandPropertyAssignment(p)) {
          const v = this.checker.getShorthandAssignmentValueSymbol(p);
          return !!v && clients.has(v);
        }
        return ts.isPropertyAssignment(p) && this.isClientExpr(p.initializer, clients);
      })
    );
  }

  /**
   * Follow `clients` through `region` from position `from`: SQL on them,
   * context-helper calls, every call that receives them, and every other
   * escape. `broadSql` also takes `.query` SQL on other receivers (a
   * callback's whole body); `followDelegates` opens a named callee's body
   * one hop.
   */
  private analyseClientUse(
    region: ts.Node,
    clients: ReadonlySet<ts.Symbol>,
    from: number,
    mode: { broadSql: boolean; followDelegates: boolean },
  ): ClientUse {
    const sf = region.getSourceFile();
    const use: ClientUse = { sql: [], contextPos: null, effect: null, handoffs: new Set(), params: [] };
    const walk = (n: ts.Node): void => {
      if (n.getStart(sf) >= from) {
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
          const args = n.arguments ?? [];
          const direct = args.flatMap((a, i) => (this.isClientExpr(a, clients) ? [i] : []));
          const viaObject = args.some((a) => this.objectHoldsClient(a, clients));
          if (direct.length || viaObject) {
            if (ts.isCallExpression(n) && isContextHelperCall(n, this.checker)) {
              if (use.contextPos === null) use.contextPos = n.getStart(sf);
            } else {
              this.recordHandoff(n, direct, use, mode.followDelegates, clients);
            }
          }
          if (ts.isCallExpression(n)) {
            const callee = n.expression;
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'query') {
              const onClient = this.isClientExpr(callee.expression, clients);
              if (onClient || mode.broadSql || clients.size === 0) {
                const texts = this.queryArgSql(n);
                use.sql.push(...texts);
                const first = texts[0] ?? '<non-literal SQL>';
                if (onClient && use.effect === null && !TX_CONTROL_RE.test(first)) {
                  use.effect = { pos: n.getStart(sf), sql: first.replace(/\s+/g, ' ').trim().slice(0, 120) };
                }
              }
            }
          }
        } else if (ts.isIdentifier(n) && clients.size > 0) {
          const sym = ts.isShorthandPropertyAssignment(n.parent)
            ? this.checker.getShorthandAssignmentValueSymbol(n.parent)
            : this.checker.getSymbolAtLocation(n);
          const escape = sym && clients.has(sym) ? escapeOf(n) : null;
          if (escape) use.handoffs.add(escape);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(region);
    return use;
  }

  private recordHandoff(
    call: ts.CallExpression | ts.NewExpression,
    direct: number[],
    use: ClientUse,
    followDelegates: boolean,
    clients: ReadonlySet<ts.Symbol>,
  ): void {
    const sf = call.getSourceFile();
    const callee = ts.isCallExpression(call) ? strip(call.expression) : call.expression;
    const text = (ts.isNewExpression(call) ? 'new ' : '') + callee.getText(sf).replace(/\s+/g, '');
    const root = ts.isCallExpression(call) ? this.paramRootOf(callee) : null;
    if (root) {
      if (use.contextPos === null) {
        // Before context: the caller's callback runs on the principal client.
        if (this.declsFor(root.fn).size > 0) use.params.push({ root, clientArgs: direct });
        else use.handoffs.add(text); // an anonymous function's parameter: no callers to list
      }
      if (!root.viaDefault) return;
    }
    use.handoffs.add(text);
    if (!followDelegates) return;
    // Literals passed alongside the client are SQL the callee may run on it
    // (`queueStatement(c, 'DELETE FROM …', tenantId)`).
    call.arguments?.forEach((a, i) => {
      const s = strip(a);
      if (direct.includes(i) || this.objectHoldsClient(a, clients) || ts.isFunctionLike(s)) return;
      use.sql.push(...literalsOf(a, this.checker));
    });
    // One hop into the callee: its SQL on the client, and its own parameter callbacks.
    const decl = ts.isCallExpression(call) ? this.calleeDeclaration(call) : undefined;
    if (!decl || !decl.body) return;
    const params = new Set<ts.Symbol>();
    for (const i of direct) {
      const p = decl.parameters[i];
      const sym = p && ts.isIdentifier(p.name) ? this.checker.getSymbolAtLocation(p.name) : undefined;
      if (sym) params.add(sym);
    }
    if (params.size === 0) return;
    const inner = this.analyseClientUse(decl.body, params, decl.body.pos, { broadSql: false, followDelegates: false });
    use.sql.push(...inner.sql);
    for (const p of inner.params) this.registerSlot(p.root, p.clientArgs);
  }

  /** The function-like declaration (with a body) a call's callee resolves to. */
  private calleeDeclaration(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
    return this.functionDeclOf(strip(call.expression));
  }

  private functionDeclOf(e: ts.Expression): ts.FunctionLikeDeclaration | undefined {
    if (isFunctionLikeWithBody(e)) return e;
    const nameNode = ts.isPropertyAccessExpression(e) ? e.name : ts.isIdentifier(e) ? e : null;
    if (!nameNode) return undefined;
    const symbol = resolveDeclared(this.checker.getSymbolAtLocation(nameNode), this.checker);
    for (const d of symbol?.getDeclarations() ?? []) {
      if (isFunctionLikeWithBody(d)) return d;
      const init =
        ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d) ? d.initializer : undefined;
      if (!init) continue;
      let s = strip(init);
      // `const reseed = deps.reseed ?? (async (client) => …)`: the default.
      if (ts.isBinaryExpression(s) && isDefaultingOperator(s.operatorToken.kind)) s = strip(s.right);
      if (isFunctionLikeWithBody(s)) return s;
    }
    return undefined;
  }

  /**
   * `run`, `options.beforeStep`, `hooks.insideFence` with
   * `const hooks = deps.hooks ?? {}`: the enclosing function parameter a
   * callee hangs off, or null.
   */
  private paramRootOf(expr: ts.Expression, depth = 0): ParamRoot | null {
    const pathParts: string[] = [];
    let e = strip(expr);
    for (;;) {
      if (ts.isPropertyAccessExpression(e)) {
        pathParts.unshift(e.name.text);
        e = strip(e.expression);
      } else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
        pathParts.unshift(e.argumentExpression.text);
        e = strip(e.expression);
      } else {
        break;
      }
    }
    if (!ts.isIdentifier(e)) return null;
    const decl = this.checker.getSymbolAtLocation(e)?.valueDeclaration;
    if (!decl) return null;
    if (ts.isParameter(decl) && ts.isIdentifier(decl.name)) {
      const fn = decl.parent as ts.SignatureDeclaration;
      return { fn, index: fn.parameters.indexOf(decl), path: pathParts, viaDefault: false };
    }
    if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
      const prop = propertyNameText(decl.propertyName ?? decl.name);
      const holder = decl.parent.parent;
      if (prop === null) return null;
      if (ts.isParameter(holder)) {
        const fn = holder.parent as ts.SignatureDeclaration;
        return { fn, index: fn.parameters.indexOf(holder), path: [prop, ...pathParts], viaDefault: false };
      }
      if (depth < 2 && ts.isVariableDeclaration(holder) && holder.initializer) {
        const r = this.paramRootOf(holder.initializer, depth + 1);
        if (r) return { ...r, path: [...r.path, prop, ...pathParts] };
      }
      return null;
    }
    if (
      depth < 2 &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isVariableDeclarationList(decl.parent) &&
      decl.parent.flags & ts.NodeFlags.Const
    ) {
      let init = strip(decl.initializer);
      let viaDefault = false;
      if (ts.isBinaryExpression(init) && isDefaultingOperator(init.operatorToken.kind)) {
        const right = strip(init.right);
        viaDefault = !(ts.isObjectLiteralExpression(right) && right.properties.length === 0) && !isUndefinedExpr(right);
        init = strip(init.left);
      }
      const r = this.paramRootOf(init, depth + 1);
      if (r) return { ...r, path: [...r.path, ...pathParts], viaDefault: r.viaDefault || viaDefault };
    }
    return null;
  }

  // ── raw-checkout helpers ──────────────────────────────────────────────

  /** The declarations a call to `fn` can resolve to: its own, and the members it implements or overrides. */
  private declsFor(fn: ts.SignatureDeclaration): Set<ts.Node> {
    const out = new Set<ts.Node>();
    const add = (s: ts.Symbol | undefined): void => {
      for (const d of s?.getDeclarations() ?? []) out.add(d);
    };
    const heritage = (cls: ts.ClassLikeDeclaration, member: string): void => {
      for (const clause of cls.heritageClauses ?? []) {
        for (const t of clause.types) add(this.checker.getTypeAtLocation(t).getProperty(member));
      }
    };
    const named = (name: ts.PropertyName | undefined, holder: ts.Node): void => {
      if (!name) return;
      add(this.checker.getSymbolAtLocation(name));
      const member = propertyNameText(name);
      if (member === null) return;
      if (ts.isClassLike(holder)) heritage(holder, member);
      if (ts.isObjectLiteralExpression(holder)) add(this.checker.getContextualType(holder)?.getProperty(member));
    };
    if (ts.isFunctionDeclaration(fn) && fn.name) add(this.checker.getSymbolAtLocation(fn.name));
    else if (ts.isMethodDeclaration(fn)) named(fn.name, fn.parent);
    else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      let p: ts.Node = fn.parent;
      while (isWrapper(p)) p = p.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) add(this.checker.getSymbolAtLocation(p.name));
      else if (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) named(p.name, p.parent);
    }
    return out;
  }

  private registerSlot(root: ParamRoot, clientArgs: readonly number[]): void {
    const decls = this.declsFor(root.fn);
    if (decls.size === 0 || root.index < 0) return;
    let helper = this.helpers.get(root.fn);
    if (!helper) {
      const sf = root.fn.getSourceFile();
      const anchor = (root.fn as ts.FunctionLikeDeclaration).body ?? root.fn.parameters[0] ?? root.fn;
      const memberName = declarationNameText(root.fn) ?? '<anonymous>';
      helper = {
        name: functionName(anchor, sf),
        decls,
        memberName,
        slots: [],
        withClient:
          ts.isMethodDeclaration(root.fn) &&
          memberName === 'withClient' &&
          toPosix(sf.fileName).endsWith('/db/pg-base.ts') &&
          ts.isClassDeclaration(root.fn.parent) &&
          root.fn.parent.name?.text === 'PgBaseRepository',
      };
      this.helpers.set(root.fn, helper);
      this.changed = true;
    }
    const same = helper.slots.find((s) => s.param === root.index && s.path.join('.') === root.path.join('.'));
    if (!same) {
      helper.slots.push({ param: root.index, path: root.path, clientArgs: [...clientArgs] });
      this.changed = true;
    } else if (clientArgs.some((i) => !same.clientArgs.includes(i))) {
      helper.slots[helper.slots.indexOf(same)] = {
        ...same,
        clientArgs: [...new Set([...same.clientArgs, ...clientArgs])].sort(),
      };
      this.changed = true;
    }
  }

  private indexCall(call: ts.CallExpression): void {
    const c = strip(call.expression);
    let names: string[] | null = null;
    if (ts.isIdentifier(c)) names = [c.text];
    else if (ts.isPropertyAccessExpression(c)) names = [c.name.text];
    else if (ts.isElementAccessExpression(c)) names = this.literalNames(c.argumentExpression);
    for (const n of names ?? []) {
      const list = this.callsByName.get(n);
      if (list) list.push(call);
      else this.callsByName.set(n, [call]);
    }
  }

  private aliasNames: Map<ts.Node, string[]> | null = null;

  /** The texts a helper's calls are spelled with: its own name, and any import alias of it. */
  private helperNames(helper: Helper): Set<string> {
    return this.namesFor(helper.memberName, helper.decls);
  }

  private namesFor(memberName: string, decls: ReadonlySet<ts.Node>): Set<string> {
    if (!this.aliasNames) {
      this.aliasNames = new Map();
      for (const local of this.importLocals) {
        const s = resolveAlias(this.checker.getSymbolAtLocation(local), this.checker);
        for (const d of s?.getDeclarations() ?? []) this.aliasNames.set(d, [...(this.aliasNames.get(d) ?? []), local.text]);
      }
    }
    const names = new Set<string>([memberName]);
    for (const d of decls) for (const n of this.aliasNames.get(d) ?? []) names.add(n);
    return names;
  }

  private helpersOf(symbol: ts.Symbol | undefined, candidates: readonly Helper[]): Helper[] {
    const decls = symbol?.getDeclarations() ?? [];
    return decls.length ? candidates.filter((h) => decls.some((d) => h.decls.has(d))) : [];
  }

  private calleeSymbol(call: ts.CallExpression): ts.Symbol | undefined {
    const c = strip(call.expression);
    if (ts.isIdentifier(c)) return resolveAlias(this.checker.getSymbolAtLocation(c), this.checker);
    if (ts.isPropertyAccessExpression(c)) return this.checker.getSymbolAtLocation(c.name);
    if (ts.isElementAccessExpression(c)) {
      const names = this.literalNames(c.argumentExpression);
      if (!names || names.length !== 1) return undefined;
      return (
        (ts.isStringLiteralLike(c.argumentExpression) ? this.checker.getSymbolAtLocation(c.argumentExpression) : undefined) ??
        this.checker.getTypeAtLocation(c.expression).getProperty(names[0])
      );
    }
    return undefined;
  }

  /** What a call passes in a helper's callback slot. */
  private callbackValue(call: ts.CallExpression, slot: Slot): CallbackValue {
    const sf = call.getSourceFile();
    const textOf = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ').slice(0, 60);
    const spread = call.arguments.findIndex((a) => ts.isSpreadElement(a));
    if (spread !== -1 && spread <= slot.param) return { kind: 'opaque', text: textOf(call.arguments[spread]) };
    let v: ts.Expression | undefined = call.arguments[slot.param];
    if (!v) return { kind: 'none' };
    let hops = 0;
    for (let i = 0; i < slot.path.length; ) {
      const key = slot.path[i];
      const s = strip(v);
      if (ts.isObjectLiteralExpression(s)) {
        const prop = s.properties.find((p) => propertyNameText(p.name) === key);
        if (!prop) {
          return s.properties.some((p) => ts.isSpreadAssignment(p)) ? { kind: 'opaque', text: textOf(s) } : { kind: 'none' };
        }
        if (ts.isMethodDeclaration(prop)) return { kind: 'fn', fn: prop };
        if (ts.isShorthandPropertyAssignment(prop)) v = prop.name;
        else if (ts.isPropertyAssignment(prop)) v = prop.initializer;
        else return { kind: 'opaque', text: textOf(prop) };
        i += 1;
        continue;
      }
      const root = this.paramRootOf(s);
      if (root) return { kind: 'param', root: { ...root, path: [...root.path, ...slot.path.slice(i)] }, text: textOf(s) };
      // A const object (`demoLeaseStep`): read the property from its initializer.
      const init = hops < 2 ? this.constInitializer(s) : undefined;
      if (init) {
        v = init;
        hops += 1;
        continue;
      }
      return { kind: 'opaque', text: `${textOf(s)}.${slot.path.slice(i).join('.')}` };
    }
    const s = strip(v);
    if (isUndefinedExpr(s)) return { kind: 'none' };
    if (ts.isArrowFunction(s) || ts.isFunctionExpression(s)) return { kind: 'fn', fn: s };
    const root = this.paramRootOf(s);
    if (root) return { kind: 'param', root, text: textOf(s) };
    const decl = this.functionDeclOf(s);
    if (decl) return { kind: 'fn', fn: decl };
    return { kind: 'opaque', text: textOf(s) };
  }

  private constInitializer(e: ts.Expression): ts.Expression | undefined {
    const nameNode = ts.isIdentifier(e) ? e : ts.isPropertyAccessExpression(e) ? e.name : null;
    if (!nameNode) return undefined;
    const symbol = resolveDeclared(this.checker.getSymbolAtLocation(nameNode), this.checker);
    for (const d of symbol?.getDeclarations() ?? []) {
      if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer) return d.initializer;
    }
    return undefined;
  }

  /** One call to raw-checkout helper(s): its callback(s) read as the site. Null for a pure pass-through. */
  private helperCallSite(call: ts.CallExpression, matched: readonly Helper[]): PgAccessSite | null {
    let emit = false;
    const sql: string[] = [];
    const handoffs = new Set<string>();
    const orders: CheckoutOrder[] = [];
    for (const slot of matched.flatMap((h) => h.slots)) {
      const v = this.callbackValue(call, slot);
      if (v.kind === 'none') continue;
      if (v.kind === 'param') {
        // Passed straight through: the wrapper is a helper, and ITS callers are the sites.
        if (this.declsFor(v.root.fn).size > 0) this.registerSlot(v.root, slot.clientArgs);
        else {
          emit = true;
          handoffs.add(`callback ${v.text}`);
        }
        if (v.root.viaDefault) {
          emit = true;
          handoffs.add(`callback ${v.text}`);
        }
        continue;
      }
      emit = true;
      if (v.kind === 'opaque') {
        handoffs.add(`callback ${v.text}`);
        continue;
      }
      const clients = new Set<ts.Symbol>();
      const names: string[] = [];
      for (const i of slot.clientArgs) {
        const p = v.fn.parameters[i];
        const sym = p && ts.isIdentifier(p.name) ? this.checker.getSymbolAtLocation(p.name) : undefined;
        if (sym && p && ts.isIdentifier(p.name)) {
          clients.add(sym);
          names.push(p.name.text);
        }
      }
      const region = v.fn.body ?? v.fn;
      const use = this.analyseClientUse(region, clients, region.getStart(region.getSourceFile()), {
        broadSql: true,
        followDelegates: true,
      });
      sql.push(...use.sql);
      for (const h of use.handoffs) handoffs.add(h);
      for (const p of use.params) this.registerSlot(p.root, p.clientArgs);
      orders.push(orderOf(region.getSourceFile(), names.length ? names.join(',') : null, use, clients.size > 0));
    }
    if (!emit) return null;
    const order =
      orders.find((o) => !o.contextFirst) ??
      orders[0] ?? { clientVar: null, contextLine: null, firstEffect: null, contextFirst: false };
    const access = matched.some((h) => h.withClient) ? 'withClient' : 'checkout-callback';
    return this.site(call.expression, access, [...new Set(matched.map((h) => h.name))].join('|'), {
      sql,
      order,
      handoffs: [...handoffs].sort(),
    });
  }

  // ── pool listeners and structural escapes ─────────────────────────────

  /** A value that is (or may be) a pg Pool, or a type built from one (`Pick<Pool, 'query'>`, a subclass). */
  private poolish(e: ts.Expression): boolean {
    const t = this.checker.getTypeAtLocation(e);
    const parts = t.isUnion() ? t.types : [t];
    return parts.some(
      (p) => pgOwners(p.getProperty('query')).includes('Pool') || pgOwners(p.getProperty('connect')).includes('Pool'),
    );
  }

  /** `pool.on('connect', (client) => …)`: the listener runs on every client the event carries. */
  private notePoolListener(call: ts.CallExpression, sites: PgAccessSite[]): void {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || !LISTENER_METHODS.has(callee.name.text)) return;
    if (!this.poolish(callee.expression)) return;
    const event = call.arguments[0];
    const names = event ? this.literalNames(event) : null;
    const indexes = names === null ? [0, 1] : names.flatMap((n) => (n in POOL_CLIENT_EVENTS ? [POOL_CLIENT_EVENTS[n]] : []));
    if (!indexes.length) return;
    const listener = call.arguments[1];
    if (!listener) return;
    const s = strip(listener);
    const fn = ts.isArrowFunction(s) || ts.isFunctionExpression(s) ? s : this.functionDeclOf(s);
    if (!fn) {
      sites.push(this.site(callee, 'checkout-callback', 'Pool.on', { handoffs: [`callback ${s.getText().slice(0, 60)}`] }));
      return;
    }
    const clients = new Set<ts.Symbol>();
    const bound: string[] = [];
    for (const i of indexes) {
      const p = fn.parameters[i];
      const sym = p && ts.isIdentifier(p.name) ? this.checker.getSymbolAtLocation(p.name) : undefined;
      if (sym && p && ts.isIdentifier(p.name)) {
        clients.add(sym);
        bound.push(p.name.text);
      }
    }
    if (!clients.size) return;
    const region = fn.body ?? fn;
    const use = this.analyseClientUse(region, clients, region.getStart(region.getSourceFile()), {
      broadSql: true,
      followDelegates: true,
    });
    for (const p of use.params) this.registerSlot(p.root, p.clientArgs);
    sites.push(
      this.site(callee, 'checkout-callback', 'Pool.on', {
        sql: use.sql,
        order: orderOf(region.getSourceFile(), bound.join(','), use, true),
        handoffs: [...use.handoffs].sort(),
      }),
    );
  }

  /**
   * A `.query`/`.connect` the typed rule does not list (a structural `query`,
   * or `ClientBase`'s): a cast Pool receiver is an escape here; a parameter
   * receiver makes its function a structural slot whose Pool-passing callers
   * are escapes (`structuralEscapes`).
   */
  private noteUnclassifiedMember(call: ts.CallExpression, sites: PgAccessSite[]): void {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || !PG_MEMBERS.has(callee.name.text)) return;
    const owners = pgOwners(this.checker.getSymbolAtLocation(callee.name));
    if (owners.includes('Pool')) return; // pool.query / pool.connect / ambient-or-pool
    if (callee.name.text === 'connect' && owners.length) return; // client.connect
    if (this.checker.getTypeAtLocation(callee.expression).flags & ts.TypeFlags.Any) return; // R-any
    const sql = callee.name.text === 'query' ? this.queryArgSql(call) : [];
    const { inner, cast } = uncast(callee.expression);
    if (cast) {
      if (this.poolish(inner)) sites.push(this.site(callee, 'pool-escape', 'cast', { sql }));
      return;
    }
    if (!ts.isIdentifier(inner)) return;
    const decl = this.checker.getSymbolAtLocation(inner)?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && this.poolish(uncast(decl.initializer).inner)) {
      // `const db: Queryable = pool; db.query(…)`
      sites.push(this.site(callee, 'pool-escape', 'variable', { sql }));
      return;
    }
    const root = this.paramRootOf(inner);
    if (root) this.addStructuralSlot(root, sql);
  }

  private addStructuralSlot(root: ParamRoot, sql: readonly string[]): boolean {
    if (root.index < 0 || this.declsFor(root.fn).size === 0) return false; // an anonymous callback's parameter
    let entry = this.structural.get(root.fn);
    if (!entry) {
      entry = { fn: root.fn, slots: [] };
      this.structural.set(root.fn, entry);
    }
    const slot = entry.slots.find((s) => s.index === root.index && s.path.join('.') === root.path.join('.'));
    if (slot) {
      const before = slot.sql.length;
      for (const q of sql) if (!slot.sql.includes(q)) slot.sql.push(q);
      return slot.sql.length !== before;
    }
    entry.slots.push({ index: root.index, path: root.path, sql: [...sql] });
    return true;
  }

  /** Every call that passes a Pool into a structural slot, to a fixpoint through pass-through parameters. */
  private structuralEscapes(sites: PgAccessSite[]): void {
    const reported = new Set<string>();
    for (let round = 0; round < 8; round += 1) {
      let grew = false;
      for (const entry of [...this.structural.values()]) {
        const decls = this.declsFor(entry.fn);
        const names = this.namesFor(declarationNameText(entry.fn) ?? '<anonymous>', decls);
        for (const name of names) {
          for (const call of this.callsByName.get(name) ?? []) {
            const decl = this.calleeSymbol(call)?.getDeclarations() ?? [];
            if (!decl.some((d) => decls.has(d))) continue;
            entry.slots.forEach((slot, i) => {
              const arg = this.slotArgument(call, slot.index, slot.path);
              if (!arg) return;
              const { inner } = uncast(arg.expr);
              if (this.poolish(inner)) {
                const key = `${call.pos}:${call.getSourceFile().fileName}:${i}`;
                if (reported.has(key)) return;
                reported.add(key);
                const anchor = (entry.fn as ts.FunctionLikeDeclaration).body ?? entry.fn;
                sites.push(
                  this.site(call.expression, 'pool-escape', functionName(anchor, entry.fn.getSourceFile()), { sql: slot.sql }),
                );
                return;
              }
              const root = this.paramRootOf(inner);
              if (root && this.addStructuralSlot({ ...root, path: [...root.path, ...arg.rest] }, slot.sql)) grew = true;
            });
          }
        }
      }
      if (!grew) break;
    }
  }

  /** The argument at `index`, followed into an object literal along `path`; `rest` is the path left over. */
  private slotArgument(call: ts.CallExpression, index: number, path: readonly string[]): { expr: ts.Expression; rest: string[] } | null {
    let v: ts.Expression | undefined = call.arguments[index];
    let i = 0;
    while (v && i < path.length) {
      const s = strip(v);
      if (!ts.isObjectLiteralExpression(s)) break;
      const prop = s.properties.find((p) => propertyNameText(p.name) === path[i]);
      if (!prop) return null;
      v = ts.isShorthandPropertyAssignment(prop) ? prop.name : ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
      i += 1;
    }
    return v ? { expr: v, rest: path.slice(i) } : null;
  }

  private indirectHelperReferences(files: readonly ts.SourceFile[], sites: PgAccessSite[]): void {
    const byName = new Map<string, Helper[]>();
    for (const h of this.helpers.values()) {
      for (const n of this.helperNames(h)) byName.set(n, [...(byName.get(n) ?? []), h]);
    }
    if (byName.size === 0) return;
    const helperOf = (s: ts.Symbol | undefined, candidates: Helper[]): Helper | undefined =>
      this.helpersOf(s, candidates)[0];
    const report = (expr: ts.Node, helper: Helper): void => {
      let e = expr;
      while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isNonNullExpression(e.parent))) e = e.parent;
      if (ts.isCallExpression(e.parent) && e.parent.expression === e) return; // a call: pass 2 read it
      sites.push(this.site(expr, 'indirect', helper.name));
    };
    for (const sf of files) {
      const visit = (n: ts.Node): void => {
        const p = n.parent;
        if (
          ts.isIdentifier(n) &&
          byName.has(n.text) &&
          ts.isBindingElement(p) &&
          (p.propertyName ?? p.name) === n &&
          ts.isObjectBindingPattern(p.parent)
        ) {
          // `const { withClient } = this` takes the helper out of reach.
          const h = helperOf(this.checker.getTypeAtLocation(p.parent).getProperty(n.text), byName.get(n.text)!);
          if (h) sites.push(this.site(p, 'indirect', h.name));
        } else if (ts.isIdentifier(n) && byName.has(n.text) && !isDeclarationName(n) && !inTypePosition(n)) {
          if (ts.isPropertyAccessExpression(p) && p.name === n) {
            const h = helperOf(this.checker.getSymbolAtLocation(n), byName.get(n.text)!);
            if (h) report(p, h);
          } else {
            const s = ts.isShorthandPropertyAssignment(p)
              ? this.checker.getShorthandAssignmentValueSymbol(p)
              : resolveAlias(this.checker.getSymbolAtLocation(n), this.checker);
            const h = helperOf(s, byName.get(n.text)!);
            if (h) report(n, h);
          }
        } else if (ts.isElementAccessExpression(n)) {
          for (const name of this.literalNames(n.argumentExpression) ?? []) {
            const candidates = byName.get(name);
            if (!candidates) continue;
            const s =
              (ts.isStringLiteralLike(n.argumentExpression)
                ? this.checker.getSymbolAtLocation(n.argumentExpression)
                : undefined) ?? this.checker.getTypeAtLocation(n.expression).getProperty(name);
            const h = helperOf(s, candidates);
            if (h) report(n, h);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
}

/** The name a function-like declaration is called by: its own, or the variable / property holding it. */
function declarationNameText(fn: ts.SignatureDeclaration): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return propertyNameText(fn.name);
  let p: ts.Node = fn.parent;
  while (isWrapper(p)) p = p.parent;
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return propertyNameText(p.name);
  return null;
}

function isDefaultingOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken;
}

function orderOf(sf: ts.SourceFile, clientVar: string | null, use: ClientUse, tracked: boolean): CheckoutOrder {
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const ctx = use.contextPos;
  const eff = use.effect;
  return {
    clientVar,
    contextLine: ctx === null ? null : lineOf(ctx),
    firstEffect: eff ? { line: lineOf(eff.pos), sql: eff.sql } : null,
    contextFirst: tracked && ctx !== null && (eff === null || ctx < eff.pos),
  };
}

/** How a client identifier escapes other than through a call, or null. */
function escapeOf(id: ts.Identifier): string | null {
  let e: ts.Node = id;
  for (;;) {
    const p = e.parent;
    if (isWrapper(p)) {
      e = p;
      continue;
    }
    if (ts.isBinaryExpression(p) && p.right === e && isLogicalOperator(p.operatorToken.kind)) {
      e = p;
      continue;
    }
    if (ts.isBinaryExpression(p) && p.left === e && isDefaultingOperator(p.operatorToken.kind)) {
      e = p;
      continue;
    }
    if (ts.isConditionalExpression(p) && p.condition !== e) {
      e = p;
      continue;
    }
    break;
  }
  const p = e.parent;
  // An argument (or an object-literal argument's property) is read at the
  // call; a member access on the client is a pg member, not an escape.
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) return null;
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === e) return null;
  if (ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === e)) {
    let holder: ts.Node = p.parent;
    while (isWrapper(holder.parent)) holder = holder.parent;
    const call = holder.parent;
    if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && (call.arguments ?? []).some((a) => a === holder)) return null;
    return '<object>';
  }
  if (ts.isVariableDeclaration(p) && p.initializer === e) return `<alias ${p.name.getText()}>`;
  if (ts.isBinaryExpression(p) && p.right === e && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return `<alias ${p.left.getText()}>`;
  }
  if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === e)) return '<return>';
  if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) return '<object>';
  return null;
}

function isLogicalOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandToken
  );
}

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isQualifiedName(p)
  ) {
    return true;
  }
  return 'name' in p && (p as { name?: ts.Node }).name === id && !ts.isPropertyAccessExpression(p) && !ts.isShorthandPropertyAssignment(p);
}

function inTypePosition(n: ts.Node): boolean {
  return !!ts.findAncestor(n.parent, (a) =>
    ts.isTypeNode(a) && !ts.isExpressionWithTypeArguments(a)
      ? true
      : ts.isStatement(a) || ts.isBlock(a) || ts.isFunctionLike(a) || ts.isExpressionStatement(a)
        ? 'quit'
        : false,
  );
}

// ─── member resolution ──────────────────────────────────────────────────────

function pgOwners(symbol: ts.Symbol | undefined): string[] {
  const owners = new Set<string>();
  for (const decl of symbol?.getDeclarations() ?? []) {
    if (!PG_DECL_RE.test(decl.getSourceFile().fileName)) continue;
    let p: ts.Node | undefined = decl.parent;
    while (p && !(ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p))) p = p.parent;
    if (p && (p as ts.ClassDeclaration | ts.InterfaceDeclaration).name) {
      owners.add((p as ts.ClassDeclaration | ts.InterfaceDeclaration).name!.text);
    }
  }
  return [...owners].sort();
}

function classifyCall(member: string, owners: readonly string[]): PgAccessKind | null {
  if (owners.includes('Pool')) {
    if (member === 'connect') return 'pool.connect';
    return owners.length === 1 ? 'pool.query' : 'ambient-or-pool';
  }
  // A `connect` declared anywhere else opens a connection of its own (Client,
  // ClientBase). A `query` on a client is governed by where the client came from.
  if (member === 'connect') return 'client.connect';
  return null;
}

function resolveAlias(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) return checker.getAliasedSymbol(symbol);
  return symbol;
}

function declaredIn(symbol: ts.Symbol | undefined, fileSuffix: string): boolean {
  return (symbol?.getDeclarations() ?? []).some((d) =>
    toPosix(d.getSourceFile().fileName).endsWith(`/${fileSuffix}`),
  );
}

/**
 * The symbol a name ultimately refers to: through an import alias, and through
 * a destructuring of a module or object (`const { applyTenantContext } =
 * await import('../db/rls-runtime-role')`) to the property it binds.
 */
function resolveDeclared(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  const s = resolveAlias(symbol, checker);
  const decl = s?.getDeclarations()?.[0];
  if (decl && ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
    const prop = decl.propertyName ?? decl.name;
    if (ts.isIdentifier(prop) || ts.isStringLiteralLike(prop)) {
      const bound = checker.getTypeAtLocation(decl.parent).getProperty(prop.text);
      if (bound) return resolveAlias(bound, checker);
    }
  }
  return s;
}

function isContextHelperCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = strip(call.expression);
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : null;
  if (!nameNode) return false;
  const symbol = resolveDeclared(checker.getSymbolAtLocation(nameNode), checker);
  if (!symbol) return false;
  return CONTEXT_HELPERS.some((h) => h.name === symbol.getName() && declaredIn(symbol, h.file));
}

// ─── SQL extraction ─────────────────────────────────────────────────────────

/** The literal text of a string/template literal; substitutions become `${expr}`. */
export function literalText(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression): string {
  if (!ts.isTemplateExpression(node)) return node.text;
  return (
    node.head.text +
    node.templateSpans.map((s) => '${' + s.expression.getText() + '}' + s.literal.text).join('')
  );
}

/** Every literal under `expr`, following identifiers to their `const` initializer (two hops). */
function literalsOf(expr: ts.Node | undefined, checker: ts.TypeChecker, depth = 0): string[] {
  if (!expr) return [];
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      out.push(literalText(n));
      for (const span of n.templateSpans) walk(span.expression);
      return;
    }
    if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
      // `sql`, `SQL.insert`, `this.selectSql`: follow the symbol to its
      // initializer. A member with no initializer of its own (`sql.trim`)
      // contributes its receiver instead, never the whole enclosing object.
      const target = ts.isPropertyAccessExpression(n) ? n.name : n;
      const symbol = resolveAlias(checker.getSymbolAtLocation(target), checker);
      let followed = false;
      if (depth < 2) {
        for (const d of symbol?.getDeclarations() ?? []) {
          const init =
            ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)
              ? d.initializer
              : undefined;
          if (init && init !== expr) {
            out.push(...literalsOf(init, checker, depth + 1));
            followed = true;
          }
        }
      }
      if (!followed && ts.isPropertyAccessExpression(n)) walk(n.expression);
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(expr);
  return out;
}

// ─── naming ─────────────────────────────────────────────────────────────────

const ROUTE_METHOD_RE = /^(get|post|put|patch|delete|use|all)$/;

/**
 * The nearest named function for a node — the allowlist key. Line numbers move
 * on every edit; a function name plus an exact count stays stable and still
 * catches a new statement.
 *
 * `Class.method`, `Class.constructor`, `Class.property` (arrow properties),
 * a variable-bound arrow by its variable, an object-literal property arrow
 * qualified by what encloses it (`createApp.check`), and an anonymous route
 * handler as `POST /route`.
 */
export function functionName(node: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isFunctionDeclaration(p) && p.name) {
      parts.unshift(p.name.getText(sf));
      break;
    }
    if (ts.isMethodDeclaration(p) && p.name) {
      parts.unshift(p.name.getText(sf));
      if (ts.isClassLike(p.parent)) {
        if (p.parent.name) parts.unshift(p.parent.name.text);
        break;
      }
      // An object-literal method: keep walking to name what holds the object.
    }
    if (parts.length > 0 && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      // `const userModeService = { async getUser() {…} }` → userModeService.getUser
      parts.unshift(p.name.text);
      break;
    }
    if (ts.isConstructorDeclaration(p)) {
      parts.unshift('constructor');
      if (p.parent.name) parts.unshift(p.parent.name.text);
      break;
    }
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const q = p.parent;
      if (ts.isVariableDeclaration(q)) {
        parts.unshift(q.name.getText(sf));
        break;
      }
      if (ts.isPropertyAssignment(q)) parts.unshift(q.name.getText(sf));
      if (ts.isPropertyDeclaration(q)) {
        parts.unshift(q.name.getText(sf));
        if (ts.isClassLike(q.parent) && q.parent.name) parts.unshift(q.parent.name.text);
        break;
      }
      if (
        ts.isCallExpression(q) &&
        ts.isPropertyAccessExpression(q.expression) &&
        ROUTE_METHOD_RE.test(q.expression.name.text) &&
        q.arguments[0] &&
        ts.isStringLiteralLike(q.arguments[0])
      ) {
        parts.unshift(`${q.expression.name.text.toUpperCase()} ${q.arguments[0].text}`);
        break;
      }
    }
    p = p.parent;
  }
  return parts.join('.') || '<module>';
}

// ─── table extraction (used by the guard's tables check) ────────────────────

/**
 * Table identifiers named after FROM/JOIN/INTO/UPDATE/TABLE/USING/TRUNCATE/COPY
 * (and each further item of a comma join), quoted or `public.`-qualified,
 * intersected with `known`.
 */
export function sqlTables(sql: readonly string[], known: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const add = (a: string, b: string | undefined): void => {
    const first = a.toLowerCase();
    const second = b?.toLowerCase();
    const name = second === undefined ? first : first === 'public' ? second : `${first}.${second}`;
    if (known.has(name)) found.add(name);
  };
  for (const text of sql) {
    for (const m of text.matchAll(TABLE_REF_RE)) {
      add(m[1], m[2]);
      // A comma join: `FROM a x, b y` names b too.
      let rest = text.slice((m.index ?? 0) + m[0].length);
      for (let guard = 0; guard < 16; guard += 1) {
        const c = COMMA_ITEM_RE.exec(rest);
        if (!c || (c[1] !== undefined && SQL_CLAUSE_WORDS.has(c[1].toLowerCase()))) break;
        add(c[2], c[3]);
        rest = rest.slice(c[0].length);
      }
    }
  }
  return [...found].sort();
}
