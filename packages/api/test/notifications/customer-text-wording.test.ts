import { describe, it, expect, vi } from 'vitest';
import {
  createCustomerTextWording,
  fillOwnerWording,
  InMemoryCustomerTextWordingRepository,
  MAX_WORDING_LENGTH,
  wordingProblems,
} from '../../src/notifications/customer-text-wording';

const TENANT = 'tenant-wording-1';

describe('wordingProblems', () => {
  it('accepts a wording that uses only its own fill-ins and carries the link', () => {
    expect(wordingProblems('invoice_text', 'Hi {{customer_name}}, invoice {{number}} for {{total}}: {{link}}')).toEqual([]);
    expect(wordingProblems('thank_you_text', 'Thanks from {{business_name}}!')).toEqual([]);
  });

  it('refuses a blank wording', () => {
    expect(wordingProblems('estimate_text', '   \n ')).toEqual(['Write the text, or reset to our wording.']);
  });

  it('names a fill-in the text has no value for, and lists the ones it has', () => {
    const [problem] = wordingProblems('portal_link_text', 'Hi {{customer_name}}, total {{total}} {{link}}');
    expect(problem).toMatch(/\{\{total\}\} can't be filled in here/);
    expect(problem).toMatch(/\{\{customer_name\}\}, \{\{business_name\}\}, \{\{link\}\}/);
  });

  it('requires the link on texts that exist to deliver one, but not on the thank-you', () => {
    expect(wordingProblems('estimate_text', 'Your estimate is ready')).toEqual(['Include {{link}} so the customer can open it.']);
    expect(wordingProblems('thank_you_text', 'Thanks!')).toEqual([]);
  });

  it.each(['Hi {{customer name}} {{link}}', 'Hi {{customer-name}} {{link}}', 'Hi {{}} {{link}}', 'Hi {{ customer_name } {{link}}', 'Hi {{{link}}}'])(
    'refuses anything brace-like that is not a whole fill-in: %s',
    (body) => {
      expect(wordingProblems('estimate_text', body)).toContainEqual(expect.stringMatching(/two braces each side/));
    },
  );

  it('accepts spaces inside a whole fill-in', () => {
    expect(wordingProblems('estimate_text', 'Hi {{ customer_name }}: {{ link }}')).toEqual([]);
  });

  it('caps the length', () => {
    const long = `{{link}} ${'a'.repeat(MAX_WORDING_LENGTH)}`;
    expect(wordingProblems('invoice_text', long)[0]).toMatch(/Keep it under 480 characters/);
  });
});

describe('fillOwnerWording', () => {
  it('fills values, puts the note on the second line and extra lines last', () => {
    expect(
      fillOwnerWording({
        body: 'Hi {{customer_name}}!\nPay here: {{link}}',
        values: { customer_name: 'Ana', link: 'https://x/pay/1' },
        note: '  Thanks for today ',
        extraLines: ['We collect payment in person.'],
      }),
    ).toBe('Hi Ana!\nThanks for today\nPay here: https://x/pay/1\nWe collect payment in person.');
  });

  it('a one-line wording gets the note after it', () => {
    expect(fillOwnerWording({ body: 'Pay: {{link}}', values: { link: 'L' }, note: 'See you' })).toBe('Pay: L\nSee you');
  });

  it('is null when a fill-in it uses has no value, or only spaces', () => {
    expect(fillOwnerWording({ body: 'Hi {{customer_name}} {{link}}', values: { link: 'L' } })).toBeNull();
    expect(fillOwnerWording({ body: 'Hi {{customer_name}} {{link}}', values: { link: 'L', customer_name: '  ' } })).toBeNull();
  });

  it("drops a value's own braces, so nothing placeholder-like reaches the customer", () => {
    expect(fillOwnerWording({ body: 'Hi {{customer_name}} {{link}}', values: { customer_name: '{{link}} Ana', link: 'L' } })).toBe(
      'Hi link Ana L',
    );
  });

  it('is null when a stored wording would still send a raw placeholder', () => {
    expect(fillOwnerWording({ body: 'Hi {{customer name}} {{link}}', values: { link: 'L' } })).toBeNull();
  });

  it('a value that is not text counts as missing', () => {
    expect(fillOwnerWording({ body: '{{number}} {{link}}', values: { number: null as unknown as string, link: 'L' } })).toBeNull();
  });
});

describe('createCustomerTextWording.textFor', () => {
  function setup() {
    const repo = new InMemoryCustomerTextWordingRepository();
    const logger = { warn: vi.fn() };
    return { repo, logger, wording: createCustomerTextWording({ repo, logger }) };
  }
  const base = {
    tenantId: TENANT,
    purpose: 'invoice_text' as const,
    customerLanguage: 'en' as const,
    values: { customer_name: 'Ana', link: 'https://x/pay/1' },
    builtIn: () => 'OURS',
  };

  it('uses ours when the owner has not written one', async () => {
    const { wording } = setup();
    expect(await wording.textFor(base)).toBe('OURS');
  });

  it("uses the owner's wording for a customer who reads the business's language", async () => {
    const { repo, wording } = setup();
    await repo.save(TENANT, 'invoice_text', 'Hey {{customer_name}}, {{link}}', 'en', 'user-1');
    expect(await wording.textFor(base)).toBe('Hey Ana, https://x/pay/1');
  });

  it("uses ours, translated, for a customer who reads another language", async () => {
    const { repo, wording } = setup();
    await repo.save(TENANT, 'invoice_text', 'Hey {{customer_name}}, {{link}}', 'en', 'user-1');
    const builtIn = vi.fn(() => 'NUESTRO');
    expect(await wording.textFor({ ...base, customerLanguage: 'es', builtIn })).toBe('NUESTRO');
  });

  it('goes by the language the wording was written in, so a business that switches language does not send it to the new language', async () => {
    const { repo, wording } = setup();
    // Written while the business was English; the business is Spanish now.
    await repo.save(TENANT, 'invoice_text', 'Hey {{customer_name}}, {{link}}', 'en', 'user-1');
    expect(await wording.textFor({ ...base, customerLanguage: 'es', builtIn: () => 'NUESTRO' })).toBe('NUESTRO');
    // Spanish wording goes to Spanish readers.
    await repo.save(TENANT, 'invoice_text', 'Hola {{customer_name}}, {{link}}', 'es', 'user-1');
    expect(await wording.textFor({ ...base, customerLanguage: 'es' })).toBe('Hola Ana, https://x/pay/1');
    expect(await wording.textFor(base)).toBe('OURS');
  });

  it('keeps purposes apart', async () => {
    const { repo, wording } = setup();
    await repo.save(TENANT, 'estimate_text', 'Estimate {{link}}', 'en', 'user-1');
    expect(await wording.textFor(base)).toBe('OURS');
  });

  it('sends ours and warns when the wording cannot be read', async () => {
    const { logger } = setup();
    const wording = createCustomerTextWording({
      repo: { find: async () => { throw new Error('db down'); } },
      logger,
    });
    expect(await wording.textFor(base)).toBe('OURS');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read/), expect.objectContaining({ error: 'db down' }));
  });

  it('sends ours and warns when a fill-in has no value for this send', async () => {
    const { repo, logger, wording } = setup();
    await repo.save(TENANT, 'invoice_text', 'Hey {{customer_name}}, {{link}}', 'en', 'user-1');
    expect(await wording.textFor({ ...base, values: { link: 'L' } })).toBe('OURS');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no value/), expect.objectContaining({ purpose: 'invoice_text' }));
  });
});
