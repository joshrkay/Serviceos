import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TextWordingSheet, previewWording, type TextWordingSheetApi } from './TextWordingSheet';
import type { TextWordingState, WordingVersion } from '../../api/textWording';

function version(ours: string, saved: string | null = null): WordingVersion {
  return { ours, addedLines: [], saved: saved ? { body: saved, updatedAt: '2026-10-22T12:00:00Z' } : null };
}

function state(over: Partial<TextWordingState> = {}): TextWordingState {
  return {
    language: 'en',
    languages: ['en', 'es'],
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
        byLanguage: {
          en: version('Hi Sam Rivera, your estimate from Acme HVAC is ready.'),
          es: version('Hola Sam Rivera, su presupuesto de Acme HVAC está listo.'),
        },
      },
      {
        purpose: 'thank_you_text',
        fillIns: ['customer_name', 'business_name'],
        sampleValues: { customer_name: 'Sam Rivera', business_name: 'Acme HVAC' },
        byLanguage: {
          en: version('Thanks for choosing Acme HVAC!', 'Thanks {{customer_name}}!'),
          es: version('¡Gracias por elegir Acme HVAC!'),
        },
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

    expect(await screen.findByTestId('wording-estimate_text-en-status')).toHaveTextContent('Our wording');
    expect(screen.getByTestId('wording-estimate_text-en-preview')).toHaveTextContent(
      'Hi Sam Rivera, your estimate from Acme HVAC is ready.',
    );
    expect(screen.getByTestId('wording-thank_you_text-en-status')).toHaveTextContent('Your wording');
    expect(screen.getByTestId('wording-thank_you_text-en-preview')).toHaveTextContent('Thanks Sam Rivera!');
  });

  it('a fill-in chip adds the fill-in, the preview follows, and Save sends the wording', async () => {
    const api = mockApi();
    render(<TextWordingSheet onClose={() => {}} api={api} />);
    const estimate = await screen.findByRole('region', { name: /estimate text/i });
    const box = within(estimate).getByLabelText(/estimate text wording/i);

    fireEvent.change(box, { target: { value: 'Your quote: ' } });
    fireEvent.click(within(estimate).getByRole('button', { name: '{{link}}' }));
    expect(box).toHaveValue('Your quote: {{link}}');
    expect(screen.getByTestId('wording-estimate_text-en-preview')).toHaveTextContent(
      'Your quote: https://app.example.com/e/sample',
    );

    fireEvent.click(within(estimate).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('estimate_text', 'Your quote: {{link}}', 'en'));
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

    expect(screen.getByTestId('wording-thank_you_text-en-preview')).toHaveTextContent('Thanks Sam Rivera!');
    expect(screen.getByTestId('wording-thank_you_text-en-cleared-hint')).toHaveTextContent(/Reset to ours/);
    expect(within(thanks).getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(within(thanks).getByText('Your wording')).toBeInTheDocument();
  });

  it('Reset to ours clears the wording and the card goes back to ours', async () => {
    const api = mockApi();
    render(<TextWordingSheet onClose={() => {}} api={api} />);
    const thanks = await screen.findByRole('region', { name: /thank-you text/i });

    fireEvent.click(within(thanks).getByRole('button', { name: /reset to ours/i }));

    await waitFor(() => expect(api.reset).toHaveBeenCalledWith('thank_you_text', 'en'));
    expect(await within(thanks).findByText('Our wording')).toBeInTheDocument();
    expect(within(thanks).getByLabelText(/thank-you text wording/i)).toHaveValue('');
    expect(screen.getByTestId('wording-thank_you_text-en-preview')).toHaveTextContent('Thanks for choosing Acme HVAC!');
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
    expect(await screen.findByTestId('wording-estimate_text-en-status')).toBeInTheDocument();
  });

  it("the preview ends with the lines every send adds (an invoice paid in person)", async () => {
    const invoice = {
      ...state().texts[0],
      purpose: 'invoice_text' as const,
      byLanguage: {
        en: { ...version('ours', 'Invoice {{number}}: {{link}}'), addedLines: ['Acme HVAC collects payment in person.'] },
        es: version('nuestro'),
      },
    };
    render(<TextWordingSheet onClose={() => {}} api={mockApi({ fetch: vi.fn().mockResolvedValue(state({ texts: [invoice] })) })} />);

    const preview = await screen.findByTestId('wording-invoice_text-en-preview');
    expect(preview.textContent).toBe('Invoice EST-1042: https://app.example.com/e/sample\nAcme HVAC collects payment in person.');
  });

  it('locks the box and fill-ins while a save is on its way, so nothing typed meanwhile is lost', async () => {
    let finish: (v: { body: string; updatedAt: string }) => void = () => {};
    const save = vi.fn(() => new Promise<{ body: string; updatedAt: string }>((r) => (finish = r)));
    render(<TextWordingSheet onClose={() => {}} api={mockApi({ save })} />);
    const estimate = await screen.findByRole('region', { name: /estimate text/i });
    const box = within(estimate).getByLabelText(/estimate text wording/i);

    fireEvent.change(box, { target: { value: 'Quote: {{link}}' } });
    fireEvent.click(within(estimate).getByRole('button', { name: /^save$/i }));

    expect(box).toHaveAttribute('readonly');
    expect(within(estimate).getByRole('button', { name: '{{link}}' })).toBeDisabled();
    finish({ body: 'Quote: {{link}}', updatedAt: '2026-10-22T13:00:00Z' });
    await waitFor(() => expect(box).not.toHaveAttribute('readonly'));
    expect(within(estimate).getByRole('button', { name: '{{link}}' })).toBeEnabled();
  });

  it('opens on the business language; Spanish shows its own wording, and saves and resets in Spanish', async () => {
    const api = mockApi();
    render(<TextWordingSheet onClose={() => {}} api={api} />);
    await screen.findByTestId('wording-estimate_text-en-status');

    expect(screen.getByRole('button', { name: /english \(main\)/i })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^spanish$/i }));

    const estimate = screen.getByRole('region', { name: /estimate text/i });
    expect(within(estimate).getByLabelText(/estimate text wording in spanish/i)).toHaveValue('');
    expect(screen.getByTestId('wording-estimate_text-es-preview')).toHaveTextContent('Hola Sam Rivera');
    // English has a saved thank-you; Spanish does not.
    expect(within(card(/thank-you text/i)).getByText('Our wording')).toBeInTheDocument();

    fireEvent.change(within(estimate).getByLabelText(/estimate text wording in spanish/i), {
      target: { value: 'Su presupuesto: {{link}}' },
    });
    fireEvent.click(within(estimate).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('estimate_text', 'Su presupuesto: {{link}}', 'es'));
    expect(await within(estimate).findByText('Your wording')).toBeInTheDocument();
    fireEvent.click(within(estimate).getByRole('button', { name: /reset to ours/i }));
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith('estimate_text', 'es'));
  });

  it('switching language keeps what was typed in the other one', async () => {
    render(<TextWordingSheet onClose={() => {}} api={mockApi()} />);
    const estimate = await screen.findByRole('region', { name: /estimate text/i });
    fireEvent.change(within(estimate).getByLabelText(/estimate text wording in english/i), {
      target: { value: 'Draft {{link}}' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^spanish$/i }));
    fireEvent.click(screen.getByRole('button', { name: /english/i }));

    expect(screen.getByLabelText(/estimate text wording in english/i)).toHaveValue('Draft {{link}}');
  });

  it('a Spanish business opens on Spanish', async () => {
    render(<TextWordingSheet onClose={() => {}} api={mockApi({ fetch: vi.fn().mockResolvedValue(state({ language: 'es' })) })} />);
    expect(await screen.findByRole('button', { name: /spanish \(main\)/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: /estimate text/i })).toContainElement(
      screen.getByLabelText(/estimate text wording in spanish/i),
    );
  });

  it('every button is at least 44px tall (min-h-11)', async () => {
    render(<TextWordingSheet onClose={() => {}} api={mockApi()} />);
    await screen.findByTestId('wording-estimate_text-en-status');
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toMatch(/\bmin-h-11\b/);
    }
  });
});
