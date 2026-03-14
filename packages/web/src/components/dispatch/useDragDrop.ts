import { useState, useCallback } from 'react';

export type DragSourceType = 'queue' | 'lane';

export interface DragState {
  isDragging: boolean;
  draggedAppointmentId: string | null;
  sourceType: DragSourceType | null;
  sourceTechnicianId: string | null;
  targetTechnicianId: string | null;
  targetPosition: number | null;
}

export interface DragResult {
  appointmentId: string;
  sourceType: DragSourceType;
  sourceTechnicianId: string | null;
  targetTechnicianId: string;
  targetPosition: number | null;
  proposedScheduledStart?: string;
  proposedScheduledEnd?: string;
}

export interface UseDragDropResult {
  dragState: DragState;
  handleDragStart: (e: React.DragEvent, appointmentId: string, sourceType: DragSourceType, sourceTechnicianId?: string) => void;
  handleDragOver: (e: React.DragEvent, technicianId: string) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent, technicianId: string, position?: number) => DragResult | null;
  handleDragEnd: () => void;
  isDropTarget: (technicianId: string) => boolean;
}

const INITIAL_STATE: DragState = {
  isDragging: false,
  draggedAppointmentId: null,
  sourceType: null,
  sourceTechnicianId: null,
  targetTechnicianId: null,
  targetPosition: null,
};

export function useDragDrop(onDragComplete?: (result: DragResult) => void): UseDragDropResult {
  const [dragState, setDragState] = useState<DragState>(INITIAL_STATE);

  const handleDragStart = useCallback((
    e: React.DragEvent,
    appointmentId: string,
    sourceType: DragSourceType,
    sourceTechnicianId?: string,
  ) => {
    e.dataTransfer.setData('text/plain', appointmentId);
    e.dataTransfer.effectAllowed = 'move';

    setDragState({
      isDragging: true,
      draggedAppointmentId: appointmentId,
      sourceType,
      sourceTechnicianId: sourceTechnicianId ?? null,
      targetTechnicianId: null,
      targetPosition: null,
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, technicianId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    setDragState((prev) => ({
      ...prev,
      targetTechnicianId: technicianId,
    }));
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Ignore events fired when pointer moves into a child element
    if (e.currentTarget && e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragState((prev) => ({
      ...prev,
      targetTechnicianId: null,
    }));
  }, []);

  const handleDrop = useCallback((
    e: React.DragEvent,
    technicianId: string,
    position?: number,
  ): DragResult | null => {
    e.preventDefault();

    const appointmentId = e.dataTransfer.getData('text/plain');
    if (!appointmentId || !dragState.sourceType) {
      setDragState(INITIAL_STATE);
      return null;
    }

    const result: DragResult = {
      appointmentId,
      sourceType: dragState.sourceType,
      sourceTechnicianId: dragState.sourceTechnicianId,
      targetTechnicianId: technicianId,
      targetPosition: position ?? null,
    };

    setDragState(INITIAL_STATE);
    onDragComplete?.(result);
    return result;
  }, [dragState.sourceType, dragState.sourceTechnicianId, onDragComplete]);

  const handleDragEnd = useCallback(() => {
    setDragState(INITIAL_STATE);
  }, []);

  const isDropTarget = useCallback((technicianId: string): boolean => {
    return dragState.isDragging && dragState.targetTechnicianId === technicianId;
  }, [dragState.isDragging, dragState.targetTechnicianId]);

  return {
    dragState,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
    isDropTarget,
  };
}
