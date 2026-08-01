import { describe, expect, it } from 'vitest';
import { matchVoiceCommand } from './useVoiceCommands';

// Regression: ISSUE-004 / QA-067 — typed "show me today's schedule" fell
// through to the failing assistant provider instead of navigating.
// Found by /qa on 2026-07-25
// Report: .gstack/qa-reports/qa-report-app-therivetapp-com-2026-07-25.md
describe('assistant navigation command matching', () => {
  it('routes the production QA schedule phrase', () => {
    expect(matchVoiceCommand("show me today's schedule")).toEqual({
      route: '/schedule',
      label: 'Opening schedule',
    });
  });

  it('does not hijack ordinary scheduling conversation', () => {
    expect(matchVoiceCommand('Can you schedule an appointment for tomorrow?')).toBeNull();
  });
});
