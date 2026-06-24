import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock the /api/me transport so we can drive terminology_preferences
// without the network (mirrors useMe.test.tsx).
vi.mock('../api/me', async () => {
  const actual = await vi.importActual<typeof import('../api/me')>('../api/me');
  return { ...actual, fetchMe: vi.fn(), postModeSwitch: vi.fn() };
});

import { fetchMe, type MeResponse } from '../api/me';
import { _resetMeCacheForTests } from './useMe';
import { useEntityLabels } from './useEntityLabels';

const baseMe: MeResponse = {
  user_id: 'u-1',
  tenant_id: 't-1',
  role: 'owner',
  can_field_serve: true,
  current_mode: 'supervisor',
  mode_changed_at: null,
  permissions: [],
  backup_supervisor_user_id: null,
  unsupervised_proposal_routing: 'queue_and_sms',
};

describe('useEntityLabels', () => {
  beforeEach(() => {
    vi.mocked(fetchMe).mockReset();
    _resetMeCacheForTests();
  });

  it('falls back to platform defaults before /api/me resolves', () => {
    vi.mocked(fetchMe).mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useEntityLabels());
    expect(result.current.labels.estimateTerm).toBe('Estimate');
    expect(result.current.label('jobTerm')).toBe('Job');
  });

  it("renders the tenant's overrides once /api/me lands", async () => {
    vi.mocked(fetchMe).mockResolvedValue({
      ...baseMe,
      terminology_preferences: { estimateTerm: 'Quote', jobTerm: 'Project' },
    });
    const { result } = renderHook(() => useEntityLabels());

    await waitFor(() => expect(result.current.labels.estimateTerm).toBe('Quote'));
    expect(result.current.label('jobTerm')).toBe('Project');
    expect(result.current.label('estimateTerm', { plural: true })).toBe('Quotes');
    // Unset entities keep their platform default.
    expect(result.current.labels.invoiceTerm).toBe('Invoice');
  });

  it('falls back to defaults when no preferences are present', async () => {
    vi.mocked(fetchMe).mockResolvedValue(baseMe);
    const { result } = renderHook(() => useEntityLabels());
    await waitFor(() => expect(fetchMe).toHaveBeenCalled());
    expect(result.current.labels.customerTerm).toBe('Customer');
    expect(result.current.label('workerTerm', { plural: true })).toBe('Technicians');
  });
});
