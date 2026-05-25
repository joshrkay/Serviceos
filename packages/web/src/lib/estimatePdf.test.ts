import { describe, it, expect, vi, afterEach } from 'vitest';
import { printEstimateDocument } from './estimatePdf';

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
  estimateNumber: 'EST-001',
  customerName: 'Alice Smith',
  businessName: 'Fieldly Pro Services',
  lineItems: [
    { description: 'Labor', qty: 2, rate: 95 },
    { description: 'Part', qty: 1, rate: 150 },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('printEstimateDocument', () => {
  it('writes a document with the estimate number and formatted totals, then prints', () => {
    const { win, writes } = makeFakeWindow();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    const ok = printEstimateDocument(base);
    expect(ok).toBe(true);
    expect(openSpy).toHaveBeenCalled();

    const html = writes.join('');
    expect(html).toContain('EST-001');
    expect(html).toContain('Alice Smith');
    // 2 × $95 + 1 × $150 = $340.00, formatted with cents.
    expect(html).toContain('$340.00');
    expect(html).toContain('$190.00'); // line total for labor
  });

  it('escapes HTML in user-entered fields', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    printEstimateDocument({
      ...base,
      lineItems: [{ description: '<script>alert(1)</script>', qty: 1, rate: 10 }],
    });

    const html = writes.join('');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('returns false when the popup is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(printEstimateDocument(base)).toBe(false);
  });

  it('uses an explicit total override when provided', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    printEstimateDocument({ ...base, totalDollars: 999 });
    expect(writes.join('')).toContain('$999.00');
  });
});
