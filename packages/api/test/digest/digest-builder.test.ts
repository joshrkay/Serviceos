/**
 * P5-020 — DigestBuilder unit tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDigestData } from '../../src/digest/digest-builder';

// Helper to build a mock pg Pool
function makeMockPool(queryResults: Record<string, { rows: Record<string, unknown>[] }>) {
  const queryMock = vi.fn(async (sql: string, _params?: unknown[]) => {
    for (const [key, result] of Object.entries(queryResults)) {
      if (sql.includes(key)) return { rows: result.rows };
    }
    return { rows: [] };
  });
  return {
    query: queryMock,
    connect: vi.fn(async () => ({
      query: queryMock,
      release: vi.fn(),
    })),
  };
}

const tenantId = '00000000-0000-0000-0000-000000000001';
const localDate = '2026-01-15';
const timezone = 'America/Phoenix';
const utcDayStart = new Date('2026-01-15T07:00:00Z'); // Phoenix is UTC-7
const utcDayEnd = new Date('2026-01-16T07:00:00Z');
const utcTomorrowStart = new Date('2026-01-16T07:00:00Z');
const utcTomorrowEnd = new Date('2026-01-17T07:00:00Z');

describe('DigestBuilder — buildDigestData', () => {
  it('returns correct source data and sections for a synthetic day', async () => {
    const mockPool = makeMockPool({
      'FROM jobs': {
        rows: [
          { id: 'job-1' },
          { id: 'job-2' },
        ],
      },
      'FROM estimates': {
        rows: [
          { id: 'est-1', total_cents: 15000 },
        ],
      },
      'FROM invoices': {
        rows: [
          { id: 'inv-1', total_cents: 20000, amount_paid_cents: 5000 },
        ],
      },
      'FROM appointments': {
        rows: [
          { id: 'appt-1' },
        ],
      },
      'FROM proposals': {
        rows: [
          { id: 'prop-1' },
        ],
      },
      'FROM knowledge_chunks': {
        rows: [
          { id: 'chunk-1', content: 'correction content' },
        ],
      },
    });

    const result = await buildDigestData(
      mockPool as any,
      tenantId,
      localDate,
      utcDayStart,
      utcDayEnd,
      utcTomorrowStart,
      utcTomorrowEnd,
      timezone,
    );

    expect(result.sourceData.completedJobIds).toEqual(['job-1', 'job-2']);
    expect(result.sourceData.sentEstimateIds).toEqual(['est-1']);
    expect(result.sourceData.followUpInvoiceIds).toEqual(['inv-1']);
    expect(result.sourceData.tomorrowAppointmentIds).toEqual(['appt-1']);
    expect(result.sourceData.uncertainProposalIds).toEqual(['prop-1']);
    expect(result.sourceData.correctionChunkIds).toEqual(['chunk-1']);

    // Should have 6 sections (all present)
    expect(result.sections).toHaveLength(6);
    expect(result.sections[0].label).toBe('Jobs wrapped up today');
    expect(result.sections[0].lines[0]).toContain('2 jobs completed');
    expect(result.sections[1].label).toBe('Estimates sent today');
    expect(result.sections[1].lines[0]).toContain('$150');
    expect(result.sections[4].label).toBe("What I wasn't sure about");
    expect(result.sections[5].label).toBe('What I learned today');
  });

  it('omits "What I wasn\'t sure about" section on zero uncertain proposals', async () => {
    const mockPool = makeMockPool({
      'FROM jobs': { rows: [] },
      'FROM estimates': { rows: [] },
      'FROM invoices': { rows: [] },
      'FROM appointments': { rows: [] },
      'FROM proposals': { rows: [] },
      'FROM knowledge_chunks': { rows: [] },
    });

    const result = await buildDigestData(
      mockPool as any,
      tenantId,
      localDate,
      utcDayStart,
      utcDayEnd,
      utcTomorrowStart,
      utcTomorrowEnd,
      timezone,
    );

    const labels = result.sections.map((s) => s.label);
    expect(labels).not.toContain("What I wasn't sure about");
  });

  it('omits "What I learned today" section on zero correction chunks', async () => {
    const mockPool = makeMockPool({
      'FROM jobs': { rows: [] },
      'FROM estimates': { rows: [] },
      'FROM invoices': { rows: [] },
      'FROM appointments': { rows: [] },
      'FROM proposals': { rows: [{ id: 'prop-1' }] },
      'FROM knowledge_chunks': { rows: [] },
    });

    const result = await buildDigestData(
      mockPool as any,
      tenantId,
      localDate,
      utcDayStart,
      utcDayEnd,
      utcTomorrowStart,
      utcTomorrowEnd,
      timezone,
    );

    const labels = result.sections.map((s) => s.label);
    expect(labels).not.toContain('What I learned today');
    // But uncertain proposals section should be present
    expect(labels).toContain("What I wasn't sure about");
  });
});
