/**
 * #1276 leftover (QA 2026-09-16) — the chat proposal card's own action
 * buttons (Approve / Edit / Dismiss) were `py-2 text-xs`, about 32px tall:
 * under the 44px tap-target floor CLAUDE.md sets for mobile UI.
 *
 * Seam: AIProposalCard as the chat renders it. Pinned as a class contract
 * (min-h-11 = 44px); the rendered height at 320px is pinned by
 * e2e/chat-proposal-card-mobile.spec.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AIProposalCard } from './AIProposalCard';
import type { AIProposal } from '../../types/assistant-ui';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-router', async (orig) => {
  const actual = await (orig() as Promise<typeof import('react-router')>);
  return { ...actual, useNavigate: () => vi.fn() };
});

const estimate: AIProposal = {
  id: 'prop-1',
  title: 'Estimate: water heater for Priya',
  summary: 'Water heater install.',
  explanation: 'Drafted from chat.',
  confidence: 'High',
  type: 'Estimate',
  status: 'Pending',
  proposalType: 'draft_estimate',
  editFields: [{ label: 'Notes', key: 'notes', value: '' }],
};

describe('chat proposal card actions are ≥44px tap targets', () => {
  it.each(['Approve', 'Edit', 'Dismiss'])('%s is min-h-11', (name) => {
    render(<AIProposalCard proposal={estimate} />);
    expect(screen.getByRole('button', { name: new RegExp(`^${name}$`) }).className).toContain('min-h-11');
  });

  // At 320px the three ≥44px buttons are wider than the card; on one row
  // Dismiss was pushed past the card's clipped edge (measured: right edge
  // at 332px). The row must wrap.
  it('the action row wraps so no button is pushed off a 320px card', () => {
    render(<AIProposalCard proposal={estimate} />);
    const row = screen.getByRole('button', { name: /^Dismiss$/ }).parentElement!;
    expect(row.className).toContain('flex-wrap');
  });

  it('a long unbroken token in the title or summary wraps instead of being clipped', () => {
    render(<AIProposalCard proposal={estimate} />);
    expect(screen.getByText(estimate.title).className).toContain('break-words');
    expect(screen.getByText(estimate.summary).className).toContain('break-words');
  });

  it.each(['Save & apply', 'Cancel'])('the edit form\'s %s is min-h-11', (name) => {
    render(<AIProposalCard proposal={estimate} />);
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getByRole('button', { name: new RegExp(`^${name}$`) }).className).toContain('min-h-11');
  });
});
