import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/settings', () => ({
  fetchLanguageSettings: vi.fn(),
  updateLanguageSettings: vi.fn(),
}));

import { LanguageSettingsPage } from '../../../pages/settings/LanguageSettings';
import {
  fetchLanguageSettings,
  updateLanguageSettings,
} from '../../../api/settings';

describe('P11-002 LanguageSettings page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Multilingual: renders the current default language from the API', async () => {
    (fetchLanguageSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      defaultLanguage: 'es',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
    });
    render(<LanguageSettingsPage />);
    const select = (await screen.findByLabelText('Default language')) as HTMLSelectElement;
    expect(select.value).toBe('es');
  });

  it('Language: PATCHes when the operator picks a new default', async () => {
    (fetchLanguageSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      defaultLanguage: 'en',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
    });
    (updateLanguageSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      defaultLanguage: 'es',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
    });
    render(<LanguageSettingsPage />);
    const select = (await screen.findByLabelText('Default language')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'es' } });
    await waitFor(() =>
      expect(updateLanguageSettings).toHaveBeenCalledWith({ defaultLanguage: 'es' }),
    );
  });

  it('Bilingual: PATCHes supported_languages when the operator enables Spanish', async () => {
    (fetchLanguageSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      defaultLanguage: 'en',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
      supportedLanguages: ['en'],
    });
    (updateLanguageSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      defaultLanguage: 'en',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
      supportedLanguages: ['en', 'es'],
    });
    render(<LanguageSettingsPage />);
    const toggle = (await screen.findByLabelText('Enable Spanish')) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(updateLanguageSettings).toHaveBeenCalledWith({
        supportedLanguages: ['en', 'es'],
      }),
    );
  });

  it('Multilingual: surfaces an error when the API rejects the load', async () => {
    (fetchLanguageSettings as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom'),
    );
    render(<LanguageSettingsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});
