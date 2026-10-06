import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChartContainer, ChartLegendContent, ChartTooltipContent, type ChartConfig } from './chart';

// jsdom has no layout, so ResponsiveContainer renders no children; render them directly.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <>{children}</> };
});

const config = {
  count: { label: 'Responses', color: '#f59e0b' },
} satisfies ChartConfig;

describe('chart wrapper (recharts 3 content props)', () => {
  it('renders tooltip rows from a recharts-3 shaped payload', () => {
    render(
      <ChartContainer config={config}>
        <div>
          <ChartTooltipContent
            active
            label="count"
            payload={[{ graphicalItemId: 'g1', dataKey: 'count', name: 'count', value: 7, color: '#f59e0b', payload: { star: '5★', count: 7 } }]}
          />
        </div>
      </ChartContainer>,
    );
    expect(screen.getAllByText('Responses')).toHaveLength(2); // heading label + row label
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('renders nothing when the tooltip is inactive', () => {
    const { container } = render(
      <ChartContainer config={config}>
        <div>
          <ChartTooltipContent active={false} payload={[{ graphicalItemId: 'g1', dataKey: 'count', name: 'count', value: 7 }]} />
        </div>
      </ChartContainer>,
    );
    expect(container.textContent).not.toContain('Responses');
  });

  it('renders legend entries from a recharts-3 shaped payload', () => {
    render(
      <ChartContainer config={config}>
        <div>
          <ChartLegendContent
            verticalAlign="top"
            payload={[{ value: 'count', dataKey: 'count', type: 'square', color: '#f59e0b' }]}
          />
        </div>
      </ChartContainer>,
    );
    expect(screen.getByText('Responses')).toBeInTheDocument();
  });
});
