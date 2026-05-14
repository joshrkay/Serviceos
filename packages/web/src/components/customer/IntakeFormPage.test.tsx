import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../api/public-intake', () => ({
  submitIntakeLead: vi.fn(),
  fetchIntakeTenantInfo: vi.fn(),
}));

import { submitIntakeLead, fetchIntakeTenantInfo } from '../../api/public-intake';
import { IntakeFormPage } from './IntakeFormPage';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const TENANT_INFO = {
  businessName: 'Ortega HVAC & Services',
  businessPhone: '(512) 555-0100',
  serviceTypes: [{ verticalType: 'hvac', displayName: 'HVAC Services' }],
};

function setTenantQueryParam(t: string | null): void {
  window.history.pushState({}, '', t ? `/intake?t=${t}` : '/intake');
}

/** Drive the wizard from step 1 through to a submitted state. */
async function completeWizard(): Promise<void> {
  // Step 1 — pick a service.
  fireEvent.click(screen.getByTestId('intake-service-HVAC'));
  fireEvent.click(screen.getByTestId('intake-cta'));
  // Step 2 — description (>= 10 chars) + urgency.
  fireEvent.change(screen.getByTestId('intake-description'), {
    target: { value: 'AC stopped blowing cold air yesterday.' },
  });
  fireEvent.click(screen.getByText('🚨 Emergency'));
  fireEvent.click(screen.getByTestId('intake-cta'));
  // Step 3 — name + phone.
  fireEvent.change(screen.getByTestId('intake-field-name'), {
    target: { value: 'Sandra Wu' },
  });
  fireEvent.change(screen.getByTestId('intake-field-phone'), {
    target: { value: '(512) 555-0191' },
  });
  fireEvent.click(screen.getByTestId('intake-cta'));
  // Step 4 — review, then submit.
  fireEvent.click(screen.getByTestId('intake-cta'));
}

describe('IntakeFormPage', () => {
  beforeEach(() => {
    vi.mocked(submitIntakeLead).mockReset();
    vi.mocked(submitIntakeLead).mockResolvedValue({ ok: true, leadId: 'lead-1' });
    vi.mocked(fetchIntakeTenantInfo).mockReset();
    vi.mocked(fetchIntakeTenantInfo).mockResolvedValue(TENANT_INFO);
    setTenantQueryParam(TENANT_ID);
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('renders step 1 with the service question', () => {
    render(<IntakeFormPage />);
    expect(screen.getByText('What can we help you with?')).toBeInTheDocument();
  });

  it('keeps the CTA disabled until a service is selected', () => {
    render(<IntakeFormPage />);
    expect(screen.getByTestId('intake-cta')).toBeDisabled();
    fireEvent.click(screen.getByTestId('intake-service-HVAC'));
    expect(screen.getByTestId('intake-cta')).not.toBeDisabled();
  });

  it('submits the lead with a split name, honeypot, and attribution, then shows success', async () => {
    render(<IntakeFormPage />);
    await completeWizard();

    await waitFor(() => {
      expect(screen.getByText('Request submitted!')).toBeInTheDocument();
    });
    expect(submitIntakeLead).toHaveBeenCalledTimes(1);
    const [calledTenantId, payload] = vi.mocked(submitIntakeLead).mock.calls[0];
    expect(calledTenantId).toBe(TENANT_ID);
    expect(payload.firstName).toBe('Sandra');
    expect(payload.lastName).toBe('Wu');
    expect(payload.primaryPhone).toBe('(512) 555-0191');
    expect(payload._company_url).toBe('');
    expect(payload.attribution).toBeDefined();
    expect(payload.serviceType).toBe('HVAC');
    expect(payload.urgency).toBe('Emergency');
    expect(payload.description).toBe(
      'Service: HVAC — Urgency: Emergency — AC stopped blowing cold air yesterday.',
    );
  });

  it('shows an error and stays on the review step when submission fails', async () => {
    vi.mocked(submitIntakeLead).mockRejectedValue(new Error('Submission failed (500)'));
    render(<IntakeFormPage />);
    await completeWizard();

    await waitFor(() => {
      expect(screen.getByText('Submission failed (500)')).toBeInTheDocument();
    });
    expect(screen.queryByText('Request submitted!')).not.toBeInTheDocument();
  });

  it('shows a tenant-id error when the ?t= param is missing', async () => {
    setTenantQueryParam(null);
    render(<IntakeFormPage />);
    await completeWizard();

    await waitFor(() => {
      expect(
        screen.getByText('This intake form is missing its tenant id.'),
      ).toBeInTheDocument();
    });
    expect(submitIntakeLead).not.toHaveBeenCalled();
  });

  it('loads and renders the real business name in the header', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByText('Ortega HVAC & Services')).toBeInTheDocument();
    });
    expect(fetchIntakeTenantInfo).toHaveBeenCalledWith(TENANT_ID);
  });

  it('does not render the hardcoded mock review rating', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByText('Ortega HVAC & Services')).toBeInTheDocument();
    });
    expect(screen.queryByText(/124 reviews/i)).not.toBeInTheDocument();
  });
});
