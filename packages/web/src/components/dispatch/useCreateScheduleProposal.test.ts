import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCreateScheduleProposal } from './useCreateScheduleProposal';
import { DragResult } from './useDragDrop';

describe('P6-008 — Convert drag/drop into schedule proposal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates reassignment proposal for queue-to-lane drag', async () => {
    const mockResponse = { id: 'proposal-1' };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { result } = renderHook(() => useCreateScheduleProposal());

    const dragResult: DragResult = {
      appointmentId: 'appt-1',
      sourceType: 'queue',
      sourceTechnicianId: null,
      targetTechnicianId: 'tech-1',
      targetPosition: null,
    };

    let proposalResult: any;
    await act(async () => {
      proposalResult = await result.current.createProposal(dragResult);
    });

    expect(proposalResult.success).toBe(true);
    expect(proposalResult.proposalId).toBe('proposal-1');
    expect(global.fetch).toHaveBeenCalledWith('/api/proposals', expect.objectContaining({
      method: 'POST',
    }));

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('reassign_appointment');
    expect(body.payload.appointmentId).toBe('appt-1');
    expect(body.payload.toTechnicianId).toBe('tech-1');
  });

  it('creates reassignment proposal for lane-to-lane drag', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'proposal-2' }),
    });

    const { result } = renderHook(() => useCreateScheduleProposal());

    const dragResult: DragResult = {
      appointmentId: 'appt-1',
      sourceType: 'lane',
      sourceTechnicianId: 'tech-1',
      targetTechnicianId: 'tech-2',
      targetPosition: null,
    };

    await act(async () => {
      await result.current.createProposal(dragResult);
    });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('reassign_appointment');
    expect(body.payload.fromTechnicianId).toBe('tech-1');
    expect(body.payload.toTechnicianId).toBe('tech-2');
  });

  it('returns error for within-lane reorder without proposed times', async () => {
    global.fetch = vi.fn();

    const { result } = renderHook(() => useCreateScheduleProposal());

    const dragResult: DragResult = {
      appointmentId: 'appt-1',
      sourceType: 'lane',
      sourceTechnicianId: 'tech-1',
      targetTechnicianId: 'tech-1',
      targetPosition: 2,
    };

    let proposalResult: any;
    await act(async () => {
      proposalResult = await result.current.createProposal(dragResult);
    });

    expect(proposalResult.success).toBe(false);
    expect(proposalResult.error).toContain('Specify new times');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('creates reschedule proposal for within-lane reorder with proposed times', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'proposal-3' }),
    });

    const { result } = renderHook(() => useCreateScheduleProposal());

    const dragResult: DragResult = {
      appointmentId: 'appt-1',
      sourceType: 'lane',
      sourceTechnicianId: 'tech-1',
      targetTechnicianId: 'tech-1',
      targetPosition: 2,
      proposedScheduledStart: '2026-03-14T10:00:00Z',
      proposedScheduledEnd: '2026-03-14T12:00:00Z',
    };

    await act(async () => {
      await result.current.createProposal(dragResult);
    });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('reschedule_appointment');
    expect(body.payload.newScheduledStart).toBe('2026-03-14T10:00:00Z');
    expect(body.payload.newScheduledEnd).toBe('2026-03-14T12:00:00Z');
  });

  it('handles API error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve('Server error'),
    });

    const { result } = renderHook(() => useCreateScheduleProposal());

    const dragResult: DragResult = {
      appointmentId: 'appt-1',
      sourceType: 'queue',
      sourceTechnicianId: null,
      targetTechnicianId: 'tech-1',
      targetPosition: null,
    };

    let proposalResult: any;
    await act(async () => {
      proposalResult = await result.current.createProposal(dragResult);
    });

    expect(proposalResult.success).toBe(false);
    expect(proposalResult.error).toContain('Server error');
  });

  it('handles network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const { result } = renderHook(() => useCreateScheduleProposal());

    const dragResult: DragResult = {
      appointmentId: 'appt-1',
      sourceType: 'queue',
      sourceTechnicianId: null,
      targetTechnicianId: 'tech-1',
      targetPosition: null,
    };

    let proposalResult: any;
    await act(async () => {
      proposalResult = await result.current.createProposal(dragResult);
    });

    expect(proposalResult.success).toBe(false);
    expect(proposalResult.error).toContain('Network failure');
  });

  it('is idempotent — same drag produces same proposal type', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'proposal-1' }),
    });

    const { result } = renderHook(() => useCreateScheduleProposal());

    const dragResult: DragResult = {
      appointmentId: 'appt-1',
      sourceType: 'queue',
      sourceTechnicianId: null,
      targetTechnicianId: 'tech-1',
      targetPosition: null,
    };

    await act(async () => {
      await result.current.createProposal(dragResult);
    });
    await act(async () => {
      await result.current.createProposal(dragResult);
    });

    const calls = (global.fetch as any).mock.calls;
    const body1 = JSON.parse(calls[0][1].body);
    const body2 = JSON.parse(calls[1][1].body);
    expect(body1.proposalType).toBe(body2.proposalType);
  });

  it('forwards appointmentVersion as If-Match header and body field', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: () => Promise.resolve({ id: 'p-1' }),
    });
    const { result } = renderHook(() => useCreateScheduleProposal());
    const dragResult: DragResult = {
      appointmentId: 'a-1', sourceType: 'queue', sourceTechnicianId: null,
      targetTechnicianId: 'tech-1', targetPosition: null,
      appointmentVersion: '2026-05-16T12:00:00.000Z',
    };
    await act(async () => { await result.current.createProposal(dragResult); });
    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].headers['If-Match']).toBe('2026-05-16T12:00:00.000Z');
    const body = JSON.parse(call[1].body);
    expect(body.appointmentVersion).toBe('2026-05-16T12:00:00.000Z');
  });

  it('returns { success:false, error:"STALE" } on 409', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 409,
      json: () => Promise.resolve({ error: 'STALE_APPOINTMENT', currentVersion: 'x', providedVersion: 'y' }),
      text: () => Promise.resolve(''),
    });
    const { result } = renderHook(() => useCreateScheduleProposal());
    let r: any;
    await act(async () => {
      r = await result.current.createProposal({
        appointmentId: 'a-1', appointmentVersion: 'old',
        sourceType: 'queue', sourceTechnicianId: null,
        targetTechnicianId: 'tech-1', targetPosition: null,
      } as DragResult);
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe('STALE');
  });

  it('returns { success:false, error:"INFEASIBLE", blocking } on 422', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 422,
      json: () => Promise.resolve({
        error: 'INFEASIBLE',
        blocking: [{ check: 'overlap', severity: 'blocking', message: 'overlaps' }],
        warnings: [], info: [],
      }),
      text: () => Promise.resolve(''),
    });
    const { result } = renderHook(() => useCreateScheduleProposal());
    let r: any;
    await act(async () => {
      r = await result.current.createProposal({
        appointmentId: 'a-1', appointmentVersion: 'v',
        sourceType: 'queue', sourceTechnicianId: null,
        targetTechnicianId: 'tech-1', targetPosition: null,
      } as DragResult);
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe('INFEASIBLE');
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].check).toBe('overlap');
  });
});
