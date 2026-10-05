import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { routeParam } from '../../src/shared/route-params';

// #1555 — Express 5 types every req.params value as `string | string[]`
// (a `*splat` param is an array of path segments). routeParam() is the one
// typed read every handler uses instead of casting.
describe('routeParam (#1555)', () => {
  it('returns a named :param exactly as Express decoded it', async () => {
    const app = express();
    app.get('/jobs/:id', (req, res) => {
      res.json({ id: routeParam(req, 'id') });
    });
    const res = await request(app).get('/jobs/abc-123');
    expect(res.body).toEqual({ id: 'abc-123' });
  });

  it('rejoins a *splat param into the slash-separated path it matched', async () => {
    const app = express();
    app.get('/files/*key', (req, res) => {
      res.json({ key: routeParam(req, 'key') });
    });
    const res = await request(app).get('/files/tenant/uploads/photo.jpg');
    expect(res.body).toEqual({ key: 'tenant/uploads/photo.jpg' });
  });

  it('returns an empty string for a param the route does not define', async () => {
    const app = express();
    app.get('/jobs/:id', (req, res) => {
      res.json({ missing: routeParam(req, 'nope') });
    });
    const res = await request(app).get('/jobs/abc');
    expect(res.body).toEqual({ missing: '' });
  });
});
