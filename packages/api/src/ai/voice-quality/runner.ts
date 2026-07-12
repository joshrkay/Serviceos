/**
 * VQ-008 — Per-script runner for the Voice Quality Layer 1 harness.
 *
 * Given a single `VoiceQualityScript` plus a context bundle, drives the
 * script end-to-end and returns an `Observation` (plus session timing
 * metadata). The runner does NOT grade — that's the job of VQ-020..023.
 * The runner's contract is "produce a pristine observation graders can
 * later assert against".
 *
 * # Lifecycle (per call to `runScript`)
 * 1. Build a fresh in-memory `RepoBundle` (see `makeRepoBundle`). Layer 1
 *    is intentionally memory-only: the LLM is mocked via cassettes, and the
 *    driver reads several repos (owner-approval settings, catalog, on-call,
 *    DNC) that the bundle doesn't own, so a "half-pg" bundle would be a
 *    misleading DB signal rather than a faithful one. A true DB-backed
 *    Layer-1 harness is tracked as future work (QUALITY-2026-07-12 WS1).
 * 2. Seed `script.fixtures.tenant` (overrides) into a synthesized
 *    `TenantRow` via `buildTenant` from the existing test factories.
 *    Seed `script.fixtures.customers` / `appointments` / `invoices`
 *    into the corresponding repos. Fixture rows are passed through
 *    each repo's `create()` directly — they're already fully-shaped
 *    domain objects per the schema convention (see VQ-001 docs §5.2).
 *    Spurious fields are tolerated: each repo deep-copies the row, and
 *    the InMemory implementations don't introspect unknown keys.
 * 3. Snapshot pre-counts for `customer` / `appointment` so the
 *    Observation can report deltas.
 * 4. Build a fresh `AgentEventBus` and obtain a driver via
 *    `ctx.driverFactory()`. The factory is invoked per `runScript`
 *    call so each script gets its own session store / classifier
 *    state — no leakage between sequential calls.
 * 5. Walk the script's `turns`:
 *    a. `driver.speak(sessionId, turn.caller)` — collect latency.
 *    b. If `turn.hangupAfter`, `driver.hangup(sessionId)` — emits
 *       `session_terminated cause=hangup` on the session bus.
 * 6. `driver.endSession()` so synthetic Twilio CallSids and timers
 *    don't leak.
 * 7. Snapshot post-counts + audit + proposals.
 * 8. Build `Observation` via `buildObservation()` (a pure function;
 *    all timestamps are explicit so test results are deterministic).
 *
 * # Bus subscription
 * The runner builds its own `AgentEventBus` and passes it into the
 * driver via the factory contract — but `AgentDriver` only exposes
 * lifecycle methods, not "subscribe to my session". To bridge this:
 * the runner accepts a factory (not an instance) so the factory's
 * implementation can pre-wire the bus into the driver's deps before
 * returning. The runner *also* passes the bus into `buildObservation`
 * so the observation captures every event the bus heard. The factory
 * convention used by the unit tests + Phase 2 corpus is to pass the
 * same `AgentEventBus` instance the runner used into the driver's
 * deps; if a factory ignores this, the runner falls back to walking
 * the session's emitter directly via the driver's bus arg
 * (`ctx.bus`). VQ-008's tests cover the factory-pre-wired path.
 *
 * # Cassette wiring
 * `ctx.cassetteMode` and `ctx.gatewayFactory` exist for forward
 * compatibility with the Phase-2 corpus runs. The default factory
 * (left undefined here) means the call-site is expected to wire the
 * cassette gateway into the driver inside `driverFactory`. We expose
 * the explicit hook so future call-sites that want to override the
 * cassette mode (e.g. a scheduled re-record job) can plumb a custom
 * gateway factory through without changing the driver factory.
 */
import { v4 as uuidv4 } from 'uuid';
import type { VoiceQualityScript } from './schema';
import type { AgentDriver } from './text-mode-driver';
import type { LLMGateway } from '../gateway/gateway';
import { AgentEventBus } from './event-bus';
import { buildObservation, type Observation } from './observation';
import { sessionTerminatedEvent } from './events';

import { InMemoryCustomerRepository, type Customer } from '../../customers/customer';
import { InMemoryAppointmentRepository } from '../../appointments/in-memory-appointment';
import type { Appointment } from '../../appointments/appointment';
import { InMemoryInvoiceRepository, type Invoice } from '../../invoices/invoice';
import { InMemoryEstimateRepository, type Estimate } from '../../estimates/estimate';
import { InMemoryJobRepository } from '../../jobs/job';
import { InMemoryLeadRepository } from '../../leads/in-memory-lead';
import { InMemoryProposalRepository } from '../../proposals/proposal';
import { InMemoryAuditRepository } from '../../audit/audit';
import type { TenantRow } from '../../db/schema';

