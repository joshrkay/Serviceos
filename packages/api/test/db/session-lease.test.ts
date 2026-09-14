/**
 * #1125 — session-lease bookkeeping (pure logic; the real-Postgres proof is
 * test/integration/advisory-lock-fencing-1125.test.ts).
 */
import { EventEmitter } from 'events';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  assertAmbientSessionLeaseHeld,
  runWithSessionLease,
  SessionLeaseLostError,
  watchSessionLease,
} from '../../src/db/session-lease';

function fakeClient(): EventEmitter & PoolClient {
  return new EventEmitter() as EventEmitter & PoolClient;
}

describe('watchSessionLease', () => {
  it('is held until the client emits error, then assertHeld throws SESSION_LEASE_LOST naming the cause', () => {
    const client = fakeClient();
    const { lease } = watchSessionLease(client, 'leader lock 42');
    expect(lease.lost).toBe(false);
    expect(() => lease.assertHeld()).not.toThrow();

    client.emit('error', new Error('terminating connection due to administrator command'));

    expect(lease.lost).toBe(true);
    let thrown: unknown;
    try {
      lease.assertHeld();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SessionLeaseLostError);
    expect((thrown as SessionLeaseLostError).code).toBe('SESSION_LEASE_LOST');
    expect((thrown as Error).message).toContain('leader lock 42');
    expect((thrown as Error).message).toContain('terminating connection due to administrator command');
  });

  it('is lost when the connection ends without an error event', () => {
    const client = fakeClient();
    const { lease } = watchSessionLease(client, 'k');
    client.emit('end');
    expect(lease.lost).toBe(true);
    expect(() => lease.assertHeld()).toThrow(SessionLeaseLostError);
  });

  it('stopWatching detaches its listeners: a later error or end (the owner releasing/destroying the client) does not mark the lease lost', () => {
    const client = fakeClient();
    // The production pool guard's own listener stays attached, so an
    // 'error' emit here does not throw.
    client.on('error', () => undefined);
    const { lease, stopWatching } = watchSessionLease(client, 'k');
    expect(client.listenerCount('error')).toBe(2);
    stopWatching();
    expect(client.listenerCount('error')).toBe(1);
    expect(client.listenerCount('end')).toBe(0);
    client.emit('error', new Error('late'));
    client.emit('end');
    expect(lease.lost).toBe(false);
  });
});

describe('ambient session lease', () => {
  it('is a no-op outside any lease scope', () => {
    expect(() => assertAmbientSessionLeaseHeld()).not.toThrow();
  });

  it('throws inside a scope whose lease was lost — including continuations that resume after the loss', async () => {
    const client = fakeClient();
    const { lease } = watchSessionLease(client, 'k');
    let resume!: () => void;
    const parked = new Promise<void>((r) => {
      resume = r;
    });

    const inScope = runWithSessionLease(lease, async () => {
      assertAmbientSessionLeaseHeld(); // held on entry
      await parked;
      assertAmbientSessionLeaseHeld(); // must now refuse
    });

    client.emit('error', new Error('killed'));
    resume();
    await expect(inScope).rejects.toBeInstanceOf(SessionLeaseLostError);
    // The loss does not leak out of the scope.
    expect(() => assertAmbientSessionLeaseHeld()).not.toThrow();
  });

  it('a nested scope also enforces every enclosing lease', async () => {
    const outerClient = fakeClient();
    const innerClient = fakeClient();
    const outer = watchSessionLease(outerClient, 'outer').lease;
    const inner = watchSessionLease(innerClient, 'inner').lease;

    await runWithSessionLease(outer, () =>
      runWithSessionLease(inner, async () => {
        expect(() => assertAmbientSessionLeaseHeld()).not.toThrow();
        outerClient.emit('end');
        expect(() => assertAmbientSessionLeaseHeld()).toThrow(/outer/);
      }),
    );
  });
});
