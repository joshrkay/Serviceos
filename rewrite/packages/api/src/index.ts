import { createRuntime } from './bootstrap';

async function main(): Promise<void> {
  const runtime = await createRuntime();
  await runtime.app.listen({ port: runtime.config.port, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[api] ${signal} received, draining`);
    try {
      await runtime.shutdown();
      process.exit(0);
    } catch (err) {
      console.error('[api] shutdown failed', { message: (err as Error).message });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[api] fatal', { message: (err as Error).message });
  process.exit(1);
});
