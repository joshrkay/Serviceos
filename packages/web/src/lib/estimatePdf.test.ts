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
  businessName: 'Rivet Pro Services',
  lineItems: [
    { description: 'Labor', qty: 2, rate: 95 },
    { description: 'Part', qty: 1, rate: 150 },
  ],
  totals: { subtotalCents: 34_000, discountCents: 0, taxRateBps: 0, taxCents: 0, totalCents: 34_000 },
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

  it('prints the supplied document totals verbatim (discount + tax), never a line re-sum (#1400)', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    printEstimateDocument({
      ...base,
      totals: { subtotalCents: 34_000, discountCents: 500, taxRateBps: 825, taxCents: 2_764, totalCents: 36_264 },
    });
    const html = writes.join('');
    expect(html).toContain('-$5.00');
    expect(html).toContain('Tax (8.25%)');
    expect(html).toContain('$27.64');
    expect(html).toMatch(/<span>Total<\/span>\s*<span>\$362\.64<\/span>/);
  });

  it('defaults the document label to "Estimate"', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    printEstimateDocument(base);
    const html = writes.join('');
    expect(html).toContain('<div class="label">Estimate</div>');
    expect(html).toContain('<title>Estimate EST-001</title>');
  });

  it('renders the tenant terminology label (Quote) when provided', () => {
    // 7.4 — the tenant word flows into the printed customer-facing document.
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    printEstimateDocument({ ...base, documentLabel: 'Quote' });
    const html = writes.join('');
    expect(html).toContain('<div class="label">Quote</div>');
    expect(html).toContain('<title>Quote EST-001</title>');
    expect(html).not.toContain('<div class="label">Estimate</div>');
  });

  it('EE-4 — renders a thumbnail for a line with an imageUrl and none otherwise', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    printEstimateDocument({
      ...base,
      lineItems: [
        { description: 'Heater', qty: 1, rate: 2500, imageUrl: 'https://cdn/heater.jpg' },
        { description: 'Labor', qty: 1, rate: 100 },
      ],
    });
    const html = writes.join('');
    expect(html).toContain('<img class="thumb" src="https://cdn/heater.jpg" alt="" />');
    // The image-less line renders text only (exactly one thumbnail total).
    expect(html.match(/class="thumb"/g)).toHaveLength(1);
  });

  it('EE-4 — escapes a malicious imageUrl (no attribute breakout)', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    printEstimateDocument({
      ...base,
      lineItems: [{ description: 'X', qty: 1, rate: 1, imageUrl: '"><script>alert(1)</script>' }],
    });
    const html = writes.join('');
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
  it('B7.5 — prints the descriptive unit beside the quantity', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    printEstimateDocument({
      ...base,
      lineItems: [
        { description: 'Deck staining', qty: 240, unit: 'sq ft', rate: 3.75 },
        { description: 'Prep labor', qty: 3, rate: 85 },
      ],
    });
    const html = writes.join('');
    expect(html).toContain('240 <span class="unit">sq ft</span>');
    // The unit-less line stays exactly as before — no stray markup.
    expect(html.match(/class="unit"/g)).toHaveLength(1);
    expect(html).toContain('<td class="num">3</td>');
  });

  it('B7.5 — the unit is descriptive: it changes no printed money', () => {
    const withUnit = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(withUnit.win as unknown as Window);
    printEstimateDocument({
      ...base,
      lineItems: [{ description: 'Deck staining', qty: 240, unit: 'sq ft', rate: 3.75 }],
    });
    const withoutUnit = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(withoutUnit.win as unknown as Window);
    printEstimateDocument({
      ...base,
      lineItems: [{ description: 'Deck staining', qty: 240, rate: 3.75 }],
    });
    // 240 x $3.75 = $900.00 either way.
    expect(withUnit.writes.join('')).toContain('$900.00');
    expect(withoutUnit.writes.join('')).toContain('$900.00');
  });

  it('B7.5 — escapes a malicious unit string', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    printEstimateDocument({
      ...base,
      lineItems: [{ description: 'X', qty: 1, unit: '<script>alert(1)</script>', rate: 1 }],
    });
    const html = writes.join('');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('printEstimateDocument — #1402 §13 business address', () => {
  it('prints the business address under the business name, one line per line, escaped', () => {
    const { win, writes } = makeFakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    printEstimateDocument({ ...base, businessAddress: '1200 W Main St\nMesa, AZ <85201>' });

    const html = writes.join('');
    expect(html).toContain(
      '<div class="muted address">1200 W Main St<br>Mesa, AZ &lt;85201&gt;</div>',
    );
    expect(html.indexOf('Rivet Pro Services')).toBeLessThan(html.indexOf('1200 W Main St'));
  });
});
