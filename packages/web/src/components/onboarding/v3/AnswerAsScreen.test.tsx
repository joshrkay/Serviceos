import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AnswerAsScreen } from './AnswerAsScreen';

describe('AnswerAsScreen', () => {
  it('asks what to answer as and offers the four trade chips', () => {
    render(<AnswerAsScreen onSubmit={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeInTheDocument();
    for (const name of ['Plumbing', 'HVAC', 'Electrical', 'Something else']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('keeps the button off until there is a name and a trade, and marks the chosen chip', async () => {
    render(<AnswerAsScreen onSubmit={vi.fn()} />);
    const go = screen.getByRole('button', { name: 'Show me my shop' });
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Business name'), 'Walsh Plumbing');
    expect(go).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Plumbing' }));
    expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
    expect(go).toBeEnabled();
  });

  it('submits the pack, the trimmed name, and the cell only when given', async () => {
    const onSubmit = vi.fn();
    render(<AnswerAsScreen onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Business name'), '  Walsh Plumbing ');
    await userEvent.click(screen.getByRole('button', { name: 'Something else' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show me my shop' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ packId: 'other', businessName: 'Walsh Plumbing' });

    await userEvent.type(screen.getByLabelText('Your cell'), '(216) 555-0142');
    await userEvent.click(screen.getByRole('button', { name: 'Plumbing' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show me my shop' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '(216) 555-0142' });
  });

  it('holds back a cell that is too short to place an area', async () => {
    render(<AnswerAsScreen onSubmit={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Business name'), 'Walsh');
    await userEvent.click(screen.getByRole('button', { name: 'HVAC' }));
    await userEvent.type(screen.getByLabelText('Your cell'), '216');
    expect(screen.getByRole('button', { name: 'Show me my shop' })).toBeDisabled();
    expect(screen.getByText('Include the area code, 10 digits.')).toBeInTheDocument();
  });
});
