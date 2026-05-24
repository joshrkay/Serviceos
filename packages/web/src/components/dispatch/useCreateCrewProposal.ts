import { useState, useCallback } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import type { FeasibilityIssue } from './feasibility-types';

export type CrewProposalErrorKind =
  | 'STALE'
  | 'INFEASIBLE'
  | 'MISSING_VERSION'
  | 'INVALID_VERSION'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'BAD_INPUT';

export interface CrewProposalResult {
  success: boolean;
  proposalId?: string;
  error?: CrewProposalErrorKind | string;
  blocking?: FeasibilityIssue[];
  warnings?: FeasibilityIssue[];
}

interface CrewProposalArgs {
  appointmentId: string;
  technicianId: string;
  appointmentVersion?: string;
  reason?: string;
}

export interface UseCreateCrewProposalResult {
  addCrew: (args: CrewProposalArgs) => Promise<CrewProposalResult>;
  removeCrew: (args: CrewProposalArgs) => Promise<CrewProposalResult>;
  isSubmitting: boolean;
}

async function postCrewProposal(
  proposalType: 'add_crew_member' | 'remove_crew_member',
  args: CrewProposalArgs,
): Promise<CrewProposalResult> {
  const { appointmentId, technicianId, appointmentVersion, reason } = args;
  try {
    const response = await apiFetch('/api/proposals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(appointmentVersion ? { 'If-Match': appointmentVersion } : {}),
      },
      body: JSON.stringify({
        proposalType,
        payload: { appointmentId, technicianId, ...(reason ? { reason } : {}) },
        summary:
          proposalType === 'add_crew_member'
            ? 'Add crew member to appointment'
            : 'Remove crew member from appointment',
        ...(appointmentVersion ? { appointmentVersion } : {}),
      }),
    });

    if (!response.ok) {
      if (response.status === 409) return { success: false, error: 'STALE' };
      if (response.status === 422) {
        const body = await response.json().catch(() => ({} as { blocking?: FeasibilityIssue[]; warnings?: FeasibilityIssue[] }));
        return {
          success: false,
          error: 'INFEASIBLE',
          blocking: body.blocking ?? [],
          warnings: body.warnings ?? [],
        };
      }
      if (response.status === 400) {
        const body = await response.json().catch(() => ({} as { error?: string }));
        const kind =
          body.error === 'MISSING_VERSION' || body.error === 'INVALID_VERSION'
            ? body.error
            : 'BAD_INPUT';
        return { success: false, error: kind };
      }
      const text = await response.text().catch(() => '');
      return { success: false, error: `Failed to create proposal${text ? `: ${text}` : ''}` };
    }

    const data = await response.json();
    return { success: true, proposalId: data.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'NETWORK' };
  }
}

export function useCreateCrewProposal(): UseCreateCrewProposalResult {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const run = useCallback(
    async (
      proposalType: 'add_crew_member' | 'remove_crew_member',
      args: CrewProposalArgs,
    ): Promise<CrewProposalResult> => {
      setIsSubmitting(true);
      try {
        return await postCrewProposal(proposalType, args);
      } finally {
        setIsSubmitting(false);
      }
    },
    [],
  );

  const addCrew = useCallback((args: CrewProposalArgs) => run('add_crew_member', args), [run]);
  const removeCrew = useCallback((args: CrewProposalArgs) => run('remove_crew_member', args), [run]);

  return { addCrew, removeCrew, isSubmitting };
}
