import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDragDrop } from './useDragDrop';

function createMockDragEvent(
  data?: Record<string, string>,
  overrides?: Partial<React.DragEvent>,
): React.DragEvent {
  const store: Record<string, string> = { ...data };
  return {
    preventDefault: vi.fn(),
    currentTarget: null,
    relatedTarget: null,
    dataTransfer: {
      setData: vi.fn((key: string, value: string) => { store[key] = value; }),
      getData: vi.fn((key: string) => store[key] || ''),
      effectAllowed: 'uninitialized',
      dropEffect: 'none',
    },
    ...overrides,
  } as unknown as React.DragEvent;
}

describe('P6-007 — Drag-start and drag-target interaction model', () => {
  it('initializes with idle state', () => {
    const { result } = renderHook(() => useDragDrop());
    expect(result.current.dragState.isDragging).toBe(false);
    expect(result.current.dragState.draggedAppointmentId).toBeNull();
  });

  it('sets drag state on drag start', () => {
    const { result } = renderHook(() => useDragDrop());
    const event = createMockDragEvent();

    act(() => {
      result.current.handleDragStart(event, 'appt-1', 'queue');
    });

    expect(result.current.dragState.isDragging).toBe(true);
    expect(result.current.dragState.draggedAppointmentId).toBe('appt-1');
    expect(result.current.dragState.sourceType).toBe('queue');
  });

  it('sets drag state for lane source with technician', () => {
    const { result } = renderHook(() => useDragDrop());
    const event = createMockDragEvent();

    act(() => {
      result.current.handleDragStart(event, 'appt-1', 'lane', 'tech-1');
    });

    expect(result.current.dragState.sourceTechnicianId).toBe('tech-1');
  });

  it('updates target technician on drag over', () => {
    const { result } = renderHook(() => useDragDrop());
    const startEvent = createMockDragEvent();
    const overEvent = createMockDragEvent();

    act(() => {
      result.current.handleDragStart(startEvent, 'appt-1', 'queue');
    });
    act(() => {
      result.current.handleDragOver(overEvent, 'tech-2');
    });

    expect(result.current.dragState.targetTechnicianId).toBe('tech-2');
    expect(overEvent.preventDefault).toHaveBeenCalled();
  });

  it('clears target on drag leave', () => {
    const { result } = renderHook(() => useDragDrop());
    const startEvent = createMockDragEvent();
    const leaveEvent = createMockDragEvent();

    act(() => {
      result.current.handleDragStart(startEvent, 'appt-1', 'queue');
      result.current.handleDragOver(createMockDragEvent(), 'tech-1');
    });
    act(() => {
      result.current.handleDragLeave(leaveEvent);
    });

    expect(result.current.dragState.targetTechnicianId).toBeNull();
  });

  it('returns drag result on drop and resets state', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useDragDrop(onComplete));
    const startEvent = createMockDragEvent();

    act(() => {
      result.current.handleDragStart(startEvent, 'appt-1', 'queue');
    });

    const dropEvent = createMockDragEvent({ 'text/plain': 'appt-1' });
    let dropResult: ReturnType<typeof result.current.handleDrop> = null;

    act(() => {
      dropResult = result.current.handleDrop(dropEvent, 'tech-2');
    });

    expect(dropResult).toEqual({
      appointmentId: 'appt-1',
      sourceType: 'queue',
      sourceTechnicianId: null,
      targetTechnicianId: 'tech-2',
      targetPosition: null,
    });
    expect(onComplete).toHaveBeenCalledWith(dropResult);
    expect(result.current.dragState.isDragging).toBe(false);
  });

  it('resets state on drag end', () => {
    const { result } = renderHook(() => useDragDrop());
    const startEvent = createMockDragEvent();

    act(() => {
      result.current.handleDragStart(startEvent, 'appt-1', 'queue');
    });
    act(() => {
      result.current.handleDragEnd();
    });

    expect(result.current.dragState.isDragging).toBe(false);
  });

  it('identifies drop targets correctly', () => {
    const { result } = renderHook(() => useDragDrop());
    const startEvent = createMockDragEvent();

    act(() => {
      result.current.handleDragStart(startEvent, 'appt-1', 'queue');
      result.current.handleDragOver(createMockDragEvent(), 'tech-1');
    });

    expect(result.current.isDropTarget('tech-1')).toBe(true);
    expect(result.current.isDropTarget('tech-2')).toBe(false);
  });

  it('does not produce a result if no data on drop', () => {
    const { result } = renderHook(() => useDragDrop());
    const dropEvent = createMockDragEvent();

    act(() => {
      result.current.handleDragStart(createMockDragEvent(), 'appt-1', 'queue');
    });

    // Drop without proper data transfer
    const emptyDropEvent = {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: vi.fn(() => ''),
        setData: vi.fn(),
        effectAllowed: 'uninitialized',
        dropEffect: 'none',
      },
    } as unknown as React.DragEvent;

    let dropResult: ReturnType<typeof result.current.handleDrop> = null;
    act(() => {
      dropResult = result.current.handleDrop(emptyDropEvent, 'tech-1');
    });

    expect(dropResult).toBeNull();
  });
});
