/**
 * Service-address completion on the `create_customer` review card.
 *
 * A technician says "she's over at 1207 Riverbell Drive". `service_locations`
 * requires street1/city/state/postal_code NOT NULL, so that address cannot
 * become a location on its own — and before this card change it was silently
 * dropped on approval. The approver, who is already looking at the card, is
 * the one person who knows the city and the ZIP, so the card asks them.
 *
 * The two rules under test:
 *   1. the inputs appear ONLY when the address can't yet satisfy the table;
 *   2. approving with them blank is ALLOWED — the consequence is stated, not
 *      enforced. A dead Approve button on a job site is worse than an
 *      incomplete record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AIProposalCard } from './AIProposalCard';
import type { AIProposal } from '../../types/assistant-ui';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const navigateMock = vi.fn();
vi.mock('react-router', async (orig) => {
  const actual = await (orig() as Promise<typeof import('react-router')>);
  return { ...actual, useNavigate: () => navigateMock };
});

function customerProposal(overrides: Partial<AIProposal> = {}): AIProposal {
  return {
    id: 'prop-addr-1',
    title: 'New customer: Ashia Aksuna',
    summary: 'Name: Ashia Aksuna · Address: 1207 Riverbell Drive',
    explanation: 'From the inbound call.',
    confidence: 'Medium',
    type: 'Customer',
    status: 'Pending',
    proposalType: 'create_customer',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AIProposalCard — when the address inputs appear', () => {
  it('renders them for a street-only spoken address', () => {
    render(
      <AIProposalCard
        proposal={customerProposal({ addressCapture: { address: '1207 Riverbell Drive' } })}
      />,
    );
    expect(screen.getByTestId('address-completion')).toBeInTheDocument();
    expect(screen.getByTestId('address-verbatim')).toHaveTextContent('1207 Riverbell Drive');
  });

  it('renders NOTHING when the spoken address is already complete', () => {
    render(
      <AIProposalCard
        proposal={customerProposal({
          addressCapture: { address: '412 Oak Street, Scottsdale, AZ 85254' },
        })}
      />,
    );
    expect(screen.queryByTestId('address-completion')).toBeNull();
  });

  it('renders NOTHING when the structured fields are already filled in', () => {
    render(
      <AIProposalCard
        proposal={customerProposal({
          addressCapture: {
            address: '1207 Riverbell Drive',
            street1: '1207 Riverbell Drive',
            city: 'Scottsdale',
            state: 'AZ',
            postalCode: '85254',
          },
        })}
      />,
    );
    expect(screen.queryByTestId('address-completion')).toBeNull();
  });

  it('renders NOTHING when no address was captured at all', () => {
    render(<AIProposalCard proposal={customerProposal()} />);
    expect(screen.queryByTestId('address-completion')).toBeNull();
  });

  it('renders NOTHING on a proposal type that carries no address', () => {
    render(
      <AIProposalCard
        proposal={{
          id: 'p2',
          title: 'Draft estimate',
          summary: 'Two lines.',
          explanation: '',
          confidence: 'High',
          type: 'Estimate',
          status: 'Pending',
        }}
      />,
    );
    expect(screen.queryByTestId('address-completion')).toBeNull();
  });
});

describe('AIProposalCard — prefill from the parseable free text', () => {
  it('leaves everything but the street empty for a street-only address', () => {
    render(
      <AIProposalCard
        proposal={customerProposal({ addressCapture: { address: '1207 Riverbell Drive' } })}
      />,
    );
    expect(screen.getByTestId('address-input-street1')).toHaveValue('1207 Riverbell Drive');
    expect(screen.getByTestId('address-input-city')).toHaveValue('');
    expect(screen.getByTestId('address-input-state')).toHaveValue('');
    expect(screen.getByTestId('address-input-postalCode')).toHaveValue('');
  });

  it('prefills city and ZIP when they were spoken but the state was not', () => {
    render(
      <AIProposalCard
        proposal={customerProposal({
          addressCapture: { address: '412 Oak Street, Scottsdale, 85254' },
        })}
      />,
    );
    expect(screen.getByTestId('address-input-street1')).toHaveValue('412 Oak Street');
    expect(screen.getByTestId('address-input-city')).toHaveValue('Scottsdale');
    expect(screen.getByTestId('address-input-postalCode')).toHaveValue('85254');
    // The one genuinely missing piece is the only empty box.
    expect(screen.getByTestId('address-input-state')).toHaveValue('');
  });

  it('names the consequence, and names exactly what is missing', () => {
    render(
      <AIProposalCard
        proposal={customerProposal({ addressCapture: { address: '1207 Riverbell Drive' } })}
      />,
    );
    expect(screen.getByTestId('address-consequence')).toHaveTextContent(
      'saved as a note, not a service location',
    );
    expect(screen.getByTestId('address-consequence')).toHaveTextContent('city');
    expect(screen.getByTestId('address-consequence')).toHaveTextContent('zip');
  });

  it('drops the warning as soon as the approver fills the last box', () => {
    render(
      <AIProposalCard
        proposal={customerProposal({ addressCapture: { address: '412 Oak Street, Scottsdale, 85254' } })}
      />,
    );
    expect(screen.getByTestId('address-consequence')).toHaveTextContent('saved as a note');
    fireEvent.change(screen.getByTestId('address-input-state'), { target: { value: 'AZ' } });
    expect(screen.getByTestId('address-consequence')).toHaveTextContent(
      'Saved as a service location on approval.',
    );
  });
});

describe('AIProposalCard — the edit is sent before the approval', () => {
  it('forwards the completed fields under their payload keys', () => {
    const onApprove = vi.fn();
    render(
      <AIProposalCard
        proposal={customerProposal({ addressCapture: { address: '1207 Riverbell Drive' } })}
        onApprove={onApprove}
      />,
    );

    fireEvent.change(screen.getByTestId('address-input-city'), { target: { value: 'Scottsdale' } });
    fireEvent.change(screen.getByTestId('address-input-state'), { target: { value: 'AZ' } });
    fireEvent.change(screen.getByTestId('address-input-postalCode'), { target: { value: '85254' } });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    // Keys are the `createCustomerPayloadSchema` keys verbatim. A rename here
    // is exactly how this field was lost four times on the way in.
    expect(onApprove).toHaveBeenCalledWith({
      street1: '1207 Riverbell Drive',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
    });
  });

  it('OMITS boxes the approver left blank rather than sending empty strings', () => {
    // The payload schema requires `.min(1)` on each field, so an empty string
    // would fail validation on the edit endpoint and turn "I don't know the
    // ZIP" into a failed approval.
    const onApprove = vi.fn();
    render(
      <AIProposalCard
        proposal={customerProposal({ addressCapture: { address: '1207 Riverbell Drive' } })}
        onApprove={onApprove}
      />,
    );

    fireEvent.change(screen.getByTestId('address-input-city'), { target: { value: 'Scottsdale' } });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onApprove).toHaveBeenCalledWith({
      street1: '1207 Riverbell Drive',
      city: 'Scottsdale',
    });
  });

  it('does NOT block approval when every box is empty', () => {
    const onApprove = vi.fn();
    render(
      <AIProposalCard
        // Nothing parseable at all, so every required box starts blank.
        proposal={customerProposal({ addressCapture: { address: ',' } })}
        onApprove={onApprove}
      />,
    );

    const approve = screen.getByRole('button', { name: /approve/i });
    expect(approve).not.toBeDisabled();
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('merges address edits with the ordinary Edit-form fields on Save & apply', () => {
    const onApprove = vi.fn();
    render(
      <AIProposalCard
        proposal={customerProposal({
          addressCapture: { address: '1207 Riverbell Drive' },
          editFields: [
            { label: 'Name', key: 'name', value: 'Ashia Aksuna' },
            { label: 'Phone', key: 'phone', value: '' },
          ],
        })}
        onApprove={onApprove}
      />,
    );

    fireEvent.change(screen.getByTestId('address-input-city'), { target: { value: 'Scottsdale' } });
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /save & apply/i }));

    expect(onApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Ashia Aksuna',
        street1: '1207 Riverbell Drive',
        city: 'Scottsdale',
      }),
    );
  });

  it('sends no edits when the address needs nothing (behaviour unchanged)', () => {
    const onApprove = vi.fn();
    render(
      <AIProposalCard
        proposal={customerProposal({
          addressCapture: { address: '412 Oak Street, Scottsdale, AZ 85254' },
        })}
        onApprove={onApprove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledWith(undefined);
  });
});
