export type ServiceType = 'HVAC' | 'Plumbing' | 'Painting';
export type JobStatus = 'New' | 'Scheduled' | 'Unscheduled' | 'Dispatched' | 'En Route' | 'On Site' | 'Active' | 'In Progress' | 'Waiting for Parts' | 'Day 2' | 'Completed' | 'Canceled' | 'No Show' | 'Pending';
export type EstimateStatus = 'Draft' | 'Sent' | 'Viewed' | 'Approved' | 'Declined';
export type InvoiceStatus = 'Draft' | 'Sent' | 'Unpaid' | 'Paid' | 'Overdue';
export type ProposalType = 'Invoice' | 'Estimate' | 'Schedule' | 'Follow-up' | 'Alert' | 'Duplicate';
export type ProposalConfidence = 'High' | 'Medium';
export type LeadStatus = 'New' | 'Contacted' | 'Estimate Sent' | 'Won' | 'Lost';
export type LeadSource = 'Web Form' | 'Referral' | 'Google' | 'Yelp' | 'Facebook' | 'Nextdoor' | 'Phone';

export interface Lead {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  serviceType: ServiceType;
  description: string;
  status: LeadStatus;
  source: LeadSource;
  estimatedValue?: number;
  assignedTo?: string;
  createdAt: string;
  daysInStage: number;
  notes?: string;
  convertedJobId?: string;
  convertedEstimateId?: string;
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

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;           // primary location address (backwards compat)
  serviceType: ServiceType;  // primary service type (backwards compat)
  locations: ServiceLocation[];
  jobCount: number;
  openJobs: number;
  lastService?: string;
  notes?: string;
  tags?: string[];
  memberSince?: string;
  totalRevenue?: number;
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

export interface Estimate {
  id: string;
  estimateNumber: string;
  customer: string;
  customerId: string;
  description: string;
  lineItems: { description: string; qty: number; rate: number }[];
  status: EstimateStatus;
  createdDate: string;
  sentDate?: string;
  viewedDate?: string;
  approvedDate?: string;
  validUntil?: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customer: string;
  customerId: string;
  description: string;
  lineItems: { description: string; qty: number; rate: number }[];
  status: InvoiceStatus;
  dueDate?: string;
  sentDate?: string;
  paidDate?: string;
  jobId?: string;
}

export interface AIProposal {
  id: string;
  title: string;
  summary: string;
  explanation: string;
  reasoning?: string[];
  editFields?: { label: string; value: string; key: string }[];
  confidence: ProposalConfidence;
  type: ProposalType;
  status: 'Pending' | 'Approved' | 'Rejected';
  relatedId?: string;
  impact?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  time: string;
  inputMode?: 'text' | 'voice' | 'photo';
  voiceDuration?: number;
  attachments?: { type: 'photo' | 'document'; url?: string; name?: string }[];
  proposal?: AIProposal;
  autoApplied?: boolean;
  reasoning?: string;
}

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

export interface Technician {
  id: string;
  name: string;
  initials: string;
  color: string;
  phone: string;
  activeJobs: number;
}

// ─── Technicians ───────────────────────────────────────────────
export const technicians: Technician[] = [
  { id: 't1', name: 'Carlos Reyes', initials: 'CR', color: '#3B82F6', phone: '(512) 555-0101', activeJobs: 2 },
  { id: 't2', name: 'Marcus Webb', initials: 'MW', color: '#10B981', phone: '(512) 555-0142', activeJobs: 2 },
  { id: 't3', name: 'Sarah Lin', initials: 'SL', color: '#8B5CF6', phone: '(512) 555-0187', activeJobs: 1 },
];

// ─── Jobs ───────────────────────────────────────────────────────
export const jobs: Job[] = [
  {
    id: 'j1',
    jobNumber: '1042',
    customer: 'Roberto Rodriguez',
    customerId: 'c1',
    address: '412 Maple Drive, Austin TX',
    serviceType: 'HVAC',
    status: 'Active',
    assignedTech: 'Carlos Reyes',
    scheduledDate: 'Today',
    scheduledTime: '9:00 AM',
    description: 'AC unit not cooling. Compressor making noise.',
    priority: 'Normal',
    photos: 3,
    estimateId: 'e5',
    statusHistory: [
      { status: 'Created', time: '8:15 AM', note: 'Job created via assistant' },
      { status: 'Dispatched', time: '8:30 AM' },
      { status: 'On Site', time: '9:04 AM', note: 'Carlos checked in' },
    ],
    activity: [
      { id: 'j1-a1', type: 'system', content: 'Job created via Fieldly AI', time: '8:15 AM', authorInitials: 'AI', authorColor: '#6366f1' },
      { id: 'j1-a2', type: 'status_change', content: 'Dispatched to Carlos Reyes', time: '8:30 AM', author: 'Mike (owner)', authorInitials: 'MO', authorColor: '#475569' },
      { id: 'j1-a3', type: 'check_in', content: 'Carlos checked in on site', time: '9:04 AM', author: 'Carlos Reyes', authorInitials: 'CR', authorColor: '#3B82F6' },
      { id: 'j1-a4', type: 'photo', content: 'Before photos of AC unit and condenser added', time: '9:08 AM', author: 'Carlos Reyes', authorInitials: 'CR', authorColor: '#3B82F6' },
      { id: 'j1-a5', type: 'note', content: 'Compressor capacitor is blown — 45/5 MFD dual run. Checking stock on the truck before ordering.', time: '9:22 AM', author: 'Carlos Reyes', authorInitials: 'CR', authorColor: '#3B82F6' },
      { id: 'j1-a6', type: 'parts', content: 'Parts logged for repair', time: '9:24 AM', author: 'Carlos Reyes', authorInitials: 'CR', authorColor: '#3B82F6',
        parts: [
          { id: 'mp1', name: '45/5 MFD Dual Run Capacitor', partNumber: 'CAP-45-5-440V', qty: 1, unitCost: 28.50, category: 'Part' as const },
          { id: 'mp2', name: 'Contactor 40A 24V Coil', partNumber: 'CONT-2P-40A', qty: 1, unitCost: 22.00, category: 'Part' as const },
        ],
      },
      { id: 'j1-a7', type: 'voice', content: '"Contactor is pitted — recommending replacement while we\'re here. Customer approved the extra $85."', time: '9:31 AM', author: 'Carlos Reyes', authorInitials: 'CR', authorColor: '#3B82F6', voiceDuration: 18 },
    ],
    materials: [
      { id: 'mp1', name: '45/5 MFD Dual Run Capacitor', partNumber: 'CAP-45-5-440V', qty: 1, unitCost: 28.50, category: 'Part' as const },
      { id: 'mp2', name: 'Contactor 40A 24V Coil', partNumber: 'CONT-2P-40A', qty: 1, unitCost: 22.00, category: 'Part' as const },
    ],
    duplicateWarning: {
      matchJobId: 'j-archive',
      matchJobNumber: '1030',
      matchCustomer: 'Roberto Rodriguez',
      reason: 'Same customer · HVAC service · 3 weeks ago',
      similarity: 78,
    },
  },
  {
    id: 'j2',
    jobNumber: '1043',
    customer: 'Patricia Johnson',
    customerId: 'c2',
    address: '891 Oak Lane, Austin TX',
    serviceType: 'Plumbing',
    status: 'Scheduled',
    assignedTech: 'Marcus Webb',
    scheduledDate: 'Today',
    scheduledTime: '2:00 PM',
    description: 'Slow drain in master bath and kitchen sink.',
    priority: 'Normal',
    photos: 0,
    statusHistory: [
      { status: 'Created', time: 'Yesterday 4:22 PM' },
      { status: 'Scheduled', time: 'Yesterday 4:22 PM' },
    ],
  },
  {
    id: 'j3',
    jobNumber: '1041',
    customer: 'Elena Martinez',
    customerId: 'c5',
    address: '220 Cedar St, Austin TX',
    serviceType: 'Plumbing',
    status: 'Active',
    assignedTech: 'Marcus Webb',
    scheduledDate: 'Today',
    scheduledTime: '7:30 AM',
    description: 'Emergency pipe burst in utility room.',
    priority: 'Urgent',
    notes: 'Customer has water shutoff at main. Access code: 4812',
    photos: 5,
    statusHistory: [
      { status: 'Created', time: '7:10 AM', note: 'Emergency call' },
      { status: 'Dispatched', time: '7:12 AM' },
      { status: 'On Site', time: '7:28 AM' },
    ],
    activity: [
      { id: 'j3-a1', type: 'system', content: 'Emergency job created', time: '7:10 AM', authorInitials: 'AI', authorColor: '#6366f1' },
      { id: 'j3-a2', type: 'status_change', content: 'Emergency dispatch to Marcus Webb', time: '7:12 AM', author: 'Mike (owner)', authorInitials: 'MO', authorColor: '#475569' },
      { id: 'j3-a3', type: 'check_in', content: 'Marcus arrived on site', time: '7:28 AM', author: 'Marcus Webb', authorInitials: 'MW', authorColor: '#10B981' },
      { id: 'j3-a4', type: 'photo', content: '5 photos added – burst pipe and water damage in utility room', time: '7:35 AM', author: 'Marcus Webb', authorInitials: 'MW', authorColor: '#10B981' },
      { id: 'j3-a5', type: 'note', content: 'Main shutoff closed by customer. 2" copper pipe burst at 90° elbow joint. Drywall damage approx 2×3 ft — will need section repair after plumbing fix.', time: '7:40 AM', author: 'Marcus Webb', authorInitials: 'MW', authorColor: '#10B981' },
      { id: 'j3-a6', type: 'parts', content: 'Parts pulled from truck', time: '8:02 AM', author: 'Marcus Webb', authorInitials: 'MW', authorColor: '#10B981',
        parts: [
          { id: 'mq1', name: '2" Type L Copper Pipe (10ft)', partNumber: 'COP-2L-10', qty: 1, unitCost: 44.00, category: 'Material' as const },
          { id: 'mq2', name: '2" 90° Copper Elbow', partNumber: 'ELB-2-90', qty: 2, unitCost: 8.75, category: 'Part' as const },
          { id: 'mq3', name: 'Flux & Solder Kit', partNumber: 'FLUX-KIT', qty: 1, unitCost: 12.50, category: 'Material' as const },
        ],
      },
    ],
    materials: [
      { id: 'mq1', name: '2" Type L Copper Pipe (10ft)', partNumber: 'COP-2L-10', qty: 1, unitCost: 44.00, category: 'Material' as const },
      { id: 'mq2', name: '2" 90° Copper Elbow', partNumber: 'ELB-2-90', qty: 2, unitCost: 8.75, category: 'Part' as const },
      { id: 'mq3', name: 'Flux & Solder Kit', partNumber: 'FLUX-KIT', qty: 1, unitCost: 12.50, category: 'Material' as const },
    ],
  },
  {
    id: 'j4',
    jobNumber: '1044',
    customer: 'Michael Davis',
    customerId: 'c4',
    address: '35 Birch Blvd, Round Rock TX',
    serviceType: 'HVAC',
    status: 'Scheduled',
    assignedTech: 'Carlos Reyes',
    scheduledDate: 'Tomorrow',
    scheduledTime: '10:00 AM',
    description: 'Annual HVAC maintenance. Filter replacement + coil cleaning.',
    priority: 'Normal',
    photos: 0,
    estimateId: 'e2',
    statusHistory: [
      { status: 'Created', time: '2 days ago' },
      { status: 'Scheduled', time: '2 days ago' },
    ],
  },
  {
    id: 'j5',
    jobNumber: '1045',
    customer: 'James Thompson',
    customerId: 'c6',
    address: '1100 Elm Court, Austin TX',
    serviceType: 'Painting',
    status: 'Unscheduled',
    description: 'Exterior repaint – 2,400 sq ft. Customer wants Sherwin-Williams Alabaster.',
    priority: 'Normal',
    photos: 4,
    estimateId: 'e1',
    statusHistory: [
      { status: 'Created', time: '3 days ago', note: 'Estimate approved by customer' },
    ],
  },
  {
    id: 'j6',
    jobNumber: '1040',
    customer: 'Sarah Williams',
    customerId: 'c3',
    address: '78 Pine Street, Pflugerville TX',
    serviceType: 'Painting',
    status: 'Active',
    assignedTech: 'Sarah Lin',
    scheduledDate: 'Today',
    scheduledTime: '8:00 AM',
    description: 'Interior repaint – living room, dining room, hallway.',
    priority: 'Normal',
    photos: 6,
    invoiceId: 'i3',
    statusHistory: [
      { status: 'Created', time: 'Yesterday 9:00 AM' },
      { status: 'In Progress', time: 'Yesterday 9:30 AM' },
      { status: 'Day 2', time: 'Today 8:02 AM', note: 'Sarah checked in' },
    ],
  },
  {
    id: 'j7',
    jobNumber: '1039',
    customer: 'David Chen',
    customerId: 'c7',
    address: '540 Willow Way, Austin TX',
    serviceType: 'HVAC',
    status: 'Completed',
    assignedTech: 'Carlos Reyes',
    scheduledDate: 'Yesterday',
    scheduledTime: '11:00 AM',
    description: 'New AC unit installation – 3.5 ton Carrier.',
    priority: 'Normal',
    photos: 8,
    estimateId: 'e3',
    invoiceId: 'i1',
    statusHistory: [
      { status: 'Created', time: '4 days ago' },
      { status: 'On Site', time: 'Yesterday 11:05 AM' },
      { status: 'Completed', time: 'Yesterday 3:45 PM', note: 'Invoice created' },
    ],
  },
  {
    id: 'j8',
    jobNumber: '1046',
    customer: 'Linda Brown',
    customerId: 'c8',
    address: '302 Ash Ave, Cedar Park TX',
    serviceType: 'Plumbing',
    status: 'Scheduled',
    assignedTech: 'Sarah Lin',
    scheduledDate: 'Tomorrow',
    scheduledTime: '9:30 AM',
    description: 'Drain cleaning – kitchen and two bathrooms.',
    priority: 'Normal',
    photos: 0,
    estimateId: 'e4',
    statusHistory: [
      { status: 'Created', time: 'Today 10:00 AM' },
      { status: 'Scheduled', time: 'Today 10:05 AM' },
    ],
  },
  {
    id: 'j9',
    jobNumber: '1047',
    customer: 'Kevin Park',
    customerId: 'c9',
    address: '820 Summit Rd, Austin TX',
    serviceType: 'HVAC',
    status: 'Canceled',
    assignedTech: 'Carlos Reyes',
    scheduledDate: 'Today',
    scheduledTime: '11:00 AM',
    description: 'AC tune-up and filter replacement.',
    priority: 'Normal',
    photos: 0,
    cancelReason: 'Customer canceled – will reschedule next week',
    activity: [
      { id: 'j9-a1', type: 'status_change', content: 'Job scheduled with Carlos', time: 'Yesterday 2:00 PM', author: 'Mike (owner)', authorInitials: 'MO', authorColor: '#475569' },
      { id: 'j9-a2', type: 'system', content: 'Canceled: Customer canceled – will reschedule next week', time: 'Today 7:45 AM', author: 'Mike (owner)', authorInitials: 'MO', authorColor: '#ef4444' },
    ],
    statusHistory: [
      { status: 'Scheduled', time: 'Yesterday 2:00 PM' },
      { status: 'Canceled', time: 'Today 7:45 AM', note: 'Customer canceled – will reschedule next week' },
    ],
  },
  {
    id: 'j10',
    jobNumber: '1048',
    customer: 'Angela Foster',
    customerId: 'c10',
    address: '445 Riverside Dr, Austin TX',
    serviceType: 'Plumbing',
    status: 'No Show',
    assignedTech: 'Marcus Webb',
    scheduledDate: 'Today',
    scheduledTime: '10:00 AM',
    description: 'Water heater inspection and anode rod replacement.',
    priority: 'Normal',
    photos: 1,
    noShowNotes: 'Marcus arrived on time. Customer not home — no answer at door or phone after 20 minutes.',
    activity: [
      { id: 'j10-a1', type: 'status_change', content: 'Job scheduled with Marcus', time: 'Yesterday 3:30 PM', author: 'Mike (owner)', authorInitials: 'MO', authorColor: '#475569' },
      { id: 'j10-a2', type: 'check_in', content: 'Marcus arrived at the address', time: 'Today 9:58 AM', author: 'Marcus Webb', authorInitials: 'MW', authorColor: '#10B981' },
      { id: 'j10-a3', type: 'note', content: 'Knocked multiple times, no answer at door. Tried calling customer twice — no answer.', time: 'Today 10:12 AM', author: 'Marcus Webb', authorInitials: 'MW', authorColor: '#10B981' },
      { id: 'j10-a4', type: 'system', content: 'Marked no-show after 20 minute wait', time: 'Today 10:22 AM', author: 'Marcus Webb', authorInitials: 'MW', authorColor: '#f97316' },
    ],
    statusHistory: [
      { status: 'Scheduled', time: 'Yesterday 3:30 PM' },
      { status: 'No Show', time: 'Today 10:22 AM', note: 'Customer not home after 20 min' },
    ],
  },
];

// ─── Customers ──────────────────────────────────────────────────
export const customers: Customer[] = [
  {
    id: 'c1', name: 'Roberto Rodriguez', phone: '(512) 555-2201', email: 'roberto@email.com',
    address: '412 Maple Drive, Austin TX', serviceType: 'HVAC',
    jobCount: 5, openJobs: 1, lastService: 'Today',
    tags: ['Residential', 'Repeat'], memberSince: 'Jan 2023', totalRevenue: 2340,
    locations: [
      { id: 'c1-l1', nickname: 'Main Residence', address: '412 Maple Drive, Austin TX', serviceTypes: ['HVAC'], isPrimary: true, jobCount: 4, lastService: 'Today', notes: 'Ring doorbell twice. Side gate always open.', accessCode: 'Gate code: 4412' },
      { id: 'c1-l2', nickname: 'Rental Property', address: '7802 Bluebell Ln, Austin TX', serviceTypes: ['HVAC', 'Plumbing'], isPrimary: false, jobCount: 1, lastService: '3 months ago', notes: 'Contact tenant Maria (512-555-8801) before arrival.', accessCode: 'Lockbox: #2847' },
    ],
  },
  {
    id: 'c2', name: 'Patricia Johnson', phone: '(512) 555-3341', email: 'pjohnson@email.com',
    address: '891 Oak Lane, Austin TX', serviceType: 'Plumbing',
    jobCount: 3, openJobs: 1, lastService: '3 months ago',
    tags: ['Residential'], memberSince: 'Aug 2023', totalRevenue: 980,
    locations: [
      { id: 'c2-l1', nickname: 'Home', address: '891 Oak Lane, Austin TX', serviceTypes: ['Plumbing'], isPrimary: true, jobCount: 2, lastService: '3 months ago', notes: 'Dogs in backyard — open gate carefully.' },
      { id: 'c2-l2', nickname: "Mother's House", address: '204 Rosewood Dr, Austin TX', serviceTypes: ['Plumbing'], isPrimary: false, jobCount: 0, notes: 'Elderly resident — call Patricia 30 min before arrival.', accessCode: 'Hide-a-key under front mat' },
    ],
  },
  {
    id: 'c3', name: 'Sarah Williams', phone: '(737) 555-4412', email: 'swilliams@email.com',
    address: '78 Pine Street, Pflugerville TX', serviceType: 'Painting',
    jobCount: 1, openJobs: 1, lastService: 'Today',
    tags: ['Residential'], memberSince: 'Mar 2026', totalRevenue: 1850,
    locations: [
      { id: 'c3-l1', nickname: 'Home', address: '78 Pine Street, Pflugerville TX', serviceTypes: ['Painting'], isPrimary: true, jobCount: 1, lastService: 'Today', notes: 'Painting in progress — 3 rooms.' },
    ],
  },
  {
    id: 'c4', name: 'Michael Davis', phone: '(512) 555-6671', email: 'mdavis@email.com',
    address: '35 Birch Blvd, Round Rock TX', serviceType: 'HVAC',
    jobCount: 8, openJobs: 1, lastService: '6 months ago',
    notes: 'Annual maintenance contract. VIP.',
    tags: ['VIP', 'Commercial', 'Contract'], memberSince: 'Jun 2021', totalRevenue: 14200,
    locations: [
      { id: 'c4-l1', nickname: 'Residence', address: '35 Birch Blvd, Round Rock TX', serviceTypes: ['HVAC'], isPrimary: true, jobCount: 5, lastService: '6 months ago', notes: 'Annual contract — always priority scheduling.', accessCode: 'Smart lock: 8841' },
      { id: 'c4-l2', nickname: 'Downtown Office', address: '601 Congress Ave, Ste 200, Austin TX', serviceTypes: ['HVAC', 'Plumbing'], isPrimary: false, jobCount: 2, lastService: '2 months ago', notes: 'Bldg mgmt: Tom (512-555-4000). Sign in at lobby.', accessCode: 'Parking: Level B2, spot 14' },
      { id: 'c4-l3', nickname: 'Lake Property', address: '15 Lakeshore Cir, Lago Vista TX', serviceTypes: ['HVAC'], isPrimary: false, jobCount: 1, lastService: '8 months ago', notes: 'Seasonal — confirm access road before scheduling.', accessCode: 'Gate: LV-7721' },
    ],
  },
  {
    id: 'c5', name: 'Elena Martinez', phone: '(512) 555-9980', email: 'emartinez@email.com',
    address: '220 Cedar St, Austin TX', serviceType: 'Plumbing',
    jobCount: 1, openJobs: 1, lastService: 'Today',
    notes: 'Emergency call this morning.', tags: ['Residential'], memberSince: 'Mar 2026', totalRevenue: 385,
    locations: [
      { id: 'c5-l1', nickname: 'Home', address: '220 Cedar St, Austin TX', serviceTypes: ['Plumbing'], isPrimary: true, jobCount: 1, lastService: 'Today', notes: 'Water main shutoff is at front-left corner of yard.', accessCode: 'Access: 4812' },
    ],
  },
  {
    id: 'c6', name: 'James Thompson', phone: '(512) 555-1123', email: 'jthompson@email.com',
    address: '1100 Elm Court, Austin TX', serviceType: 'Painting',
    jobCount: 1, openJobs: 1, lastService: 'Pending',
    tags: ['Residential'], memberSince: 'Mar 2026', totalRevenue: 0,
    locations: [
      { id: 'c6-l1', nickname: 'Home', address: '1100 Elm Court, Austin TX', serviceTypes: ['Painting'], isPrimary: true, jobCount: 1, notes: 'Large corner lot. Parking in driveway.' },
    ],
  },
  {
    id: 'c7', name: 'David Chen', phone: '(512) 555-8845', email: 'dchen@email.com',
    address: '540 Willow Way, Austin TX', serviceType: 'HVAC',
    jobCount: 4, openJobs: 0, lastService: 'Yesterday',
    tags: ['Residential', 'Repeat'], memberSince: 'Nov 2022', totalRevenue: 7850,
    locations: [
      { id: 'c7-l1', nickname: 'Primary Home', address: '540 Willow Way, Austin TX', serviceTypes: ['HVAC'], isPrimary: true, jobCount: 3, lastService: 'Yesterday', notes: 'Prefers weekday mornings.' },
      { id: 'c7-l2', nickname: 'Vacation Cabin', address: '88 Creekview Rd, Wimberley TX', serviceTypes: ['HVAC', 'Plumbing'], isPrimary: false, jobCount: 1, lastService: '4 months ago', notes: 'Remote property — confirm road access before scheduling.', accessCode: 'Combo lock: 3-8-4-1' },
    ],
  },
  {
    id: 'c8', name: 'Linda Brown', phone: '(512) 555-6630', email: 'lbrown@email.com',
    address: '302 Ash Ave, Cedar Park TX', serviceType: 'Plumbing',
    jobCount: 2, openJobs: 1, lastService: '1 month ago',
    tags: ['Residential'], memberSince: 'May 2024', totalRevenue: 645,
    locations: [
      { id: 'c8-l1', nickname: 'Home', address: '302 Ash Ave, Cedar Park TX', serviceTypes: ['Plumbing'], isPrimary: true, jobCount: 2, lastService: '1 month ago' },
    ],
  },
  {
    id: 'c9', name: 'Kevin Park', phone: '(512) 555-7714', email: 'kpark@email.com',
    address: '820 Summit Rd, Austin TX', serviceType: 'HVAC',
    jobCount: 1, openJobs: 0, lastService: 'Today',
    tags: ['Residential'], memberSince: 'Feb 2026', totalRevenue: 0,
    locations: [
      { id: 'c9-l1', nickname: 'Home', address: '820 Summit Rd, Austin TX', serviceTypes: ['HVAC'], isPrimary: true, jobCount: 1, lastService: 'Today', notes: 'Cancellation today — rescheduling next week.' },
    ],
  },
  {
    id: 'c10', name: 'Angela Foster', phone: '(512) 555-4429', email: 'afoster@email.com',
    address: '445 Riverside Dr, Austin TX', serviceType: 'Plumbing',
    jobCount: 1, openJobs: 0, lastService: 'Today',
    tags: ['Residential'], memberSince: 'Jan 2026', totalRevenue: 0,
    locations: [
      { id: 'c10-l1', nickname: 'Home', address: '445 Riverside Dr, Austin TX', serviceTypes: ['Plumbing'], isPrimary: true, jobCount: 1, lastService: 'Today', notes: 'No-show today — follow up to reschedule.' },
    ],
  },
];

// ─── Estimates ──────────────────────────────────────────────────
export const estimates: Estimate[] = [
  {
    id: 'e1',
    estimateNumber: 'EST-0047',
    customer: 'James Thompson',
    customerId: 'c6',
    description: 'Exterior repaint – 2,400 sq ft',
    lineItems: [
      { description: 'Labor – exterior prep & painting', qty: 3, rate: 650 },
      { description: 'Sherwin-Williams Alabaster paint (5 gal)', qty: 4, rate: 62.50 },
      { description: 'Primer coat', qty: 1, rate: 180 },
    ],
    status: 'Approved',
    createdDate: '5 days ago',
    sentDate: '4 days ago',
    viewedDate: '4 days ago',
    approvedDate: '3 days ago',
    validUntil: 'Mar 24, 2026',
  },
  {
    id: 'e2',
    estimateNumber: 'EST-0046',
    customer: 'Michael Davis',
    customerId: 'c4',
    description: 'Full HVAC system replacement – 4-ton unit',
    lineItems: [
      { description: 'Carrier 4-ton AC unit', qty: 1, rate: 2800 },
      { description: 'Installation labor', qty: 1, rate: 950 },
      { description: 'Refrigerant charge', qty: 1, rate: 320 },
      { description: 'Permit & inspection', qty: 1, rate: 150 },
    ],
    status: 'Sent',
    createdDate: '3 days ago',
    sentDate: '3 days ago',
    validUntil: 'Mar 24, 2026',
  },
  {
    id: 'e3',
    estimateNumber: 'EST-0044',
    customer: 'David Chen',
    customerId: 'c7',
    description: 'New AC installation – 3.5 ton Carrier',
    lineItems: [
      { description: 'Carrier 3.5-ton AC unit', qty: 1, rate: 2200 },
      { description: 'Installation labor', qty: 1, rate: 850 },
    ],
    status: 'Approved',
    createdDate: '7 days ago',
    sentDate: '7 days ago',
    approvedDate: '5 days ago',
    validUntil: 'Mar 17, 2026',
  },
  {
    id: 'e4',
    estimateNumber: 'EST-0048',
    customer: 'Linda Brown',
    customerId: 'c8',
    description: 'Drain cleaning – kitchen + 2 baths',
    lineItems: [
      { description: 'Drain cleaning service (per drain)', qty: 3, rate: 120 },
      { description: 'Bio-enzymatic treatment', qty: 1, rate: 45 },
    ],
    status: 'Draft',
    createdDate: 'Today',
    validUntil: 'Mar 24, 2026',
  },
  {
    id: 'e5',
    estimateNumber: 'EST-0045',
    customer: 'Roberto Rodriguez',
    customerId: 'c1',
    description: 'Thermostat upgrade + AC tune-up',
    lineItems: [
      { description: 'Nest Learning Thermostat', qty: 1, rate: 220 },
      { description: 'AC tune-up labor', qty: 1, rate: 120 },
      { description: 'Refrigerant top-off', qty: 1, rate: 85 },
    ],
    status: 'Viewed',
    createdDate: '2 days ago',
    sentDate: '2 days ago',
    viewedDate: 'Yesterday',
    validUntil: 'Mar 17, 2026',
  },
];

// ─── Invoices ───────────────────────────────────────────────────
export const invoices: Invoice[] = [
  {
    id: 'i1',
    invoiceNumber: 'INV-0089',
    customer: 'David Chen',
    customerId: 'c7',
    description: 'AC Installation – Job #1039',
    lineItems: [
      { description: 'Carrier 3.5-ton AC unit', qty: 1, rate: 2200 },
      { description: 'Installation labor', qty: 1, rate: 850 },
    ],
    status: 'Paid',
    dueDate: 'Mar 8, 2026',
    sentDate: 'Yesterday',
    paidDate: 'Today 7:42 AM',
    jobId: 'j7',
  },
  {
    id: 'i2',
    invoiceNumber: 'INV-0087',
    customer: 'Roberto Rodriguez',
    customerId: 'c1',
    description: 'AC Tune-Up & Thermostat – Job #1042',
    lineItems: [
      { description: 'Nest Learning Thermostat install', qty: 1, rate: 220 },
      { description: 'AC tune-up labor', qty: 1, rate: 120 },
      { description: 'Refrigerant top-off', qty: 1, rate: 85 },
    ],
    status: 'Unpaid',
    dueDate: 'Mar 17, 2026',
    sentDate: '2 days ago',
    jobId: 'j1',
  },
  {
    id: 'i3',
    invoiceNumber: 'INV-0088',
    customer: 'Sarah Williams',
    customerId: 'c3',
    description: 'Interior Paint – Job #1040',
    lineItems: [
      { description: 'Labor – interior painting (3 rooms)', qty: 2, rate: 620 },
      { description: 'Paint & supplies', qty: 1, rate: 380 },
      { description: 'Prep & tape labor', qty: 1, rate: 230 },
    ],
    status: 'Draft',
    jobId: 'j6',
  },
  {
    id: 'i4',
    invoiceNumber: 'INV-0086',
    customer: 'Patricia Johnson',
    customerId: 'c2',
    description: 'Plumbing – Slow Drain Service',
    lineItems: [
      { description: 'Drain cleaning (2 drains)', qty: 2, rate: 120 },
      { description: 'Service call fee', qty: 1, rate: 85 },
    ],
    status: 'Overdue',
    dueDate: 'Mar 3, 2026',
    sentDate: '10 days ago',
    jobId: 'j2',
  },
];

// ─── AI Proposals ───────────────────────────────────────────────
export const aiProposals: AIProposal[] = [
  {
    id: 'p1',
    title: 'Invoice ready for Williams job',
    summary: 'Job #1040 (Sarah Williams – Interior Paint) appears complete. Draft invoice INV-0088 is ready to review and send.',
    explanation: 'Sarah Lin marked the job as Day 2 complete this morning. Total is $1,850.',
    confidence: 'High',
    type: 'Invoice',
    status: 'Pending',
    relatedId: 'i3',
  },
  {
    id: 'p2',
    title: 'Follow-up: Davis estimate unopened',
    summary: 'EST-0046 sent to Michael Davis 3 days ago and hasn\'t been viewed yet. A follow-up message may help.',
    explanation: 'This estimate is for $4,220. Davis is a repeat customer.',
    confidence: 'High',
    type: 'Follow-up',
    status: 'Pending',
    relatedId: 'e2',
  },
  {
    id: 'p3',
    title: 'Johnson invoice overdue – send reminder',
    summary: 'INV-0086 ($325) for Patricia Johnson is 7 days overdue. Suggest sending a payment reminder.',
    explanation: 'Due date was Mar 3. No payment received.',
    confidence: 'High',
    type: 'Alert',
    status: 'Pending',
    relatedId: 'i4',
  },
  {
    id: 'p4',
    title: 'Schedule Thompson exterior paint job',
    summary: 'EST-0047 was approved 3 days ago. Job #1045 is still unscheduled. Ready to assign and schedule?',
    explanation: 'Sarah Lin has availability Thursday and Friday this week.',
    confidence: 'Medium',
    type: 'Schedule',
    status: 'Pending',
    relatedId: 'j5',
  },
];

// ─── Conversation Messages ───────────────────────────────────────
export const initialMessages: Message[] = [
  {
    id: 'm1',
    role: 'assistant',
    content: 'Good morning, Mike. You have 3 active jobs today and 2 items that need your attention. Want a quick rundown?',
    time: '8:00 AM',
  },
  {
    id: 'm2',
    role: 'user',
    content: 'Yeah go ahead',
    time: '8:02 AM',
  },
  {
    id: 'm3',
    role: 'assistant',
    content: 'Here\'s your morning summary:\n\n• Marcus is on-site at the Martinez emergency (pipe burst on Cedar St) — going well.\n• Carlos checked in at Rodriguez at 9:04 AM for the AC job.\n• Patricia Johnson is scheduled for 2pm with Marcus.\n\nAlso — the Williams interior paint job is wrapping up today. Want me to get that invoice ready?',
    time: '8:02 AM',
  },
  {
    id: 'm4',
    role: 'user',
    content: 'Yes, create the invoice for the Williams job',
    time: '8:05 AM',
  },
  {
    id: 'm5',
    role: 'assistant',
    content: 'Got it. I\'ve drafted INV-0088 for the Williams interior paint job. Take a look:',
    time: '8:05 AM',
    proposal: {
      id: 'p1-conv',
      title: 'Create Invoice INV-0088 – Sarah Williams',
      summary: 'Interior paint job – 3 rooms. Total: $1,850.',
      explanation: 'Line items match the approved estimate plus two days of labor. Sending via SMS to (737) 555-4412.',
      confidence: 'High',
      type: 'Invoice',
      status: 'Pending',
      relatedId: 'i3',
    },
  },
  {
    id: 'm6',
    role: 'user',
    content: 'What about the Johnson plumbing job – is it still at 2pm?',
    time: '8:08 AM',
  },
  {
    id: 'm7',
    role: 'assistant',
    content: 'Yes, confirmed for 2:00 PM today with Marcus at 891 Oak Lane. I\'ll send Patricia a reminder text at 12:30 PM.',
    time: '8:08 AM',
    autoApplied: true,
  },
];

export function calcEstimateTotal(est: Estimate): number {
  return est.lineItems.reduce((s, i) => s + i.qty * i.rate, 0);
}

export function calcInvoiceTotal(inv: Invoice): number {
  return inv.lineItems.reduce((s, item) => s + item.qty * item.rate, 0);
}

export function calcMaterialsTotal(materials: MaterialItem[]): number {
  return materials.reduce((s, m) => s + m.qty * m.unitCost, 0);
}

// ─── Leads ──────────────────────────────────────────────────────
export const leads: Lead[] = [
  {
    id: 'lead-1',
    name: 'Sandra Wu',
    phone: '(512) 555-0191',
    email: 'swu@email.com',
    address: '4821 Burnet Rd, Austin TX',
    serviceType: 'HVAC',
    description: 'AC not cooling – 2,500 sqft home. Says it\'s been getting worse over 2 weeks.',
    status: 'New',
    source: 'Web Form',
    estimatedValue: 850,
    createdAt: 'Today 8:14 AM',
    daysInStage: 0,
  },
  {
    id: 'lead-2',
    name: 'Tom Nguyen',
    phone: '(512) 555-0234',
    email: 'tnguyen@mail.com',
    address: '2910 Manor Rd, Austin TX',
    serviceType: 'Plumbing',
    description: 'Water heater not producing hot water. 10-yr-old unit. Wants replacement quote.',
    status: 'New',
    source: 'Google',
    estimatedValue: 1400,
    createdAt: 'Today 6:55 AM',
    daysInStage: 0,
  },
  {
    id: 'lead-3',
    name: 'Brittany Campos',
    phone: '(512) 555-0482',
    serviceType: 'Painting',
    description: 'Full interior repaint, 3BR/2BA ranch home. Wants neutral palette throughout.',
    status: 'New',
    source: 'Nextdoor',
    estimatedValue: 3200,
    createdAt: 'Yesterday',
    daysInStage: 1,
  },
  {
    id: 'lead-4',
    name: 'Marcus Bell',
    phone: '(512) 555-0667',
    email: 'mbell@email.com',
    address: '309 W 5th St, Austin TX',
    serviceType: 'HVAC',
    description: 'Commercial space – HVAC not keeping up in server room. Needs inspection ASAP.',
    status: 'Contacted',
    source: 'Referral',
    estimatedValue: 2200,
    createdAt: '2 days ago',
    daysInStage: 1,
    notes: 'Called back yesterday. Wants estimate Thu or Fri this week.',
    assignedTo: 'Carlos Reyes',
  },
  {
    id: 'lead-5',
    name: 'Diane Fuller',
    phone: '(512) 555-0719',
    email: 'dfuller@email.com',
    address: '1805 Exposition Blvd, Austin TX',
    serviceType: 'Plumbing',
    description: 'Recurring slab leak – third time in 2 years. Looking for permanent fix.',
    status: 'Contacted',
    source: 'Phone',
    estimatedValue: 4800,
    createdAt: '3 days ago',
    daysInStage: 2,
    notes: 'Spoke with her this morning – very interested. Sending estimate today.',
    assignedTo: 'Marcus Webb',
  },
  {
    id: 'lead-6',
    name: 'Jerome Ellis',
    phone: '(512) 555-0885',
    email: 'jellis@email.com',
    address: '7700 Shoal Creek Blvd, Austin TX',
    serviceType: 'HVAC',
    description: 'Mini-split installation for garage conversion / home office.',
    status: 'Estimate Sent',
    source: 'Google',
    estimatedValue: 2600,
    createdAt: '5 days ago',
    daysInStage: 2,
    notes: 'EST-0049 sent Mar 8. Customer said they\'re comparing 2 quotes.',
    convertedEstimateId: 'e2',
  },
  {
    id: 'lead-7',
    name: 'Priya Anand',
    phone: '(512) 555-0991',
    email: 'panand@email.com',
    address: '512 Congress Ave, Austin TX',
    serviceType: 'Painting',
    description: 'Exterior paint + deck stain. Colonial-style home, approx 3,000 sqft.',
    status: 'Estimate Sent',
    source: 'Referral',
    estimatedValue: 5100,
    createdAt: '6 days ago',
    daysInStage: 3,
    notes: 'EST-0050 sent Mar 7. Viewed twice but no response yet. Follow-up due.',
  },
  {
    id: 'lead-8',
    name: 'Ray Hoffman',
    phone: '(512) 555-1042',
    serviceType: 'Plumbing',
    description: 'Water softener installation + whole-house filter.',
    status: 'Won',
    source: 'Yelp',
    estimatedValue: 1800,
    createdAt: '10 days ago',
    daysInStage: 0,
    convertedJobId: 'j8',
    notes: 'Approved estimate Mar 4. Job scheduled for next week.',
  },
  {
    id: 'lead-9',
    name: 'Carla Vega',
    phone: '(512) 555-1133',
    serviceType: 'HVAC',
    description: 'AC replacement quote – went with another provider on price.',
    status: 'Lost',
    source: 'Web Form',
    estimatedValue: 3400,
    createdAt: '14 days ago',
    daysInStage: 0,
    notes: 'Lost on price. Follow up in summer peak season.',
  },
];