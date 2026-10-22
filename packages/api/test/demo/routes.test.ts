/**
 * S6-3 — `POST /public/demo/calls` on the real router and the real service:
 * the refusals that answer before any write (status code and copy), with a
 * pool that fails the test if touched. The started, busy, limited and failed
 * answers run against real Postgres in test/integration/demo-calls.test.ts.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { createDemoCallsRouter } from '../../src/demo/routes';
import type { DemoCallServiceDeps } from '../../src/demo/service';
import { loadDemoConfig } from '../../src/demo/config';

function untouchablePool(): Pool & { touched: number } {
  const p = {
    touched: 0,
    connect() {
      p.touched += 1;
      throw new Error('the database was touched');
    },
    query() {
      p.touched += 1;
      throw new Error('the database was touched');
    },
  };
  return p as unknown as Pool & { touched: number };
}

function app(overrides: Partial<DemoCallServiceDeps> = {}) {
  const pool = untouchablePool();
  const deps: DemoCallServiceDeps = {
    pool,
    config: loadDemoConfig({}),
    isEnabled: () => true,
    getCreds: () => ({ accountSid: 'ACplatform', authToken: 'tok', fromE164: '+15125550100' }),
    leaseTokenSecret: 'secret',
    publicApiUrl: 'https://api.example.test',
    alert: async () => undefined,
    resetter: {
      resetAndRelease: async () => {
        throw new Error('no lease may be ended');
      },
    },
    fetchImpl: async () => {
      throw new Error('no request may be made');
    },
    ...overrides,
  };
  const a = express();
  a.use(express.json());
  a.use('/public/demo', createDemoCallsRouter(deps));
  return { a, pool };
}

const body = { phone: '(512) 555-0142', trade: 'plumbing', businessName: 'Austin Pipe Pros' };
const DISABLED = { error: 'DEMO_DISABLED', message: "The demo call isn't available right now." };

describe('POST /public/demo/calls — answered before any write', () => {
  it('kill switch off → 503 DEMO_DISABLED, even for a bad body', async () => {
    const { a, pool } = app({ isEnabled: () => false });
    const res = await request(a).post('/public/demo/calls').send({ nonsense: true });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(DISABLED);
    expect(pool.touched).toBe(0);
  });

  it('no platform credentials → 503 DEMO_DISABLED with nothing written', async () => {
    const { a, pool } = app({ getCreds: () => null });
    const res = await request(a).post('/public/demo/calls').send(body);
    expect(res.status).toBe(503);
    expect(res.body).toEqual(DISABLED);
    expect(pool.touched).toBe(0);
  });

  it('a closed module (a bad DEMO_* value) → 503 DEMO_DISABLED', async () => {
    const { a, pool } = app({ config: loadDemoConfig({ DEMO_COST_DAILY_CAP_CENTS: '-1' }) });
    const res = await request(a).post('/public/demo/calls').send(body);
    expect(res.status).toBe(503);
    expect(res.body).toEqual(DISABLED);
    expect(pool.touched).toBe(0);
  });

  it.each([
    ['an unlisted trade', { ...body, trade: 'roofing' }],
    ['a missing business name', { phone: body.phone, trade: 'plumbing' }],
    ['an unknown field', { ...body, tenantId: 'x' }],
    ['no body', undefined],
  ])('%s → 400 INVALID_INPUT', async (_l, b) => {
    const { a, pool } = app();
    const res = await request(a).post('/public/demo/calls').send(b as object);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'INVALID_INPUT', message: 'Check the number and business name, then try again.' });
    expect(pool.touched).toBe(0);
  });

  it.each(['+19005550142', '+447700900123'])('%s → 400 DEMO_NUMBER_NOT_ALLOWED', async (phone) => {
    const { a, pool } = app();
    const res = await request(a).post('/public/demo/calls').send({ ...body, phone });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'DEMO_NUMBER_NOT_ALLOWED',
      message: 'We can only call a US or Canadian phone number.',
    });
    expect(pool.touched).toBe(0);
  });
});
