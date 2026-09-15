import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

test('requested real database failure aborts global setup instead of silently skipping', async () => {
  const listener = createServer(socket => socket.destroy());
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '-e',
    "import setup from './e2e/global-setup'; setup().then(()=>console.log('SETUP_RETURNED_SUCCESS')).catch(()=>process.exit(1))"], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, E2E_USE_TEST_DB: 'true', DATABASE_URL: `postgresql://test:test@127.0.0.1:${port}/serviceos_test`,
      E2E_CLERK_SECRET_KEY: '', E2E_CLERK_PUBLISHABLE_KEY: '', CLERK_SECRET_KEY: '', CLERK_PUBLISHABLE_KEY: '' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /SETUP_RETURNED_SUCCESS/);
});
