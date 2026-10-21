import { describe, it, expect, vi } from 'vitest';
import { needsFieldNote, sendTechVoiceUpdate, suggestTechStatus } from './tech-voice';

describe('suggestTechStatus', () => {
  it.each([
    ['waiting on parts, should be done tomorrow', 'waiting'],
    ['Need to order a new blower motor, I will come back Thursday', 'waiting'],
    ['on my way to the Garcia job', 'en_route'],
    ["all done here, system's cooling", 'complete'],
    ['finished up, replaced the capacitor', 'complete'],
    ["I'm here, starting the job", 'in_progress'],
  ])('%j → %s', (text, status) => {
    expect(suggestTechStatus(text)).toBe(status);
  });

  it.each([
    'not done yet, still flushing the lines',
    'almost finished with the duct work',
    'replaced the 45/5 capacitor and a contactor',
    'customer wants a quote for a new condenser',
    'the job will be done after lunch',
  ])('%j suggests nothing', (text) => {
    expect(suggestTechStatus(text)).toBeUndefined();
  });
});

function fetcher(response: Response | Error) {
  return vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe('sendTechVoiceUpdate', () => {
  it('sends the words as a voice turn with this job as the open record', async () => {
    const apiFetch = fetcher(
      new Response(
        JSON.stringify({
          message: {
            content: 'Invoice: Ana Garcia, capacitor + 2h labor $412. Ready for review.',
            proposal: { id: 'p1', title: 'Invoice', proposalType: 'draft_invoice' },
          },
        }),
        { status: 200 },
      ),
    );
    const out = await sendTechVoiceUpdate(apiFetch, 'job-1', 'used a capacitor and two hours labor');
    expect(apiFetch).toHaveBeenCalledWith('/api/assistant/chat', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((apiFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'used a capacitor and two hours labor' }],
      inputMode: 'voice',
      pageContext: { entityType: 'job', entityId: 'job-1' },
      jobStatusHandled: true,
    });
    expect(out).toEqual({
      ok: true,
      reply: 'Invoice: Ana Garcia, capacitor + 2h labor $412. Ready for review.',
      draft: { id: 'p1', title: 'Invoice', proposalType: 'draft_invoice' },
    });
    expect(needsFieldNote(out)).toBe(true);
  });

  it('does not save the words twice when the assistant already approved them as a note', async () => {
    const out = await sendTechVoiceUpdate(
      fetcher(
        new Response(
          JSON.stringify({
            message: { content: 'Note added.', proposal: { id: 'p2', title: 'Note', proposalType: 'add_note', status: 'Approved' } },
          }),
          { status: 200 },
        ),
      ),
      'job-1',
      'note: gate code 4471',
    );
    expect(needsFieldNote(out)).toBe(false);
  });

  it('still saves the words when the note draft is only pending, since nothing here approves it', async () => {
    const out = await sendTechVoiceUpdate(
      fetcher(
        new Response(
          JSON.stringify({
            message: { content: 'Note drafted.', proposal: { id: 'p3', title: 'Note', proposalType: 'add_note', status: 'Pending' } },
          }),
          { status: 200 },
        ),
      ),
      'job-1',
      'note: gate code 4471',
    );
    expect(needsFieldNote(out)).toBe(true);
  });

  it('reports a failure on an error status, an empty reply or a network error', async () => {
    expect(await sendTechVoiceUpdate(fetcher(new Response('{}', { status: 500 })), 'j', 'x')).toEqual({ ok: false });
    expect(await sendTechVoiceUpdate(fetcher(new Response('{"message":{}}', { status: 200 })), 'j', 'x')).toEqual({ ok: false });
    expect(await sendTechVoiceUpdate(fetcher(new Error('offline')), 'j', 'x')).toEqual({ ok: false });
    expect(needsFieldNote({ ok: false })).toBe(true);
  });
});
