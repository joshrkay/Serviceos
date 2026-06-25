/**
 * Tenant-neutral class contract for the public intake wizard (U13e).
 *
 * Walks every step (service → description → contact → review) because a jsdom
 * guard only sees the states it mounts, and the blue accents this unit
 * removed lived on steps 2–3 (the hint box, the kit form fields). The urgency
 * options stay a real 3-way severity scale (destructive/warning/success);
 * what must never appear is the ServiceOS brand blue.
 */
import React from 'react';
import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { expectTenantNeutral } from './tenantNeutralContract';

vi.mock('../../api/public-intake', () => ({
  submitIntakeLead: vi.fn(),
  fetchIntakeTenantInfo: vi.fn(),
}));

import { submitIntakeLead, fetchIntakeTenantInfo } from '../../api/public-intake';
import { IntakeFormPage } from './IntakeFormPage';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_INFO = {
  businessName: 'Ortega HVAC & Services',
  businessPhone: '(737) 999-0042',
  businessHoursSummary: 'Mon–Fri 8am–6pm',
  serviceTypes: [{ verticalType: 'hvac', displayName: 'HVAC Services' }],
};

describe('IntakeFormPage — tenant-neutral class contract', () => {
  beforeEach(() => {
    vi.mocked(submitIntakeLead).mockResolvedValue({ ok: true, leadId: 'lead-1' });
    vi.mocked(fetchIntakeTenantInfo).mockResolvedValue(TENANT_INFO);
    window.history.pushState({}, '', `/intake?t=${TENANT_ID}`);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('stays neutral across every wizard step', async () => {
    const { container } = render(<IntakeFormPage />);

    // Step 1 — service select.
    fireEvent.click(await screen.findByTestId('intake-service-hvac'));
    expectTenantNeutral(container.innerHTML);
    fireEvent.click(screen.getByTestId('intake-cta'));

    // Step 2 — description (kit Textarea), urgency severity, business-hours hint.
    fireEvent.change(screen.getByTestId('intake-description'), {
      target: { value: 'AC stopped blowing cold air yesterday.' },
    });
    fireEvent.click(screen.getByText('🚨 Emergency'));
    expectTenantNeutral(container.innerHTML);
    fireEvent.click(screen.getByTestId('intake-cta'));

    // Step 3 — contact (kit Inputs).
    fireEvent.change(screen.getByTestId('intake-field-name'), { target: { value: 'Sandra Wu' } });
    fireEvent.change(screen.getByTestId('intake-field-phone'), { target: { value: '(512) 555-0191' } });
    expectTenantNeutral(container.innerHTML);
    fireEvent.click(screen.getByTestId('intake-cta'));

    // Step 4 — review.
    expectTenantNeutral(container.innerHTML);
  });
});
