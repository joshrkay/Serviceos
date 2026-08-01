import { createApp } from './app';

// ARCH-02: bounded, idempotent drain-before-exit shared by graceful signals
// (SIGTERM/SIGINT) and fatal in-process errors (uncaughtException/
// unhandledRejection). Declared and wired up FIRST — before createApp()/
// app.listen() — so a fatal error thrown anywhere during startup is still
// caught with our structured stdout logging (Railway greps deploy logs for
// "FATAL"), matching the original handler's "capture startup errors" intent.
//
// `server`/`app` start undefined and are only ever read here after the
// `!serverListening` guard below, by which point app.listen's callback has
// already assigned them — so this is safe despite the forward reference.
const FORCE_EXIT_MS = Number(process.env.SHUTDOWN_FORCE_EXIT_MS) || 30_000;
let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
let app: ReturnType<typeof createApp> | undefined;
let serverListening = false;
let shuttingDown = false;

// Blocker 5 / P4 U-P4a — graceful shutdown. On a stop signal (or, per
// ARCH-02, a fatal in-process error), stop accepting new HTTP connections so
// in-flight requests can finish, then run createApp's own drain sequence
// (`app.gracefulDrain`): rejects new WS upgrades via the drain flag, waits
// up to DRAIN_TIMEOUT_MS for active voice/WS sessions, then tears down
// background loops/Redis/pool. The hard-timeout fallback (unref'd so it
// never keeps the process alive by itself) force-exits if draining stalls —
// set longer than DRAIN_TIMEOUT_MS (default 25s) and shorter than Railway's
// stop grace period (set RAILWAY stop grace ≥ 35s; see
// docs/runbooks/scaling.md).
//
// `serverListening` guards the startup phase: if a fatal error fires before
// app.listen's callback has run, there is no live server/voice traffic to
// drain, so we exit immediately instead of waiting on state that was never
// brought up. `shuttingDown` makes the whole path idempotent — a SIGTERM
// racing a fatal uncaughtException (or a second uncaughtException firing
// while the first is still draining) must not double-run the drain or
// re-arm a second force-exit timer; it just falls through, and the drain
// already in flight (app.gracefulDrain is itself idempotent — see app.ts)
// still exits the process via its own force-exit timer.
function gracefulShutdown(reason: string, exitCode: number): void {
  if (shuttingDown) {
    process.stdout.write(`[shutdown] ${reason} received during an in-progress shutdown — ignoring\n`);
    return;
  }
  shuttingDown = true;

  const srv = server;
  const currentApp = app;
  if (!serverListening || !srv || !currentApp) {
    process.stdout.write(`[shutdown] ${reason} received before server was listening — exiting immediately\n`);
    process.exit(exitCode);
    return;
  }

  process.stdout.write(`[shutdown] ${reason} received — closing HTTP server and draining\n`);
  srv.close(() => {
    process.stdout.write('[shutdown] HTTP server closed\n');
  });

  // Hard backstop — fires regardless of whether the drain below (or the
  // server close above) ever completes, bounding the whole sequence.
  setTimeout(() => process.exit(exitCode), FORCE_EXIT_MS).unref();

  // Same drain app.ts runs for SIGTERM/SIGINT (voice/WS drain, then
  // Redis/pool teardown). app.gracefulDrain is itself idempotent, so if a
  // SIGTERM already triggered it this just awaits the same in-flight
  // promise instead of re-entering teardown.
  Promise.resolve(currentApp.gracefulDrain(reason))
    .catch((err) => {
      process.stdout.write(
        `[shutdown] drain error: ${err instanceof Error ? err.stack : String(err)}\n`
      );
    })
    .finally(() => {
      process.exit(exitCode);
    });
}

// ARCH-02: uncaughtException used to bypass the drain entirely with a raw
// process.exit(1), dropping all in-flight HTTP + live voice/WS sessions with
// no warning — a single sync throw escaping any worker/timer/WS callback
// could take down the whole process with zero drain. Node's own guidance is
// that process state is undefined after an uncaught exception and the
// process must exit — but "must exit" doesn't mean "must exit before
// draining what we safely can", so this now routes through the same
// bounded, idempotent sequence as SIGTERM instead of exiting immediately.
process.on('uncaughtException', (err: Error) => {
  process.stdout.write(`FATAL uncaughtException: ${err.stack}\n`);
  gracefulShutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(
    `WARN unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`
  );
  // Do NOT call process.exit() here — an unhandled rejection from a background
  // task (e.g. DB seeding, queue polling) should not kill the entire process
  // and block Railway healthchecks. Errors are logged for observability.
});

process.once('SIGTERM', (signal) => gracefulShutdown(signal, 0));
process.once('SIGINT', (signal) => gracefulShutdown(signal, 0));

const PORT = parseInt(process.env.PORT || '3000', 10);
process.stdout.write(`[startup] PORT=${PORT} NODE_ENV=${process.env.NODE_ENV}\n`);

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

server = app.listen(PORT, () => {
  console.log(`Rivet API running on http://localhost:${PORT}`);
  console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
  console.log(`Health check at http://localhost:${PORT}/health`);
  serverListening = true;
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
// Railway: targets api stage via dockerfileTarget in railway.toml
// cache-bust: force fresh tsc compile
