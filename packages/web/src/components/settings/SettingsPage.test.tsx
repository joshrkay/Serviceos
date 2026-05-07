import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  it('renders Price book settings item', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    expect(screen.getByText('Price book')).toBeInTheDocument();
  });
});
