/**
 * Does `createApp()` ACTUALLY hand the appointment path its dependencies?
 *
 * This is the layer that killed the first cut of this fix. The drafting
 * handler had a correct `detectServiceLocationGap`, the registry threaded a
 * `locationRepo` into it, the router interface declared the dep, and the unit
 * tests were green — but `app.ts` never passed one, so in production the gap
 * check no-opped on every booking and the feature was dead on arrival. The
 * same applies to the tenant timezone: `AssistantRouterDeps` declared a
 * top-level `tenantTimezoneResolver` while app.ts only ever set a
 * DIFFERENT, similarly-named field nested under `lookups` — so the assistant
 * surface drafted every appointment with no zone at all.
 *
 * Neither defect is visible to a type check (both deps are optional) or to any
 * test that constructs the router itself. So this file boots the real app and
 * intercepts the dependency objects at the two call sites.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Router } from 'express';

const assistantDeps: Record<string, unknown>[] = [];
const voiceWorkerDeps: Record<string, unknown>[] = [];

vi.mock('../../src/routes/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../src/routes/assistant')>(
    '../../src/routes/assistant',
  );
  return {
    ...actual,
    createAssistantRouter: (deps: Record<string, unknown>) => {
      assistantDeps.push(deps);
      return Router();
    },
  };
});

vi.mock('../../src/workers/voice-action-router', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/workers/voice-action-router')
  >('../../src/workers/voice-action-router');
  return {
    ...actual,
    createVoiceActionRouterWorker: (deps: Record<string, unknown>) => {
      voiceWorkerDeps.push(deps);
      return { start: () => undefined, stop: async () => undefined };
    },
  };
});

let app: { shutdown?: () => Promise<void> } | undefined;

beforeAll(async () => {
  const { createApp } = await import('../../src/app');
  const { resetConfig } = await import('../../src/shared/config');
  resetConfig();
  app = (await createApp()) as unknown as { shutdown?: () => Promise<void> };
});

afterAll(async () => {
  await app?.shutdown?.();
});

describe('createApp wires the appointment path', () => {
  it('gives the assistant router a locationRepo (draft-time bookability gate)', () => {
    expect(assistantDeps.length).toBeGreaterThan(0);
    // Without this the gate silently no-ops and an unbookable customer's
    // booking auto-approves into "Customer has no service location".
    expect(assistantDeps[0]!.locationRepo).toBeDefined();
  });

  it('gives the assistant router a TOP-LEVEL tenantTimezoneResolver', () => {
    // NOT `lookups.tenantTimezoneResolver` — that one feeds the read-only
    // lookup skills and never reaches a drafting TaskContext. This is the
    // exact confusion that left assistant-drafted appointments with no zone.
    const deps = assistantDeps[0]!;
    expect(typeof deps.tenantTimezoneResolver).toBe('function');
  });

  it('gives the voice worker both a locationRepo and a scheduling resolver', () => {
    expect(voiceWorkerDeps.length).toBeGreaterThan(0);
    const deps = voiceWorkerDeps[0]!;
    expect(deps.locationRepo).toBeDefined();
    // The zone source for every spoken booking.
    expect(typeof deps.tenantSchedulingResolver).toBe('function');
  });

  it('the assistant timezone resolver reads through to tenant settings', async () => {
    const resolve = assistantDeps[0]!.tenantTimezoneResolver as (
      t: string,
    ) => Promise<string | undefined>;
    // An unknown tenant has no settings row, so it must resolve to undefined
    // — the "never chose a zone" state the drafting handler gates on. A
    // resolver that substituted a default here would re-open the whole bug.
    await expect(resolve('99999999-9999-4999-8999-999999999999')).resolves.toBeUndefined();
  });
});
