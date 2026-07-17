/**
 * UI-compat job / billing status shapes used by operator surfaces.
 * Decoupled from any fixture data — production fetches live API payloads
 * and maps them into these view models where needed.
 */

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
  | 'Invoiced'
  | 'Closed'
  | 'Canceled'
  | 'No Show'
  | 'Pending';

export type EstimateStatus =
  | 'Draft'
  | 'Sent'
  | 'Viewed'
  | 'Approved'
  | 'Declined'
  | 'Expired';

export type InvoiceStatus =
  | 'Draft'
  | 'Sent'
  | 'Unpaid'
  | 'Paid'
  | 'Overdue'
  | 'Canceled';

export interface MaterialItem {
  id: string;
  name: string;
  partNumber?: string;
  qty: number;
  unitCost: number;
  category: 'Part' | 'Material' | 'Labor' | 'Equipment';
}

export interface JobActivity {
  id: string;
  type: 'status_change' | 'check_in' | 'note' | 'photo' | 'voice' | 'parts' | 'system';
  content: string;
  author?: string;
  authorInitials?: string;
  authorColor?: string;
  time: string;
  voiceDuration?: number;
  parts?: MaterialItem[];
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
  cancelReason?: string;
  noShowNotes?: string;
  duplicateWarning?: {
    matchJobId: string;
    matchJobNumber: string;
    matchCustomer: string;
    reason: string;
    similarity: number;
  };
}

export interface Technician {
  id: string;
  name: string;
  initials: string;
  color: string;
  phone: string;
  activeJobs: number;
}

export interface ServiceLocation {
  id: string;
  nickname: string;
  address: string;
  serviceTypes: ServiceType[];
  notes?: string;
  accessCode?: string;
  isPrimary: boolean;
  jobCount: number;
  lastService?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  serviceType: ServiceType;
  locations: ServiceLocation[];
  jobCount: number;
  openJobs: number;
  lastService?: string;
  notes?: string;
  tags?: string[];
  memberSince?: string;
  totalRevenue?: number;
}
