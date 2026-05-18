import { z } from 'zod';

import { ProposalType } from '../enums.js';
import {
  assertRegistryIntegrity,
  JURISDICTION_FLAGS,
  INTERACTION_TOOL_HOOKS,
  type JurisdictionFlag,
  type InteractionToolHook,
} from './voice-assistants.js';

export interface EmailTemplateContract {
  id: string;
  description: string;
  requiredToolsHooks: readonly InteractionToolHook[];
  jurisdictionFlags: readonly JurisdictionFlag[];
  proposalTypes: readonly ProposalType[];
}

const expectedEmailIds = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9'] as const;

const emailTemplateContractSchema = z.object({
  id: z.string().regex(/^E\d+$/),
  description: z.string().min(1),
  requiredToolsHooks: z.array(z.enum(INTERACTION_TOOL_HOOKS)).nonempty(),
  jurisdictionFlags: z.array(z.enum(JURISDICTION_FLAGS)),
  proposalTypes: z.array(z.nativeEnum(ProposalType)),
});

export const EMAIL_TEMPLATES = [
  { id: 'E1', description: 'Proposal digest email for supervisor.', requiredToolsHooks: ['proposal_queue'], jurisdictionFlags: [], proposalTypes: [ProposalType.CREATE_CUSTOMER, ProposalType.UPDATE_CUSTOMER, ProposalType.CREATE_JOB, ProposalType.CREATE_APPOINTMENT, ProposalType.DRAFT_ESTIMATE, ProposalType.UPDATE_ESTIMATE, ProposalType.DRAFT_INVOICE, ProposalType.REASSIGN_APPOINTMENT, ProposalType.RESCHEDULE_APPOINTMENT, ProposalType.CANCEL_APPOINTMENT] },
  { id: 'E2', description: 'New customer welcome follow-up.', requiredToolsHooks: ['customer_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.CREATE_CUSTOMER] },
  { id: 'E3', description: 'Customer profile change summary.', requiredToolsHooks: ['customer_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.UPDATE_CUSTOMER] },
  { id: 'E4', description: 'New job request summary.', requiredToolsHooks: ['job_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.CREATE_JOB] },
  { id: 'E5', description: 'Appointment scheduling confirmation.', requiredToolsHooks: ['appointment_lookup'], jurisdictionFlags: ['quiet_hours_restrictions'], proposalTypes: [ProposalType.CREATE_APPOINTMENT, ProposalType.RESCHEDULE_APPOINTMENT] },
  { id: 'E6', description: 'Appointment cancellation confirmation.', requiredToolsHooks: ['appointment_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.CANCEL_APPOINTMENT] },
  { id: 'E7', description: 'Technician reassignment confirmation.', requiredToolsHooks: ['appointment_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.REASSIGN_APPOINTMENT] },
  { id: 'E8', description: 'Estimate draft/revision ready email.', requiredToolsHooks: ['estimate_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.DRAFT_ESTIMATE, ProposalType.UPDATE_ESTIMATE] },
  { id: 'E9', description: 'Invoice draft ready email.', requiredToolsHooks: ['invoice_lookup'], jurisdictionFlags: [], proposalTypes: [ProposalType.DRAFT_INVOICE] },
] as const satisfies readonly EmailTemplateContract[];

for (const row of EMAIL_TEMPLATES) emailTemplateContractSchema.parse(row);
assertRegistryIntegrity('EMAIL_TEMPLATES', EMAIL_TEMPLATES, expectedEmailIds);
