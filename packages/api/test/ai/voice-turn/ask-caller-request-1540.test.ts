/**
 * #1540 §2 — which ask_caller answers carry a request worth classifying.
 * Identity-only answers skip the classify call (no model latency, no wait on
 * a down gateway); request-bearing ones — the corpus's unknown-caller lines —
 * are carried forward.
 */
import { describe, it, expect } from 'vitest';
import { askCallerUtteranceCarriesRequest } from '../../../src/ai/voice-turn/ask-caller-request';

describe('#1540 §2 — askCallerUtteranceCarriesRequest', () => {
  it.each([
    'Casey Rivera, 12 Oak Street',
    'My name is Jane Smith.',
    "It's Jane Smith, 12 Oak Street.",
    'Hi, this is Dana Reyes',
    'Me llamo Rosa Méndez',
    '',
  ])('identity only: %j → no request', (utterance) => {
    expect(askCallerUtteranceCarriesRequest(utterance)).toBe(false);
  });

  it.each([
    "Hi, I'd like to schedule service for my home.",
    "I'd like to sign up as a new customer. My name is Jane Smith.",
    'Add a new customer, Mario Delingo, 412 Oak Street, Scottsdale, 85254.',
    'Hi, my name is Dana Reyes and my furnace stopped heating, can someone come out Tuesday at 2pm?',
    'My name is Casey Rivera. Please send the Henderson invoice to me right now.',
    'What do I owe?',
    'Necesito una cita para el martes',
  ])('carries a request: %j', (utterance) => {
    expect(askCallerUtteranceCarriesRequest(utterance)).toBe(true);
  });
});
