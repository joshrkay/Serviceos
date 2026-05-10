import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { InteractionsPage } from './InteractionsPage';

const TABS: { id: string; label: string; demoText: string }[] = [
  { id: 'ai',          label: 'AI',           demoText: 'Propose action' },
  { id: 'messaging',   label: 'Messaging',    demoText: 'Draft SMS · Review · Send feedback' },
  { id: 'scheduling',  label: 'Scheduling',   demoText: 'Create schedule from conversation' },
  { id: 'records',     label: 'Records',      demoText: 'Resolve customer match' },
  { id: 'financial',   label: 'Financial',    demoText: 'Estimate draft from conversation' },
  { id: 'onboarding',  label: 'Onboarding',   demoText: 'Voice answer capture · Text fallback' },
  { id: 'states',      label: 'System States',demoText: 'Pending review' },
];

describe('InteractionsPage', () => {
  it('renders the page header and AI tab by default', () => {
    render(<InteractionsPage />);
    expect(screen.getByText('Interaction Patterns')).toBeInTheDocument();
    expect(screen.getByText('Propose action')).toBeInTheDocument();
  });

  it('renders every tab without crashing when switched', () => {
    render(<InteractionsPage />);
    for (const t of TABS) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(t.label) }));
      expect(screen.getByText(t.demoText)).toBeInTheDocument();
    }
  });
});
