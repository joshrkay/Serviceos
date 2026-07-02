import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPresenceRouter } from '../../src/dispatch/presence-routes';
import {
  listDispatchPresence,
  resetDispatchPresenceStoreForTests,
} from '../../src/dispatch/presence-store';
import { getDispatchBoardEventBus } from '../../src/dispatch/board-event-bus';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

/**
 * UC-3 — HTTP presence contract. The PUT/DELETE route is now the FALLBACK
 * transport (WS carries the primary heartbeat), so backward compatibility is
 * load-bearing: legacy clients still on the original 5s PUT with no `ttlMs`
 * must keep working unchanged.
 */

const DATE = '2026-05-20';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).auth = {
      tenantId: 't1',
      userId: 'u1',
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use('/api/dispatch', createPresenceRouter());
  return app;
}

describe('presence routes (HTTP fallback + legacy contract)', () => {
  let events: Array<{ type: string; date: string }>;
  let unsubscribe: () => void;

  beforeEach(() => {
    resetDispatchPresenceStoreForTests();
    events = [];
    unsubscribe = getDispatchBoardEventBus().subscribe('t1', DATE, (evt) => {
      events.push(evt);
    });
  });

  afterEach(() => {
    unsubscribe();
    resetDispatchPresenceStoreForTests();
  });

  it('legacy 5s-PUT clients (no ttlMs) still get a 204 and the unchanged 15s default lease', async () => {
    const app = makeApp();
    const before = Date.now();
    const res = await request(app)
      .put('/api/dispatch/presence')
      .send({ date: DATE, mode: 'viewing', appointmentId: null, displayName: 'Alex' });
    expect(res.status).toBe(204);

    const entries = await listDispatchPresence('t1', DATE);
    expect(entries).toHaveLength(1);
    const remaining = entries[0].expiresAt - before;
    expect(remaining).toBeGreaterThan(10_000);
    expect(remaining).toBeLessThanOrEqual(16_000); // default 15s, not the fallback TTL
  });

  it('publishes presence_updated only when the visible state changes (not on heartbeat refresh)', async () => {
    const app = makeApp();
    const body = { date: DATE, mode: 'viewing', appointmentId: null, displayName: 'Alex' };
    await request(app).put('/api/dispatch/presence').send(body);
    expect(events.filter((e) => e.type === 'presence_updated')).toHaveLength(1);

    // Identical heartbeat — pure TTL refresh, no fan-out.
    await request(app).put('/api/dispatch/presence').send(body);
    expect(events.filter((e) => e.type === 'presence_updated')).toHaveLength(1);

    // Drag start — visible change, publishes again.
    await request(app)
      .put('/api/dispatch/presence')
      .send({ ...body, mode: 'dragging', appointmentId: 'appt-1' });
    expect(events.filter((e) => e.type === 'presence_updated')).toHaveLength(2);
  });

  it('accepts the fallback ttlMs and clamps it to the allowed range', async () => {
    const app = makeApp();
    const before = Date.now();
    await request(app)
      .put('/api/dispatch/presence')
      .send({ date: DATE, mode: 'viewing', appointmentId: null, displayName: 'Alex', ttlMs: 75_000 });
    let entries = await listDispatchPresence('t1', DATE);
    expect(entries[0].expiresAt - before).toBeGreaterThan(60_000);

    await request(app)
      .put('/api/dispatch/presence')
      .send({ date: DATE, mode: 'viewing', appointmentId: null, displayName: 'Alex', ttlMs: 999_999_999 });
    entries = await listDispatchPresence('t1', DATE);
    expect(entries[0].expiresAt - Date.now()).toBeLessThanOrEqual(120_000);
  });

  it('rejects a malformed date with 400 (unchanged validation)', async () => {
    const app = makeApp();
    const res = await request(app)
      .put('/api/dispatch/presence')
      .send({ date: 'not-a-date', mode: 'viewing' });
    expect(res.status).toBe(400);
  });

  it('DELETE clears presence and publishes once; a second DELETE is silent', async () => {
    const app = makeApp();
    await request(app)
      .put('/api/dispatch/presence')
      .send({ date: DATE, mode: 'viewing', appointmentId: null, displayName: 'Alex' });
    const baseline = events.length;

    const res = await request(app).delete(`/api/dispatch/presence?date=${DATE}`);
    expect(res.status).toBe(204);
    expect(await listDispatchPresence('t1', DATE)).toHaveLength(0);
    expect(events.length).toBe(baseline + 1);

    await request(app).delete(`/api/dispatch/presence?date=${DATE}`);
    expect(events.length).toBe(baseline + 1); // nothing existed — no fan-out
  });
});
