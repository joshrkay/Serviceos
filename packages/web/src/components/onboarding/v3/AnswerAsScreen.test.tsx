import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AnswerAsScreen } from './AnswerAsScreen';

const WHY = 'I ring this number for emergencies, and your area code sets your prices. 10 digits with the area code.';
const NOT_A_US_CELL = "That doesn't look like a US cell number. Include the area code, 10 digits.";
const REFUSED = 'That does not look like a US cell number. Include the 10-digit area code, for example (216) 555-0100.';

const go = () => screen.getByRole('button', { name: 'Show me my shop' });
const cellField = () => screen.getByLabelText('Your cell');

/** A name and a trade, so the cell is the only thing between the owner and the button. */
async function nameAndTrade() {
  await userEvent.type(screen.getByLabelText('Business name'), 'Walsh');
  await userEvent.click(screen.getByRole('button', { name: 'HVAC' }));
}

describe('AnswerAsScreen', () => {
  it('asks what to answer as and offers the four trade chips', () => {
    render(<AnswerAsScreen onSubmit={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeInTheDocument();
    for (const name of ['Plumbing', 'HVAC', 'Electrical', 'Something else']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('keeps the button off until there is a name, a trade and a cell, and marks the chosen chip', async () => {
    render(<AnswerAsScreen onSubmit={vi.fn()} />);
    expect(go()).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Business name'), 'Walsh Plumbing');
    expect(go()).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Plumbing' }));
    expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
    expect(go()).toBeDisabled();
    await userEvent.type(cellField(), '(216) 555-0142');
    expect(go()).toBeEnabled();
  });

  it('submits the pack, the trimmed name and the trimmed cell', async () => {
    const onSubmit = vi.fn();
    render(<AnswerAsScreen onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Business name'), '  Walsh Plumbing ');
    await userEvent.click(screen.getByRole('button', { name: 'Something else' }));
    await userEvent.type(cellField(), '  (216) 555-0142 ');
    await userEvent.click(go());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenLastCalledWith({ packId: 'other', businessName: 'Walsh Plumbing', phone: '(216) 555-0142' });
  });

  it.each(['2165550142', '216-555-0142', '+1 216 555 0142', '1 (216) 555-0142'])('takes the US form %j as it was typed', async (typed) => {
    const onSubmit = vi.fn();
    render(<AnswerAsScreen onSubmit={onSubmit} />);
    await nameAndTrade();
    await userEvent.type(cellField(), typed);
    expect(go()).toBeEnabled();
    expect(screen.getByText(WHY)).toBeInTheDocument();
    await userEvent.click(go());
    expect(onSubmit).toHaveBeenLastCalledWith({ packId: 'hvac', businessName: 'Walsh', phone: typed });
  });

  describe('a cell the API would refuse', () => {
    it.each([
      ['too short to place an area', '216'],
      ['no digits in it', 'call me later'],
      ['twelve digits', '216555010012'],
      ['a non-US +44 number', '+44 7911 123456'],
      ['a Norwegian number that is ten digits long', '+47 912 34 567'],
      ['an area code starting 0', '055-123-4567'],
      ['an area code starting 1', '155-123-4567'],
      ['letters mixed in', '216-555-CALL'],
    ])('holds back %s (%j) and says what is needed', async (_what, typed) => {
      const onSubmit = vi.fn();
      render(<AnswerAsScreen onSubmit={onSubmit} />);
      await nameAndTrade();
      await userEvent.type(cellField(), typed);
      expect(go()).toBeDisabled();
      expect(cellField()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(NOT_A_US_CELL)).toBeInTheDocument();
      await userEvent.type(cellField(), '{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('the cell is required until the dedicated prompt exists', () => {
    it('keeps the button off with no cell, or a blank one, and says why Rivet needs it, with no way to skip', async () => {
      const onSubmit = vi.fn();
      const { container } = render(<AnswerAsScreen onSubmit={onSubmit} />);
      await nameAndTrade();
      expect(go()).toBeDisabled();
      expect(cellField()).toHaveAttribute('aria-required', 'true');
      expect(cellField()).not.toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(WHY)).toBeInTheDocument();

      await userEvent.type(cellField(), '   ');
      expect(go()).toBeDisabled();
      expect(screen.getByText(WHY)).toBeInTheDocument();
      await userEvent.type(cellField(), '{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();

      expect(container).not.toHaveTextContent(/skip|optional/i);
      expect(screen.queryByRole('button', { name: /skip|later/i })).not.toBeInTheDocument();
    });
  });

  describe('coming back after the API refused the cell', () => {
    const initial = { packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '(216) 555-0142' };

    it('keeps what the owner typed, shows the API\'s reason, and will not send the refused cell again', async () => {
      const onSubmit = vi.fn();
      render(<AnswerAsScreen onSubmit={onSubmit} initial={initial} cellProblem={REFUSED} />);

      expect(screen.getByLabelText('Business name')).toHaveValue('Walsh Plumbing');
      expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
      expect(cellField()).toHaveValue('(216) 555-0142');
      expect(screen.getByRole('alert')).toHaveTextContent(REFUSED);
      expect(cellField()).toHaveAttribute('aria-invalid', 'true');
      expect(go()).toBeDisabled();

      // A different cell clears the reason and the button comes back.
      await userEvent.clear(cellField());
      await userEvent.type(cellField(), '2165550199');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText(WHY)).toBeInTheDocument();
      expect(go()).toBeEnabled();

      // Typing the refused cell back in brings the reason back with it.
      await userEvent.clear(cellField());
      await userEvent.type(cellField(), '  (216) 555-0142');
      expect(screen.getByRole('alert')).toHaveTextContent(REFUSED);
      expect(go()).toBeDisabled();
      await userEvent.type(cellField(), '{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();

      await userEvent.clear(cellField());
      await userEvent.type(cellField(), '2165550199');
      await userEvent.click(go());
      expect(onSubmit).toHaveBeenCalledWith({ packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '2165550199' });
    });

    it('starts from what the owner typed even when the API gave no reason', () => {
      render(<AnswerAsScreen onSubmit={vi.fn()} initial={initial} />);
      expect(screen.getByLabelText('Business name')).toHaveValue('Walsh Plumbing');
      expect(cellField()).toHaveValue('(216) 555-0142');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(go()).toBeEnabled();
    });
  });
});
