// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceLookupAnswer } from '@ai-service-os/shared';

const h = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
}));

// eslint-disable-next-line import/first
import { AnswerCard, answerDeepLink, answerRowsToLabelValues } from './AnswerCard';

const CUSTOMER_ID = '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1';

const balanceAnswer: VoiceLookupAnswer = {
  version: 1,
  intent: 'lookup_balance',
  result: 'found',
  summary: 'Your current balance is $123.45 across 2 open invoices.',
  rows: [
    { kind: 'money', label: 'Outstanding balance', amountCents: 12345 },
    { kind: 'count', label: 'Open invoices', count: 2 },
    { kind: 'text', label: 'Oldest due', text: 'Jul 28' },
  ],
  entityRef: { kind: 'customer', id: CUSTOMER_ID },
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('answerRowsToLabelValues', () => {
  it('formats money rows from integer cents via the canonical formatter', () => {
    const rows = answerRowsToLabelValues(balanceAnswer.rows);
    expect(rows).toEqual([
      { label: 'Outstanding balance', value: '$123.45' },
      { label: 'Open invoices', value: '2' },
      { label: 'Oldest due', value: 'Jul 28' },
    ]);
  });
});

describe('answerDeepLink', () => {
  it('maps entity kinds to read screens (detail when an id is present)', () => {
    expect(answerDeepLink(balanceAnswer)).toEqual({
      href: `/customers/${CUSTOMER_ID}`,
      label: 'View customer',
    });
    expect(
      answerDeepLink({ ...balanceAnswer, entityRef: { kind: 'invoice' } }),
    ).toEqual({ href: '/invoices', label: 'View invoices' });
    expect(
      answerDeepLink({ ...balanceAnswer, entityRef: { kind: 'appointment' } }),
    ).toEqual({ href: '/schedule', label: 'Open schedule' });
    // Agreements land on customer detail until the U10 screen exists.
    expect(
      answerDeepLink({ ...balanceAnswer, entityRef: { kind: 'agreement', id: CUSTOMER_ID } }),
    ).toEqual({ href: `/customers/${CUSTOMER_ID}`, label: 'View customer' });
    expect(answerDeepLink({ ...balanceAnswer, entityRef: undefined })).toBeNull();
  });
});

describe('AnswerCard', () => {
  it('renders the summary, formatted money rows, and a >=44px deep link', () => {
    const { getByText } = render(createElement(AnswerCard, { answer: balanceAnswer }));

    expect(getByText(/current balance is \$123\.45/)).toBeTruthy();
    expect(getByText('$123.45')).toBeTruthy();
    expect(getByText('Open invoices')).toBeTruthy();

    const link = getByText('View customer').closest('button')!;
    expect(link.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(link);
    expect(h.push).toHaveBeenCalledWith(`/customers/${CUSTOMER_ID}`);
  });

  it('renders a "nothing found" answer without a deep link', () => {
    const answer: VoiceLookupAnswer = {
      version: 1,
      intent: 'lookup_invoices',
      result: 'none',
      summary: 'No open invoices right now.',
      rows: [],
      entityRef: { kind: 'invoice' },
    };
    const { getByText, queryByText, container } = render(
      createElement(AnswerCard, { answer }),
    );
    expect(getByText('No open invoices right now.')).toBeTruthy();
    expect(queryByText('View invoices')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders a refusal answer as copy only — no rows, no link', () => {
    const answer: VoiceLookupAnswer = {
      version: 1,
      intent: 'lookup_revenue',
      result: 'refused',
      summary: "That's an owner-level report.",
      rows: [],
    };
    const { getByText, container } = render(createElement(AnswerCard, { answer }));
    expect(getByText('Not available')).toBeTruthy();
    expect(getByText("That's an owner-level report.")).toBeTruthy();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
