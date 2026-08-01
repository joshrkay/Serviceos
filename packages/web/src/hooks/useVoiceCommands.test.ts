import { describe, it, expect } from 'vitest';
import { matchVoiceCommand } from './useVoiceCommands';

describe('matchVoiceCommand — navigation intents route correctly', () => {
  const navCases: Array<[string, string]> = [
    ['show my schedule', '/schedule'],
    ['open the calendar', '/schedule'],
    ['go to jobs', '/jobs'],
    ["show today's jobs", '/jobs'],
    ['open clients', '/customers'],
    ['show customers', '/customers'],
    ['open estimates', '/estimates'],
    ['show me the quotes', '/estimates'],
    ['go to billing', '/invoices'],
    ['open invoices', '/invoices'],
    ['go home', '/'],
    ['home', '/'],
    ['dashboard', '/'],
    ['go to dashboard', '/'],
  ];

  it.each(navCases)('routes %j → %s', (transcript, route) => {
    expect(matchVoiceCommand(transcript)?.route).toBe(route);
  });

  const createCases: Array<[string, string]> = [
    ['new job', '/jobs/new'],
    ['create a job for tomorrow', '/jobs/new'],
    ['add a new customer', '/customers/new'],
    ['create a new estimate', '/estimates/new'],
    ['add an estimate', '/estimates/new'],
  ];

  it.each(createCases)('routes %j → %s', (transcript, route) => {
    expect(matchVoiceCommand(transcript)?.route).toBe(route);
  });

  const directCases: Array<[string, string]> = [
    ['jobs', '/jobs'],
    ['schedule', '/schedule'],
    ['invoices', '/invoices'],
  ];

  it.each(directCases)('direct page %j → %s', (transcript, route) => {
    expect(matchVoiceCommand(transcript)?.route).toBe(route);
  });
});

describe('matchVoiceCommand — dictation is NOT hijacked into navigation', () => {
  // These are the regressions the bare-keyword alternations caused: an ordinary
  // note that merely contains "home", "quote", "client", "customer", "billing",
  // etc. must fall through to the assistant (null), not navigate.
  const passThrough = [
    "add a note that the customer wasn't home",
    'text the client about their quote',
    'let the customer know we are running behind',
    'the invoice is ready but billing is on hold',
    'remind me to call about the estimate later',
    'note that the calendar invite was declined',
    'tell them the quote looks good',
  ];

  it.each(passThrough)('does not match %j', (transcript) => {
    expect(matchVoiceCommand(transcript)).toBeNull();
  });
});
