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
  console.log(`ServiceOS API running on http://localhost:${PORT}`);
  console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
  console.log(`Health check at http://localhost:${PORT}/health`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  process.stdout.write(`FATAL server listen error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});

// Blocker 5 — graceful shutdown. On a stop signal, stop accepting new
// connections so in-flight requests can finish; createApp's own SIGTERM
// handler concurrently stops the background loops and drains the pg pool.
// A hard-timeout fallback (unref'd so it never keeps the process alive)
// force-exits if draining stalls, well within Railway's stop grace period.
const gracefulExit = (signal: NodeJS.Signals) => {
  process.stdout.write(`[shutdown] ${signal} received — closing HTTP server\n`);
  server.close(() => {
    process.stdout.write('[shutdown] HTTP server closed\n');
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.once('SIGTERM', gracefulExit);
process.once('SIGINT', gracefulExit);
// Railway: targets api stage via dockerfileTarget in railway.toml
// cache-bust: force fresh tsc compile
