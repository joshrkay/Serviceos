/**
 * Characterization — repository instance sharing inside createApp().
 *
 * PREREQUISITE SAFETY NET for the app.ts wiring decomposition (D-022).
 *
 * Several repositories are deliberately constructed ~180 lines above their
 * domain cluster so that the pre-auth webhook routers and the authenticated
 * /api routers receive THE SAME OBJECT. app.ts:1111-1114 states the reason:
 *
 *     "Hoisted up so the Stripe webhook and the rest of the app share a
 *      single instance — InMemory repos are stateful, so two separate
 *      `new InMemoryJobRepository()` calls would diverge in tests."
 *
 * That invariant is invisible to the type system and to every existing test:
 * a factory extraction that constructs a second instance still type-checks,
 * still boots, and still passes every suite that exercises only one of the
 * two surfaces. It fails only where the webhook writes and the API reads.
 *
 * IMPORTANT — the invariant is NOT applied uniformly today, and this test
 * pins the ASYMMETRY as it actually is rather than as the comment implies:
 *
 *   shared (1 construction)      settingsRepo (aliased, app.ts:1106)
 *                                jobRepo (hoisted, app.ts:1115)
 *                                pendingInvitationRepo (hoisted, app.ts:1119)
 *
 *   duplicated (2 constructions) invoiceRepo   1295 vs webhookInvoiceRepo  1108
 *                                estimateRepo  1294 vs webhookEstimateRepo 1109
 *                                paymentRepo   1302 vs webhookPaymentRepo  1110
 *
 * The duplicated three are harmless in production — two PgInvoiceRepository
 * instances read one database — but in hermetic (no-pool) mode they are two
 * independent in-memory stores that silently diverge. That is a test-fidelity
 * gap, not a production bug, and it is deliberately pinned here rather than
 * fixed: changing it is a behaviour change that belongs in its own commit,
 * not smuggled into a wiring refactor.
 *
 * If you are here because this test failed:
 *   - a count went 1 -> 2: you broke a sharing invariant. Do not update the
 *     constant. The webhook surface and the API surface have diverged.
 *   - a count went 2 -> 1: you (perhaps accidentally) FIXED one of the
 *     duplicates. That is likely an improvement, but it changes in-memory
 *     test behaviour — land it deliberately, on its own, and say so.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted so the vi.mock factories below (which are themselves hoisted above
// the imports) can reach the counter.
const { constructions, countConstruction } = vi.hoisted(() => {
  const constructions = new Map<string, number>();
  return {
    constructions,
    countConstruction: (name: string) =>
      constructions.set(name, (constructions.get(name) ?? 0) + 1),
  };
});

/**
 * Wraps an InMemory repository class so each `new` bumps a counter, while
 * preserving the class name (some diagnostics read `constructor.name`) and
 * the prototype chain (so `instanceof` and the real behaviour are intact).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a constructor
// wrapper is inherently variadic over its base's parameters.
type AnyRepositoryCtor = new (...args: any[]) => object;

function counting<T extends AnyRepositoryCtor>(Base: T, name: string): T {
  const Wrapped = class extends (Base as AnyRepositoryCtor) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      super(...args);
      countConstruction(name);
    }
  };
  // Preserve the class name — some boot diagnostics read `constructor.name`.
  Object.defineProperty(Wrapped, 'name', { value: name });
  return Wrapped as unknown as T;
}

vi.mock('../../src/jobs/job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/jobs/job')>();
  return {
    ...actual,
    InMemoryJobRepository: counting(actual.InMemoryJobRepository, 'InMemoryJobRepository'),
  };
});

vi.mock('../../src/settings/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/settings/settings')>();
  return {
    ...actual,
    InMemorySettingsRepository: counting(
      actual.InMemorySettingsRepository,
      'InMemorySettingsRepository',
    ),
  };
});

vi.mock('../../src/users/pending-invitation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/users/pending-invitation')>();
  return {
    ...actual,
    InMemoryPendingInvitationRepository: counting(
      actual.InMemoryPendingInvitationRepository,
      'InMemoryPendingInvitationRepository',
    ),
  };
});

vi.mock('../../src/invoices/invoice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/invoices/invoice')>();
  return {
    ...actual,
    InMemoryInvoiceRepository: counting(
      actual.InMemoryInvoiceRepository,
      'InMemoryInvoiceRepository',
    ),
  };
});

vi.mock('../../src/estimates/estimate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/estimates/estimate')>();
  return {
    ...actual,
    InMemoryEstimateRepository: counting(
      actual.InMemoryEstimateRepository,
      'InMemoryEstimateRepository',
    ),
  };
});

vi.mock('../../src/invoices/payment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/invoices/payment')>();
  return {
    ...actual,
    InMemoryPaymentRepository: counting(
      actual.InMemoryPaymentRepository,
      'InMemoryPaymentRepository',
    ),
  };
});

/** Constructions per hermetic createApp() boot, as of the baseline. */
const EXPECTED_CONSTRUCTIONS: ReadonlyArray<readonly [string, number]> = [
  // Shared between the pre-auth webhook routers and the /api routers.
  ['InMemorySettingsRepository', 1],
  ['InMemoryJobRepository', 1],
  ['InMemoryPendingInvitationRepository', 1],
  // Duplicated: one for the webhook surface, one for the API surface.
  ['InMemoryInvoiceRepository', 2],
  ['InMemoryEstimateRepository', 2],
  ['InMemoryPaymentRepository', 2],
];

describe('characterization — repository instance sharing', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalProcessRole = process.env.PROCESS_ROLE;
  let created: Array<{ gracefulDrain: (reason: string) => Promise<void> }> = [];

  beforeEach(() => {
    // Hermetic: no pool, so every repo takes its InMemory branch.
    delete process.env.DATABASE_URL;
    process.env.PROCESS_ROLE = 'all';
    constructions.clear();
    created = [];
  });

  afterEach(async () => {
    for (const app of created.splice(0)) {
      await app.gracefulDrain('test-cleanup');
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalProcessRole === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = originalProcessRole;
  });

  const boot = async () => {
    const { createApp } = await import('../../src/app');
    const { resetConfig } = await import('../../src/shared/config');
    resetConfig();
    const app = createApp();
    created.push(app);
    return app;
  };

  it.each(EXPECTED_CONSTRUCTIONS)(
    'constructs %s exactly %i time(s) per boot',
    async (className, expected) => {
      await boot();
      expect(constructions.get(className) ?? 0).toBe(expected);
    },
  );

  it('constructs the same counts on a second boot in the same process', async () => {
    await boot();
    const first = new Map(constructions);
    constructions.clear();
    await boot();
    expect(Object.fromEntries(constructions)).toEqual(Object.fromEntries(first));
  });
});
