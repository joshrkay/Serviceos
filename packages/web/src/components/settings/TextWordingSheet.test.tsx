import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TextWordingSheet, previewWording, type TextWordingSheetApi } from './TextWordingSheet';
import type { TextWordingState } from '../../api/textWording';

function state(over: Partial<TextWordingState> = {}): TextWordingState {
  return {
    language: 'en',
    maxLength: 480,
    texts: [
      {
        purpose: 'estimate_text',
        fillIns: ['customer_name', 'business_name', 'number', 'total', 'link'],
        sampleValues: {
          customer_name: 'Sam Rivera',
          business_name: 'Acme HVAC',
          number: 'EST-1042',
          total: '$485.00',
          link: 'https://app.example.com/e/sample',
        },
        ours: 'Hi Sam Rivera, your estimate from Acme HVAC is ready.',
        saved: null,
      },
      {
        purpose: 'thank_you_text',
        fillIns: ['customer_name', 'business_name'],
        sampleValues: { customer_name: 'Sam Rivera', business_name: 'Acme HVAC' },
        ours: 'Thanks for choosing Acme HVAC!',
        saved: { body: 'Thanks {{customer_name}}!', updatedAt: '2026-10-22T12:00:00Z' },
      },
    ],
    ...over,
  };
}

function mockApi(over: Partial<TextWordingSheetApi> = {}): TextWordingSheetApi {
  return {
    fetch: vi.fn().mockResolvedValue(state()),
    save: vi.fn(async (_p, body: string) => ({ body: body.trim(), updatedAt: '2026-10-22T13:00:00Z' })),
    reset: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function card(name: RegExp) {
  return screen.getByRole('region', { name });
}

describe('previewWording', () => {
  it('fills known fill-ins and leaves unknown ones as typed', () => {
    expect(previewWording(' Hi {{ customer_name }} {{oops}} ', { customer_name: 'Sam' })).toBe('Hi Sam {{oops}}');
  });
});

describe('D-045 — TextWordingSheet', () => {
  it("shows our wording where the owner hasn't written one, and theirs where they have", async () => {
    render(<TextWordingSheet onClose={() => {}} api={mockApi()} />);

    expect(await screen.findByTestId('wording-estimate_text-status')).toHaveTextContent('Our wording');
    expect(screen.getByTestId('wording-estimate_text-preview')).toHaveTextContent(
      'Hi Sam Rivera, your estimate from Acme HVAC is ready.',
    );
    expect(screen.getByTestId('wording-thank_you_text-status')).toHaveTextContent('Your wording');
    expect(screen.getByTestId('wording-thank_you_text-preview')).toHaveTextContent('Thanks Sam Rivera!');
  });

  it('a fill-in chip adds the fill-in, the preview follows, and Save sends the wording', async () => {
    const api = mockApi();
    render(<TextWordingSheet onClose={() => {}} api={api} />);
    const estimate = await screen.findByRole('region', { name: /estimate text/i });
    const box = within(estimate).getByLabelText(/estimate text wording/i);

    fireEvent.change(box, { target: { value: 'Your quote: ' } });
    fireEvent.click(within(estimate).getByRole('button', { name: '{{link}}' }));
    expect(box).toHaveValue('Your quote: {{link}}');
    expect(screen.getByTestId('wording-estimate_text-preview')).toHaveTextContent(
      'Your quote: https://app.example.com/e/sample',
    );

    fireEvent.click(within(estimate).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('estimate_text', 'Your quote: {{link}}'));
    expect(await within(card(/estimate text/i)).findByText('Your wording')).toBeInTheDocument();
  });

  it("shows the API's reasons when a save is refused", async () => {
    const refused = Object.assign(new Error('Include {{link}} so the customer can open it.'), {
      problems: ['Include {{link}} so the customer can open it.'],
    });
    const api = mockApi({ save: vi.fn().mockRejectedValue(refused) });
    render(<TextWordingSheet onClose={() => {}} api={api} />);
    const estimate = await screen.findByRole('region', { name: /estimate text/i });

    fireEvent.change(within(estimate).getByLabelText(/estimate text wording/i), { target: { value: 'Ready!' } });
    fireEvent.click(within(estimate).getByRole('button', { name: /^save$/i }));

    expect(await within(estimate).findByRole('alert')).toHaveTextContent('Include {{link}} so the customer can open it.');
    expect(within(estimate).getByText('Our wording')).toBeInTheDocument();
  });

  it('Save is off until something changed; Reset to ours only shows for a saved wording', async () => {
    render(<TextWordingSheet onClose={() => {}} api={mockApi()} />);
    const estimate = await screen.findByRole('region', { name: /estimate text/i });

    expect(within(estimate).getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(within(estimate).queryByRole('button', { name: /reset to ours/i })).not.toBeInTheDocument();
    expect(within(card(/thank-you text/i)).getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('clearing the box on a saved wording still shows what customers get: the saved wording', async () => {
    render(<TextWordingSheet onClose={() => {}} api={mockApi()} />);
    const thanks = await screen.findByRole('region', { name: /thank-you text/i });

    fireEvent.change(within(thanks).getByLabelText(/thank-you text wording/i), { target: { value: '' } });

    expect(screen.getByTestId('wording-thank_you_text-preview')).toHaveTextContent('Thanks Sam Rivera!');
    expect(screen.getByTestId('wording-thank_you_text-cleared-hint')).toHaveTextContent(/Reset to ours/);
    expect(within(thanks).getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(within(thanks).getByText('Your wording')).toBeInTheDocument();
  });

  it('Reset to ours clears the wording and the card goes back to ours', async () => {
    const api = mockApi();
    render(<TextWordingSheet onClose={() => {}} api={api} />);
    const thanks = await screen.findByRole('region', { name: /thank-you text/i });

    fireEvent.click(within(thanks).getByRole('button', { name: /reset to ours/i }));

    await waitFor(() => expect(api.reset).toHaveBeenCalledWith('thank_you_text'));
    expect(await within(thanks).findByText('Our wording')).toBeInTheDocument();
    expect(within(thanks).getByLabelText(/thank-you text wording/i)).toHaveValue('');
    expect(screen.getByTestId('wording-thank_you_text-preview')).toHaveTextContent('Thanks for choosing Acme HVAC!');
  });

  it('a failed reset says so and keeps the wording', async () => {
    const api = mockApi({ reset: vi.fn().mockRejectedValue(new Error('Network down')) });
    render(<TextWordingSheet onClose={() => {}} api={api} />);
    const thanks = await screen.findByRole('region', { name: /thank-you text/i });

    fireEvent.click(within(thanks).getByRole('button', { name: /reset to ours/i }));

    expect(await within(thanks).findByRole('alert')).toHaveTextContent('Network down');
    expect(within(thanks).getByText('Your wording')).toBeInTheDocument();
  });

  it('a failed load says so and offers to try again', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('')).mockResolvedValueOnce(state());
    render(<TextWordingSheet onClose={() => {}} api={mockApi({ fetch })} />);

    expect(await screen.findByText('The text wording could not be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByTestId('wording-estimate_text-status')).toBeInTheDocument();
  });

  it('every button is at least 44px tall (min-h-11)', async () => {
    render(<TextWordingSheet onClose={() => {}} api={mockApi()} />);
    await screen.findByTestId('wording-estimate_text-status');
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toMatch(/\bmin-h-11\b/);
    }
  });
});
