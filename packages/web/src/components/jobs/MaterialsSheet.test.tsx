import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MaterialsSheet } from './MaterialsSheet';

// U10d — MaterialsSheet collects a dollar "Unit cost" via the kit inputs and
// keeps it in dollars (the parent converts to cents on save). This pins that
// the kit migration preserved the money field's value/onChange wiring.
describe('MaterialsSheet (kit inputs + money)', () => {
  it('adds a custom item via the kit inputs, preserving the dollar unit cost', () => {
    render(<MaterialsSheet serviceType="HVAC" existing={[]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText(/Add custom item/i));
    fireEvent.change(screen.getByPlaceholderText('Item name'), { target: { value: 'Widget' } });
    fireEvent.change(screen.getByPlaceholderText('Unit cost ($)'), { target: { value: '12.50' } });
    fireEvent.change(screen.getByPlaceholderText('Qty'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // The kit inputs collected name/cost/qty; the dollar line total (2 × $12.50)
    // renders — proving the migration kept the value wiring and the money math.
    expect(screen.getByText('Widget')).toBeInTheDocument();
    // $25.00 shows as both the line total and the cart total.
    expect(screen.getAllByText('$25.00').length).toBeGreaterThan(0);
  });

  it('does not add a custom item without a name and cost (Add stays disabled)', () => {
    render(<MaterialsSheet serviceType="HVAC" existing={[]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Add custom item/i));
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('renders on Path A tokens — no raw Tailwind palette leaks', () => {
    const { container } = render(
      <MaterialsSheet serviceType="HVAC" existing={[]} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|border-l|placeholder|ring|divide|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });
});
