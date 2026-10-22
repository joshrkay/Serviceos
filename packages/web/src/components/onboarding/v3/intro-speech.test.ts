import { describe, expect, it } from 'vitest';
import {
  askFor,
  cellReadback,
  confirmMiss,
  matchTrade,
  nameHeard,
  nextIntroStep,
  parseSpokenCell,
  spokenBusinessName,
  tradeAmbiguous,
  tradeHeard,
} from './intro-speech';

describe('spokenBusinessName', () => {
  it.each([
    ['Walsh Plumbing', 'Walsh Plumbing'],
    ['Walsh Plumbing.', 'Walsh Plumbing'],
    ['walsh plumbing', 'Walsh Plumbing'],
    ["It's Walsh Plumbing.", 'Walsh Plumbing'],
    ['its walsh plumbing', 'Walsh Plumbing'],
    ["We're called Lakeside Heating and Air.", 'Lakeside Heating and Air'],
    ['The name is Bright Spark Electric', 'Bright Spark Electric'],
    ['My business is called A1 HVAC', 'A1 HVAC'],
    ['Um, uh, Walsh Plumbing', 'Walsh Plumbing'],
    ['McNeil and Sons', 'McNeil and Sons'],
    ['j and j electric', 'J and J Electric'],
    ['Call It Done Handyman', 'Call It Done Handyman'],
  ])('%j is the name %j', (said, name) => {
    expect(spokenBusinessName(said)).toBe(name);
  });

  it.each([
    ['W A L S H', 'Walsh'],
    ['W-A-L-S-H Plumbing', 'Walsh Plumbing'],
    ['w a l s h plumbing', 'Walsh Plumbing'],
    ['A B C Plumbing', 'ABC Plumbing'],
    ['A.B.C. Plumbing', 'ABC Plumbing'],
    ['Walsh, W-A-L-S-H, Plumbing', 'Walsh Plumbing'],
  ])('joins spelled letters: %j is %j', (said, name) => {
    expect(spokenBusinessName(said)).toBe(name);
  });

  it('keeps a single letter as a word ("A Plus Plumbing")', () => {
    expect(spokenBusinessName('A Plus Plumbing')).toBe('A Plus Plumbing');
  });

  it.each(['', '   ', 'um', 'Uh.', '...'])('finds no name in %j', (said) => {
    expect(spokenBusinessName(said)).toBeNull();
  });

  it('keeps a lead-in that is the whole answer as the name rather than dropping everything', () => {
    // "Called" alone is too little to be a lead-in: there is nothing after it.
    expect(spokenBusinessName('Called')).toBe('Called');
  });

  it('caps the name at the field length', () => {
    expect(spokenBusinessName(`Walsh ${'x'.repeat(200)}`)!.length).toBe(120);
  });
});

describe('matchTrade', () => {
  it.each([
    ['plumbing', 'plumbing'],
    ["I'm a plumber.", 'plumbing'],
    ['We do drains and sewer work', 'plumbing'],
    ['HVAC', 'hvac'],
    ['H V A C', 'hvac'],
    ['heating and cooling', 'hvac'],
    ['AC', 'hvac'],
    ['a c repair', 'hvac'],
    ['air conditioning', 'hvac'],
    ['furnaces', 'hvac'],
    ['electrician', 'electrical'],
    ['Electrical.', 'electrical'],
    ['something else', 'other'],
    ['Other', 'other'],
    ['roofing', 'other'],
    ['garage doors', 'other'],
    ['we do landscaping', 'other'],
    ['no, plumbing', 'plumbing'],
    ['not plumbing, HVAC', 'hvac'],
    ["we don't do HVAC, just electrical", 'electrical'],
  ])('%j is %s', (said, packId) => {
    expect(matchTrade(said)).toEqual({ kind: 'trade', packId });
  });

  it('never picks one when two trades are named, and lists them in chip order', () => {
    expect(matchTrade('plumbing, heating and air')).toEqual({ kind: 'ambiguous', packIds: ['plumbing', 'hvac'] });
    expect(matchTrade('electrical and plumbing')).toEqual({ kind: 'ambiguous', packIds: ['plumbing', 'electrical'] });
    expect(matchTrade('plumbing, or something else')).toEqual({ kind: 'ambiguous', packIds: ['plumbing', 'other'] });
  });

  it.each([
    ['plumbing and remodeling', 'plumbing'],
    ['plumbing contractor', 'plumbing'],
    ['electrical contractor', 'electrical'],
    ['window AC', 'hvac'],
    ['air duct cleaning', 'hvac'],
    ['solar electric', 'electrical'],
    ['water heaters', 'plumbing'],
    ['septic', 'plumbing'],
    ['mechanical', 'hvac'],
    ['general contractor', 'other'],
    ['contractor', 'other'],
  ])('a named trade beats a word for other work: %j is %s', (said, packId) => {
    expect(matchTrade(said)).toEqual({ kind: 'trade', packId });
  });

  it.each(['banana', '', 'um', 'I am not sure', 'repair'])('hears no trade in %j', (said) => {
    expect(matchTrade(said)).toEqual({ kind: 'none' });
  });
});

