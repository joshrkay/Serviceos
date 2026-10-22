/**
 * S3-2 (plan U4), voice-only onboarding PR 2 — the choice registry, narrated,
 * stays inside the one-turn batch caps.
 *
 * `POST /api/voice/tts/batch` speaks one turn as `narrateTurn` builds it (the
 * question, a line per option with its reason and what callers hear, and which
 * one most shops pick) and refuses more than TTS_BATCH_MAX_ITEMS clips, a clip
 * over TTS_BATCH_MAX_ITEM_CHARS or a turn over TTS_BATCH_MAX_TURN_CHARS. The
 * registry schema's own ceilings are looser than those caps, so this test is
 * the guard: it narrates every trade's turns at the longest substitutions the
 * draft contract allows and fails the content PR that outgrows a cap. It also
 * pins the measured maxima so content drift is visible in the diff rather than
 * silent until it crosses a cap.
 *
 * Substitution ceilings: `{businessName}` 120 and `{ownerFirstName}` 60 come
 * from CreateOnboardingDraftBodySchema (packages/shared); `{city}` 40 is the
 * longest US metro name with room; `{tripFee}` / `{hourlyRate}` `$1,000.00`
 * is a test fixture (cents carry no upper bound in the schema), wide enough
 * for any price a trade pack ships.
 */
import { describe, it, expect } from 'vitest';
import { answerHelp, narrateTurn, type NarratedChoice, type OnboardingHelpRequest } from '@ai-service-os/shared';
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
  clips: string[];
}

function renderEveryChoice(): Array<{ trade: string; settingKey: string; choice: NarratedChoice }> {
  const choices: Array<{ trade: string; settingKey: string; choice: NarratedChoice }> = [];
  for (const trade of REGISTRY_TRADES) {
    for (const entry of CHOICE_REGISTRY[trade]) {
      const [a, b] = entry.options.map((o) => ({
        key: o.key,
        label: renderTemplate(o.label, LONGEST),
        detail: o.detail ? renderTemplate(o.detail, LONGEST) : undefined,
        rivetLine: renderTemplate(o.rivetLine, LONGEST),
      }));
      const choice: NarratedChoice = {
        question: renderTemplate(entry.question, LONGEST),
        supportLine: entry.supportLine ? renderTemplate(entry.supportLine, LONGEST) : undefined,
        explain: renderTemplate(entry.explain, LONGEST),
        example: renderTemplate(entry.example, LONGEST),
        options: [a, b],
        mostShops: entry.mostShops,
      };
      choices.push({ trade, settingKey: entry.settingKey, choice });
    }
  }
  return choices;
}

function renderEveryTurn(): RenderedTurn[] {
  return renderEveryChoice().map(({ trade, settingKey, choice }) => ({ trade, settingKey, clips: narrateTurn(choice) }));
}

const HELP: readonly OnboardingHelpRequest[] = ['repeat', 'explain', 'example', 'most_shops'];

/** Every help answer, on every turn — and the fallbacks a draft from before the explanations gets. */
function renderEveryHelpAnswer(): RenderedTurn[] {
  return renderEveryChoice().flatMap(({ trade, settingKey, choice }) =>
    HELP.flatMap((help) => [
      { trade, settingKey: `${settingKey}:${help}`, clips: answerHelp(choice, help) },
      { trade, settingKey: `${settingKey}:${help}:old-draft`, clips: answerHelp({ ...choice, explain: undefined, example: undefined }, help) },
    ]),
  );
}

const turnChars = (t: RenderedTurn) => t.clips.reduce((sum, c) => sum + c.length, 0);

describe('choice registry, narrated — inside the one-turn TTS batch caps', () => {
  const turns = renderEveryTurn();

  it('the caps are the ones the batch route enforces: 4 clips, 320 per clip, 900 per turn', () => {
    expect([TTS_BATCH_MAX_ITEMS, TTS_BATCH_MAX_ITEM_CHARS, TTS_BATCH_MAX_TURN_CHARS]).toEqual([4, 320, 900]);
  });

  it.each(REGISTRY_TRADES)('%s: every turn narrates in at most 4 clips, so one batch request', (trade) => {
    for (const t of turns.filter((x) => x.trade === trade)) {
      expect(t.clips.length, `${trade}/${t.settingKey}`).toBeLessThanOrEqual(TTS_BATCH_MAX_ITEMS);
    }
  });

  it.each(REGISTRY_TRADES)('%s: every narrated clip at the longest names is within 320 characters', (trade) => {
    for (const t of turns.filter((x) => x.trade === trade)) {
      for (const clip of t.clips) {
        expect(clip.length, `${trade}/${t.settingKey}: "${clip}"`).toBeLessThanOrEqual(TTS_BATCH_MAX_ITEM_CHARS);
      }
    }
  });

  it.each(REGISTRY_TRADES)('%s: every narrated turn at the longest names is within 900 characters in all', (trade) => {
    for (const t of turns.filter((x) => x.trade === trade)) {
      expect(turnChars(t), `${trade}/${t.settingKey}`).toBeLessThanOrEqual(TTS_BATCH_MAX_TURN_CHARS);
    }
  });

  it('pins the measured maxima so content drift shows in the diff (longest clip / heaviest turn)', () => {
    const longest = turns.flatMap((t) => t.clips.map((c) => ({ c, at: `${t.trade}/${t.settingKey}` }))).reduce((x, y) => (y.c.length > x.c.length ? y : x));
    const heaviest = turns.reduce((x, y) => (turnChars(y) > turnChars(x) ? y : x));
    expect({
      longestClipChars: longest.c.length,
      longestClip: longest.at,
      heaviestTurnChars: turnChars(heaviest),
      heaviestTurn: `${heaviest.trade}/${heaviest.settingKey}`,
    }).toEqual({
      longestClipChars: 315,
      longestClip: 'plumbing/emergency_target',
      heaviestTurnChars: 654,
      heaviestTurn: 'plumbing/existing_number',
    });
  });
});

describe('help answers ("what does that mean?", "give me an example"…) — inside the same caps', () => {
  const answers = renderEveryHelpAnswer();

  it('every answer is one batch request: at most 4 clips, 320 per clip, 900 in all', () => {
    for (const t of answers) {
      expect(t.clips.length, `${t.trade}/${t.settingKey}`).toBeLessThanOrEqual(TTS_BATCH_MAX_ITEMS);
      for (const clip of t.clips) {
        expect(clip.length, `${t.trade}/${t.settingKey}: "${clip}"`).toBeLessThanOrEqual(TTS_BATCH_MAX_ITEM_CHARS);
      }
      expect(turnChars(t), `${t.trade}/${t.settingKey}`).toBeLessThanOrEqual(TTS_BATCH_MAX_TURN_CHARS);
    }
  });

  it('every turn has its own explanation and example, and each ends by asking again', () => {
    for (const t of answers.filter((x) => !x.settingKey.endsWith(':old-draft'))) {
      expect(t.clips.at(-1), `${t.trade}/${t.settingKey}`).toMatch(/Which one\?$/);
    }
  });
});
