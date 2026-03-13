import { WorkerRegistry } from '../../src/workers/worker-registry';
import { WorkerHandler, QueueMessage } from '../../src/queues/queue';
import { createLogger } from '../../src/logging/logger';

describe('WorkerRegistry', () => {
  const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

  function createMockHandler(type: string, fn?: () => Promise<void>): WorkerHandler {
    return {
      type,
      handle: fn ? async (_msg, _log) => fn() : async () => {},
    };
  }

  function createMessage(type: string): QueueMessage {
    return {
      id: 'msg-1',
      type,
      payload: { data: 'test' },
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: 'idem-1',
      createdAt: new Date().toISOString(),
    };
  }

  it('registers and retrieves a handler', () => {
    const registry = new WorkerRegistry();
    const handler = createMockHandler('test_job');
    registry.register(handler);

    expect(registry.getHandler('test_job')).toBe(handler);
    expect(registry.getRegisteredTypes()).toContain('test_job');
  });

  it('throws on duplicate registration', () => {
    const registry = new WorkerRegistry();
    registry.register(createMockHandler('test_job'));
    expect(() => registry.register(createMockHandler('test_job'))).toThrow(
      'Handler already registered for type: test_job'
    );
  });

  it('dispatches message to correct handler', async () => {
    const registry = new WorkerRegistry();
    let handled = false;
    registry.register(createMockHandler('test_job', async () => { handled = true; }));

    const result = await registry.dispatch(createMessage('test_job'), logger);
    expect(result).toBe(true);
    expect(handled).toBe(true);
  });

  it('returns false for unknown message type', async () => {
    const registry = new WorkerRegistry();
    const result = await registry.dispatch(createMessage('unknown_type'), logger);
    expect(result).toBe(false);
  });

  it('returns undefined for unregistered handler type', () => {
    const registry = new WorkerRegistry();
    expect(registry.getHandler('nonexistent')).toBeUndefined();
  });
});
