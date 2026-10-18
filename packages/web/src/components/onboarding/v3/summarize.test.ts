import { describe, expect, it } from 'vitest';
import { OnboardingDraftSchema, type OnboardingDraft } from '@ai-service-os/shared';
import draftJson from './__fixtures__/draft.plumbing-cle.json';
import { CHOICE_COUNT, dollars, pricesNote, readbackRows, readyRows, resolveChoice, typicalShopPhrase } from './summarize';

const draft = OnboardingDraftSchema.parse(draftJson);
const withChoices = (choices: OnboardingDraft['choices']): OnboardingDraft => ({ ...draft, choices });

describe('summarize', () => {
  it('pins the fixture to the shared contract and counts seven core choices', () => {
    expect(draft.assembled.choices.length).toBe(8);
    expect(CHOICE_COUNT).toBe(7);
  });

  it('formats whole dollars without cents and keeps real cents', () => {
    expect(dollars(8900)).toBe('$89');
    expect(dollars(8950)).toBe('$89.50');
    expect(dollars(123400)).toBe('$1,234');
  });

  it('resolves a choice: default, picked option, then override', () => {
    expect(resolveChoice(draft, 'booking_posture')).toMatchObject({ label: 'Book it on the call', source: 'a', isMostShops: true });
    expect(resolveChoice(withChoices({ booking_posture: { option: 'b' } }), 'booking_posture')).toMatchObject({
      label: 'Hold it for me',
      source: 'b',
      isMostShops: false,
    });
    expect(
      resolveChoice(withChoices({ greeting: { override: { label: 'Walsh, go ahead', writes: { voiceGreeting: 'Walsh, go ahead' } } } }), 'greeting'),
    ).toMatchObject({ label: 'Walsh, go ahead', source: 'override', isMostShops: false });
    expect(resolveChoice(draft, 'greeting')?.key).toBe('greeting');
  });

  it('builds the Ready rows from the assembled shop, marking typical answers', () => {
    const rows = readyRows(draft);
    expect(rows.map((r) => r.label)).toEqual(['Answering as', 'To come out', 'Booking', 'Getting paid', 'Emergencies']);
    expect(rows[0].value).toBe('“Walsh Plumbing, how can I help?”');
    expect(rows[1].value).toBe('$89, then $150 an hour');
    expect(rows[2].value).toBe('Monday to Saturday, 7 to 5. Book it on the call.');
    expect(rows.every((r) => r.mostShops)).toBe(true);
  });

  it('does not mark a row whose answer is not the typical one', () => {
    const rows = readyRows(withChoices({ booking_posture: { option: 'b' }, payment_collection_mode: { option: 'b' } }));
    expect(rows.find((r) => r.id === 'booking')?.mostShops).toBe(false);
    expect(rows.find((r) => r.id === 'payment_collection_mode')?.mostShops).toBe(false);
    expect(rows.find((r) => r.id === 'greeting')?.mostShops).toBe(true);
  });

  it('builds one read-back row per core choice, in the order Rivet asks them', () => {
    const rows = readbackRows(draft);
    expect(rows.map((r) => r.key)).toEqual([
      'greeting',
      'trip_fee_and_rate',
      'booking_posture',
      'payment_collection_mode',
      'booking_hours',
      'emergency_target',
      'after_hours_mode',
    ]);
    const price = rows.find((r) => r.key === 'trip_fee_and_rate');
    expect(price?.value).toBe('$89 to come out, $150 an hour after');
    expect(price?.note).toBe('Typical for Cleveland plumbers. Most new owners start here and adjust after a few jobs.');
    expect(rows.filter((r) => r.note)).toHaveLength(1);
  });

  it('shows the picked price and an override as the owner chose them, without the "typical" note on an override', () => {
    const picked = readbackRows(withChoices({ trip_fee_and_rate: { option: 'b' } })).find((r) => r.key === 'trip_fee_and_rate');
    expect(picked?.value).toBe('$129 to come out, $185 an hour after');
    expect(picked?.note).toBeDefined();

    const overridden = readbackRows(
      withChoices({
        trip_fee_and_rate: { override: { label: '$95, then $140 an hour', writes: {}, prices: { tripFeeCents: 9500, hourlyRateCents: 14000 } } },
      }),
    ).find((r) => r.key === 'trip_fee_and_rate');
    expect(overridden?.value).toBe('$95 to come out, $140 an hour after');
    expect(overridden?.note).toBeUndefined();
  });

  it('drops the city when the prices are not that city’s', () => {
    const national: OnboardingDraft = { ...draft, assembled: { ...draft.assembled, showsCity: false, priceSource: 'national' } };
    expect(typicalShopPhrase(draft)).toBe('most Cleveland plumbing shops');
    expect(typicalShopPhrase(national)).toBe('most plumbing shops');
    expect(pricesNote(national)).toMatch(/^Typical for plumbers\./);
    const generic: OnboardingDraft = { ...national, assembled: { ...national.assembled, trade: 'generic' } };
    expect(typicalShopPhrase(generic)).toBe('most shops like yours');
    expect(pricesNote(generic)).toMatch(/^Typical for shops like yours\./);
  });
});
