/**
 * 4.11 — Does `createApp()` ACTUALLY register a technician-assignment
 * notifier?
 *
 * `TechnicianAssignmentNotifier`'s own doc-comment claims "app.ts registers
 * one notifier" (mirroring the owner-notification singleton), but
 * `setTechnicianAssignmentNotifier` had zero production callers: every
 * assignment/reassignment calls the process-wide
 * `notifyTechnicianAssignmentChange` accessor, which resolves through an
 * `instance` that app.ts never set — so every production assignment
 * silently no-ops. Unit tests of `TechnicianAssignmentNotifier` itself
 * (test/appointments/assignment-notifications.test.ts) can't catch this: they
 * construct the class directly and never go near createApp(). This file
 * boots the real app (in-memory — no Postgres needed for this half of the
 * proof) and intercepts the registration call, matching the precedent in
 * test/app/appointment-bookability-wiring.test.ts for a wiring defect that a
 * type check and a unit test both miss.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const registered: unknown[] = [];

vi.mock('../../src/appointments/assignment-notifications', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/appointments/assignment-notifications')
  >('../../src/appointments/assignment-notifications');
  return {
    ...actual,
    setTechnicianAssignmentNotifier: (notifier: unknown) => {
      registered.push(notifier);
      return actual.setTechnicianAssignmentNotifier(notifier as never);
    },
  };
});

let app: { shutdown?: () => Promise<void> } | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  // In-memory boot — no Postgres needed to prove the registration call
  // itself happens; the Docker-gated
  // test/integration/assignment-notifier-wiring.test.ts proves what the
  // registered notifier does against real Postgres.
  delete process.env.DATABASE_URL;
  const { createApp } = await import('../../src/app');
  const { resetConfig } = await import('../../src/shared/config');
  resetConfig();
  app = (await createApp()) as unknown as { shutdown?: () => Promise<void> };
});

afterAll(async () => {
  await app?.shutdown?.();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe('createApp wires the technician-assignment notifier (4.11)', () => {
  it('calls setTechnicianAssignmentNotifier with a real (defined) notifier during boot', () => {
    expect(registered.length).toBeGreaterThan(0);
    expect(registered[0]).toBeDefined();
  });
});
