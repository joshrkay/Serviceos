// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { SavePhaseButton } from './SavePhaseButton';

describe('SavePhaseButton', () => {
  it('renders a min-h-11 primary control', () => {
    const { getByText } = render(
      createElement(SavePhaseButton, {
        phase: 'idle',
        idleLabel: 'Save',
        savingLabel: 'Saving…',
        savedLabel: 'Saved',
        onPress: () => {},
      }),
    );
    const btn = getByText('Save').closest('button')!;
    expect(btn.className).toMatch(/\bmin-h-11\b/);
  });
});
