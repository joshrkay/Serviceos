import { describe, it, expect, vi } from 'vitest';
import {
  decideGeocodeOutcome,
  runGeocodeSweep,
  type GeocodeOutcome,
  type PendingLocation,
} from '../../src/workers/geocode-locations-sweep';
import type { Geocoder, GeocodeResult } from '../../src/locations/geocoder';
import type { Logger } from '../../src/logging/logger';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

function pending(id: string, attempts = 0): PendingLocation {
  return {
    id,
    tenantId: '00000000-0000-0000-0000-000000000001',
    attempts,
    address: { street1: `${id} Main St`, city: 'Phoenix', state: 'AZ', postalCode: '85004', country: 'US' },
  };
}

describe('decideGeocodeOutcome', () => {
  it('writes coordinates for found and fails not_found straight away', () => {
    expect(decideGeocodeOutcome({ kind: 'found', coords: { latitude: 1, longitude: 2 } })).toEqual({
      kind: 'found',
      latitude: 1,
      longitude: 2,
    });
    expect(decideGeocodeOutcome({ kind: 'not_found' })).toEqual({ kind: 'not_found' });
  });

  it('never makes a thrown lookup terminal: a provider outage says nothing about the address', () => {
    expect(decideGeocodeOutcome(null)).toEqual({ kind: 'retry' });
  });
});

function harness(rows: PendingLocation[], answer: (loc: PendingLocation) => GeocodeResult | Error, writeOk = true) {
  const writes: Array<[string, GeocodeOutcome]> = [];
  const geocoder: Geocoder = {
    geocode: async (a) => {
      const loc = rows.find((r) => r.address.street1 === a.street1)!;
      const out = answer(loc);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return {
    writes,
    deps: {
      listPending: async (limit: number) => rows.slice(0, limit),
      writeOutcome: async (loc: PendingLocation, o: GeocodeOutcome) => {
        writes.push([loc.id, o]);
        return writeOk;
      },
      geocoder,
      logger,
    },
  };
}

describe('runGeocodeSweep', () => {
  it('writes one outcome per pending row and counts them', async () => {
    const rows = [pending('a'), pending('b')];
    const h = harness(rows, (l) =>
      l.id === 'a' ? { kind: 'found', coords: { latitude: 1, longitude: 2 } } : { kind: 'not_found' },
    );
    const result = await runGeocodeSweep(h.deps);
    expect(h.writes.map(([id, o]) => [id, o.kind])).toEqual([
      ['a', 'found'],
      ['b', 'not_found'],
    ]);
    expect(result).toMatchObject({ candidates: 2, found: 1, notFound: 1, failed: 0 });
  });

  it('stops the batch after a lookup throws, recording only that row', async () => {
    const rows = [pending('a'), pending('b'), pending('c')];
    const h = harness(rows, (l) => (l.id === 'b' ? new Error('google status=OVER_QUERY_LIMIT') : { kind: 'not_found' }));
    const result = await runGeocodeSweep(h.deps);
    expect(h.writes.map(([id, o]) => [id, o.kind])).toEqual([
      ['a', 'not_found'],
      ['b', 'retry'],
    ]);
    expect(result).toMatchObject({ notFound: 1, retried: 1 });
  });

  it('keeps retrying a row however many times the provider has failed it', async () => {
    const h = harness([pending('a', 50)], () => new Error('google status=REQUEST_DENIED'));
    const result = await runGeocodeSweep(h.deps);
    expect(h.writes[0][1]).toEqual({ kind: 'retry' });
    expect(result.retried).toBe(1);
  });

  it('counts a guarded write that missed as superseded, not as success', async () => {
    const h = harness([pending('a')], () => ({ kind: 'found', coords: { latitude: 1, longitude: 2 } }), false);
    const result = await runGeocodeSweep(h.deps);
    expect(result).toMatchObject({ found: 0, superseded: 1 });
  });

  it('keeps going when one write throws', async () => {
    const rows = [pending('a'), pending('b')];
    const h = harness(rows, () => ({ kind: 'not_found' }));
    let first = true;
    const writeOutcome = async (loc: PendingLocation, o: GeocodeOutcome) => {
      if (first) {
        first = false;
        throw new Error('connection reset');
      }
      return h.deps.writeOutcome(loc, o);
    };
    const result = await runGeocodeSweep({ ...h.deps, writeOutcome });
    expect(result).toMatchObject({ failed: 1, notFound: 1 });
  });

  it('stops the batch when both the lookup and its retry write fail', async () => {
    const rows = [pending('a'), pending('b')];
    const h = harness(rows, () => new Error('timeout'));
    const lookups: string[] = [];
    const geocoder: Geocoder = {
      geocode: async (a) => {
        lookups.push(a.street1);
        throw new Error('timeout');
      },
    };
    const writeOutcome = async () => {
      throw new Error('connection reset');
    };
    const result = await runGeocodeSweep({ ...h.deps, geocoder, writeOutcome });
    expect(lookups).toHaveLength(1);
    expect(result.failed).toBe(1);
  });

  it('asks the enumerator for at most the batch size', async () => {
    const listPending = vi.fn(async () => []);
    await runGeocodeSweep({ ...harness([], () => ({ kind: 'not_found' })).deps, listPending, batchSize: 7 });
    expect(listPending).toHaveBeenCalledWith(7);
  });
});
