/**
 * Tradesperson wave 1, Task 2 review fixes — UpdateCatalogItemTaskHandler.
 *
 * Covers the quality-review findings: reuse of `resolveLineItemToCatalog`
 * (ai/resolution/catalog-resolver.ts) instead of a hand-rolled substring
 * matcher, flat-key `missingFields` entries (never prose — see
 * missing-fields.ts `clearSatisfiedMissingFields`, which only lifts a gate
 * on an EXACT flat-key edit), ambiguous-match candidates surfaced on
 * `sourceContext.entityCandidates`, and the rename/description honest-no-op
 * behavior (see the class doc comment in voice-extended-tasks.ts).
 */
import { describe, it, expect } from 'vitest';
import { UpdateCatalogItemTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { InMemoryCatalogItemRepository, createCatalogItem } from '../../../src/catalog/catalog-item';
import { MAX_UNIT_PRICE_CENTS } from '../../../src/proposals/contracts/add-catalog-item';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { approveProposal, editProposal } from '../../../src/proposals/actions';

const TENANT_ID = 't-1';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT_ID,
    userId: 'u-1',
    message: 'update the catalog',
    ...overrides,
  };
}

async function seededRepo(
  items: Array<{ name: string; unitPriceCents: number }>,
): Promise<InMemoryCatalogItemRepository> {
  const repo = new InMemoryCatalogItemRepository();
  for (const item of items) {
    await repo.create(
      createCatalogItem({
        tenantId: TENANT_ID,
        name: item.name,
        category: 'Labor',
        unit: 'each',
        unitPriceCents: item.unitPriceCents,
      }),
    );
  }
  return repo;
}

