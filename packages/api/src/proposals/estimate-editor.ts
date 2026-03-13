import { Proposal, ProposalRepository } from './proposal';
import { validateProposalPayload } from './contracts';
import { ValidationError } from '../shared/errors';

export const ALLOWED_WORDING_FIELDS = [
  'title', 'description', 'summary', 'notes', 'terms', 'disclaimer', 'headerText', 'footerText',
];

export interface EstimateLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  category?: string;
}

export interface EstimateEditAction {
  type: 'update_line_item' | 'add_line_item' | 'remove_line_item' | 'update_notes' | 'update_wording';
  index?: number; // for update/remove
  lineItem?: EstimateLineItem; // for add/update
  notes?: string;
  field?: string;
  value?: string;
}

export function getEstimateLineItems(payload: Record<string, unknown>): EstimateLineItem[] {
  if (!payload.lineItems || !Array.isArray(payload.lineItems)) {
    return [];
  }
  return payload.lineItems as EstimateLineItem[];
}

export function calculateEstimateTotal(payload: Record<string, unknown>): number {
  const lineItems = getEstimateLineItems(payload);
  return lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}

export function editEstimateProposal(
  proposal: Proposal,
  actions: EstimateEditAction[]
): { updatedProposal: Proposal; editedFields: string[] } {
  if (proposal.proposalType !== 'draft_estimate') {
    throw new ValidationError('Can only edit draft_estimate proposals');
  }

  const editedFields: string[] = [];
  const payload: Record<string, unknown> = { ...proposal.payload };
  let lineItems = getEstimateLineItems(payload).map((item) => ({ ...item }));

  for (const action of actions) {
    switch (action.type) {
      case 'update_line_item': {
        if (action.index === undefined || action.index < 0 || action.index >= lineItems.length) {
          throw new ValidationError(`Invalid line item index: ${action.index}`);
        }
        if (!action.lineItem) {
          throw new ValidationError('lineItem is required for update_line_item');
        }
        validateLineItem(action.lineItem);
        lineItems[action.index] = { ...action.lineItem };
        editedFields.push(`lineItems[${action.index}]`);
        break;
      }
      case 'add_line_item': {
        if (!action.lineItem) {
          throw new ValidationError('lineItem is required for add_line_item');
        }
        validateLineItem(action.lineItem);
        lineItems.push({ ...action.lineItem });
        editedFields.push(`lineItems[${lineItems.length - 1}]`);
        break;
      }
      case 'remove_line_item': {
        if (action.index === undefined || action.index < 0 || action.index >= lineItems.length) {
          throw new ValidationError(`Invalid line item index: ${action.index}`);
        }
        lineItems.splice(action.index, 1);
        editedFields.push(`lineItems`);
        break;
      }
      case 'update_notes': {
        if (action.notes === undefined) {
          throw new ValidationError('notes is required for update_notes');
        }
        payload.notes = action.notes;
        editedFields.push('notes');
        break;
      }
      case 'update_wording': {
        if (!action.field || action.value === undefined) {
          throw new ValidationError('field and value are required for update_wording');
        }
        if (!ALLOWED_WORDING_FIELDS.includes(action.field)) {
          throw new ValidationError(
            `Field '${action.field}' is not allowed for update_wording. Allowed: ${ALLOWED_WORDING_FIELDS.join(', ')}`
          );
        }
        payload[action.field] = action.value;
        editedFields.push(action.field);
        break;
      }
    }
  }

  payload.lineItems = lineItems;

  const updatedProposal: Proposal = {
    ...proposal,
    payload,
    updatedAt: new Date(),
  };

  return { updatedProposal, editedFields };
}

function validateLineItem(item: EstimateLineItem): void {
  if (!item.description || typeof item.description !== 'string') {
    throw new ValidationError('Line item description is required');
  }
  if (typeof item.quantity !== 'number' || item.quantity < 0) {
    throw new ValidationError('Line item quantity must be a non-negative number');
  }
  if (typeof item.unitPrice !== 'number' || item.unitPrice < 0) {
    throw new ValidationError('Line item unitPrice must be a non-negative number');
  }
}
