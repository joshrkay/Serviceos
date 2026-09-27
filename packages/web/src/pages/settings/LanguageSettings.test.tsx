/**
 * #1283 — mobile bar: the language checkboxes were bare 13×13 native inputs.
 * The whole label row is the tap target (clicking a <label> toggles its
 * checkbox), so each row must be ≥44px tall.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/settings', () => ({
  fetchLanguageSettings: vi.fn().mockResolvedValue({
    defaultLanguage: 'en',
    ttsVoiceEn: null,
    ttsVoiceEs: null,
    autoDetectLanguage: true,
    spanishDispatcherUserIds: [],
    supportedLanguages: ['en'],
  }),
  updateLanguageSettings: vi.fn(),
}));

import { LanguageSettingsPage } from './LanguageSettings';

describe('LanguageSettingsPage — tap targets (#1283)', () => {
  it.each(['Enable Spanish', 'Auto-detect caller language'])(
    'the "%s" checkbox row is a ≥44px tap target',
    async (name) => {
      render(<LanguageSettingsPage />);
      const box = await screen.findByRole('checkbox', { name });
      const row = box.closest('label');
      expect(row, 'checkbox is wrapped by its label').not.toBeNull();
      expect(row!.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    },
  );
});
