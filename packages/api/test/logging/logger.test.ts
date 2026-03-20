import { createLogger } from '../../src/logging/logger';
import { initSentry } from '../../src/monitoring/sentry';

describe('P0-008 — Observability, structured logging, and Sentry', () => {
  it('happy path — creates logger and produces JSON output', () => {
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      output.push(chunk);
      return true;
    }) as any;

    const logger = createLogger({
      service: 'api',
      environment: 'dev',
      level: 'debug',
    });

    logger.info('test message', { key: 'value' });

    process.stdout.write = originalWrite;

    expect(output.length).toBe(1);
    const entry = JSON.parse(output[0]);
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('test message');
    expect(entry.service).toBe('api');
    expect(entry.key).toBe('value');
    expect(entry.timestamp).toBeTruthy();
  });

  it('happy path — child logger inherits bindings', () => {
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      output.push(chunk);
      return true;
    }) as any;

    const logger = createLogger({
      service: 'api',
      environment: 'dev',
      level: 'info',
    });

    const child = logger.child({ correlationId: 'abc', tenantId: 't1' });
    child.info('child message');

    process.stdout.write = originalWrite;

    const entry = JSON.parse(output[0]);
    expect(entry.correlationId).toBe('abc');
    expect(entry.tenantId).toBe('t1');
  });

  it('validation — respects log level filtering', () => {
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      output.push(chunk);
      return true;
    }) as any;

    const logger = createLogger({
      service: 'api',
      environment: 'dev',
      level: 'warn',
    });

    logger.debug('should not appear');
    logger.info('should not appear');
    logger.warn('should appear');

    process.stdout.write = originalWrite;

    expect(output.length).toBe(1);
  });

  it('happy path — error logs go to stderr', () => {
    const output: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      output.push(chunk);
      return true;
    }) as any;

    const logger = createLogger({
      service: 'api',
      environment: 'dev',
      level: 'error',
    });

    logger.error('error message');

    process.stderr.write = originalWrite;

    expect(output.length).toBe(1);
    const entry = JSON.parse(output[0]);
    expect(entry.level).toBe('error');
  });

  it('happy path — Sentry no-op client when DSN missing', () => {
    const client = initSentry({ environment: 'dev' });
    const eventId = client.captureException(new Error('test'));
    expect(eventId).toBe('no-op');
  });

  it('happy path — Sentry logging client with DSN', () => {
    const client = initSentry({ dsn: 'https://test@sentry.io/123', environment: 'dev' });
    const eventId = client.captureException(new Error('test error'));

    expect(eventId).not.toBe('no-op');
    expect(typeof eventId).toBe('string');
    expect(eventId.length).toBeGreaterThan(0);
  });
});