import type { CustomerRepository } from '../../customers/customer';
import type { AppointmentRepository } from '../../appointments/appointment';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { EstimateRepository } from '../../estimates/estimate';
import type { JobRepository } from '../../jobs/job';
import type { LeadRepository } from '../../leads/lead';
import type { Proposal, ProposalRepository } from '../../proposals/proposal';
import type { AuditRepository } from '../../audit/audit';

// ─── Public types ────────────────────────────────────────────────────────────

export interface RepoBundle {
  customerRepo: CustomerRepository;
  appointmentRepo: AppointmentRepository;
  leadRepo: LeadRepository;
  invoiceRepo: InvoiceRepository;
  estimateRepo: EstimateRepository;
  jobRepo: JobRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
}

/**
 * Tiny cost tracker shape — graders accumulate `addCents()` deltas as
 * the call progresses; `totalCents()` is surfaced on `Observation`.
 * The runner doesn't itself emit cost events (those come from
 * production emit sites already wired in VQ-003); the tracker is
 * exposed so higher-level harness code (Phase-3 graders, judge
 * batching) can share an accumulator without re-walking events.
 */
export interface CostTracker {
  addCents: (n: number) => void;
  totalCents: () => number;
}

/**
 * Context passed to the `driverFactory`. The runner owns the
 * `RepoBundle` (so it can seed fixtures + snapshot counts) and the
 * `AgentEventBus` (so it can read events for the observation), then
 * hands both to the factory so the factory wires them into a fresh
 * `TextModeDriver` (or a Layer-2 driver) without re-allocating.
 */
export interface DriverFactoryContext {
  repos: RepoBundle;
  bus: AgentEventBus;
  /** Pre-built cassette/mock gateway for this script run, when supplied. */
  gateway?: LLMGateway;
  /** Identifies the script the driver is being built for (cassette key). */
  scriptId: string;
  /** The canonical tenant id the runner is scoping the call to. */
  tenantId: string;
}

export interface RunScriptContext {
  /**
   * Factory because each call needs a fresh session store. The runner
   * passes the repo bundle + event bus it owns so the factory wires
   * them into the driver. Without this, the driver would allocate its
   * own repos and the runner's seed/observe loop would target a
   * different memory than the driver actually reads/writes.
   */
  driverFactory: (ctx: DriverFactoryContext) => AgentDriver;
  /**
   * Layer 1 is memory-only (see `makeRepoBundle`). Kept as an explicit field
   * (rather than dropped entirely) so every call-site states its intent and a
   * future DB-backed mode can widen this union without touching call-sites.
   */
  repoMode: 'memory';
  /** Forwarded to `gatewayFactory`. Reserved for cassette wiring (VQ-005). */
  cassetteMode?: 'replay' | 'record' | 'refresh';
  /** Optional gateway override; default leaves the driver's gateway untouched. */
  gatewayFactory?: (scriptId: string) => LLMGateway;
  costTracker?: CostTracker;
  /**
   * Optional bus override. When supplied, the runner subscribes the
   * driver's session(s) here AND uses the same bus to build the
   * observation. When omitted (the default), the runner builds its own.
   */
  bus?: AgentEventBus;
}

export interface RunScriptResult {
  observation: Observation;
  /**
   * Always `false` from the runner. Graders flip this to `true` when
   * every applicable rubric criterion passes. Co-locating this here
   * (rather than letting graders synthesise their own Result type)
   * lets the report aggregator compute pass rates without needing a
   * second join across two record types.
   */
  passed: boolean;
  errors: string[];
  durationMs: number;
}

// ─── Repo factory ────────────────────────────────────────────────────────────

/**
 * Build a fresh in-memory `RepoBundle` for a single `runScript` invocation.
 * Isolation is trivial: each call gets its own bundle.
 *
 * There is no `pg` mode. It was a throwing stub (`'pg mode not yet supported'`)
 * that the nightly workflow drove behind `continue-on-error`, so the corpus
 * never actually ran against Postgres — the run errored and was ignored, a
 * decorative gate. Rather than keep a fake option alive, Layer 1 is memory-only
 * (QUALITY-2026-07-12 WS1). See the runner header for why a partial Pg bundle
 * would be a misleading signal; a true DB-backed Layer-1 harness is future work.
 */
