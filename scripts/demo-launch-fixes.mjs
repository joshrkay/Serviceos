#!/usr/bin/env node
/**
 * Live demo: money formatting fix + /ready 503 on DB down.
 * Run: node scripts/demo-launch-fixes.mjs
 */
import express from 'express';
import http from 'http';

// --- Money formatting (mirrors packages/web/src/utils/currency.ts) ---
const fmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
function formatCurrencyAmount(cents) {
  return fmt.format(cents / 100);
}
function formatDollars(dollars) {
  return formatCurrencyAmount(Math.round(dollars * 100));
}

console.log('\n=== MONEY FORMATTING (InvoicesPage fix) ===\n');
const amountDollars = 1234.5;
const roundDollars = 1200;
console.log('BEFORE (bare .toLocaleString()):');
console.log(`  $${amountDollars.toLocaleString()}   ← drops cents on $1,234.50`);
console.log(`  $${roundDollars.toLocaleString()}     ← drops .00 on $1,200.00`);
console.log('\nAFTER (formatDollars → formatCurrencyAmount):');
console.log(`  $${formatDollars(amountDollars)}   ← correct`);
console.log(`  $${formatDollars(roundDollars)}     ← keeps trailing zeros`);

// --- Health /ready (mirrors app.ts DB check returning `down`) ---
console.log('\n=== /ready ON DB OUTAGE (app.ts fix) ===\n');

const app = express();
app.use(
  express.Router()
    .get('/health', async (_req, res) => {
      res.status(200).json({
        status: 'down',
        checks: { database: { status: 'down', message: 'Database connection failed' } },
      });
    })
    .get('/ready', async (_req, res) => {
      const dbDown = true; // app.ts now returns `down` on SELECT 1 failure
      res.status(dbDown ? 503 : 200).json({ status: dbDown ? 'not_ready' : 'ready' });
    }),
);

const server = app.listen(0, async () => {
  const port = server.address().port;
  const get = (path) =>
    new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}${path}`, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });

  const health = await get('/health');
  const ready = await get('/ready');

  console.log('Simulated DB outage (health check status: down):');
  console.log(`  GET /health → HTTP ${health.status}  ${JSON.stringify(health.body)}`);
  console.log(`  GET /ready  → HTTP ${ready.status}  ${JSON.stringify(ready.body)}`);
  console.log('\nRailway liveness uses /health (stays 200 in real app); readiness uses /ready (503 stops traffic).\n');

  server.close();
});
