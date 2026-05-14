import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchIntakeTenantInfo, submitIntakeLead } from './public-intake';

describe('public-intake api client', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('fetchIntakeTenantInfo', () => {
    it('GETs the tenant info endpoint and returns the parsed body', async () => {
      const body = {
        businessName: 'Ortega HVAC & Services',
        businessPhone: '(512) 555-0100',
        serviceTypes: [{ verticalType: 'hvac', displayName: 'HVAC Services' }],
      };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await fetchIntakeTenantInfo('tenant-123');

      expect(fetchMock).toHaveBeenCalledWith(
        '/public/intake/tenant-123',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result).toEqual(body);
    });

    it('throws when the response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      await expect(fetchIntakeTenantInfo('missing')).rejects.toThrow(
        'Could not load intake form (404)',
      );
    });
  });

  describe('submitIntakeLead', () => {
    it('POSTs the payload as JSON and returns the parsed body', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ ok: true, leadId: 'lead-1' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const payload = {
        firstName: 'Sandra',
        primaryPhone: '5125550191',
        _company_url: '',
      };
      const result = await submitIntakeLead('tenant-123', payload);

      expect(fetchMock).toHaveBeenCalledWith(
        '/public/intake/tenant-123/leads',
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
      expect(result).toEqual({ ok: true, leadId: 'lead-1' });
    });

    it('throws when the response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      await expect(
        submitIntakeLead('tenant-123', { firstName: 'X', _company_url: '' }),
      ).rejects.toThrow('Submission failed (500)');
    });
  });
});
