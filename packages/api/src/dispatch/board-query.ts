import { AppointmentRepository, Appointment, AppointmentStatus } from '../appointments/appointment';
import { AssignmentRepository, AppointmentAssignment } from '../appointments/assignment';
import { WorkingHoursRepository } from '../availability/working-hours';
import { UnavailableBlockRepository } from '../availability/unavailable-block';

export interface BoardAppointment {
  id: string;
  jobId: string;
  customerName?: string;
  locationAddress?: string;
  jobSummary?: string;
  technicianId?: string;
  technicianName?: string;
  scheduledStart: string;
  scheduledEnd: string;
  arrivalWindowStart?: string;
  arrivalWindowEnd?: string;
  status: string;
}

export interface TechnicianLane {
  technicianId: string;
  technicianName: string;
  appointments: BoardAppointment[];
  availabilitySummary?: {
    workingHours?: { start: string; end: string };
    unavailableBlocks?: { start: string; end: string; reason?: string }[];
  };
}

export interface BoardSummary {
  unassigned: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  canceled: number;
}

export interface DispatchBoardData {
  date: string;
  unassignedAppointments: BoardAppointment[];
  technicianLanes: TechnicianLane[];
  summary: BoardSummary;
}

export interface BoardQueryDependencies {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  workingHoursRepo?: WorkingHoursRepository;
  unavailableBlockRepo?: UnavailableBlockRepository;
  getTechnicianName?: (technicianId: string) => Promise<string>;
  getAppointmentDisplayContext?: (appointment: Appointment) => Promise<{
    customerName?: string;
    locationAddress?: string;
    jobSummary?: string;
  }>;
}

function getTimezoneOffsetMs(date: Date, timezone: string): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: timezone });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}

function getDayBoundaries(dateStr: string, timezone = 'UTC'): { start: Date; end: Date } {
  const [year, month, day] = dateStr.split('-').map(Number);
  // Use noon UTC as a DST-safe reference point to determine the timezone offset
  const ref = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offsetMs = getTimezoneOffsetMs(ref, timezone);
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMs);
  const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMs);
  return { start, end };
}

function toISOString(date: Date): string {
  return date.toISOString();
}

function toBoardAppointment(
  appointment: Appointment,
  context?: { customerName?: string; locationAddress?: string; jobSummary?: string },
  technicianId?: string,
  technicianName?: string,
): BoardAppointment {
  return {
    id: appointment.id,
    jobId: appointment.jobId,
    customerName: context?.customerName,
    locationAddress: context?.locationAddress,
    jobSummary: context?.jobSummary,
    technicianId,
    technicianName,
    scheduledStart: toISOString(appointment.scheduledStart),
    scheduledEnd: toISOString(appointment.scheduledEnd),
    arrivalWindowStart: appointment.arrivalWindowStart ? toISOString(appointment.arrivalWindowStart) : undefined,
    arrivalWindowEnd: appointment.arrivalWindowEnd ? toISOString(appointment.arrivalWindowEnd) : undefined,
    status: appointment.status,
  };
}

function computeSummary(
  unassigned: BoardAppointment[],
  lanes: TechnicianLane[],
): BoardSummary {
  const allAppointments = [
    ...unassigned,
    ...lanes.flatMap((l) => l.appointments),
  ];

  return {
    unassigned: unassigned.length,
    scheduled: allAppointments.filter((a) => a.status === 'scheduled' || a.status === 'confirmed').length,
    inProgress: allAppointments.filter((a) => a.status === 'in_progress').length,
    completed: allAppointments.filter((a) => a.status === 'completed').length,
    canceled: allAppointments.filter((a) => a.status === 'canceled').length,
  };
}