describe('parseSpokenCell', () => {
  it.each([
    ['216-555-0142', '(216) 555-0142'],
    ['(216) 555-0142', '(216) 555-0142'],
    ['2165550142', '(216) 555-0142'],
    ['My cell is 216 555 0142.', '(216) 555-0142'],
    ['two one six five five five zero one four two', '(216) 555-0142'],
    ['two one six, five five five, oh one four two', '(216) 555-0142'],
    ['two one six double five five zero one four two', '(216) 555-0142'],
    ['two one six triple five zero one forty two', '(216) 555-0142'],
    ['+1 216 555 0142', '(216) 555-0142'],
    ['plus one two one six five five five zero one four two', '(216) 555-0142'],
    ['1-216-555-0142', '(216) 555-0142'],
    ['Oh, it is 216-555-0142', '(216) 555-0142'],
    ['(216) 555-0142 ext. 3', '(216) 555-0142'],
    ['216-555-0142 extension 12', '(216) 555-0142'],
    ['216-555-0142, 216-555-0142', '(216) 555-0142'],
    ['My number is 216 555 0142 and my office is 216 555 0100', '(216) 555-0142'],
  ])('%j is %j', (said, display) => {
    expect(parseSpokenCell(said)).toEqual({ kind: 'cell', display });
  });

  it.each([
    ['555-0142', '5550142'],
    ['five five five zero one four two', '5550142'],
    ['+44 20 7946 0958', '+442079460958'],
    ['016-555-0142', '0165550142'],
    ['216-555-0142-99', '216555014299'],
    ['21655501421234567', '21655501421234567'],
  ])('%j is digits but not a US cell', (said, digits) => {
    expect(parseSpokenCell(said)).toEqual({ kind: 'not_us', digits });
  });

  it.each(['', 'I do not know', 'hang on'])('hears no number in %j', (said) => {
    expect(parseSpokenCell(said)).toEqual({ kind: 'none' });
  });
});

describe('cellReadback', () => {
  it('reads the cell digit by digit in its three groups', () => {
    expect(cellReadback('(216) 555-0142')).toBe('2 1 6, 5 5 5, 0 1 4 2');
    expect(cellReadback('+1 216 555 0142')).toBe('2 1 6, 5 5 5, 0 1 4 2');
  });
});

describe('nextIntroStep', () => {
  it('asks for the name, then the trade, then the cell, then checks', () => {
    expect(nextIntroStep({ name: '', packId: null, cellOk: false })).toBe('name');
    expect(nextIntroStep({ name: '  ', packId: 'hvac', cellOk: true })).toBe('name');
    expect(nextIntroStep({ name: 'Walsh', packId: null, cellOk: true })).toBe('trade');
    expect(nextIntroStep({ name: 'Walsh', packId: 'hvac', cellOk: false })).toBe('cell');
    expect(nextIntroStep({ name: 'Walsh', packId: 'hvac', cellOk: true })).toBe('confirm');
  });
});

describe('what Rivet says', () => {
  const answers = { name: 'Walsh Plumbing', packId: 'plumbing', cell: '(216) 555-0142' };

  it('asks one question a step, and reads the whole form back on the check', () => {
    expect(askFor('name', answers)).toEqual(["What's your business called?"]);
    expect(askFor('spell', answers)).toEqual(['Go ahead and spell it, letter by letter.']);
    expect(askFor('trade', answers)).toEqual(["What's your trade: plumbing, HVAC, electrical, or something else?"]);
    expect(askFor('cell', answers)).toEqual(["What's your cell number, with the area code?"]);
    expect(askFor('confirm', answers)).toEqual([
      'Walsh Plumbing, plumbing, and your cell is 2 1 6, 5 5 5, 0 1 4 2.',
      'Say “show me my shop”, or fix anything above.',
    ]);
    expect(askFor('confirm', { ...answers, packId: 'other' })[0]).toBe(
      'Walsh Plumbing, something else, and your cell is 2 1 6, 5 5 5, 0 1 4 2.',
    );
  });

  it('reads the name back with the ways to fix it', () => {
    expect(nameHeard('Walsh Plumbing')).toBe("I've got Walsh Plumbing. If that's not right, say “spell it”, or type it above.");
  });

  it('acknowledges the trade, and asks which when two were named', () => {
    expect(tradeHeard('hvac')).toBe('Got it, HVAC.');
    expect(tradeHeard('other')).toBe('Got it.');
    expect(tradeAmbiguous(['plumbing', 'hvac'])).toBe('I heard plumbing and HVAC. Which one do you do most?');
    expect(tradeAmbiguous(['plumbing', 'hvac', 'electrical'])).toBe(
      'I heard plumbing, HVAC, and electrical. Which one do you do most?',
    );
  });

  it('says what it heard on the check when the answer was not a command', () => {
    expect(confirmMiss(' banana ')).toBe('I heard “banana”. Say “show me my shop”, or fix anything above.');
  });
});
