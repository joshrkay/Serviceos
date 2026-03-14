import { useState, useCallback } from 'react';
import { DragResult } from './useDragDrop';

export interface ScheduleProposalResult {
  success: boolean;
  proposalId?: string;
  error?: string;
}

export interface UseCreateScheduleProposalResult {
  createProposal: (dragResult: DragResult) => Promise<ScheduleProposalResult>;
  isCreating: boolean;
  lastResult: ScheduleProposalResult | null;
}

function buildProposalPayload(dragResult: DragResult): {
  proposalType: string;
  payload: Record<string, unknown>;
  summary: string;
} {
  if (dragResult.sourceType === 'queue') {
    // Unassigned → Lane = reassignment
    return {
      proposalType: 'reassign_appointment',
      payload: {
        appointmentId: dragResult.appointmentId,
        toTechnicianId: dragResult.targetTechnicianId,
      },
      summary: `Assign appointment to technician`,
    };
  }

  if (dragResult.sourceTechnicianId === dragResult.targetTechnicianId) {
    // Within-lane reorder = reschedule
    return {
      proposalType: 'reschedule_appointment',
      payload: {
        appointmentId: dragResult.appointmentId,
        reason: 'Reordered within technician lane',
      },
      summary: `Reorder appointment within technician lane`,
    };
  }

  // Lane → Different Lane = reassignment
  return {
    proposalType: 'reassign_appointment',
    payload: {
      appointmentId: dragResult.appointmentId,
      fromTechnicianId: dragResult.sourceTechnicianId,
      toTechnicianId: dragResult.targetTechnicianId,
    },
    summary: `Reassign appointment to different technician`,
  };
}

export function useCreateScheduleProposal(): UseCreateScheduleProposalResult {
  const [isCreating, setIsCreating] = useState(false);
  const [lastResult, setLastResult] = useState<ScheduleProposalResult | null>(null);

  const createProposal = useCallback(async (dragResult: DragResult): Promise<ScheduleProposalResult> => {
    setIsCreating(true);
    setLastResult(null);

    try {
      const { proposalType, payload, summary } = buildProposalPayload(dragResult);

      const response = await fetch('/api/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalType,
          payload,
          summary,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        const result: ScheduleProposalResult = {
          success: false,
          error: `Failed to create proposal: ${error}`,
        };
        setLastResult(result);
        return result;
      }

      const data = await response.json();
      const result: ScheduleProposalResult = {
        success: true,
        proposalId: data.id,
      };
      setLastResult(result);
      return result;
    } catch (err) {
      const result: ScheduleProposalResult = {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to create proposal',
      };
      setLastResult(result);
      return result;
    } finally {
      setIsCreating(false);
    }
  }, []);

  return { createProposal, isCreating, lastResult };
}
