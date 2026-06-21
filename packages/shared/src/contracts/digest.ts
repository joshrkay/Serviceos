/**
 * P5-020 — End-of-day digest: shared types.
 */
export type DigestStatus = 'pending' | 'delivered' | 'failed' | 'acked';

export interface DigestSourceData {
  completedJobIds: string[];
  sentEstimateIds: string[];
  followUpInvoiceIds: string[];
  tomorrowAppointmentIds: string[];
  uncertainProposalIds: string[];
  correctionChunkIds: string[];
  // N-009 / P2-038 — correction-loop lessons applied today (one digest line
  // each), surfaced in "what I learned today". Optional for back-compat with
  // digest rows persisted before this field existed.
  correctionLessonIds?: string[];
}

export interface DigestSection {
  label: string;
  lines: string[];
}

export interface DigestEntry {
  id: string;
  tenantId: string;
  date: string; // YYYY-MM-DD
  status: DigestStatus;
  attemptCount: number;
  renderedText: string;
  sourceData: DigestSourceData;
  deliveredAt?: Date;
  ownerReply?: string;
  createdAt: Date;
  updatedAt: Date;
}
