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

/**
 * Drive the wizard from step 1 through to a submitted state.
 *
 * Service options now load asynchronously from the tenant info endpoint,
 * so callers must `await` the step-1 service button before invoking this.
 *
 * `beforeSubmit` runs after step 4 renders but before the final submit
 * click — used by the missing-tenant-id test to clear `?t=` so `submit()`
 * re-reads the URL and throws.
 */
async function completeWizard(beforeSubmit?: () => void): Promise<void> {
  // Step 1 — pick a service.
  fireEvent.click(screen.getByTestId('intake-service-hvac'));
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
  beforeSubmit?.();
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

  it('renders step 1 with the service question', async () => {
    render(<IntakeFormPage />);
    expect(screen.getByText('What can we help you with?')).toBeInTheDocument();
    await screen.findByText('Ortega HVAC & Services'); // flush the mount effect
  });

  it('keeps the CTA disabled until a service is selected', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByTestId('intake-service-hvac')).toBeInTheDocument();
    });
    expect(screen.getByTestId('intake-cta')).toBeDisabled();
    fireEvent.click(screen.getByTestId('intake-service-hvac'));
    expect(screen.getByTestId('intake-cta')).not.toBeDisabled();
  });

  it('submits the lead with a split name, honeypot, and attribution, then shows success', async () => {
    render(<IntakeFormPage />);
    await screen.findByTestId('intake-service-hvac');
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
    expect(payload.serviceType).toBe('HVAC Services');
    expect(payload.urgency).toBe('Emergency');
    expect(payload.description).toBe(
      'Service: HVAC Services — Urgency: Emergency — AC stopped blowing cold air yesterday.',
    );
  });

  it('renders only the service types returned by the tenant info endpoint', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByText('HVAC Services')).toBeInTheDocument();
    });
    // The old hardcoded "Painting" option must be gone.
    expect(screen.queryByText('Painting')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intake-service-plumbing')).not.toBeInTheDocument();
  });

  it('sends the selected service display name in the submit payload', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByTestId('intake-service-hvac')).toBeInTheDocument();
    });
    await completeWizard();
    await waitFor(() => {
      expect(screen.getByText('Request submitted!')).toBeInTheDocument();
    });
    const [, payload] = vi.mocked(submitIntakeLead).mock.calls[0];
    expect(payload.serviceType).toBe('HVAC Services');
  });

  it('shows an error and stays on the review step when submission fails', async () => {
    vi.mocked(submitIntakeLead).mockRejectedValue(new Error('Submission failed (500)'));
    render(<IntakeFormPage />);
    await screen.findByTestId('intake-service-hvac');
    await completeWizard();

    await waitFor(() => {
      expect(screen.getByText('Submission failed (500)')).toBeInTheDocument();
    });
    expect(screen.queryByText('Request submitted!')).not.toBeInTheDocument();
  });

  it('shows a tenant-id error when the ?t= param is missing', async () => {
    // Service options only render once the tenant info endpoint resolves,
    // which needs `?t=` at mount time. So we mount *with* a tenant id (the
    // wizard becomes drivable), then clear `?t=` right before submit —
    // `submit()` re-reads the URL and throws the missing-tenant-id error.
    render(<IntakeFormPage />);
    await screen.findByTestId('intake-service-hvac');
    await completeWizard(() => setTenantQueryParam(null));

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
