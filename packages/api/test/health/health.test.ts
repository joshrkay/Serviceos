import { createHealthRouter } from '../../src/health/health';
import express from 'express';
import http from 'http';

function createTestApp() {
  const app = express();
  const router = createHealthRouter('1.0.0', 'test', [
    { name: 'db', check: async () => ({ status: 'ok' }) },
  ]);
  app.use(router);
  return app;
}

async function request(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as any;
      http.get(`http://localhost:${addr.port}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        });
      }).on('error', (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

describe('P0-005 — Health endpoint', () => {
  it('happy path — returns ok status', async () => {
    const app = createTestApp();
    const res = await request(app, '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('1.0.0');
    expect(res.body.environment).toBe('test');
  });

  it('happy path — ready endpoint returns ready', async () => {
    const app = createTestApp();
    const res = await request(app, '/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });


  it('degraded dependencies — returns 200 with degraded status', async () => {
    const app = express();
    const router = createHealthRouter('1.0.0', 'test', [
      { name: 'db', check: async () => ({ status: 'degraded', message: 'Slow' }) },
    ]);
    app.use(router);

    const res = await request(app, '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });

  it('liveness — /health always returns 200 even when check is down', async () => {
    const app = express();
    const router = createHealthRouter('1.0.0', 'test', [
      { name: 'db', check: async () => ({ status: 'down', message: 'Connection refused' }) },
    ]);
    app.use(router);

    const res = await request(app, '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('down');
  });

  it('readiness — /ready returns 503 when a check is down', async () => {
    const app = express();
    const router = createHealthRouter('1.0.0', 'test', [
      { name: 'db', check: async () => ({ status: 'down', message: 'Connection refused' }) },
    ]);
    app.use(router);

    const res = await request(app, '/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });
});
