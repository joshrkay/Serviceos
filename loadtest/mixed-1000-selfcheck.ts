/**
 * Mixed load-harness self-check (U6 — scale-to-1000 plan).
 *
 * Mirrors http-load-selfcheck.ts: spins up an in-process stub server
 * implementing the endpoint *shapes* the mixed harness drives —
 *
 *   - GET  /api/proposals                → 200 JSON list
 *   - PUT  /api/dispatch/presence        → 204
 *   - GET  /api/dispatch/board/events    → SSE (requires ?date=, like the real route)
 *   - GET  /api/escalations/events       → SSE
 *   - GET  /api/ws (upgrade)             → RFC6455 handshake + gateway-style
 *                                          `hello` frame, then heartbeats
 *
 * — then runs the harness at tiny scale (5 users, ~10 s wall clock) and
 * asserts the report renders with sane numbers. Proves the TOOLING (raw WS
 * client, SSE parser, scheduler, report pipeline) without booting the API —
 * runs in CI with no docker or network.
 *
 * Exit 0 on a healthy run, non-zero on any harness defect.
 *
 * Run: tsx loadtest/mixed-1000-selfcheck.ts
 */

import http from 'node:http';
import {
  runMixedLoad,
  printMixedSummary,
  encodeWsFrame,
  decodeWsFrames,
  wsAcceptKey,
  WS_OPCODE,
  inFraction,
  type MixedReport,
} from './mixed-1000';

function sendServerJson(socket: import('node:stream').Duplex, obj: unknown): void {
  if (!socket.destroyed) {
    socket.write(encodeWsFrame(WS_OPCODE.TEXT, Buffer.from(JSON.stringify(obj)), false));
  }
}

function startStubServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const delay = 2 + (url.pathname.length % 7); // 2–8 ms, varied percentiles

    if (req.method === 'GET' && url.pathname === '/api/proposals') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [], total: 0 }));
      }, delay);
      return;
    }

    if (req.method === 'PUT' && url.pathname === '/api/dispatch/presence') {
      req.resume();
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(204);
          res.end();
        }, delay);
      });
      return;
    }

    if (
      req.method === 'GET' &&
      (url.pathname === '/api/dispatch/board/events' || url.pathname === '/api/escalations/events')
    ) {
      // Mirror the real board route's contract: date is mandatory.
      if (url.pathname === '/api/dispatch/board/events' && !url.searchParams.get('date')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'date query parameter is required (YYYY-MM-DD)' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': hb\n\n');
      const t = setInterval(() => {
        res.write(`data: ${JSON.stringify({ type: 'stub_event', at: Date.now() })}\n\n`);
      }, 400);
      req.on('close', () => {
        clearInterval(t);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  // Client-gateway shape: upgrade on /api/ws, token required (?token=…),
  // hello frame on accept — see packages/api/src/ws/client-gateway.ts.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    if (!url.searchParams.get('token')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
        '',
        '',
      ].join('\r\n'),
    );
    sendServerJson(socket, { kind: 'hello', serverTimeMs: Date.now(), heartbeatIntervalMs: 500 });
    const hb = setInterval(
      () => sendServerJson(socket, { kind: 'heartbeat', serverTimeMs: Date.now() }),
      500,
    );

    let buf: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = decodeWsFrames(Buffer.concat([buf, chunk]), (opcode, payload) => {
        if (opcode === WS_OPCODE.CLOSE) {
          socket.destroy();
          return;
        }
        if (opcode === WS_OPCODE.PING && !socket.destroyed) {
          socket.write(encodeWsFrame(WS_OPCODE.PONG, payload, false));
          return;
        }
        // Gateway behavior: a client {kind:'ping'} text frame gets a heartbeat.
        if (opcode === WS_OPCODE.TEXT) {
          sendServerJson(socket, { kind: 'heartbeat', serverTimeMs: Date.now() });
        }
      });
    };
    socket.on('data', onData);
    if (head && head.length > 0) onData(head);
    const cleanup = (): void => clearInterval(hb);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('failed to bind stub server');
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function main(): Promise<void> {
  const { server, url } = await startStubServer();

  const users = 5;
  const dispatchFraction = 0.4; // 2 of 5 — guarantees both SSE classes exercise
  const escalationsFraction = 0.4;

  let report: MixedReport;
  try {
    report = await runMixedLoad({
      url,
      token: 'selfcheck-token',
      max: users,
      rampSeconds: 1,
      holdSeconds: 6,
      rampdownSeconds: 1,
      dispatchFraction,
      escalationsFraction,
      presenceIntervalS: 1, // fast so the tiny hold collects samples
      proposalIntervalS: 2,
      wsPingIntervalS: 1,
      date: '2026-01-01',
      timeoutMs: 2000,
      assert: false,
      voice: 0,
    });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }

  const expectedClass = (frac: number): number =>
    Array.from({ length: users }, (_, i) => i).filter((i) => inFraction(i, frac)).length;
  const wantDispatch = expectedClass(dispatchFraction);
  const wantEscalations = expectedClass(escalationsFraction);
  const proposals = report.http.perEndpoint['GET /api/proposals'];
  const presence = report.http.perEndpoint['PUT /api/dispatch/presence'];

  const checks: Array<[string, boolean]> = [
    ['spawned all users', report.users.total === users],
    ['ws attempted per user', report.connections.ws.attempts === users],
    ['ws all connected (hello received)', report.connections.ws.connected === users],
    ['ws zero failures', report.connections.ws.failures === 0],
    ['ws zero unexpected closes', report.connections.ws.unexpectedCloses === 0],
    ['ws received server frames', report.connections.ws.messages > users],
    [
      'dispatch sse connected',
      report.connections.dispatchSse.attempts === wantDispatch &&
        report.connections.dispatchSse.connected === wantDispatch,
    ],
    ['dispatch sse received events', report.connections.dispatchSse.messages > 0],
    [
      'escalations sse connected',
      report.connections.escalationsSse.attempts === wantEscalations &&
        report.connections.escalationsSse.connected === wantEscalations,
    ],
    ['escalations sse received events', report.connections.escalationsSse.messages > 0],
    ['proposals polled', (proposals?.count ?? 0) >= users],
    ['proposals p99 >= p50', (proposals?.p99 ?? 0) >= (proposals?.p50 ?? 0)],
    ['presence PUTs sent', (presence?.count ?? 0) >= wantDispatch],
    ['zero http errors against stub', report.http.errors === 0],
    ['steady-state rps computed', report.http.steadyStateRps > 0],
    ['thresholds evaluated + passed', report.thresholds.passed === true],
  ];

  printMixedSummary(report);
  const failed = checks.filter(([, ok]) => !ok);
  process.stdout.write(
    `mixed load self-check against ${url}\n` +
      checks.map(([name, ok]) => `  ${ok ? '✓' : '✗'} ${name}`).join('\n') +
      `\n\n  ${report.http.totalRequests} requests, ${report.http.steadyStateRps} rps steady-state, ` +
      `${report.connections.ws.connected} ws, ` +
      `${report.connections.dispatchSse.connected + report.connections.escalationsSse.connected} sse, ` +
      `errors ${report.http.errors}\n`,
  );

  if (failed.length > 0) {
    process.stderr.write(`\nself-check FAILED: ${failed.map(([n]) => n).join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write('\nself-check PASSED — mixed harness + report pipeline operational.\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`self-check crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
