import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/smoke-test.ts', import.meta.url));

async function runSmoke(health: string, telephony = '{"ok":true}') {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(req.url === '/health' ? health : req.url === '/ready' ? '{}' : telephony);
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    try {
      await execFileAsync(process.execPath, [
        '--import', 'tsx', script, `--base=http://127.0.0.1:${address.port}`,
      ], { timeout: 15_000 });
      return 0;
    } catch (error) {
      const failure = error as Error & { code?: number };
      if (typeof failure.code !== 'number') throw error;
      return failure.code;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
    });
  }
}

describe('deployment smoke response validation', () => {
  it('accepts healthy JSON regardless of whitespace', async () => {
    expect(await runSmoke('{ "status": "ok" }', '{ "ok": true }')).toBe(0);
  });
  it('rejects degraded health even when a nested check is healthy', async () => {
    expect(await runSmoke('{"status":"degraded","checks":{"drain":{"status":"ok"}}}')).toBe(1);
  });
  it('rejects degraded telephony even when a nested check is healthy', async () => {
    expect(await runSmoke('{"status":"ok"}', '{"ok":false,"checks":{"provider":{"ok":true}}}')).toBe(1);
  });
  it('rejects malformed health JSON', async () => {
    expect(await runSmoke('not JSON: "status":"ok"')).toBe(1);
  });
  it('rejects a missing top-level status', async () => {
    expect(await runSmoke('{"checks":{"status":"ok"}}')).toBe(1);
  });
});
