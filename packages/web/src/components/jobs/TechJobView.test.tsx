import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router';
import { TechJobView } from './TechJobView';

describe('TechJobView delay acknowledgement prompt', () => {
  it('renders fixed delay options and toggles with Yes/No', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TechJobView id="j1" />
      </MemoryRouter>
    );

    expect(screen.getByText('Running behind?')).toBeInTheDocument();
    const yesButton = screen.getByRole('button', { name: 'Yes' });
    const noButton = screen.getByRole('button', { name: 'No' });

    const chip10 = screen.getByRole('button', { name: '10' });
    const chip15 = screen.getByRole('button', { name: '15' });
    const chip20 = screen.getByRole('button', { name: '20' });
    const chip60 = screen.getByRole('button', { name: '60' });

    expect(chip10).toBeDisabled();
    expect(chip15).toBeDisabled();
    expect(chip20).toBeDisabled();
    expect(chip60).toBeDisabled();

    await user.click(yesButton);

    expect(chip10).toBeEnabled();
    expect(chip15).toBeEnabled();
    expect(chip20).toBeEnabled();
    expect(chip60).toBeEnabled();

    await user.click(chip20);
    expect(chip20).toHaveClass('bg-indigo-600');

    await user.click(noButton);
    expect(chip10).toBeDisabled();
    expect(chip15).toBeDisabled();
    expect(chip20).toBeDisabled();
    expect(chip60).toBeDisabled();
  });
});
