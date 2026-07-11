/**
 * WS5 — pure quote read-back unit matrix.
 *
 * These pin the EXACT strings the live voice agent speaks about money after
 * drafting an estimate. The invariant under test: a price is spoken ONLY when
 * every line is a clean catalog match; uncatalogued / ambiguous / unavailable
 * cases speak NO number; and at most one price is ever spoken.
 */
import { describe, it, expect } from 'vitest';
import {
  buildQuoteReadback,
  GENERIC_PROPOSAL_CONFIRMATION,
  UNCATALOGUED_QUOTE_READBACK,
  PER_LINE_READBACK_MAX_LINES,
  type QuoteReadbackLine,
} from '../../../src/ai/voice-turn/quote-readback';

const catalogLine = (
  description: string,
  unitPrice: number,
  quantity = 1,
): QuoteReadbackLine => ({ description, unitPrice, quantity, pricingSource: 'catalog' });

describe('buildQuoteReadback', () => {
  it('empty line items → generic confirmation (verbatim)', () => {
    expect(buildQuoteReadback({ lineItems: [], catalogAvailable: true })).toBe(
      GENERIC_PROPOSAL_CONFIRMATION,
    );
  });

  it('single catalogued line → one grounded price', () => {
    expect(
      buildQuoteReadback({
        lineItems: [catalogLine('Water Heater Replacement', 185000)],
        catalogAvailable: true,
      }),
    ).toBe(
      "For the Water Heater Replacement, that's typically $1850.00. I'll send the full quote to confirm.",
    );
  });

  it('single catalogued line honours quantity in the spoken total', () => {
    expect(
      buildQuoteReadback({
        lineItems: [catalogLine('Service Call', 12500, 2)],
        catalogAvailable: true,
      }),
    ).toBe("For the Service Call, that's typically $250.00. I'll send the full quote to confirm.");
  });

  it('two all-catalogued lines → per-line recital + total last (WS17 I2)', () => {
    const said = buildQuoteReadback({
      lineItems: [catalogLine('Water Heater Install', 85000), catalogLine('Gasket', 450, 2)],
      catalogAvailable: true,
    });
    expect(said).toBe(
      "The Water Heater Install is $850.00, and 2 Gaskets are $9.00 — that's $859.00 all together. I'll send the full quote to confirm.",
    );
    // WS17 I2 DELIBERATE RELAXATION: the pre-WS17 rule spoke exactly ONE
    // dollar figure for a multi-line quote (total only). A fully-catalogued
    // 2..N-line quote now recites each line + the total, so THREE figures are
    // spoken here (two lines + total). The no-number invariants below are
    // untouched — this relaxation only affects the all-catalogued path.
    expect(said.match(/\$/g)).toHaveLength(3);
    // The total is always the last figure spoken.
    expect(said.lastIndexOf('$859.00')).toBeGreaterThan(said.lastIndexOf('$9.00'));
  });

  it('three all-catalogued lines → per-line recital + total (Oxford join)', () => {
    const said = buildQuoteReadback({
      lineItems: [
        catalogLine('Water Heater Install', 85000),
        catalogLine('Gasket', 450),
        catalogLine('Smoke Detector', 8900, 3),
      ],
      catalogAvailable: true,
    });
    expect(said).toBe(
      "The Water Heater Install is $850.00, the Gasket is $4.50, and 3 Smoke Detectors are $267.00 — that's $1121.50 all together. I'll send the full quote to confirm.",
    );
    expect(said.match(/\$/g)).toHaveLength(4);
  });

  it('qty>1 pluralisation follows the standard small rules (+es, ies, +s)', () => {
    // s/x/z/ch/sh → +es
    expect(
      buildQuoteReadback({
        lineItems: [catalogLine('Junction Box', 2500, 2), catalogLine('Gasket', 450)],
        catalogAvailable: true,
      }),
    ).toBe(
      "2 Junction Boxes are $50.00, and the Gasket is $4.50 — that's $54.50 all together. I'll send the full quote to confirm.",
    );
    // consonant+y → ies
    expect(
      buildQuoteReadback({
        lineItems: [catalogLine('Valve Assembly', 7000, 3), catalogLine('Gasket', 450)],
        catalogAvailable: true,
      }),
    ).toBe(
      "3 Valve Assemblies are $210.00, and the Gasket is $4.50 — that's $214.50 all together. I'll send the full quote to confirm.",
    );
    // default +s
    expect(
      buildQuoteReadback({
        lineItems: [catalogLine('Smoke Detector', 8900, 2), catalogLine('Gasket', 450)],
        catalogAvailable: true,
      }),
    ).toBe(
      "2 Smoke Detectors are $178.00, and the Gasket is $4.50 — that's $182.50 all together. I'll send the full quote to confirm.",
    );
  });

  it('more than N all-catalogued lines → TOTAL only (recital would overwhelm)', () => {
    const lines = Array.from({ length: PER_LINE_READBACK_MAX_LINES + 1 }, (_, i) =>
      catalogLine(`Item ${i + 1}`, 1000),
    );
    const said = buildQuoteReadback({ lineItems: lines, catalogAvailable: true });
    expect(said).toBe(
      "That usually comes to about $40.00 all together. I'll send the full quote to confirm.",
    );
    // Total only → exactly one dollar figure.
    expect(said.match(/\$/g)).toHaveLength(1);
  });

  it('ANY uncatalogued line → NO numbers at all', () => {
    const said = buildQuoteReadback({
      lineItems: [
        catalogLine('Water Heater Install', 85000),
        { description: 'custom fabrication', pricingSource: 'uncatalogued' },
      ],
      catalogAvailable: true,
    });
    expect(said).toBe(UNCATALOGUED_QUOTE_READBACK);
    expect(said).not.toMatch(/\$/);
  });

  it('ANY ambiguous line → NO numbers at all', () => {
    const said = buildQuoteReadback({
      lineItems: [{ description: 'valve', pricingSource: 'ambiguous' }],
      catalogAvailable: true,
    });
    expect(said).toBe(UNCATALOGUED_QUOTE_READBACK);
    expect(said).not.toMatch(/\$/);
  });

  it('catalog unavailable → NO numbers even if a line looks priced', () => {
    const said = buildQuoteReadback({
      lineItems: [catalogLine('Water Heater Install', 85000)],
      catalogAvailable: false,
    });
    expect(said).toBe(UNCATALOGUED_QUOTE_READBACK);
    expect(said).not.toMatch(/\$/);
  });

  it('a catalog line missing its price is treated as un-priced → NO numbers', () => {
    const said = buildQuoteReadback({
      lineItems: [{ description: 'Water Heater Install', pricingSource: 'catalog' }],
      catalogAvailable: true,
    });
    expect(said).toBe(UNCATALOGUED_QUOTE_READBACK);
  });
});