export function makeRepoBundle(mode: 'memory'): RepoBundle {
  void mode;
  return {
    customerRepo: new InMemoryCustomerRepository(),
    appointmentRepo: new InMemoryAppointmentRepository(),
    leadRepo: new InMemoryLeadRepository(),
    invoiceRepo: new InMemoryInvoiceRepository(),
    estimateRepo: new InMemoryEstimateRepository(),
    jobRepo: new InMemoryJobRepository(),
    proposalRepo: new InMemoryProposalRepository(),
    auditRepo: new InMemoryAuditRepository(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Materialize the script's tenant overrides into a `TenantRow`.
 *
 * `script.fixtures.tenant` is `Record<string, unknown>` per Zod
 * schema. We mirror the test factory (`buildTenant` in
 * `test/factories/tenant.factory.ts`) inline rather than import it —
 * the runner ships in production builds (where `test/` is excluded)
 * so reaching into the factory would create a build dependency on
 * test-only code. Defaults match the factory's shape; the script's
 * overrides spread last so it can pin a specific id when downstream
 * skill calls need a stable tenant.
 *
 * Spurious keys in the fixture (anything that isn't a `TenantRow`
 * field) are ignored at runtime by virtue of being assigned to
 * properties no one reads.
 */
function materializeTenant(script: VoiceQualityScript): TenantRow {
  const now = new Date();
  const defaults: TenantRow = {
    id: uuidv4(),
    owner_id: uuidv4(),
    owner_email: 'owner@vq-runner.test',
    name: 'VQ Runner Tenant',
    created_at: now,
    updated_at: now,
  };
  return { ...defaults, ...(script.fixtures.tenant as Partial<TenantRow>) };
}

/**
 * Resolve the canonical tenant ID used to scope the run. Prefers the
 * fixture's `id` if present (so call-sites that synthesize fixtures
 * with a known id can target them in `lookup_*` skills); otherwise
 * uses the freshly-minted tenant row id.
 */
function resolveTenantId(script: VoiceQualityScript, tenantRow: TenantRow): string {
  const fixtureId = (script.fixtures.tenant as Record<string, unknown>).id;
  if (typeof fixtureId === 'string' && fixtureId.length > 0) return fixtureId;
  return tenantRow.id;
}

/**
 * Seed fixture rows into their respective repos. Each row is passed
 * to the repo's `create()` verbatim — fixtures are expected to be
 * already-shaped domain objects per the schema convention (the Zod
 * schema declares them as `unknown` for forward-compat). If a row is
 * malformed, the repo will throw a clear error.
 */
/**
 * Coerce a JSON-fixture proposal's ISO-string date fields into real `Date`
 * objects so seeded rows match the production (Pg-hydrated) domain shape the
 * approval/resolver code paths assume. Idempotent: already-`Date` values pass
 * through untouched.
 */
export function coerceProposalDates(p: Proposal): Proposal {
  const toDate = (v: unknown): Date | undefined => {
    if (v instanceof Date) return v;
    if (typeof v === 'string' || typeof v === 'number') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return undefined;
  };
  const createdAt = toDate(p.createdAt);
  const updatedAt = toDate(p.updatedAt);
  return {
    ...p,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

async function seedFixtures(
  script: VoiceQualityScript,
  repos: RepoBundle,
): Promise<void> {
  for (const c of script.fixtures.customers as Customer[]) {
    await repos.customerRepo.create(c);
  }
  if (script.fixtures.appointments) {
    for (const a of script.fixtures.appointments as Appointment[]) {
      await repos.appointmentRepo.create(a);
    }
  }
  if (script.fixtures.invoices) {
    for (const i of script.fixtures.invoices as Invoice[]) {
      await repos.invoiceRepo.create(i);
    }
  }
  // WS21b — pending proposals so an owner-approval script has real targets to
  // approve/reject. Seeded into the SAME proposalRepo the driver's approval
  // dialogue reads/writes, so a script's approve turn flips the seeded
  // proposal's status and the runner's post-count delta observes it.
  //
  // Date fields MUST be coerced to real `Date` objects: fixtures are JSON, so
  // `createdAt`/`updatedAt` arrive as ISO strings, but `Proposal.createdAt` is
  // typed `Date` and production (PgProposalRepository) hydrates real Dates.
  // The pending-proposal resolver sorts by `createdAt.getTime()`
  // (pending-proposal-resolver.ts) — a batch owner-approval ("what's waiting")
  // over ≥2 seeded proposals invoked that comparator and threw
  // `createdAt.getTime is not a function`, dropping the turn. Single-proposal
  // scripts never tripped it (Array.sort skips the comparator for length 1).
  if (script.fixtures.proposals) {
    for (const p of script.fixtures.proposals as Proposal[]) {
      await repos.proposalRepo.create(coerceProposalDates(p));
    }
  }
  // Estimates / jobs / leads not surfaced in the v1 schema's optional
  // fixture set, but the repo bundle exposes them so future schema
  // versions can extend without touching this signature. Treated as
  // pass-through for now.
  void (null as unknown as Estimate);
}

/**
 * Snapshot the count of customers + appointments for a tenant. Used to
 * compute deltas on the observation.
 */
async function snapshotCounts(
  tenantId: string,
  repos: RepoBundle,
): Promise<{ customers: number; appointments: number }> {
  const customers = (await repos.customerRepo.findByTenant(tenantId)).length;
  // Appointments lack a top-level findByTenant — listWithMeta returns
  // total. The InMemory variant exposes it; if a future repo doesn't,
  // we fall back to a wide date range walk. Since v1 always uses the
  // InMemory variant in PR-CI, listWithMeta is the canonical path.
  let appointments = 0;
  if (repos.appointmentRepo.listWithMeta) {
    const r = await repos.appointmentRepo.listWithMeta(tenantId);
    appointments = r.total;
  } else {
    const r = await repos.appointmentRepo.findByDateRange(
      tenantId,
      new Date(0),
      new Date('9999-12-31'),
    );
    appointments = r.length;
  }
  return { customers, appointments };
}

// ─── Public entry ────────────────────────────────────────────────────────────

export async function runScript(
  script: VoiceQualityScript,
  ctx: RunScriptContext,
): Promise<RunScriptResult> {
  const callId = `vq-${script.id}-${uuidv4()}`;
  const startedAt = Date.now();
  const errors: string[] = [];

  // Repo bundle — `pg` throws today.
  const repos = makeRepoBundle(ctx.repoMode);

  // Tenant row + canonical id. The schema permits fixture ids as
  // strings, but if the fixture didn't carry one we fall back to the
  // factory's uuid.
  const tenantRow = materializeTenant(script);
  const tenantId = resolveTenantId(script, tenantRow);

  // Seed fixtures.
  try {
    await seedFixtures(script, repos);
  } catch (err) {
    errors.push(`seed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Pre-counts for delta math.
  const pre = await snapshotCounts(tenantId, repos);

  // Bus: caller may provide one (so they can also pre-wire it into the
  // driver via `driverFactory`); otherwise we mint our own. Either
  // way, the same bus instance is what `buildObservation` reads at the
  // end of the run.
  const bus = ctx.bus ?? new AgentEventBus();

  // Driver: factory invoked once per script. We pass the repo bundle
  // + bus so the driver writes mutations into the same store the
  // runner snapshots and emits events on the bus the runner reads.
  const gateway = ctx.gatewayFactory ? ctx.gatewayFactory(script.id) : undefined;
  const driver = ctx.driverFactory({
    repos,
    bus,
    ...(gateway ? { gateway } : {}),
    scriptId: script.id,
    tenantId,
  });

  let sessionId: string | undefined;
  try {
    const startResult = await driver.startSession({
      tenantId,
      callerId: script.callerId,
      callerIdBlocked: script.callerIdBlocked,
      // WS21b — unlock the owner-only approval/edit dialogue when the fixture
      // declares the caller is the owner (or seeds a matching ownerPhone).
      ...(script.callerIsOwner ? { callerIsOwner: true } : {}),
    });
    sessionId = startResult.sessionId;

    // Walk turns. Each `speak` rolls forward classifier + router; on a
    // `hangupAfter` turn we follow with `hangup` so the session emits
    // `session_terminated cause=hangup`.
    for (const turn of script.turns) {
      try {
        await driver.speak(sessionId, turn.caller);
      } catch (err) {
        errors.push(
          `speak: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (turn.hangupAfter) {
        try {
          await driver.hangup(sessionId);
        } catch (err) {
          errors.push(
            `hangup: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

  } finally {
    if (sessionId) {
      try {
        await driver.endSession(sessionId);
      } catch (err) {
        errors.push(
          `endSession: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Mark a clean end. The production driver only emits
  // `session_terminated` for hangup/cost-cap paths, so a successful
  // happy-path script otherwise has no termination event and
  // `buildObservation` would conservatively classify it as
  // 'terminated' (see VQ-004's default). Stamp `completed` here when
  // — and only when — no terminating event already exists, so we
  // don't override an earlier hangup/cost_cap.
  const alreadyTerminated = bus
    .events()
    .some((e) => e.type === 'session_terminated');
  if (!alreadyTerminated) {
    bus.record(sessionTerminatedEvent('completed'));
  }

  // Post-counts + observation.
  const post = await snapshotCounts(tenantId, repos);
  const proposalsAfter = await repos.proposalRepo.findByTenant(tenantId);
  const audit =
    repos.auditRepo instanceof InMemoryAuditRepository
      ? repos.auditRepo.getAll()
      : [];

  const callEndedAt = Date.now();
  const observation = buildObservation({
    callId,
    scriptId: script.id,
    tenantId,
    bus,
    proposalsAfter,
    customerCountBefore: pre.customers,
    customerCountAfter: post.customers,
    appointmentCountBefore: pre.appointments,
    appointmentCountAfter: post.appointments,
    audit,
    callStartedAtMs: startedAt,
    callEndedAtMs: callEndedAt,
  });

  return {
    observation,
    passed: false,
    errors,
    durationMs: callEndedAt - startedAt,
  };
}
