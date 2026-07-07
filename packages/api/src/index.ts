import { createApp } from './app';

// Capture startup errors so they appear in Railway deploy logs (stdout)
process.on('uncaughtException', (err: Error) => {
  process.stdout.write(`FATAL uncaughtException: ${err.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(
    `WARN unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`
  );
  // Do NOT call process.exit() here — an unhandled rejection from a background
  // task (e.g. DB seeding, queue polling) should not kill the entire process
  // and block Railway healthchecks. Errors are logged for observability.
});

const PORT = parseInt(process.env.PORT || '3000', 10);
process.stdout.write(`[startup] PORT=${PORT} NODE_ENV=${process.env.NODE_ENV}\n`);

let app: ReturnType<typeof createApp>;
try {
  process.stdout.write('[startup] calling createApp()\n');
  app = createApp();
  process.stdout.write('[startup] createApp() returned successfully\n');
} catch (err) {
  process.stdout.write(
    `FATAL createApp() threw: ${err instanceof Error ? (err as Error).stack : String(err)}\n`
  );
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`Rivet API running on http://localhost:${PORT}`);
  console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
  console.log(`Health check at http://localhost:${PORT}/health`);
});

// Behind Railway's edge proxy, Node's default keepAliveTimeout (5s) is
// shorter than the proxy's keep-alive, causing the classic race where the
// proxy reuses a socket Node just closed → intermittent 502s. Keep
// keepAliveTimeout above the proxy idle window and headersTimeout above
// keepAliveTimeout (Node requires the gap to avoid ERR_HTTP_REQUEST_TIMEOUT
// on reused sockets). requestTimeout bounds how long a client may take to
// deliver a request (headers+body) — it does NOT cap long-lived responses,
// so SSE streams are unaffected.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 60_000;

server.on('error', (err: NodeJS.ErrnoException) => {
  process.stdout.write(`FATAL server listen error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});

// Blocker 5 / P4 U-P4a — graceful shutdown. On a stop signal, stop accepting
// new HTTP connections so in-flight requests can finish; createApp's own SIGTERM
// handler concurrently DRAINS live voice/WS calls (rejects new upgrades via the
// drain flag, waits up to DRAIN_TIMEOUT_MS for active sessions) before tearing
// down sessions/Redis/pool. The hard-timeout fallback (unref'd so it never keeps
// the process alive) force-exits if draining stalls — set longer than
// DRAIN_TIMEOUT_MS (default 25s) and shorter than Railway's stop grace period
// (set RAILWAY stop grace ≥ 35s; see docs/runbooks/scaling.md).
const FORCE_EXIT_MS = Number(process.env.SHUTDOWN_FORCE_EXIT_MS) || 30_000;
const gracefulExit = (signal: NodeJS.Signals) => {
  process.stdout.write(`[shutdown] ${signal} received — closing HTTP server\n`);
  server.close(() => {
    process.stdout.write('[shutdown] HTTP server closed\n');
  });
  setTimeout(() => process.exit(0), FORCE_EXIT_MS).unref();
};
process.once('SIGTERM', gracefulExit);
process.once('SIGINT', gracefulExit);
// Railway: targets api stage via dockerfileTarget in railway.toml
// cache-bust: force fresh tsc compile
