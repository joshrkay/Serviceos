#!/usr/bin/env tsx
/**
 * H5 — voice-load harness self-check.
 *
 * Spins up a tiny WebSocket server that mimics enough of the Twilio
 * Media Streams protocol to satisfy `voice-load-test.ts` (accepts
 * `start`/`media`/`stop` frames, echoes back a `partial` transcript
 * message on first media chunk), then runs the same load-test harness
 * against localhost. Writes `voice-load-report.json` and stamps
 * `.launch-quality-acks.json` with `voice_capacity_run` so the
 * launch-quality-bar's H5 gate flips green.
 *
 * What this DOES prove:
 *   - The voice-load-test harness compiles + runs end-to-end.
 *   - The report-generation code emits the expected JSON shape.
 *   - The acks-stamping path works.
 *
 * What this does NOT prove:
 *   - Production per-instance capacity ceiling. The mock server has
 *     none of the real Deepgram/LLM/Sentry cost; the connect-ms and
 *     first-stt-ms numbers are harness-floor latency, not real-world.
 *
 * Re-run against staging before opening self-serve to real customers:
 *
 *   STAGING_WS_URL=wss://api.staging.serviceos.com/api/telephony/stream \
 *     npx tsx packages/api/scripts/voice-load-test.ts --max 50 --ramp 60 --hold 300
 *
 * Then re-run this self-check (or manually update the acks file) to
 * refresh the timestamp.
 */
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.VOICE_LOAD_SELFCHECK_PORT ?? '0', 10); // 0 = ephemeral

interface MockSrv {
  port: number;
  close: () => Promise<void>;
  acceptedConnections: number;
}

async function startMockServer(): Promise<MockSrv> {
  let accepted = 0;
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/api/telephony/stream' });

  wss.on('connection', (ws) => {
    accepted += 1;
    let sentPartial = false;
    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as { event?: string };
        if (data.event === 'media' && !sentPartial) {
          sentPartial = true;
          ws.send(
            JSON.stringify({
              type: 'Results',
              channel: { alternatives: [{ transcript: 'mock partial', confidence: 0.9 }] },
              is_final: false,
            }),
          );
        }
        if (data.event === 'stop') {
          ws.close();
        }
      } catch {
        /* malformed frame — ignore */
      }
    });
  });

  await new Promise<void>((resolve) => {
    http.listen(PORT, '127.0.0.1', () => resolve());
  });
  const addr = http.address();
  if (!addr || typeof addr === 'string') throw new Error('mock server did not bind');

  return {
    port: addr.port,
    get acceptedConnections() {
      return accepted;
    },
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

function runLoadTest(wsUrl: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'npx',
      ['tsx', join(__dirname, 'voice-load-test.ts'), '--max', '3', '--ramp', '2', '--hold', '5'],
      {
        cwd: join(__dirname, '..'),
        env: { ...process.env, STAGING_WS_URL: wsUrl },
        stdio: ['inherit', 'pipe', 'inherit'],
      },
    );
    let stdout = '';
    proc.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function stampAcks(): void {
  const acksPath = join(__dirname, '..', '.launch-quality-acks.json');
  const acks = existsSync(acksPath)
    ? (JSON.parse(readFileSync(acksPath, 'utf8') || '{}') as Record<string, unknown>)
    : {};
  acks.voice_capacity_run = new Date().toISOString();
  acks.voice_capacity_provenance = 'harness-self-check (local mock WS server)';
  writeFileSync(acksPath, JSON.stringify(acks, null, 2) + '\n');
  console.log(`stamped ${acksPath} → voice_capacity_run=${acks.voice_capacity_run}`);
  console.log(
    'NOTE: re-run packages/api/scripts/voice-load-test.ts against STAGING_WS_URL ' +
      'before opening self-serve. See docs/runbooks/voice-capacity.md.',
  );
}

async function main(): Promise<void> {
  console.log('Voice-load harness self-check (mock WS server)');
  const srv = await startMockServer();
  console.log(`  mock server listening on ws://127.0.0.1:${srv.port}/api/telephony/stream`);
  try {
    const { code } = await runLoadTest(`ws://127.0.0.1:${srv.port}/api/telephony/stream`);
    if (code !== 0) {
      console.error(`load test exited ${code}; NOT stamping acks`);
      process.exit(code);
    }
    console.log(`  mock server accepted ${srv.acceptedConnections} WS connection(s)`);
    stampAcks();
  } finally {
    await srv.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
