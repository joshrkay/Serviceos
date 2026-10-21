import type { Appointment } from '../appointments/appointment';
import type { User } from '../users/user';
import { isActiveMember } from '../users/tenant-member';
import { checkFeasibility } from './feasibility';
import type { FeasibilityDependencies, FeasibilityResult } from './feasibility-types';

/**
 * Dispatch FR-2 phase 3 — which technician should take this visit?
 *
 * Every active technician is run through the same `checkFeasibility` the
 * proposal executor enforces, over the visit's own window, so a suggestion
 * is never a tech the approval would then refuse. "Closest" means the drive
 * from the tech's previous visit that day; a tech with no earlier visit (or
 * no geocoded address on either end) has no known drive and ranks after
 * every tech whose drive is known. Read-only: the board turns a pick into a
 * reassign_appointment proposal that a human approves.
 */

/** Bounds the per-request feasibility fan-out (each runs a travel lookup). */
export const MAX_SUGGESTION_CANDIDATES = 25;

export interface TechnicianSuggestion {
  technicianId: string;
  name: string;
  feasible: boolean;
  /** Blocking reasons first, then warnings — what the dispatcher would hit. */
  reasons: string[];
  warningCount: number;
  /** Drive from the tech's previous visit that day; null when not known. */
  travelFromPrevSeconds: number | null;
  travelEstimateSource: 'google' | 'haversine' | 'unknown' | null;
  /** True for the technician already assigned as primary. */
  isCurrent: boolean;
}

export function technicianDisplayName(user: Pick<User, 'firstName' | 'lastName' | 'email'>): string {
  const full = [user.firstName, user.lastName].filter((p) => p && p.trim()).join(' ').trim();
  return full || user.email;
}

export function toSuggestion(
  user: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'>,
  result: FeasibilityResult,
  isCurrent: boolean,
): TechnicianSuggestion {
  return {
    technicianId: user.id,
    name: technicianDisplayName(user),
    feasible: result.feasible,
    reasons: [...result.blocking, ...result.warnings].map((i) => i.message),
    warningCount: result.warnings.length,
    travelFromPrevSeconds: result.travelTime?.fromPrevSeconds ?? null,
    travelEstimateSource: result.travelTime?.estimateSource ?? null,
    isCurrent,
  };
}

/**
 * Feasible first; then a known drive, shortest first; then fewer warnings;
 * then name, so equal candidates come back in a stable order.
 */
export function rankSuggestions(suggestions: readonly TechnicianSuggestion[]): TechnicianSuggestion[] {
  return [...suggestions].sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    const aKnown = a.travelFromPrevSeconds !== null;
    const bKnown = b.travelFromPrevSeconds !== null;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown && bKnown && a.travelFromPrevSeconds !== b.travelFromPrevSeconds) {
      return a.travelFromPrevSeconds! - b.travelFromPrevSeconds!;
    }
    if (a.warningCount !== b.warningCount) return a.warningCount - b.warningCount;
    return a.name.localeCompare(b.name);
  });
}

export interface SuggestTechniciansInput {
  tenantId: string;
  appointment: Appointment;
  /** The tenant's users; filtered here to active technicians. */
  candidates: readonly User[];
  currentTechnicianId?: string;
}

export async function suggestTechnicians(
  deps: FeasibilityDependencies,
  input: SuggestTechniciansInput,
): Promise<TechnicianSuggestion[]> {
  const technicians = input.candidates
    .filter((u) => u.role === 'technician' && isActiveMember(u))
    .slice(0, MAX_SUGGESTION_CANDIDATES);
  const suggestions = await Promise.all(
    technicians.map(async (tech) => {
      const result = await checkFeasibility(
        {
          tenantId: input.tenantId,
          appointment: input.appointment,
          proposedTechnicianId: tech.id,
          proposedScheduledStart: input.appointment.scheduledStart,
          proposedScheduledEnd: input.appointment.scheduledEnd,
        },
        deps,
      );
      return toSuggestion(tech, result, tech.id === input.currentTechnicianId);
    }),
  );
  return rankSuggestions(suggestions);
}
