import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

/**
 * Regression guard for the "unstyled dispatch board + conversation thread" bug:
 * TechnicianLane/AppointmentCard and MessageBubble/MessageInput ship with BEM
 * class names that previously had NO CSS behind them (index.css is the only
 * stylesheet), so those surfaces rendered unstyled. These assertions fail if a
 * key class loses its rule again — catching what the class-contract tests
 * (which only check markup) cannot.
 */
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8',
);

function defines(selector: string): boolean {
  // Matches a rule head like `.appointment-card {` or `.x, .y {` containing it.
  const re = new RegExp(`\\${selector}[^{}]*\\{`);
  return re.test(css);
}

describe('dispatch + conversation component styles are defined (not orphaned BEM)', () => {
  it('styles the dispatch lane + appointment card', () => {
    for (const sel of [
      '.technician-lane',
      '.technician-lane__header',
      '.technician-lane__appointments',
      '.appointment-card',
      '.appointment-card__header',
      '.appointment-card__time',
      '.appointment-card__customer',
      '.appointment-card__status',
    ]) {
      expect(defines(sel), `${sel} should have a CSS rule`).toBe(true);
    }
  });

  it('colours every appointment status the code branches on', () => {
    for (const status of ['scheduled', 'confirmed', 'in-progress', 'completed', 'canceled', 'no-show']) {
      expect(defines(`.appointment-card__status--${status}`), status).toBe(true);
    }
  });

  it('styles the conversation thread bubbles + composer', () => {
    for (const sel of [
      '.conversation-messages',
      '.message-bubble',
      '.message-header',
      '.message-content',
      '.message-input',
      '.message-input-field',
      '.message-send-button',
    ]) {
      expect(defines(sel), `${sel} should have a CSS rule`).toBe(true);
    }
  });

  it('keeps composer controls at ≥44px tap targets (min-height: 2.75rem)', () => {
    // The composer field + send button must stay finger-friendly.
    const block = css.slice(css.indexOf('.message-input-field'));
    expect(block).toMatch(/min-height:\s*2\.75rem/);
  });
});
