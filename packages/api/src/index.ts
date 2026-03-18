import { createApp } from './app';

// Capture startup errors so they appear in Railway deploy logs (stdout)
process.on('uncaughtException', (err: Error) => {
  process.stdout.write(`FATAL uncaughtException: ${err.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  process.stdout.write(
    `FATAL unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`
  );
  process.exit(1);
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
// Railway: targets api stage via dockerfileTarget in railway.toml
// cache-bust: force fresh tsc compile
