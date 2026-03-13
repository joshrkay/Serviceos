import {
  editEstimateProposal,
  calculateEstimateTotal,
  getEstimateLineItems,
  EstimateEditAction,
} from '../../src/proposals/estimate-editor';
import { createProposal, Proposal, CreateProposalInput } from '../../src/proposals/proposal';
import { ValidationError } from '../../src/shared/errors';

function makeEstimateProposal(overrides?: Partial<Proposal>): Proposal {
  const input: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'draft_estimate',
    payload: {
      customerId: '550e8400-e29b-41d4-a716-446655440000',
      lineItems: [
        { description: 'Pipe repair', quantity: 2, unitPrice: 75.0, category: 'plumbing' },
        { description: 'Labor', quantity: 3, unitPrice: 50.0 },
      ],
      notes: 'Initial estimate',
    },
    summary: 'Estimate for plumbing work',
    createdBy: 'user-1',
  };
  const proposal = createProposal(input);
  if (overrides) {
    Object.assign(proposal, overrides);
  }
  return proposal;
}

describe('P2-017 — Estimate proposal review + inline edit workflow', () => {
  it('happy path — updates a line item', () => {
    const proposal = makeEstimateProposal();
    const actions: EstimateEditAction[] = [
      {
        type: 'update_line_item',
        index: 0,
        lineItem: { description: 'Pipe replacement', quantity: 1, unitPrice: 120.0, category: 'plumbing' },
      },
    ];

    const { updatedProposal, editedFields } = editEstimateProposal(proposal, actions);

    const lineItems = getEstimateLineItems(updatedProposal.payload);
    expect(lineItems[0].description).toBe('Pipe replacement');
    expect(lineItems[0].quantity).toBe(1);
    expect(lineItems[0].unitPrice).toBe(120.0);
    expect(editedFields).toContain('lineItems[0]');
    expect(updatedProposal.updatedAt.getTime()).toBeGreaterThanOrEqual(proposal.updatedAt.getTime());
  });

  it('happy path — adds a new line item', () => {
    const proposal = makeEstimateProposal();
    const actions: EstimateEditAction[] = [
      {
        type: 'add_line_item',
        lineItem: { description: 'Disposal fee', quantity: 1, unitPrice: 25.0 },
      },
    ];

    const { updatedProposal, editedFields } = editEstimateProposal(proposal, actions);

    const lineItems = getEstimateLineItems(updatedProposal.payload);
    expect(lineItems.length).toBe(3);
    expect(lineItems[2].description).toBe('Disposal fee');
    expect(editedFields).toContain('lineItems[2]');
  });

  it('happy path — removes a line item', () => {
    const proposal = makeEstimateProposal();
    const actions: EstimateEditAction[] = [
      { type: 'remove_line_item', index: 0 },
    ];

    const { updatedProposal, editedFields } = editEstimateProposal(proposal, actions);

    const lineItems = getEstimateLineItems(updatedProposal.payload);
    expect(lineItems.length).toBe(1);
    expect(lineItems[0].description).toBe('Labor');
    expect(editedFields).toContain('lineItems');
  });

  it('happy path — updates notes', () => {
    const proposal = makeEstimateProposal();
    const actions: EstimateEditAction[] = [
      { type: 'update_notes', notes: 'Updated estimate notes' },
    ];

    const { updatedProposal, editedFields } = editEstimateProposal(proposal, actions);

    expect(updatedProposal.payload.notes).toBe('Updated estimate notes');
    expect(editedFields).toContain('notes');
  });

  it('happy path — calculates estimate total', () => {
    const proposal = makeEstimateProposal();
    const total = calculateEstimateTotal(proposal.payload);

    // 2 * 75 + 3 * 50 = 150 + 150 = 300
    expect(total).toBe(300);
  });

  it('validation — rejects edit on non-estimate proposal', () => {
    const input: CreateProposalInput = {
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: { name: 'John Doe' },
      summary: 'Create customer',
      createdBy: 'user-1',
    };
    const proposal = createProposal(input);
    const actions: EstimateEditAction[] = [
      { type: 'update_notes', notes: 'Should fail' },
    ];

    expect(() => editEstimateProposal(proposal, actions)).toThrow(ValidationError);
  });

  it('validation — rejects invalid line item data', () => {
    const proposal = makeEstimateProposal();
    const actions: EstimateEditAction[] = [
      {
        type: 'add_line_item',
        lineItem: { description: '', quantity: 1, unitPrice: 50.0 },
      },
    ];

    expect(() => editEstimateProposal(proposal, actions)).toThrow(ValidationError);
  });

  it('mock provider test — tracks edited fields', () => {
    const proposal = makeEstimateProposal();
    const actions: EstimateEditAction[] = [
      {
        type: 'update_line_item',
        index: 1,
        lineItem: { description: 'Senior Labor', quantity: 4, unitPrice: 65.0 },
      },
      { type: 'update_notes', notes: 'Revised estimate' },
      {
        type: 'add_line_item',
        lineItem: { description: 'Parts', quantity: 5, unitPrice: 10.0 },
      },
    ];

    const { editedFields } = editEstimateProposal(proposal, actions);

    expect(editedFields).toContain('lineItems[1]');
    expect(editedFields).toContain('notes');
    expect(editedFields).toContain('lineItems[2]');
    expect(editedFields.length).toBe(3);
  });

  it('malformed AI output handled gracefully — handles missing lineItems', () => {
    const proposal = makeEstimateProposal({
      payload: { customerId: '550e8400-e29b-41d4-a716-446655440000' },
    });

    const lineItems = getEstimateLineItems(proposal.payload);
    expect(lineItems).toEqual([]);

    const total = calculateEstimateTotal(proposal.payload);
    expect(total).toBe(0);
  });

  it('security — update_wording rejects disallowed fields', () => {
    const proposal = makeEstimateProposal();

    expect(() =>
      editEstimateProposal(proposal, [
        { type: 'update_wording', field: 'id', value: 'injected-id' },
      ])
    ).toThrow('not allowed for update_wording');

    expect(() =>
      editEstimateProposal(proposal, [
        { type: 'update_wording', field: 'tenantId', value: 'injected-tenant' },
      ])
    ).toThrow('not allowed for update_wording');

    expect(() =>
      editEstimateProposal(proposal, [
        { type: 'update_wording', field: 'status', value: 'executed' },
      ])
    ).toThrow('not allowed for update_wording');
  });

  it('security — update_wording allows permitted fields', () => {
    const proposal = makeEstimateProposal();

    const { updatedProposal, editedFields } = editEstimateProposal(proposal, [
      { type: 'update_wording', field: 'title', value: 'Updated Title' },
      { type: 'update_wording', field: 'disclaimer', value: 'No warranty' },
    ]);

    expect(updatedProposal.payload.title).toBe('Updated Title');
    expect(updatedProposal.payload.disclaimer).toBe('No warranty');
    expect(editedFields).toContain('title');
    expect(editedFields).toContain('disclaimer');
  });
});
