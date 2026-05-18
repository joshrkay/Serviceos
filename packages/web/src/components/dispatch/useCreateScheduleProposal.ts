import { useState, useCallback } from 'react';
import { DragResult } from './useDragDrop';
import { apiFetch } from '../../utils/api-fetch';
import type { FeasibilityIssue } from './feasibility-types';

export type ScheduleProposalErrorKind =
  | 'STALE'
  | 'INFEASIBLE'
  | 'MISSING_VERSION'
  | 'INVALID_VERSION'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'BAD_INPUT';

export interface ScheduleProposalResult {
  success: boolean;
  proposalId?: string;
  error?: ScheduleProposalErrorKind | string;
  blocking?: FeasibilityIssue[];
  warnings?: FeasibilityIssue[];
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
} | null {
  if (dragResult.sourceType === 'queue') {
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
    if (!dragResult.proposedScheduledStart || !dragResult.proposedScheduledEnd) {
      return null;
    }
    return {
      proposalType: 'reschedule_appointment',
      payload: {
        appointmentId: dragResult.appointmentId,
        newScheduledStart: dragResult.proposedScheduledStart,
        newScheduledEnd: dragResult.proposedScheduledEnd,
        reason: 'Reordered within technician lane',
      },
      summary: `Reschedule appointment within technician lane`,
    };
  }

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
      const proposalData = buildProposalPayload(dragResult);
      if (!proposalData) {
        const result: ScheduleProposalResult = {
          success: false,
          error: 'Specify new times to reschedule an appointment',
        };
        setLastResult(result);
        return result;
      }
      const { proposalType, payload, summary } = proposalData;
      const version = dragResult.appointmentVersion;

      const response = await apiFetch('/api/proposals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(version ? { 'If-Match': version } : {}),
        },
        body: JSON.stringify({
          proposalType,
          payload,
          summary,
          ...(version ? { appointmentVersion: version } : {}),
        }),
      });

      if (!response.ok) {
        if (response.status === 409) {
          const result: ScheduleProposalResult = { success: false, error: 'STALE' };
          setLastResult(result);
          return result;
        }
        if (response.status === 422) {
          const body = await response.json().catch(() => ({} as { blocking?: FeasibilityIssue[]; warnings?: FeasibilityIssue[] }));
          const result: ScheduleProposalResult = {
            success: false,
            error: 'INFEASIBLE',
            blocking: body.blocking ?? [],
            warnings: body.warnings ?? [],
          };
          setLastResult(result);
          return result;
        }
        if (response.status === 400) {
          const body = await response.json().catch(() => ({} as { error?: string }));
          const kind = body.error === 'MISSING_VERSION' || body.error === 'INVALID_VERSION'
            ? body.error
            : 'BAD_INPUT';
          const result: ScheduleProposalResult = { success: false, error: kind };
          setLastResult(result);
          return result;
        }
        const text = await response.text().catch(() => '');
        const result: ScheduleProposalResult = {
          success: false,
          error: `Failed to create proposal${text ? `: ${text}` : ''}`,
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
        error: err instanceof Error ? err.message : 'NETWORK',
      };
      setLastResult(result);
      return result;
    } finally {
      setIsCreating(false);
    }
  }, []);

  return { createProposal, isCreating, lastResult };
}
