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

  it('creates reschedule proposal for within-lane reorder', async () => {
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
    };

    await act(async () => {
      await result.current.createProposal(dragResult);
    });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.proposalType).toBe('reschedule_appointment');
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
});
