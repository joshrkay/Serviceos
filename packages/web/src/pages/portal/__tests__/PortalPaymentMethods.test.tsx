import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const confirmSetupMock = vi.fn();
vi.mock('@stripe/react-stripe-js', () => {
  const Elements = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  );
  const PaymentElement = () => <div data-testid="stripe-payment-element">[card fields]</div>;
  const useStripe = () => ({ confirmSetup: confirmSetupMock });
  const useElements = () => ({});
  return { Elements, PaymentElement, useStripe, useElements };
});
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn(() => Promise.resolve({})) }));

const paymentMethodsMock = vi.fn();
const startCardSetupMock = vi.fn();
vi.mock('../../../api/portal', () => ({
  portalApi: {
    paymentMethods: (...a: unknown[]) => paymentMethodsMock(...a),
    startCardSetup: (...a: unknown[]) => startCardSetupMock(...a),
  },
}));

import { PortalPaymentMethods } from '../PortalPaymentMethods';

describe('PortalPaymentMethods', () => {
  beforeEach(() => {
    paymentMethodsMock.mockReset();
    startCardSetupMock.mockReset();
    confirmSetupMock.mockReset();
  });

  it('lists saved cards with brand/last4 and a default badge', async () => {
    paymentMethodsMock.mockResolvedValue({
      paymentMethods: [
        { id: 'pm1', brand: 'visa', last4: '4242', expMonth: 9, expYear: 2030, isDefault: true },
      ],
    });
    render(<PortalPaymentMethods token="tok" />);
    const card = await screen.findByTestId('saved-card');
    expect(card).toHaveTextContent('4242');
    expect(card).toHaveTextContent('Default');
  });

  it('shows an empty state when there are no cards', async () => {
    paymentMethodsMock.mockResolvedValue({ paymentMethods: [] });
    render(<PortalPaymentMethods token="tok" />);
    expect(await screen.findByTestId('no-cards')).toBeInTheDocument();
  });

  it('starts a SetupIntent and renders the card form on "Add a card"', async () => {
    paymentMethodsMock.mockResolvedValue({ paymentMethods: [] });
    startCardSetupMock.mockResolvedValue({ clientSecret: 'seti_secret', setupIntentId: 'seti_1' });
    render(<PortalPaymentMethods token="tok" />);
    await screen.findByTestId('no-cards');
    fireEvent.click(screen.getByTestId('add-card-button'));
    await waitFor(() => expect(startCardSetupMock).toHaveBeenCalledWith('tok'));
    expect(await screen.findByTestId('add-card-form')).toBeInTheDocument();
    expect(screen.getByTestId('stripe-payment-element')).toBeInTheDocument();
  });

  it('confirms the setup and shows the saved notice', async () => {
    paymentMethodsMock.mockResolvedValue({ paymentMethods: [] });
    startCardSetupMock.mockResolvedValue({ clientSecret: 'seti_secret', setupIntentId: 'seti_1' });
    confirmSetupMock.mockResolvedValue({ setupIntent: { status: 'succeeded' } });
    render(<PortalPaymentMethods token="tok" />);
    await screen.findByTestId('no-cards');
    fireEvent.click(screen.getByTestId('add-card-button'));
    await screen.findByTestId('add-card-form');
    fireEvent.click(screen.getByText('Save card'));
    await waitFor(() => expect(confirmSetupMock).toHaveBeenCalled());
    expect(await screen.findByTestId('card-saved-notice')).toBeInTheDocument();
  });
});
