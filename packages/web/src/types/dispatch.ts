import { AppointmentCardData } from '../components/dispatch/AppointmentCard';

export interface TechnicianLaneData {
  technicianId: string;
  technicianName: string;
  appointments: AppointmentCardData[];
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
  unassignedAppointments: AppointmentCardData[];
  technicianLanes: TechnicianLaneData[];
  summary: BoardSummary;
}
