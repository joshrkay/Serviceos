import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fetchTextWording } from './textWording';

vi.mock('../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../utils/api-fetch';

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('fetchTextWording (D-045)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('passes the per-language shape through unchanged', async () => {
    const state = {
      language: 'en',
      languages: ['en', 'es'],
      maxLength: 480,
      texts: [
        {
          purpose: 'invoice_text',
          fillIns: ['link'],
          sampleValues: { link: 'L' },
          byLanguage: {
            en: { ours: 'Ours', addedLines: [], saved: null },
            es: { ours: 'Nuestro', addedLines: [], saved: { body: 'Mío', updatedAt: 't' } },
          },
        },
      ],
    };
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(state));
    await expect(fetchTextWording()).resolves.toEqual(state);
  });

  it('reads an API still on the one-language shape as the business language only', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      ok({
        language: 'es',
        maxLength: 480,
        texts: [
          {
            purpose: 'thank_you_text',
            fillIns: ['name'],
            sampleValues: { name: 'Ana' },
            ours: 'Gracias',
            addedLines: ['extra'],
            saved: { body: 'Mil gracias', language: 'es', updatedAt: 't' },
          },
        ],
      }),
    );
    await expect(fetchTextWording()).resolves.toEqual({
      language: 'es',
      languages: ['es'],
      maxLength: 480,
      texts: [
        {
          purpose: 'thank_you_text',
          fillIns: ['name'],
          sampleValues: { name: 'Ana' },
          byLanguage: { es: { ours: 'Gracias', addedLines: ['extra'], saved: { body: 'Mil gracias', updatedAt: 't' } } },
        },
      ],
    });
  });
});
