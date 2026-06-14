import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgreementDetail } from '../AgreementDetail';

vi.mock('../../../lib/apiClient', () => ({
  useApiClient: () => vi.fn(),
  isPublicApiPath: () => false,
  shouldInjectAuth: () => true,
  PUBLIC_API_PREFIXES: [],
}));

const mockGet = vi.fn();
vi.mock('../../../api/agreements', () => ({
  agreementsApi: {
    get: (...args: unknown[]) => mockGet(...args),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    runNow: vi.fn(),
  },
}));

describe('P9-003 AgreementDetail', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({
      id: 'a1',
      tenantId: 't',
      customerId: 'c',
      name: 'HVAC Tune-up',
      recurrenceRule: 'FREQ=QUARTERLY;BYMONTHDAY=15',
      priceCents: 19900,
      autoGenerateInvoice: true,
      autoGenerateJob: true,
      nextRunAt: '2026-09-15T00:00:00.000Z',
      status: 'active',
      startsOn: '2026-06-15',
      createdBy: 'u',
      createdAt: '',
      updatedAt: '',
      recentRuns: [
        {
          id: 'run-1',
          tenantId: 't',
          agreementId: 'a1',
          scheduledFor: '2026-06-15',
          generatedJobId: 'job-1',
          generatedInvoiceId: 'inv-1',
          status: 'generated',
          createdAt: '',
        },
      ],
    });
  });

  it('renders the agreement and a run row', async () => {
    render(<AgreementDetail agreementId="a1" role="dispatcher" />);
    await waitFor(() => {
      expect(screen.getByText('HVAC Tune-up')).toBeInTheDocument();
    });
    expect(screen.getByText('FREQ=QUARTERLY;BYMONTHDAY=15')).toBeInTheDocument();
    expect(screen.getByText('2026-06-15')).toBeInTheDocument();
  });

  it('hides Run Now from non-owner roles', async () => {
    render(<AgreementDetail agreementId="a1" role="dispatcher" />);
    await waitFor(() => {
      expect(screen.getByText('HVAC Tune-up')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('run-now')).toBeNull();
  });

  it('shows Run Now to owner role', async () => {
    render(<AgreementDetail agreementId="a1" role="owner" />);
    await waitFor(() => {
      expect(screen.getByTestId('run-now')).toBeInTheDocument();
    });
  });

  it('shows auto-renew off by default', async () => {
    render(<AgreementDetail agreementId="a1" role="dispatcher" />);
    const status = await screen.findByTestId('auto-renew-status');
    expect(status).toHaveTextContent('off');
  });

  it('shows the renewal cadence and count for an auto-renew membership', async () => {
    mockGet.mockResolvedValue({
      id: 'a1',
      tenantId: 't',
      customerId: 'c',
      name: 'Gold Membership',
      recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
      priceCents: 1500,
      autoGenerateInvoice: true,
      autoGenerateJob: true,
      nextRunAt: '2026-07-01T00:00:00.000Z',
      status: 'active',
      startsOn: '2026-01-01',
      endsOn: '2027-01-01',
      autoRenew: true,
      renewalTermMonths: 12,
      renewalCount: 2,
      memberDiscountBps: 1000,
      priorityBooking: true,
      autoCollectDues: true,
      createdBy: 'u',
      createdAt: '',
      updatedAt: '',
      recentRuns: [],
    });
    render(<AgreementDetail agreementId="a1" role="owner" />);
    const status = await screen.findByTestId('auto-renew-status');
    expect(status).toHaveTextContent('every 12 months');
    expect(status).toHaveTextContent('renewed 2');
    expect(screen.getByTestId('member-discount')).toHaveTextContent('10% off');
    expect(screen.getByTestId('priority-booking')).toBeInTheDocument();
    expect(screen.getByTestId('auto-collect-dues')).toBeInTheDocument();
  });

  it('hides the member-discount line when there is no discount', async () => {
    render(<AgreementDetail agreementId="a1" role="dispatcher" />);
    await screen.findByTestId('auto-renew-status');
    expect(screen.queryByTestId('member-discount')).toBeNull();
  });
});
