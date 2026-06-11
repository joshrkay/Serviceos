import { z } from 'zod';

import { ProposalType } from '../enums.js';

export const JURISDICTION_FLAGS = [
  'requires_two_party_consent',
  'requires_recording_disclosure',
  'quiet_hours_restrictions',
  'dnc_screening_required',
] as const;
export type JurisdictionFlag = (typeof JURISDICTION_FLAGS)[number];

export const INTERACTION_TOOL_HOOKS = [
  'stt',
  'tts',
  'call_recording',
  'recording_disclosure',
  'consent_capture',
  'proposal_queue',
  'human_handoff',
  'dnc_lookup',
  'appointment_lookup',
  'customer_lookup',
  'invoice_lookup',
  'estimate_lookup',
  'job_lookup',
] as const;
export type InteractionToolHook = (typeof INTERACTION_TOOL_HOOKS)[number];

export const proposalTypeSchema = z.nativeEnum(ProposalType);

export const voiceAssistantContractSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  requiredToolsHooks: z.array(z.enum(INTERACTION_TOOL_HOOKS)).nonempty(),
  jurisdictionFlags: z.array(z.enum(JURISDICTION_FLAGS)),
  proposalTypes: z.array(proposalTypeSchema),
});

export interface VoiceAssistantContract {
  id: string;
  description: string;
  requiredToolsHooks: readonly InteractionToolHook[];
  jurisdictionFlags: readonly JurisdictionFlag[];
  proposalTypes: readonly ProposalType[];
}

const expectedInboundIds = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'] as const;
const expectedOutboundIds = ['VO1', 'VO2', 'VO3', 'VO4', 'VO5'] as const;

export const VOICE_INBOUND_ASSISTANTS = [
  { id: 'V1', description: 'New customer intake and contact capture.', requiredToolsHooks: ['stt', 'tts', 'customer_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['requires_recording_disclosure'], proposalTypes: [ProposalType.CREATE_CUSTOMER] },
  { id: 'V2', description: 'Existing customer profile update intake.', requiredToolsHooks: ['stt', 'tts', 'customer_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['requires_recording_disclosure'], proposalTypes: [ProposalType.UPDATE_CUSTOMER] },
  { id: 'V3', description: 'Job creation from inbound service request.', requiredToolsHooks: ['stt', 'tts', 'customer_lookup', 'job_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['requires_recording_disclosure'], proposalTypes: [ProposalType.CREATE_JOB] },
  { id: 'V4', description: 'Appointment scheduling and dispatch intake.', requiredToolsHooks: ['stt', 'tts', 'appointment_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['requires_recording_disclosure', 'quiet_hours_restrictions'], proposalTypes: [ProposalType.CREATE_APPOINTMENT] },
  { id: 'V5', description: 'Appointment updates (time-window/notes changes).', requiredToolsHooks: ['stt', 'tts', 'appointment_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['requires_recording_disclosure', 'quiet_hours_restrictions'], proposalTypes: [ProposalType.RESCHEDULE_APPOINTMENT] },
  { id: 'V6', description: 'Estimate draft intake from call details.', requiredToolsHooks: ['stt', 'tts', 'estimate_lookup', 'job_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['requires_recording_disclosure'], proposalTypes: [ProposalType.DRAFT_ESTIMATE, ProposalType.SEND_ESTIMATE] },
  { id: 'V7', description: 'Estimate revision/intake adjustments.', requiredToolsHooks: ['stt', 'tts', 'estimate_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['requires_recording_disclosure'], proposalTypes: [ProposalType.UPDATE_ESTIMATE] },
  { id: 'V8', description: 'Invoice drafting intake from completed work call.', requiredToolsHooks: ['stt', 'tts', 'invoice_lookup', 'job_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['requires_recording_disclosure'], proposalTypes: [ProposalType.DRAFT_INVOICE] },
  { id: 'V9', description: 'Low-confidence transcript clarification and routing.', requiredToolsHooks: ['stt', 'tts', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['requires_recording_disclosure'], proposalTypes: [] },
] as const satisfies readonly VoiceAssistantContract[];

export const VOICE_OUTBOUND_USE_CASES = [
  { id: 'VO1', description: 'Outbound appointment reminder call.', requiredToolsHooks: ['tts', 'appointment_lookup', 'dnc_lookup', 'call_recording', 'recording_disclosure'], jurisdictionFlags: ['dnc_screening_required', 'quiet_hours_restrictions'], proposalTypes: [] },
  { id: 'VO2', description: 'Outbound appointment reschedule workflow.', requiredToolsHooks: ['stt', 'tts', 'appointment_lookup', 'dnc_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['dnc_screening_required', 'quiet_hours_restrictions', 'requires_recording_disclosure'], proposalTypes: [ProposalType.RESCHEDULE_APPOINTMENT] },
  { id: 'VO3', description: 'Outbound cancellation confirmation.', requiredToolsHooks: ['stt', 'tts', 'appointment_lookup', 'dnc_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['dnc_screening_required', 'requires_recording_disclosure'], proposalTypes: [ProposalType.CANCEL_APPOINTMENT] },
  { id: 'VO4', description: 'Outbound technician reassignment notice.', requiredToolsHooks: ['stt', 'tts', 'appointment_lookup', 'dnc_lookup', 'proposal_queue', 'human_handoff'], jurisdictionFlags: ['dnc_screening_required', 'requires_recording_disclosure'], proposalTypes: [ProposalType.REASSIGN_APPOINTMENT] },
  { id: 'VO5', description: 'Outbound invoice follow-up and payment reminder.', requiredToolsHooks: ['stt', 'tts', 'invoice_lookup', 'dnc_lookup', 'human_handoff'], jurisdictionFlags: ['dnc_screening_required', 'requires_recording_disclosure', 'quiet_hours_restrictions'], proposalTypes: [] },
] as const satisfies readonly VoiceAssistantContract[];

export function assertRegistryIntegrity<T extends { id: string; proposalTypes: readonly ProposalType[] }>(
  registryName: string,
  rows: readonly T[],
  expectedIds: readonly string[],
): void {
  const ids = rows.map((r) => r.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) throw new Error(`${registryName}: duplicate IDs detected`);
  for (const id of expectedIds) if (!idSet.has(id)) throw new Error(`${registryName}: missing required ID ${id}`);

  for (const row of rows) {
    voiceAssistantContractSchema.extend({ requiredToolsHooks: z.array(z.enum(INTERACTION_TOOL_HOOKS)) }).parse(row);
    const proposalSet = new Set(row.proposalTypes);
    if (proposalSet.size !== row.proposalTypes.length) {
      throw new Error(`${registryName}: duplicate proposal type in ${row.id}`);
    }
  }
}

assertRegistryIntegrity('VOICE_INBOUND_ASSISTANTS', VOICE_INBOUND_ASSISTANTS, expectedInboundIds);
assertRegistryIntegrity('VOICE_OUTBOUND_USE_CASES', VOICE_OUTBOUND_USE_CASES, expectedOutboundIds);
