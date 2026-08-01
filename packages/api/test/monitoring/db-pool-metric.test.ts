import { describe, it, expect } from 'vitest';
import { dbPoolConnections, metricsRegistry } from '../../src/monitoring/metrics';

/**
 * U2c — the DB pool-saturation gauge is the signal that proves (or disproves)
 * the connection-pool ceiling is gone. Pin its name + labels so a rename can't
 * silently break the dashboard/alert that watches it.
 */
describe('db_pool_connections metric', () => {
  it('exposes pool occupancy partitioned by pool + state', async () => {
    dbPoolConnections.set({ pool: 'main', state: 'total' }, 12);
    dbPoolConnections.set({ pool: 'main', state: 'idle' }, 5);
    dbPoolConnections.set({ pool: 'main', state: 'waiting' }, 3);
    dbPoolConnections.set({ pool: 'direct', state: 'total' }, 2);

    const out = await metricsRegistry.metrics();
    expect(out).toContain('db_pool_connections');
    expect(out).toMatch(/db_pool_connections\{pool="main",state="total"\} 12/);
    expect(out).toMatch(/db_pool_connections\{pool="main",state="waiting"\} 3/);
    expect(out).toMatch(/db_pool_connections\{pool="direct",state="total"\} 2/);
  });
});