describe('UpdateCatalogItemTaskHandler', () => {
  it('a unique high-tier match with a stated price resolves ungated', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC diagnostic fee', unitPriceCents: 7900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'diagnostic fee', unitPriceCents: 8900 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.catalogItemId).toBeTruthy();
    expect(payload.currentUnitPriceCents).toBe(7900);
    expect(payload.proposedUnitPriceCents).toBe(8900);
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('an ambiguous match (prefix-shadowed sibling) gates with a FLAT catalogItemId key and surfaces candidates', async () => {
    const catalogRepo = await seededRepo([
      { name: 'AC tune-up', unitPriceCents: 8900 },
      { name: 'AC tune-up deluxe', unitPriceCents: 14900 },
    ]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: 9900 } }),
    );

    // Flat key — never a prose string. clearSatisfiedMissingFields only
    // lifts a gate on an exact flat-key edit; a prose entry could never
    // clear.
    expect(missingFieldsFor(proposal)).toContain('catalogItemId');
    // Flat means NO `.` and NO `[` — the two shapes
      // `clearSatisfiedMissingFields` skips (missing-fields.ts) and
      // `editFieldsForMissing` filters out. Absence of SPACES, which this
      // used to assert, is neither necessary nor sufficient.
      expect(
        missingFieldsFor(proposal).every((f) => !f.includes('.') && !f.includes('[')),
      ).toBe(true);

    const sourceContext = proposal.sourceContext as Record<string, unknown>;
    const candidates = sourceContext.entityCandidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBe(2);
    expect(candidates.map((c) => c.label)).toEqual(
      expect.arrayContaining(['AC tune-up', 'AC tune-up deluxe']),
    );
    expect(sourceContext.entityKind).toBe('catalogItem');
    expect(sourceContext.entityReference).toBe('AC tune-up');
    expect(proposal.explanation).toMatch(/no confident single match/i);
  });

  it('zero matches gates with a FLAT catalogItemId key and no candidates', async () => {
    const catalogRepo = await seededRepo([{ name: 'Water heater install', unitPriceCents: 145000 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'flux capacitor', unitPriceCents: 500 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('catalogItemId');
    const sourceContext = proposal.sourceContext as Record<string, unknown> | undefined;
    expect(sourceContext?.entityCandidates).toBeUndefined();
    expect(proposal.explanation).toMatch(/no catalog item matches/i);
  });

  it('an absent catalogRepo gates catalogItemId (no resolution attempted)', async () => {
    const { proposal } = await new UpdateCatalogItemTaskHandler(undefined).handle(
      ctx({ existingEntities: { catalogItemReference: 'diagnostic fee', unitPriceCents: 8900 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('catalogItemId');
  });

  it('a rename-only request (no price) resolves the item, sets an honest no-op price, and never writes payload.name to the requested value', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({
        existingEntities: {
          catalogItemReference: 'AC tune-up',
          catalogItemNewName: 'AC seasonal service',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    // No price change requested ⇒ proposed === current (a real, honest
    // value — never fabricated), and the "what to change" gate does NOT
    // fire (a name change is a real spoken change, even though it can't
    // execute through this proposal type today).
    expect(payload.proposedUnitPriceCents).toBe(8900);
    expect(payload.currentUnitPriceCents).toBe(8900);
    expect(missingFieldsFor(proposal)).not.toContain('proposedUnitPriceCents');
    // The contract's `name` field is the item's CURRENT name (informational,
    // per the contract's own doc comment) — never the requested new one,
    // which cannot execute through this proposal type. It rides `explanation`
    // instead so the reviewer sees the ask without being told it applied.
    expect(payload.name).toBe('AC tune-up');
    expect(proposal.explanation).toMatch(/requested new name: "AC seasonal service"/i);
    expect(proposal.explanation).toMatch(/catalog screen/i);
  });

  it('the no-change-field gate fires (FLAT proposedUnitPriceCents key) when neither price, name, nor description was stated', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'AC tune-up' } }),
    );

    expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
    expect(proposal.explanation).toMatch(/no price, name, or description change was stated/i);
  });

  it('a negative unitPriceCents is not trusted as a real price change (mirrors the durationMinutes guard)', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: -500 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    // Falls back to the current price (no fabricated change) and the
    // no-change gate fires, since no OTHER change field was stated either.
    expect(payload.proposedUnitPriceCents).toBe(8900);
    expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
  });

  // Quality-review fix (2026-08-09, "I4") — mirrors add_catalog_item's own
  // MAX_UNIT_PRICE_CENTS ceiling: both intents write the SAME
  // catalog_items.unit_price_cents column from the SAME spoken
  // unitPriceCents field, so a misheard "290 thousand" must gate here
  // exactly as it does on the create side.
  //
  // Follow-up fix (2026-08-09, same day) — the ceiling was REMOVED from
  // `updateCatalogItemPayloadSchema` itself (contracts/update-catalog-item.ts)
  // because `proposedUnitPriceCents` also carries never-spoken values from
  // the correction-repetition loop and this handler's own no-price-change
  // fallback, and a shared contract ceiling wrongly rejected those. That
  // makes THIS TEST (and the exactly-ceiling test below it) the sole
  // remaining enforcement proof of the misheard-figure ceiling for this
  // intent — it no longer "mirrors" add_catalog_item's contract-level test,
  // it IS the enforcement. DO NOT DELETE AS A REDUNDANT MIRROR: nothing
  // else fails if this gate silently regresses.
  it('a unitPriceCents above the sanity ceiling is not trusted as a real price change', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({
        existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: MAX_UNIT_PRICE_CENTS + 1 },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    // Falls back to the current price (no fabricated change) and the
    // no-change gate fires, since no OTHER change field was stated either
    // — same collapsing behavior the negative-price test above pins.
    expect(payload.proposedUnitPriceCents).toBe(8900);
    expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
  });

  it('a unitPriceCents of exactly the sanity ceiling is trusted as a real price change', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({
        existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: MAX_UNIT_PRICE_CENTS },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.proposedUnitPriceCents).toBe(MAX_UNIT_PRICE_CENTS);
    expect(missingFieldsFor(proposal)).not.toContain('proposedUnitPriceCents');
  });

  it('a fractional unitPriceCents is rounded to the nearest cent, mirroring the durationMinutes guard', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: 45.5 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.proposedUnitPriceCents).toBe(46);
    // A real (rounded) price change was stated, so the no-change gate
    // does not fire.
    expect(missingFieldsFor(proposal)).not.toContain('proposedUnitPriceCents');
  });

  /**
   * Follow-up to PR #816 — a spoken price the drafting gate REFUSES must
   * never just disappear.
   *
   * The gate above collapses an untrusted spoken figure to "no price change"
   * (proposed === current). On its own that was visible: with nothing else
   * spoken, the no-change gate fired and the proposal could not be approved.
   * But a name/description change is ALSO a "real change", so it suppressed
   * that gate — and the operator got a rename proposal with the price they
   * spoke silently thrown away, on an APPROVAL surface.
   *
   * The fix keeps drafting (option b) rather than refusing the whole
   * utterance with a clarification (option a): the catalog item resolved and
   * a real rename was heard, and this handler's established posture for a
   * partially-extracted utterance is a FLAT `missingFields` key plus a prose
   * reason on `explanation` (see class doc note 3 and the ambiguous-match
   * tests above), not a `voice_clarification` that discards everything
   * extracted and makes the operator re-speak. A clarification card is what
   * Task 13 reached for when there was NOTHING to draft; that is not this.
   *
   * `missingFields` is what makes it non-silent rather than merely
   * documented: `approveProposal` blocks on the tracked list, so the
   * one-tap approval of a proposal that dropped a spoken price is
   * impossible, and `clearSatisfiedMissingFields` lifts the gate on an exact
   * flat-key edit — the operator's recovery is one edit, not a re-utterance.
   */
  describe('a spoken price the gate refuses is surfaced, never silently dropped', () => {
    it('gates and names the discarded figure when an over-ceiling price rides ALONG WITH a name change', async () => {
      const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
      const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
        ctx({
          existingEntities: {
            catalogItemReference: 'AC tune-up',
            unitPriceCents: 29_000_000, // misheard "two ninety" -> $290000.00
            catalogItemNewName: 'AC seasonal service',
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      // Still a real draft (option b) — the resolved item and the rename ask
      // both survive; nothing about the utterance is thrown away.
      expect(payload.catalogItemId).toBeTruthy();
      expect(proposal.explanation).toMatch(/requested new name: "AC seasonal service"/i);
      // The untrusted figure NEVER lands on the executable field.
      expect(payload.proposedUnitPriceCents).toBe(8900);
      // ...but the operator cannot approve past it, and is told why.
      expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
      // Flat means NO `.` and NO `[` — the two shapes
      // `clearSatisfiedMissingFields` skips (missing-fields.ts) and
      // `editFieldsForMissing` filters out. Absence of SPACES, which this
      // used to assert, is neither necessary nor sufficient.
      expect(
        missingFieldsFor(proposal).every((f) => !f.includes('.') && !f.includes('[')),
      ).toBe(true);
      expect(proposal.explanation).toMatch(/\$290,000\.00/);
      expect(proposal.explanation).toMatch(/not applied/i);
    });

    it('gates and names the discarded figure when a negative price rides along with a description change', async () => {
      const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
      const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
        ctx({
          existingEntities: {
            catalogItemReference: 'AC tune-up',
            unitPriceCents: -500,
            catalogItemNewDescription: 'Full seasonal inspection',
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.proposedUnitPriceCents).toBe(8900);
      expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
      expect(proposal.explanation).toMatch(/not applied/i);
      expect(proposal.explanation).toMatch(/requested new description: "full seasonal inspection"/i);
    });

    it('stops claiming "no price was stated" when a price WAS stated and refused', async () => {
      const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
      const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
        ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: 29_000_000 } }),
      );

      // The gate itself was already correct here (nothing else was spoken, so
      // the no-change gate fired) — the WORDING was a lie: the operator did
      // state a price and was told they hadn't.
      expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
      expect(proposal.explanation).not.toMatch(/no price, name, or description change was stated/i);
      expect(proposal.explanation).toMatch(/\$290,000\.00/);
      expect(proposal.explanation).toMatch(/\$100,000\.00/); // the limit it exceeded
    });

    /**
     * Review N7 — the over-ceiling branch names the figure it dropped; the
     * negative/invalid branch did not. A spoken `-$5.00` is as much a
     * mishearing worth showing the operator as `$290,000.00` is, and the
     * asymmetry meant half the refusals said only "a price that is not
     * valid" with no way to tell WHAT was heard.
     */
    it('names the refused figure on the negative/invalid branch too, not just the over-ceiling one', async () => {
      const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
      const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
        ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: -500 } }),
      );

      expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
      expect(proposal.explanation).toMatch(/-\$5\.00/);
      expect(proposal.explanation).toMatch(/not applied/i);
    });

    /**
     * Review N8 — `Number.isFinite` admits up to 1.79e308, so an ASR figure
     * that absurd reached the echo. `toFixed` goes exponential at >=1e21
     * ("Heard a price of $1e+306") and `Intl` renders a 300-digit wall;
     * neither is something to put on an approval card.
     */
    it('does not echo an absurd ASR figure verbatim', async () => {
      const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
      const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
        ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: 1e306 } }),
      );

      expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
      expect(proposal.explanation).not.toMatch(/e\+/i);
      // Nothing longer than a plausible money string reaches the card.
      expect(proposal.explanation!.length).toBeLessThan(400);
      expect(proposal.explanation).toMatch(/not applied/i);
    });

    it('gates only once — an unresolvable item AND a refused price do not double-push the price key', async () => {
      const catalogRepo = await seededRepo([{ name: 'Water heater install', unitPriceCents: 145000 }]);
      const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
        ctx({ existingEntities: { catalogItemReference: 'flux capacitor', unitPriceCents: 29_000_000 } }),
      );

      const missing = missingFieldsFor(proposal);
      expect(missing).toContain('catalogItemId');
      expect(missing.filter((f) => f === 'proposedUnitPriceCents')).toHaveLength(1);
    });
  });

  /**
   * Review N14 — the gate's whole justification is "the operator's recovery
   * is one field edit, not a re-utterance". That claim had never been
   * tested end to end, and on the web chat surface it turned out to be
   * FALSE (the card posts the edit as a STRING against a `z.number()`
   * field). This pins the server half of the claim so the client half has
   * something true to be measured against. Precedent:
   * test/ai/tasks/brand-voice-task.test.ts.
   */
  describe('the refused-price gate has a real unblock path', () => {
    it('an exact flat-key edit clears the gate and the proposal then approves', async () => {
      const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
      const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
        ctx({
          existingEntities: {
            catalogItemReference: 'AC tune-up',
            unitPriceCents: 29_000_000,
            catalogItemNewName: 'AC seasonal service',
          },
        }),
      );
      expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');

      const proposalRepo = new InMemoryProposalRepository();
      await proposalRepo.create({ ...proposal, status: 'ready_for_review' });

      // The gate is REAL: approval is refused while it stands.
      await expect(
        approveProposal(proposalRepo, TENANT_ID, proposal.id, 'u-owner', 'owner'),
      ).rejects.toThrow();

      // An unrelated edit does not lift it — clear-on-fill only lifts the
      // entry for the EXACT key edited (missing-fields.ts).
      const afterUnrelated = await editProposal(
        proposalRepo,
        TENANT_ID,
        proposal.id,
        'u-owner',
        'owner',
        { name: 'AC tune-up' },
      );
      expect(missingFieldsFor(afterUnrelated.proposal)).toContain('proposedUnitPriceCents');

      // Editing the gated key itself clears it. NOTE the NUMBER: the payload
      // field is `z.number()` and `editProposal` re-validates the merged
      // payload, so a string would fail with "Invalid payload after edit".
      const afterEdit = await editProposal(
        proposalRepo,
        TENANT_ID,
        proposal.id,
        'u-owner',
        'owner',
        { proposedUnitPriceCents: 29_000_000 },
      );
      expect(missingFieldsFor(afterEdit.proposal)).toEqual([]);

      // …and the proposal an operator deliberately priced at $290,000 is now
      // approvable: the ceiling is a SPOKEN-price gate, not a contract bound.
      const approved = await approveProposal(
        proposalRepo,
        TENANT_ID,
        proposal.id,
        'u-owner',
        'owner',
      );
      expect(approved.status).toBe('approved');
      expect((approved.payload as Record<string, unknown>).proposedUnitPriceCents).toBe(29_000_000);
    });

    it('rejects a STRING edit of the cents key — the shape the web chat card was sending', async () => {
      const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
      const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
        ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: 29_000_000 } }),
      );
      const proposalRepo = new InMemoryProposalRepository();
      await proposalRepo.create({ ...proposal, status: 'ready_for_review' });

      await expect(
        editProposal(proposalRepo, TENANT_ID, proposal.id, 'u-owner', 'owner', {
          proposedUnitPriceCents: '29000000',
        }),
      ).rejects.toThrow(/Invalid payload after edit/);
    });
  });

  it('a description-only request resolves the item and rides explanation, never a fabricated payload field', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({
        existingEntities: {
          catalogItemReference: 'AC tune-up',
          catalogItemNewDescription: 'Full seasonal inspection and coil clean',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.description).toBeUndefined();
    expect(missingFieldsFor(proposal)).not.toContain('proposedUnitPriceCents');
    expect(proposal.explanation).toMatch(/requested new description: "full seasonal inspection and coil clean"/i);
  });
});
