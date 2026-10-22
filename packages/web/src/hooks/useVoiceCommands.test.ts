import { describe, it, expect } from 'vitest';
import { matchVoiceCommand } from './useVoiceCommands';
import { VOICE_EXAMPLES } from '../components/shared/voice-examples';

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
    ['Start a new job.', '/jobs/new'],
    ['add a new customer', '/customers/new'],
    ['create a new estimate', '/estimates/new'],
    ['add an estimate', '/estimates/new'],
    // #881: exact phrase the Home "New invoice" quick action submits via ?q=
    ['Create a new invoice', '/invoices/new'],
    ['new invoice', '/invoices/new'],
    ['add a bill', '/invoices/new'],
    ['new customer please', '/customers/new'],
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
    'add a note about the invoice',
  ];

  it.each(passThrough)('does not match %j', (transcript) => {
    expect(matchVoiceCommand(transcript)).toBeNull();
  });
});

describe('matchVoiceCommand — a command that says more goes to the assistant', () => {
  // A blank form would throw these details away; the assistant drafts or
  // answers them instead. The first is one of the voice bar's own hints.
  const carriesDetails = [
    'New customer Maria Alvarez, 480-555-0102',
    'Create an estimate for the Khan install, 3-ton condenser',
    'create a job for tomorrow',
    'Add a job for Maria Alvarez tomorrow at 9',
    'Create a new invoice for the Martins, water heater 1200',
    'Show me the jobs Carlos has today',
    'Open the Smith invoice and add a 90 dollar contactor',
    'show me unpaid invoices',
  ];

  it.each(carriesDetails)('does not match %j', (transcript) => {
    expect(matchVoiceCommand(transcript)).toBeNull();
  });
});

describe('matchVoiceCommand — the voice bar hints are never hijacked', () => {
  it.each(VOICE_EXAMPLES.map((e) => e.example))('%j reaches the assistant', (example) => {
    expect(matchVoiceCommand(example)).toBeNull();
  });
});
