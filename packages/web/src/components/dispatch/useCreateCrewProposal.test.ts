import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCreateCrewProposal } from './useCreateCrewProposal';

describe('useCreateCrewProposal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('posts an add_crew_member proposal with the If-Match version header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'prop-1' }),
    });

    const { result } = renderHook(() => useCreateCrewProposal());

    let res: any;
    await act(async () => {
      res = await result.current.addCrew({
        appointmentId: 'appt-1',
        technicianId: 'tech-2',
        appointmentVersion: '2026-05-17T10:00:00.000Z',
      });
    });

    expect(res.success).toBe(true);
    expect(res.proposalId).toBe('prop-1');
    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toBe('/api/proposals');
    expect(call[1].headers['If-Match']).toBe('2026-05-17T10:00:00.000Z');
    const body = JSON.parse(call[1].body);
    expect(body.proposalType).toBe('add_crew_member');
    expect(body.payload).toEqual({ appointmentId: 'appt-1', technicianId: 'tech-2' });
  });

  it('posts a remove_crew_member proposal', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'prop-2' }),
    });

    const { result } = renderHook(() => useCreateCrewProposal());
    await act(async () => {
      await result.current.removeCrew({ appointmentId: 'appt-1', technicianId: 'tech-2' });
    });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('remove_crew_member');
  });

  it('maps a 409 to STALE', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({}) });
    const { result } = renderHook(() => useCreateCrewProposal());
    let res: any;
    await act(async () => {
      res = await result.current.addCrew({ appointmentId: 'a', technicianId: 't' });
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('STALE');
  });

  it('maps a 422 to INFEASIBLE and surfaces blocking issues', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ blocking: [{ check: 'overlap', message: 'Overlaps with X' }], warnings: [] }),
    });
    const { result } = renderHook(() => useCreateCrewProposal());
    let res: any;
    await act(async () => {
      res = await result.current.addCrew({ appointmentId: 'a', technicianId: 't' });
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('INFEASIBLE');
    expect(res.blocking[0].message).toBe('Overlaps with X');
  });
});
