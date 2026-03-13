export type ConversationStatus = 'open' | 'closed' | 'archived';
export type MessageType = 'text' | 'transcript' | 'system_event' | 'note' | 'clarification' | 'proposal';

export interface Conversation {
  id: string;
  tenantId: string;
  title?: string;
  entityType?: string;
  entityId?: string;
  status: ConversationStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  tenantId: string;
  conversationId: string;
  messageType: MessageType;
  content?: string;
  senderId: string;
  senderRole: string;
  fileId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type TranscriptionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface VoiceRecording {
  id: string;
  tenantId: string;
  fileId: string;
  conversationId?: string;
  status: TranscriptionStatus;
  transcript?: string;
  transcriptMetadata?: Record<string, unknown>;
  durationSeconds?: number;
  errorMessage?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type Role = 'owner' | 'dispatcher' | 'technician';

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface Proposal {
  id: string;
  type: string;
  summary: string;
  status: ProposalStatus;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ClarificationRequest {
  id: string;
  question: string;
  options?: string[];
  taskId: string;
  resolved: boolean;
  response?: string;
}

export interface ContextEntity {
  type: string;
  id: string;
  label: string;
  details: Record<string, unknown>;
}

export type OperationState = 'pending' | 'in_progress' | 'success' | 'failure';

export interface OperationInfo {
  id: string;
  type: string;
  state: OperationState;
  errorMessage?: string;
  retryable: boolean;
}
