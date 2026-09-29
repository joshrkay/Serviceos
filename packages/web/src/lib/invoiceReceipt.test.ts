import { describe, it, expect, vi, afterEach } from 'vitest';
import { printInvoiceReceipt } from './invoiceReceipt';

function makeFakeWindow() {
  const writes: string[] = [];
  return {
    writes,
    win: {
      document: { write: (s: string) => writes.push(s), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    } as unknown as Window,
  };
}

const base = {
  invoiceNumber: 'INV-0042',
  customerName: 'Alice Smith',
  businessName: 'Rivet Pro Services',
  lineItems: [{ description: 'Labor', quantity: 1, totalCents: 10_000 }],
  totals: { subtotalCents: 10_000, discountCents: 0, taxRateBps: 0, taxCents: 0, totalCents: 10_000 },
  amountPaidCents: 10_000,
  amountDueCents: 0,
  payments: [],
  formatDate: (iso: string) => iso,
  methodLabel: (m: string) => m,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('printInvoiceReceipt — #1402 §13 business address', () => {
  it('prints the business address under the business name, one line per line, escaped', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    printInvoiceReceipt({ ...base, businessAddress: '1200 W Main St\nMesa, AZ <85201>' });

    const html = writes.join('');
    expect(html).toContain(
      '<div class="muted address">1200 W Main St<br>Mesa, AZ &lt;85201&gt;</div>',
    );
    expect(html.indexOf('Rivet Pro Services')).toBeLessThan(html.indexOf('1200 W Main St'));
  });

  it('prints no address block when the tenant has none', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    printInvoiceReceipt(base);

    expect(writes.join('')).not.toContain('class="muted address"');
  });
});
