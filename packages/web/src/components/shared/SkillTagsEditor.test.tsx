import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SkillChips, SkillTagsEditor } from './SkillTagsEditor';

function renderEditor(initial: string[] = [], onSave = vi.fn()) {
  render(
    <SkillTagsEditor idPrefix="t" label="Skills" initial={initial} onSave={onSave} onCancel={() => {}} />,
  );
  return onSave;
}

function type(value: string) {
  fireEvent.change(screen.getByTestId('t-input'), { target: { value } });
}

describe('SkillTagsEditor (Dispatch FR-2 phase 2)', () => {
  it('adds a tag in the canonical form the API stores, ignoring duplicates', () => {
    const onSave = renderEditor(['hvac']);
    type('Gas Certified');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    type('HVAC');
    fireEvent.keyDown(screen.getByTestId('t-input'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('t-save'));
    expect(onSave).toHaveBeenCalledWith(['hvac', 'gas_certified']);
  });

  it('shows an error for a tag it cannot store and does not save it', () => {
    const onSave = renderEditor();
    type('R&D');
    fireEvent.click(screen.getByTestId('t-save'));
    expect(screen.getByRole('alert')).toHaveTextContent(/letters, numbers/);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves a typed-but-not-added tag rather than dropping it', () => {
    const onSave = renderEditor(['hvac']);
    type('backflow');
    fireEvent.click(screen.getByTestId('t-save'));
    expect(onSave).toHaveBeenCalledWith(['hvac', 'backflow']);
  });

  it('removes a tag', () => {
    const onSave = renderEditor(['hvac', 'backflow']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove hvac' }));
    fireEvent.click(screen.getByTestId('t-save'));
    expect(onSave).toHaveBeenCalledWith(['backflow']);
  });

  it('every control is a ≥44px tap target and the input row cannot overflow', () => {
    renderEditor(['hvac']);
    for (const btn of screen.getAllByRole('button')) {
      expect(btn.className).toMatch(/\b(min-h-11|size-11)\b/);
    }
    const input = screen.getByTestId('t-input');
    expect(input.className).toContain('min-h-11');
    expect(input.className).toContain('min-w-0');
  });
});

describe('SkillChips', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<SkillChips tags={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one chip per tag', () => {
    render(<SkillChips tags={['hvac', 'backflow']} testId="chips" />);
    expect(screen.getByTestId('chips').querySelectorAll('li')).toHaveLength(2);
  });
});
