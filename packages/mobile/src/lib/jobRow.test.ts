import { describe, expect, it } from 'vitest';
import { jobRowText } from './jobRow';

describe('jobRowText', () => {
  it('uses summary as the headline and shows jobNumber + status as secondary', () => {
    expect(
      jobRowText({ id: 'abc', jobNumber: 'JOB-0001', summary: 'Fix leaking faucet', status: 'scheduled' }),
    ).toEqual({ primary: 'Fix leaking faucet', secondary: 'JOB-0001 · scheduled' });
  });

  it('falls back to the job number when there is no summary', () => {
    expect(jobRowText({ id: 'abc', jobNumber: 'JOB-0002', status: 'new' })).toEqual({
      primary: 'JOB-0002',
      secondary: 'new',
    });
  });

  it('falls back to a short id when neither summary nor jobNumber is present', () => {
    expect(jobRowText({ id: '0123456789abcdef' })).toEqual({ primary: 'Job 01234567' });
  });

  it('never renders the literal "Job <uuid>" when the API shape is present (regression)', () => {
    // The old code read title/customerName/customer_name (absent on the API
    // Job) and always produced "Job <uuid>". With the real fields mapped, the
    // summary headlines the row instead.
    const row = jobRowText({ id: 'deadbeef-1111', jobNumber: 'JOB-0003', summary: 'Annual service' });
    expect(row.primary).toBe('Annual service');
    expect(row.primary).not.toMatch(/^Job /);
  });

  it('treats a blank summary as missing', () => {
    expect(jobRowText({ id: 'abc', jobNumber: 'JOB-0004', summary: '   ', status: 'open' })).toEqual({
      primary: 'JOB-0004',
      secondary: 'open',
    });
  });
});
