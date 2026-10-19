/**
 * Re-run repricing (U6). A template the owner saves is theirs: the template
 * PUT rewrites `lineItemTemplates` through the shared line schema, a strip-mode
 * Zod object, so the seeder's `seededUnitPriceCents` / `seededCatalogItemId`
 * keys do not survive the save and no line of that template is repriced
 * again. This pin exists so nobody adds the two keys to the schema thinking
 * they would be kept; the route half is in
 * test/integration/reprice-seeded.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { updateTemplateSchema } from '../../src/shared/contracts';

describe('the template save drops the seeded-price keys', () => {
  it('a PUT body that resends the seeded lines comes back without the two keys', () => {
    const parsed = updateTemplateSchema.parse({
      lineItemTemplates: [
        {
          description: 'AC repair labor',
          category: 'labor',
          defaultQuantity: 1,
          defaultUnitPriceCents: 11000,
          taxable: false,
          sortOrder: 1,
          isOptional: false,
          seededUnitPriceCents: 11000,
          seededCatalogItemId: '6f0c2a4e-6b1d-4c39-9a51-2f0a3b8e1c77',
        },
      ],
    });
    expect(parsed.lineItemTemplates).toEqual([
      {
        description: 'AC repair labor',
        category: 'labor',
        defaultQuantity: 1,
        defaultUnitPriceCents: 11000,
        taxable: false,
        sortOrder: 1,
        isOptional: false,
      },
    ]);
  });
});
