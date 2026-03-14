import { Appointment, AppointmentStatus } from '../appointments/appointment';
import { TechnicianWorkingHours } from '../availability/working-hours';
import { UnavailableBlock } from '../availability/unavailable-block';

export type ConflictSeverity = 'blocking' | 'warning';
export type ConflictType = 'overlapping_appointment' | 'outside_working_hours' | 'unavailable_block';

export interface ConflictResult {
  type: ConflictType;
  severity: ConflictSeverity;
  message: string;
  conflictingEntityId?: string;
}

const ACTIVE_STATUSES: AppointmentStatus[] = ['scheduled', 'confirmed', 'in_progress'];

function timeRangesOverlap(
  startA: Date,
  endA: Date,
  startB: Date,
  endB: Date,
): boolean {
  return startA < endB && endA > startB;
}

export function detectOverlappingAppointments(
  technicianId: string,
  scheduledStart: Date,
  scheduledEnd: Date,
  existingAppointments: Array<{
    id: string;
    technicianId?: string;
    scheduledStart: Date;
    scheduledEnd: Date;
    status: AppointmentStatus;
  }>,
  excludeAppointmentId?: string,
): ConflictResult[] {
  const conflicts: ConflictResult[] = [];

  for (const appt of existingAppointments) {
    if (excludeAppointmentId && appt.id === excludeAppointmentId) continue;
    if (appt.technicianId !== technicianId) continue;
    if (!ACTIVE_STATUSES.includes(appt.status)) continue;

    if (timeRangesOverlap(scheduledStart, scheduledEnd, appt.scheduledStart, appt.scheduledEnd)) {
      conflicts.push({
        type: 'overlapping_appointment',
        severity: 'blocking',
        message: `Overlaps with appointment ${appt.id} (${appt.scheduledStart.toISOString()} - ${appt.scheduledEnd.toISOString()})`,
        conflictingEntityId: appt.id,
      });
    }
  }

  return conflicts;
}

function parseTime(timeStr: string): { hours: number; minutes: number } {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

export function detectAvailabilityConflicts(
  scheduledStart: Date,
  scheduledEnd: Date,
  workingHours: TechnicianWorkingHours | null,
  unavailableBlocks: UnavailableBlock[],
): ConflictResult[] {
  const conflicts: ConflictResult[] = [];

  // Check working hours
  if (workingHours && workingHours.isActive) {
    const { hours: startH, minutes: startM } = parseTime(workingHours.startTime);
    const { hours: endH, minutes: endM } = parseTime(workingHours.endTime);

    const apptStartHour = scheduledStart.getHours();
    const apptStartMin = scheduledStart.getMinutes();
    const apptEndHour = scheduledEnd.getHours();
    const apptEndMin = scheduledEnd.getMinutes();

    const apptStartMinutes = apptStartHour * 60 + apptStartMin;
    const apptEndMinutes = apptEndHour * 60 + apptEndMin;
    const workStartMinutes = startH * 60 + startM;
    const workEndMinutes = endH * 60 + endM;

    if (apptStartMinutes < workStartMinutes || apptEndMinutes > workEndMinutes) {
      conflicts.push({
        type: 'outside_working_hours',
        severity: 'warning',
        message: `Appointment falls outside working hours (${workingHours.startTime} - ${workingHours.endTime})`,
      });
    }
  }

  // Check unavailable blocks
  for (const block of unavailableBlocks) {
    if (timeRangesOverlap(scheduledStart, scheduledEnd, block.startTime, block.endTime)) {
      conflicts.push({
        type: 'unavailable_block',
        severity: 'warning',
        message: `Conflicts with unavailable block${block.reason ? `: ${block.reason}` : ''} (${block.startTime.toISOString()} - ${block.endTime.toISOString()})`,
        conflictingEntityId: block.id,
      });
    }
  }

  return conflicts;
}
