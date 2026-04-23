import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PriceBookPage } from './PriceBookPage';

describe('PriceBookPage', () => {
  it('renders heading text', () => {
    render(<PriceBookPage />);

    expect(screen.getByText('Price book')).toBeInTheDocument();
  });
});
