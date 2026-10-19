/**
 * S3-2 (plan U4) — the choice registry stays inside the one-turn batch caps.
 *
 * `POST /api/voice/tts/batch` speaks one turn (the question plus two option
 * lines) and refuses an item over TTS_BATCH_MAX_ITEM_CHARS or a turn over
 * TTS_BATCH_MAX_TURN_CHARS. The registry schema's own ceilings (question 140,
 * rivetLine 260) are looser than those caps, so this test is the guard: it
 * renders every trade's turns through the production renderer at the longest
 * substitutions the draft contract allows and fails the content PR that
 * outgrows either cap. It also pins the measured maxima so content drift is
 * visible in the diff rather than silent until it crosses a cap.
 *
 * Substitution ceilings: `{businessName}` 120 and `{ownerFirstName}` 60 come
 * from CreateOnboardingDraftBodySchema (packages/shared); `{city}` 40 is the
 * longest US metro name with room; `{tripFee}` / `{hourlyRate}` `$1,000.00`
 * is a test fixture (cents carry no upper bound in the schema), wide enough
 * for any price a trade pack ships.
 */
import { describe, it, expect } from 'vitest';
import { CHOICE_REGISTRY, REGISTRY_TRADES } from '../../../src/onboarding/choices/registry';
import { renderTemplate, type TemplateTokens } from '../../../src/onboarding/choices/assemble';
import {
  TTS_BATCH_MAX_ITEM_CHARS,
  TTS_BATCH_MAX_ITEMS,
  TTS_BATCH_MAX_TURN_CHARS,
} from '../../../src/ai/tts/tts-batch';

const LONGEST: TemplateTokens = {
  businessName: 'B'.repeat(120),
  ownerFirstName: 'O'.repeat(60),
  tripFee: '$1,000.00',
  hourlyRate: '$1,000.00',
  city: 'C'.repeat(40),
};

interface RenderedTurn {
  trade: string;
  settingKey: string;
  question: string;
  lines: string[];
}

function renderEveryTurn(): RenderedTurn[] {
  const turns: RenderedTurn[] = [];
  for (const trade of REGISTRY_TRADES) {
    for (const entry of CHOICE_REGISTRY[trade]) {
      turns.push({
        trade,
        settingKey: entry.settingKey,
        question: renderTemplate(entry.question, LONGEST),
        lines: entry.options.map((o) => renderTemplate(o.rivetLine, LONGEST)),
      });
    }
  }
  return turns;
}

const turnChars = (t: RenderedTurn) => t.question.length + t.lines.reduce((sum, l) => sum + l.length, 0);

describe('choice registry — inside the one-turn TTS batch caps (S3-2)', () => {
  const turns = renderEveryTurn();

  it('the caps are the ones the batch route enforces: 3 items, 240 per item, 600 per turn', () => {
    expect([TTS_BATCH_MAX_ITEMS, TTS_BATCH_MAX_ITEM_CHARS, TTS_BATCH_MAX_TURN_CHARS]).toEqual([3, 240, 600]);
  });

  it.each(REGISTRY_TRADES)('%s: every turn is a question plus two lines, so one batch request', (trade) => {
    for (const t of turns.filter((x) => x.trade === trade)) {
      expect(1 + t.lines.length, `${trade}/${t.settingKey}`).toBeLessThanOrEqual(TTS_BATCH_MAX_ITEMS);
    }
  });

  it.each(REGISTRY_TRADES)('%s: every rendered question and line at the longest names is within 240 characters', (trade) => {
    for (const t of turns.filter((x) => x.trade === trade)) {
      for (const item of [t.question, ...t.lines]) {
        expect(item.length, `${trade}/${t.settingKey}: "${item}"`).toBeLessThanOrEqual(TTS_BATCH_MAX_ITEM_CHARS);
      }
    }
  });

  it.each(REGISTRY_TRADES)('%s: every rendered turn at the longest names is within 600 characters in all', (trade) => {
    for (const t of turns.filter((x) => x.trade === trade)) {
      expect(turnChars(t), `${trade}/${t.settingKey}`).toBeLessThanOrEqual(TTS_BATCH_MAX_TURN_CHARS);
    }
  });

  it('pins the measured maxima so content drift shows in the diff (question / line template / rendered line / turn)', () => {
    let longestQuestionTemplate = 0;
    let longestLineTemplate = 0;
    for (const trade of REGISTRY_TRADES) {
      for (const entry of CHOICE_REGISTRY[trade]) {
        longestQuestionTemplate = Math.max(longestQuestionTemplate, entry.question.length);
        for (const o of entry.options) longestLineTemplate = Math.max(longestLineTemplate, o.rivetLine.length);
      }
    }
    const longestRenderedLine = Math.max(...turns.flatMap((t) => t.lines.map((l) => l.length)));
    const heaviest = turns.reduce((a, b) => (turnChars(b) > turnChars(a) ? b : a));

    expect({
      longestQuestionTemplate,
      longestLineTemplate,
      longestRenderedLine,
      heaviestTurnChars: turnChars(heaviest),
      heaviestTurn: `${heaviest.trade}/${heaviest.settingKey}`,
    }).toEqual({
      longestQuestionTemplate: 61,
      longestLineTemplate: 104,
      longestRenderedLine: 163,
      heaviestTurnChars: 362,
      heaviestTurn: 'plumbing/existing_number',
    });
  });
});
