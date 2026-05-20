/** UI-compat job shapes (decoupled from mock-data). */

export type ServiceType = 'HVAC' | 'Plumbing' | 'Painting';
export type JobStatus =
  | 'New'
  | 'Scheduled'
  | 'Unscheduled'
  | 'Dispatched'
  | 'En Route'
  | 'On Site'
  | 'Active'
  | 'In Progress'
  | 'Waiting for Parts'
  | 'Day 2'
  | 'Completed'
  | 'Canceled'
  | 'No Show'
  | 'Pending';

export interface MaterialItem {
  id: string;
  name: string;
  qty: number;
  unitCost: number;
}

export interface JobActivity {
  id: string;
  type: string;
  time: string;
  note?: string;
  user?: string;
}

export interface Job {
  id: string;
  jobNumber: string;
  customer: string;
  customerId: string;
  address: string;
  serviceType: ServiceType;
  status: JobStatus;
  assignedTech?: string;
  scheduledDate?: string;
  scheduledTime?: string;
  description: string;
  priority?: 'Normal' | 'Urgent';
  notes?: string;
  photos?: number;
  estimateId?: string;
  invoiceId?: string;
  statusHistory: { status: string; time: string; note?: string }[];
  activity?: JobActivity[];
  materials?: MaterialItem[];
}

export interface Technician {
  id: string;
  name: string;
  color?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  serviceType: ServiceType;
  locations: Array<{
    id: string;
    nickname: string;
    address: string;
    serviceTypes: ServiceType[];
    isPrimary: boolean;
    jobCount?: number;
  }>;
  jobCount: number;
  openJobs: number;
}
