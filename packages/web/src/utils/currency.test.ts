import { describe, it, expect } from 'vitest';
import { formatCurrency, formatCurrencyAmount } from './currency';

/**
 * Canonical money formatter contract.
 *
 * Pre-fix, `centsToDisplay` used `.toFixed(2)` and produced `$1000.00`
 * (no thousands separator). `InvoicePaymentPage` had its own ad-hoc
 * `.toLocaleString` helper that did the right thing only there.
 * These tests lock in the unified behavior:
 *
 *  - `formatCurrency(cents)` returns "$X,XXX.XX" with grouping separator.
 *  - `formatCurrencyAmount(cents)` returns the same number without the
 *    currency symbol, for the case where surrounding JSX already prints
 *    the symbol.
 *  - Both keep trailing zero cents (`$50.00`, never `$50`).
 *  - Both render negatives with the minus before the symbol.
 */

describe('formatCurrency', () => {
  it('formats whole dollar amounts under one thousand', () => {
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(100)).toBe('$1.00');
    expect(formatCurrency(5000)).toBe('$50.00');
    expect(formatCurrency(99999)).toBe('$999.99');
  });

  it('adds a comma thousands separator at and above 1000 dollars', () => {
    expect(formatCurrency(100000)).toBe('$1,000.00');
    expect(formatCurrency(123450)).toBe('$1,234.50');
    expect(formatCurrency(1000000)).toBe('$10,000.00');
    expect(formatCurrency(1234567890)).toBe('$12,345,678.90');
  });

  it('preserves trailing zero cents (never collapses to "$50")', () => {
    expect(formatCurrency(5000)).toBe('$50.00');
    expect(formatCurrency(100000)).toBe('$1,000.00');
  });

  it('rounds odd cents to two decimal places', () => {
    expect(formatCurrency(199)).toBe('$1.99');
    expect(formatCurrency(150099)).toBe('$1,500.99');
  });

  it('renders negative amounts with the minus before the symbol', () => {
    expect(formatCurrency(-500)).toBe('-$5.00');
    expect(formatCurrency(-100000)).toBe('-$1,000.00');
  });
});

describe('formatCurrencyAmount', () => {
  it('returns the formatted number without a currency symbol', () => {
    expect(formatCurrencyAmount(0)).toBe('0.00');
    expect(formatCurrencyAmount(5000)).toBe('50.00');
    expect(formatCurrencyAmount(123450)).toBe('1,234.50');
  });

  it('uses thousands separators above 999', () => {
    expect(formatCurrencyAmount(100000)).toBe('1,000.00');
    expect(formatCurrencyAmount(1234567890)).toBe('12,345,678.90');
  });

  it('keeps the minus sign on negatives', () => {
    expect(formatCurrencyAmount(-500)).toBe('-5.00');
    expect(formatCurrencyAmount(-100000)).toBe('-1,000.00');
  });
});