export async function getDispatchBoardData(
  tenantId: string,
  dateStr: string,
  deps: BoardQueryDependencies,
  timezone?: string,
): Promise<DispatchBoardData> {
  const { start, end } = getDayBoundaries(dateStr, timezone);

  const appointments = await deps.appointmentRepo.findByDateRange(tenantId, start, end);

  // Get assignments for all appointments in parallel
  const assignmentResults = await Promise.all(
    appointments.map((appt) =>
      deps.assignmentRepo.findByAppointment(tenantId, appt.id)
        .then((assignments) => ({ apptId: appt.id, assignments }))
    )
  );
  const assignmentMap = new Map<string, AppointmentAssignment[]>(
    assignmentResults.map((r) => [r.apptId, r.assignments])
  );

  // Group by technician
  const technicianAppointments = new Map<string, { appointment: Appointment; assignment: AppointmentAssignment }[]>();
  const unassigned: Appointment[] = [];

  for (const appt of appointments) {
    const assignments = assignmentMap.get(appt.id) ?? [];
    const primary = assignments.find((a) => a.isPrimary);

    if (primary) {
      const existing = technicianAppointments.get(primary.technicianId) ?? [];
      existing.push({ appointment: appt, assignment: primary });
      technicianAppointments.set(primary.technicianId, existing);
    } else {
      unassigned.push(appt);
    }
  }

  // Fetch display contexts for all appointments in parallel
  const allAppointmentsForContext = [...unassigned, ...appointments.filter((a) => !unassigned.includes(a))];
  const displayContextMap = new Map<string, { customerName?: string; locationAddress?: string; jobSummary?: string }>();
  if (deps.getAppointmentDisplayContext) {
    const contextResults = await Promise.all(
      allAppointmentsForContext.map((appt) =>
        deps.getAppointmentDisplayContext!(appt).then((ctx) => ({ apptId: appt.id, ctx }))
      )
    );
    for (const { apptId, ctx } of contextResults) {
      displayContextMap.set(apptId, ctx);
    }
  }

  // Build unassigned list
  const unassignedBoard: BoardAppointment[] = unassigned.map((appt) =>
    toBoardAppointment(appt, displayContextMap.get(appt.id))
  );

  // Fetch technician names in parallel
  const techIds = [...technicianAppointments.keys()];
  const techNameMap = new Map<string, string>();
  if (deps.getTechnicianName) {
    const nameResults = await Promise.all(
      techIds.map((id) => deps.getTechnicianName!(id).then((name) => ({ id, name })))
    );
    for (const { id, name } of nameResults) {
      techNameMap.set(id, name);
    }
  }

  // Build technician lanes
  const lanes: TechnicianLane[] = [];
  for (const [techId, items] of technicianAppointments) {
    const techName = techNameMap.get(techId) ?? techId;

    const laneAppointments: BoardAppointment[] = items.map(({ appointment }) =>
      toBoardAppointment(appointment, displayContextMap.get(appointment.id), techId, techName)
    );

    const lane: TechnicianLane = {
      technicianId: techId,
      technicianName: techName,
      appointments: laneAppointments.sort(
        (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime()
      ),
    };

    // Add availability summary if repos provided
    if (deps.workingHoursRepo) {
      const dayOfWeek = start.getDay();
      const workingHours = await deps.workingHoursRepo.findByTechnicianAndDay(tenantId, techId, dayOfWeek);

      let unavailableBlocks: { start: string; end: string; reason?: string }[] = [];
      if (deps.unavailableBlockRepo) {
        const blocks = await deps.unavailableBlockRepo.findByTechnicianAndDateRange(tenantId, techId, start, end);
        unavailableBlocks = blocks.map((b) => ({
          start: toISOString(b.startTime),
          end: toISOString(b.endTime),
          reason: b.reason,
        }));
      }

      lane.availabilitySummary = {
        workingHours: workingHours && workingHours.isActive
          ? { start: workingHours.startTime, end: workingHours.endTime }
          : undefined,
        unavailableBlocks,
      };
    }

    lanes.push(lane);
  }

  return {
    date: dateStr,
    unassignedAppointments: unassignedBoard,
    technicianLanes: lanes,
    summary: computeSummary(unassignedBoard, lanes),
  };
}
