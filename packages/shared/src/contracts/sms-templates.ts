import { z } from 'zod';

import { ProposalType } from '../enums.js';
import {
  assertRegistryIntegrity,
  JURISDICTION_FLAGS,
  INTERACTION_TOOL_HOOKS,
  type JurisdictionFlag,
  type InteractionToolHook,
} from './voice-assistants.js';

export interface SmsTemplateContract {
  id: string;
  description: string;
  requiredToolsHooks: readonly InteractionToolHook[];
  jurisdictionFlags: readonly JurisdictionFlag[];
  proposalTypes: readonly ProposalType[];
}

const expectedSmsIds = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'] as const;

const smsTemplateContractSchema = z.object({
  id: z.string().regex(/^S\d+$/),
  description: z.string().min(1),
  requiredToolsHooks: z.array(z.enum(INTERACTION_TOOL_HOOKS)).nonempty(),
  jurisdictionFlags: z.array(z.enum(JURISDICTION_FLAGS)),
  proposalTypes: z.array(z.nativeEnum(ProposalType)),
});

export const SMS_TEMPLATES = [
  { id: 'S1', description: 'Proposal ready for review alert.', requiredToolsHooks: ['proposal_queue'], jurisdictionFlags: [], proposalTypes: [ProposalType.CREATE_CUSTOMER, ProposalType.UPDATE_CUSTOMER, ProposalType.CREATE_JOB, ProposalType.CREATE_APPOINTMENT, ProposalType.UPDATE_APPOINTMENT, ProposalType.DRAFT_ESTIMATE, ProposalType.UPDATE_ESTIMATE, ProposalType.DRAFT_INVOICE, ProposalType.REASSIGN_APPOINTMENT, ProposalType.RESCHEDULE_APPOINTMENT, ProposalType.CANCEL_APPOINTMENT] },
  { id: 'S2', description: 'Appointment confirmation SMS.', requiredToolsHooks: ['appointment_lookup'], jurisdictionFlags: ['quiet_hours_restrictions'], proposalTypes: [ProposalType.CREATE_APPOINTMENT, ProposalType.UPDATE_APPOINTMENT] },
  { id: 'S3', description: 'Appointment reschedule request SMS.', requiredToolsHooks: ['appointment_lookup'], jurisdictionFlags: ['quiet_hours_restrictions'], proposalTypes: [ProposalType.RESCHEDULE_APPOINTMENT] },
  { id: 'S4', description: 'Appointment cancellation notice SMS.', requiredToolsHooks: ['appointment_lookup'], jurisdictionFlags: ['quiet_hours_restrictions'], proposalTypes: [ProposalType.CANCEL_APPOINTMENT] },
  { id: 'S5', description: 'Technician reassignment notice SMS.', requiredToolsHooks: ['appointment_lookup'], jurisdictionFlags: ['quiet_hours_restrictions'], proposalTypes: [ProposalType.REASSIGN_APPOINTMENT] },
  { id: 'S6', description: 'Estimate draft ready SMS.', requiredToolsHooks: ['estimate_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.DRAFT_ESTIMATE, ProposalType.UPDATE_ESTIMATE] },
  { id: 'S7', description: 'Invoice draft ready SMS.', requiredToolsHooks: ['invoice_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.DRAFT_INVOICE] },
  { id: 'S8', description: 'Need-more-info clarification SMS.', requiredToolsHooks: ['proposal_queue', 'human_handoff'], jurisdictionFlags: [], proposalTypes: [] },
  { id: 'S9', description: 'Customer creation confirmation SMS.', requiredToolsHooks: ['customer_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.CREATE_CUSTOMER] },
  { id: 'S10', description: 'Job creation confirmation SMS.', requiredToolsHooks: ['job_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.CREATE_JOB] },
] as const satisfies readonly SmsTemplateContract[];

for (const row of SMS_TEMPLATES) smsTemplateContractSchema.parse(row);
assertRegistryIntegrity('SMS_TEMPLATES', SMS_TEMPLATES, expectedSmsIds);
