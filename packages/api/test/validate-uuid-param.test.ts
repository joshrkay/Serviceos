/**
 * Unit tests for the shared malformed-:id guard (#882).
 *
 * `notFoundOnMalformedId(message, param)` 404s a request whose uuid route
 * param could never name a resource, before it reaches a Pg uuid comparison
 * (`invalid input syntax for type uuid` surfaced as a bare 500). Route-level
 * behavior is pinned per resource in test/routes/*.route.test.ts; this file
 * pins the factory's own contract.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { notFoundOnMalformedId } from '../src/middleware/validate-uuid-param';

function buildApp(message: string, param?: string) {
  const app = express();
  const route = param ? `/things/:${param}` : '/things/:id';
  app.get(route, notFoundOnMalformedId(message, param), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('notFoundOnMalformedId', () => {
  it('calls next() for a well-formed uuid', async () => {
    const app = buildApp('Thing not found');
    const res = await request(app).get('/things/11111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('accepts an uppercase uuid (Postgres does too)', async () => {
    const app = buildApp('Thing not found');
    const res = await request(app).get('/things/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE');
    expect(res.status).toBe(200);
  });

  it("404s a malformed id with the route's own not-found envelope", async () => {
    const app = buildApp('Thing not found');
    const res = await request(app).get('/things/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Thing not found' });
  });

  it('guards a custom param name', async () => {
    const app = buildApp('Customer not found', 'customerId');
    const bad = await request(app).get('/things/new');
    expect(bad.status).toBe(404);
    expect(bad.body).toEqual({ error: 'NOT_FOUND', message: 'Customer not found' });

    const ok = await request(app).get('/things/22222222-2222-2222-2222-222222222222');
    expect(ok.status).toBe(200);
  });

  it('404s a uuid with surrounding whitespace (would still fail the Pg cast)', async () => {
    const app = buildApp('Thing not found');
    const res = await request(app).get('/things/%2011111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(404);
  });
});
