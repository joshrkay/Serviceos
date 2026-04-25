import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { MemoryRouter } from 'react-router';

describe('SettingsPage review URLs section', () => {
  it('renders Google Review URL input', () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByLabelText(/google review url/i)).toBeInTheDocument();
  });
});
