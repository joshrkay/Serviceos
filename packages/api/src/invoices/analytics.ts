import { v4 as uuidv4 } from 'uuid';

// ─── P5-013A: Time-to-cash event model ───

export type TimeToCashMilestone =
  | 'job_completed'
  | 'invoice_drafted'
  | 'invoice_approved'
  | 'invoice_issued'
  | 'payment_ready'
  | 'first_payment'
  | 'fully_paid';

export const VALID_MILESTONES: TimeToCashMilestone[] = [
  'job_completed',
  'invoice_drafted',
  'invoice_approved',
  'invoice_issued',
  'payment_ready',
  'first_payment',
  'fully_paid',
];

export interface TimeToCashEvent {
  id: string;
  tenantId: string;
  jobId: string;
  invoiceId?: string;
  milestone: TimeToCashMilestone;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateTimeToCashEventInput {
  tenantId: string;
  jobId: string;
  invoiceId?: string;
  milestone: TimeToCashMilestone;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

export interface TimeToCashEventRepository {
  create(event: TimeToCashEvent): Promise<TimeToCashEvent>;
  findByJob(tenantId: string, jobId: string): Promise<TimeToCashEvent[]>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<TimeToCashEvent[]>;
}

export function validateTimeToCashEventInput(input: CreateTimeToCashEventInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.jobId) errors.push('jobId is required');
  if (!input.milestone) {
    errors.push('milestone is required');
  } else if (!VALID_MILESTONES.includes(input.milestone)) {
    errors.push('Invalid milestone');
  }
  if (!input.occurredAt) errors.push('occurredAt is required');
  return errors;
}

export async function createTimeToCashEvent(
  input: CreateTimeToCashEventInput,
  repository: TimeToCashEventRepository
): Promise<TimeToCashEvent> {
  const event: TimeToCashEvent = {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    invoiceId: input.invoiceId,
    milestone: input.milestone,
    occurredAt: input.occurredAt,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  return repository.create(event);
}

export async function captureTimeToCashMilestone(
  tenantId: string,
  jobId: string,
  invoiceId: string | undefined,
  milestone: TimeToCashMilestone,
  repository: TimeToCashEventRepository
): Promise<TimeToCashEvent> {
  return createTimeToCashEvent(
    { tenantId, jobId, invoiceId, milestone, occurredAt: new Date() },
    repository
  );
}

export class InMemoryTimeToCashEventRepository implements TimeToCashEventRepository {
  private events: TimeToCashEvent[] = [];

  async create(event: TimeToCashEvent): Promise<TimeToCashEvent> {
    this.events.push({ ...event });
    return { ...event };
  }

  async findByJob(tenantId: string, jobId: string): Promise<TimeToCashEvent[]> {
    return this.events
      .filter((e) => e.tenantId === tenantId && e.jobId === jobId)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<TimeToCashEvent[]> {
    return this.events
      .filter((e) => e.tenantId === tenantId && e.invoiceId === invoiceId)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
}

// ─── P5-012A: Invoice quality metric model ───

export interface InvoiceQualityMetrics {
  approvalRate: number;
  rejectionRate: number;
  approvedWithEditsRate: number;
  editRate: number;
  averageRevisions: number;
  commonCorrections: { field: string; frequency: number; averageDelta?: number }[];
}

export function computeInvoiceQualityMetrics(
  outcomes: { status: string; approvedWithEdits: boolean }[],
  deltas: { deltas: { type: string; field?: string; oldValue?: unknown; newValue?: unknown }[] }[]
): InvoiceQualityMetrics {
  const total = outcomes.length;
  if (total === 0) {
    return {
      approvalRate: 0, rejectionRate: 0, approvedWithEditsRate: 0,
      editRate: 0, averageRevisions: 0, commonCorrections: [],
    };
  }

  const approved = outcomes.filter((o) => o.status === 'approved' || o.status === 'approved_with_edits').length;
  const rejected = outcomes.filter((o) => o.status === 'rejected').length;
  const withEdits = outcomes.filter((o) => o.approvedWithEdits).length;
  const edited = deltas.filter((d) => d.deltas.length > 0).length;

  // Field frequency analysis
  const fieldFreq = new Map<string, { count: number; deltas: number[] }>();
  for (const delta of deltas) {
    for (const entry of delta.deltas) {
      const field = entry.field || entry.type;
      const existing = fieldFreq.get(field) || { count: 0, deltas: [] };
      existing.count++;
      if (typeof entry.oldValue === 'number' && typeof entry.newValue === 'number') {
        existing.deltas.push(Math.abs(entry.newValue - entry.oldValue));
      }
      fieldFreq.set(field, existing);
    }
  }

  const commonCorrections = Array.from(fieldFreq.entries())
    .map(([field, data]) => ({
      field,
      frequency: data.count,
      ...(data.deltas.length > 0
        ? { averageDelta: data.deltas.reduce((a, b) => a + b, 0) / data.deltas.length }
        : {}),
    }))
    .sort((a, b) => b.frequency - a.frequency);

  return {
    approvalRate: approved / total,
    rejectionRate: rejected / total,
    approvedWithEditsRate: withEdits / total,
    editRate: edited / Math.max(deltas.length, 1),
    averageRevisions: deltas.length / total,
    commonCorrections,
  };
}

// ─── P5-012B: Invoice proposal outcome analytics records ───

export interface InvoiceProposalOutcomeRecord {
  id: string;
  tenantId: string;
  proposalId: string;
  invoiceId: string;
  outcome: string;
  editedFields: string[];
  confidenceScore?: number;
  createdAt: Date;
}

export interface InvoiceProposalOutcomeRepository {
  create(record: InvoiceProposalOutcomeRecord): Promise<InvoiceProposalOutcomeRecord>;
  findByTenant(tenantId: string): Promise<InvoiceProposalOutcomeRecord[]>;
}

export async function recordInvoiceProposalOutcome(
  tenantId: string,
  proposalId: string,
  invoiceId: string,
  outcome: string,
  editedFields: string[],
  confidenceScore: number | undefined,
  repository: InvoiceProposalOutcomeRepository
): Promise<InvoiceProposalOutcomeRecord> {
  const record: InvoiceProposalOutcomeRecord = {
    id: uuidv4(),
    tenantId,
    proposalId,
    invoiceId,
    outcome,
    editedFields,
    confidenceScore,
    createdAt: new Date(),
  };
  return repository.create(record);
}

export class InMemoryInvoiceProposalOutcomeRepository implements InvoiceProposalOutcomeRepository {
  private records: InvoiceProposalOutcomeRecord[] = [];

  async create(record: InvoiceProposalOutcomeRecord): Promise<InvoiceProposalOutcomeRecord> {
    this.records.push({ ...record });
    return { ...record };
  }

  async findByTenant(tenantId: string): Promise<InvoiceProposalOutcomeRecord[]> {
    return this.records.filter((r) => r.tenantId === tenantId).map((r) => ({ ...r }));
  }
}

// ─── P5-015: Invoice-acceleration beta benchmark ───

export interface InvoiceBenchmark {
  manualAverageTimeToCashMs: number;
  aiAssistedAverageTimeToCashMs: number;
  improvementPercent: number;
  sampleSize: number;
  period: { start: Date; end: Date };
}

export function computeInvoiceBenchmark(
  timeToCashEvents: TimeToCashEvent[],
  provenanceRecords: { invoiceId: string; sourceType: string }[],
  period: { start: Date; end: Date }
): InvoiceBenchmark {
  // Build set of AI-generated invoice IDs
  const aiInvoiceIds = new Set(
    provenanceRecords
      .filter((p) => p.sourceType !== 'manual')
      .map((p) => p.invoiceId)
  );

  // Group events by jobId
  const jobEvents = new Map<string, TimeToCashEvent[]>();
  for (const event of timeToCashEvents) {
    if (event.occurredAt < period.start || event.occurredAt > period.end) continue;
    const existing = jobEvents.get(event.jobId) || [];
    existing.push(event);
    jobEvents.set(event.jobId, existing);
  }

  const manualTimes: number[] = [];
  const aiTimes: number[] = [];

  for (const [, events] of jobEvents) {
    const jobCompleted = events.find((e) => e.milestone === 'job_completed');
    const fullyPaid = events.find((e) => e.milestone === 'fully_paid');
    if (!jobCompleted || !fullyPaid) continue;

    const timeToCashMs = fullyPaid.occurredAt.getTime() - jobCompleted.occurredAt.getTime();
    if (timeToCashMs < 0) continue;

    const isAi = events.some((e) => e.invoiceId && aiInvoiceIds.has(e.invoiceId));
    if (isAi) {
      aiTimes.push(timeToCashMs);
    } else {
      manualTimes.push(timeToCashMs);
    }
  }

  const avgManual = manualTimes.length > 0
    ? manualTimes.reduce((a, b) => a + b, 0) / manualTimes.length
    : 0;
  const avgAi = aiTimes.length > 0
    ? aiTimes.reduce((a, b) => a + b, 0) / aiTimes.length
    : 0;
  const improvement = avgManual > 0 ? ((avgManual - avgAi) / avgManual) * 100 : 0;

  return {
    manualAverageTimeToCashMs: avgManual,
    aiAssistedAverageTimeToCashMs: avgAi,
    improvementPercent: improvement,
    sampleSize: manualTimes.length + aiTimes.length,
    period,
  };
}
