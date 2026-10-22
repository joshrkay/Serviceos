import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RivetVoiceContext, useRivetVoice } from '../../../hooks/useRivetVoice';
import { expectTapTarget } from '../../../test-utils/tap-target';
import { AnswerAsScreen, type AnswerAsScreenProps } from './AnswerAsScreen';
import { NAME_SETTLE_MS } from './intro-speech';

vi.mock('../../../lib/analytics', () => ({ trackFunnel: vi.fn(), track: vi.fn() }));

const WHY = 'I ring this number for emergencies, and your area code sets your prices. 10 digits with the area code.';
const NOT_A_US_CELL = "That doesn't look like a US cell number. Include the area code, 10 digits.";
const REFUSED = 'That does not look like a US cell number. Include the 10-digit area code, for example (216) 555-0100.';

const go = () => screen.getByRole('button', { name: 'Show me my shop' });
const cellField = () => screen.getByLabelText('Your cell');

/** A name and a trade, so the cell is the only thing between the owner and the button. */
async function nameAndTrade() {
  await userEvent.type(screen.getByLabelText('Business name'), 'Walsh');
  await userEvent.click(screen.getByRole('button', { name: 'HVAC' }));
}

describe('AnswerAsScreen', () => {
  it('asks what to answer as and offers the four trade chips', () => {
    render(<AnswerAsScreen onSubmit={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'What should I answer as?' })).toBeInTheDocument();
    for (const name of ['Plumbing', 'HVAC', 'Electrical', 'Something else']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('keeps the button off until there is a name, a trade and a cell, and marks the chosen chip', async () => {
    render(<AnswerAsScreen onSubmit={vi.fn()} />);
    expect(go()).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Business name'), 'Walsh Plumbing');
    expect(go()).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Plumbing' }));
    expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
    expect(go()).toBeDisabled();
    await userEvent.type(cellField(), '(216) 555-0142');
    expect(go()).toBeEnabled();
  });

  it('submits the pack, the trimmed name and the trimmed cell', async () => {
    const onSubmit = vi.fn();
    render(<AnswerAsScreen onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Business name'), '  Walsh Plumbing ');
    await userEvent.click(screen.getByRole('button', { name: 'Something else' }));
    await userEvent.type(cellField(), '  (216) 555-0142 ');
    await userEvent.click(go());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenLastCalledWith({ packId: 'other', businessName: 'Walsh Plumbing', phone: '(216) 555-0142' });
  });

  it.each(['2165550142', '216-555-0142', '+1 216 555 0142', '1 (216) 555-0142'])('takes the US form %j as it was typed', async (typed) => {
    const onSubmit = vi.fn();
    render(<AnswerAsScreen onSubmit={onSubmit} />);
    await nameAndTrade();
    await userEvent.type(cellField(), typed);
    expect(go()).toBeEnabled();
    expect(screen.getByText(WHY)).toBeInTheDocument();
    await userEvent.click(go());
    expect(onSubmit).toHaveBeenLastCalledWith({ packId: 'hvac', businessName: 'Walsh', phone: typed });
  });

  describe('a cell the API would refuse', () => {
    it.each([
      ['too short to place an area', '216'],
      ['no digits in it', 'call me later'],
      ['twelve digits', '216555010012'],
      ['a non-US +44 number', '+44 7911 123456'],
      ['a Norwegian number that is ten digits long', '+47 912 34 567'],
      ['an area code starting 0', '055-123-4567'],
      ['an area code starting 1', '155-123-4567'],
      ['letters mixed in', '216-555-CALL'],
    ])('holds back %s (%j) and says what is needed', async (_what, typed) => {
      const onSubmit = vi.fn();
      render(<AnswerAsScreen onSubmit={onSubmit} />);
      await nameAndTrade();
      await userEvent.type(cellField(), typed);
      expect(go()).toBeDisabled();
      expect(cellField()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(NOT_A_US_CELL)).toBeInTheDocument();
      await userEvent.type(cellField(), '{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('the cell is required until the dedicated prompt exists', () => {
    it('keeps the button off with no cell, or a blank one, and says why Rivet needs it, with no way to skip', async () => {
      const onSubmit = vi.fn();
      const { container } = render(<AnswerAsScreen onSubmit={onSubmit} />);
      await nameAndTrade();
      expect(go()).toBeDisabled();
      expect(cellField()).toHaveAttribute('aria-required', 'true');
      expect(cellField()).not.toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(WHY)).toBeInTheDocument();

      await userEvent.type(cellField(), '   ');
      expect(go()).toBeDisabled();
      expect(screen.getByText(WHY)).toBeInTheDocument();
      await userEvent.type(cellField(), '{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();

      expect(container).not.toHaveTextContent(/skip|optional/i);
      expect(screen.queryByRole('button', { name: /skip|later/i })).not.toBeInTheDocument();
    });
  });

  describe('coming back after the API refused the cell', () => {
    const initial = { packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '(216) 555-0142' };

    it('keeps what the owner typed, shows the API\'s reason, and will not send the refused cell again', async () => {
      const onSubmit = vi.fn();
      render(<AnswerAsScreen onSubmit={onSubmit} initial={initial} cellProblem={REFUSED} />);

      expect(screen.getByLabelText('Business name')).toHaveValue('Walsh Plumbing');
      expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
      expect(cellField()).toHaveValue('(216) 555-0142');
      expect(screen.getByRole('alert')).toHaveTextContent(REFUSED);
      expect(cellField()).toHaveAttribute('aria-invalid', 'true');
      expect(go()).toBeDisabled();

      // A different cell clears the reason and the button comes back.
      await userEvent.clear(cellField());
      await userEvent.type(cellField(), '2165550199');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText(WHY)).toBeInTheDocument();
      expect(go()).toBeEnabled();

      // Typing the refused cell back in brings the reason back with it.
      await userEvent.clear(cellField());
      await userEvent.type(cellField(), '  (216) 555-0142');
      expect(screen.getByRole('alert')).toHaveTextContent(REFUSED);
      expect(go()).toBeDisabled();
      await userEvent.type(cellField(), '{Enter}');
      expect(onSubmit).not.toHaveBeenCalled();

      await userEvent.clear(cellField());
      await userEvent.type(cellField(), '2165550199');
      await userEvent.click(go());
      expect(onSubmit).toHaveBeenCalledWith({ packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '2165550199' });
    });

    it('starts from what the owner typed even when the API gave no reason', () => {
      render(<AnswerAsScreen onSubmit={vi.fn()} initial={initial} />);
      expect(screen.getByLabelText('Business name')).toHaveValue('Walsh Plumbing');
      expect(cellField()).toHaveValue('(216) 555-0142');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(go()).toBeEnabled();
    });
  });

  describe('out loud (inside the shell)', () => {
    // The microphone and Deepgram's socket are the browser/vendor boundary (faked as in
    // OptionPairTurn.test.tsx); the voice hook, the listener and the screen are real, and the
    // API is stubbed at fetch. Rivet's voice works, so what he says is read off the batch requests.
    class FakeWebSocket {
      static OPEN = 1;
      static instances: FakeWebSocket[] = [];
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    class FakeMediaRecorder {
      state = 'inactive';
      ondataavailable: unknown = null;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    }
    let micAnswer: 'granted' | 'denied';
    let getUserMedia: ReturnType<typeof vi.fn>;
    let batches: string[][];
    const socket = () => FakeWebSocket.instances.at(-1)!;
    const open = () =>
      act(() => {
        socket().readyState = 1;
        socket().onopen?.();
      });
    const hear = (transcript: string) =>
      act(() => {
        socket().onmessage?.({ data: JSON.stringify({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript }] } }) });
      });
    const flush = () =>
      act(async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
    const said = () => batches.flat();
    /** A name is read back once the owner has been quiet long enough that it is finished. */
    const nameSettles = () =>
      act(
        () =>
          new Promise<void>((done) => {
            setTimeout(done, NAME_SETTLE_MS + 50);
          }),
      );

    beforeEach(() => {
      FakeWebSocket.instances = [];
      micAnswer = 'granted';
      batches = [];
      getUserMedia = vi.fn(async () => {
        if (micAnswer === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
        return { getTracks: () => [{ stop: vi.fn() }] };
      });
      vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
      vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
      vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const path = String(input);
          const reply = (body: unknown) =>
            Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          if (path.startsWith('/api/voice/stream-token')) return reply({ token: 'dg-temp', expiresIn: 30, model: 'nova-3' });
          if (path === '/api/voice/tts/batch') {
            const { items } = JSON.parse(String(init?.body)) as { items: string[] };
            batches.push(items);
            return reply({
              clips: items.map((text, i) => ({
                text,
                clipHash: String(i).padStart(64, '0'),
                audio: btoa(encodeURIComponent(text)),
                contentType: 'audio/mpeg',
                cached: false,
              })),
            });
          }
          throw new Error(`unexpected request ${path}`);
        }),
      );
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    });
    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    function Voice({ children }: { children: ReactNode }) {
      const voice = useRivetVoice({ funnel: { tenantId: 't', userId: 'u' } });
      return <RivetVoiceContext.Provider value={voice}>{children}</RivetVoiceContext.Provider>;
    }

    const mic = () => screen.queryByRole('button', { name: 'Answer out loud' });
    const transcript = () => screen.getByTestId('rivet-transcript');
    const nameField = () => screen.getByLabelText('Business name');

    /** The screen in the shell's voice, then the owner taps "Answer out loud" and the socket opens. */
    async function startOutLoud(props: Partial<AnswerAsScreenProps> = {}) {
      const onSubmit = vi.fn();
      render(
        <Voice>
          <AnswerAsScreen onSubmit={onSubmit} {...props} />
        </Voice>,
      );
      fireEvent.click(mic()!);
      await flush();
      open();
      return { onSubmit };
    }

    it('offers "Answer out loud" only where Rivet can listen, as a 44px control, and asks nothing until it is tapped', async () => {
      render(
        <Voice>
          <AnswerAsScreen onSubmit={vi.fn()} />
        </Voice>,
      );
      expect(mic()).toBeInTheDocument();
      expect(mic()).not.toHaveAttribute('aria-pressed');
      expectTapTarget(mic()!, 'Answer out loud');
      expect(screen.queryByTestId('rivet-transcript')).not.toBeInTheDocument();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(0);
      cleanup();

      vi.stubGlobal('MediaRecorder', undefined);
      render(
        <Voice>
          <AnswerAsScreen onSubmit={vi.fn()} />
        </Voice>,
      );
      expect(mic()).not.toBeInTheDocument();
    });

    it('name, trade and cell by voice fill the form, the read-back is said, and "show me my shop" sends it once', async () => {
      const { onSubmit } = await startOutLoud();
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(mic()).toHaveAttribute('aria-pressed', 'true');
      expect(transcript()).toHaveTextContent("What's your business called?");
      expect(said()).toContain("What's your business called?");

      hear("It's Walsh Plumbing.");
      await nameSettles();
      expect(nameField()).toHaveValue('Walsh Plumbing');
      expect(transcript()).toHaveTextContent(
        "I've got Walsh Plumbing. If that's not right, say “spell it”, or type it above. What's your trade: plumbing, HVAC, electrical, or something else?",
      );

      hear('plumbing');
      expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
      expect(transcript()).toHaveTextContent("Got it, plumbing. What's your cell number, with the area code?");

      hear('two one six five five five zero one four two');
      expect(screen.getByLabelText('Your cell')).toHaveValue('(216) 555-0142');
      expect(transcript()).toHaveTextContent(
        'Walsh Plumbing, plumbing, and your cell is 2 1 6, 5 5 5, 0 1 4 2. Say “show me my shop”, or fix anything above.',
      );
      await flush();
      expect(said()).toContain('Walsh Plumbing, plumbing, and your cell is 2 1 6, 5 5 5, 0 1 4 2.');
      expect(onSubmit).not.toHaveBeenCalled();

      hear('show me my shop');
      hear('show me my shop');
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith({ packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '(216) 555-0142' });
      expect(go()).toBeDisabled();
    });

    it('a trade it did not catch, or two trades, is asked again and no chip is picked', async () => {
      await startOutLoud();
      hear('Walsh');
      await nameSettles();
      hear('banana');
      expect(transcript()).toHaveTextContent("I didn't catch the trade. Plumbing, HVAC, electrical, or something else?");
      hear('plumbing, heating and air');
      expect(transcript()).toHaveTextContent('I heard plumbing and HVAC. Which one do you do most?');
      expect(screen.getAllByRole('button', { pressed: true })).toEqual([mic()]);
      hear('mostly heating');
      expect(screen.getByRole('button', { name: 'HVAC' })).toHaveAttribute('aria-pressed', 'true');
    });

    it("a number that is not a US cell shows in the field with the form's message, said aloud; no number says so", async () => {
      const { onSubmit } = await startOutLoud();
      hear('Walsh Plumbing');
      await nameSettles();
      hear('plumbing');
      hear('five five five zero one four two');
      expect(screen.getByLabelText('Your cell')).toHaveValue('5550142');
      expect(screen.getByLabelText('Your cell')).toHaveAttribute('aria-invalid', 'true');
      expect(transcript()).toHaveTextContent(NOT_A_US_CELL);
      await flush();
      expect(said()).toContain(NOT_A_US_CELL);

      hear("hang on, I don't know it");
      expect(transcript()).toHaveTextContent("I didn't catch a number. Say your cell with the area code, 10 digits.");

      hear('show me my shop');
      expect(onSubmit).not.toHaveBeenCalled();
      expect(transcript()).toHaveTextContent("What's your cell number, with the area code?");

      hear('216-555-0142');
      expect(screen.getByLabelText('Your cell')).toHaveValue('(216) 555-0142');
      expect(screen.getByLabelText('Your cell')).toHaveAttribute('aria-invalid', 'false');
    });

    it('"spell it" takes the name letter by letter; "change the trade" goes back to the trade', async () => {
      await startOutLoud();
      hear('Welsh Plumbing');
      await nameSettles();
      hear('spell it');
      expect(transcript()).toHaveTextContent('Go ahead and spell it, letter by letter.');
      hear('W A L S H plumbing');
      await nameSettles();
      expect(nameField()).toHaveValue('Walsh Plumbing');
      hear('electrical');
      hear('216 555 0142');
      hear('change the trade');
      expect(transcript()).toHaveTextContent("What's your trade: plumbing, HVAC, electrical, or something else?");
      hear('plumber');
      expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
      expect(transcript()).toHaveTextContent('Walsh Plumbing, plumbing, and your cell is 2 1 6, 5 5 5, 0 1 4 2.');
    });

    it('"say that again" repeats the question; a tapped chip answers the trade question too', async () => {
      await startOutLoud();
      hear('Walsh Plumbing');
      await nameSettles();
      hear('say that again');
      expect(transcript()).toHaveTextContent("I've got Walsh Plumbing.");
      fireEvent.click(screen.getByRole('button', { name: 'Electrical' }));
      expect(transcript()).toHaveTextContent("Got it, electrical. What's your cell number, with the area code?");
    });

    it('"type it" stops listening and puts the owner on the field Rivet asked for', async () => {
      await startOutLoud();
      hear('Walsh Plumbing');
      await nameSettles();
      hear('plumbing');
      hear("I'll type it");
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
      expect(transcript()).toHaveTextContent('Go ahead and type it.');
      expect(screen.getByLabelText('Your cell')).toHaveFocus();
    });

    it('typing pauses listening: words said while a field is in use answer nothing, and leaving it moves Rivet on', async () => {
      await startOutLoud();
      await userEvent.click(nameField());
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
      await userEvent.type(nameField(), 'Walsh');
      hear('plumbing');
      expect(nameField()).toHaveValue('Walsh');
      await userEvent.click(screen.getByLabelText('Your cell'));
      expect(transcript()).toHaveTextContent("What's your trade: plumbing, HVAC, electrical, or something else?");
      await userEvent.type(screen.getByLabelText('Your cell'), '2165550142');
      act(() => screen.getByLabelText('Your cell').blur());
      await flush();
      open();
      hear('plumbing');
      expect(screen.getByRole('button', { name: 'Plumbing' })).toHaveAttribute('aria-pressed', 'true');
      expect(transcript()).toHaveTextContent('Walsh, plumbing, and your cell is 2 1 6, 5 5 5, 0 1 4 2.');
    });

    it('after "type it" and a typed answer, Rivet asks what is missing now and the next words answer that', async () => {
      const { onSubmit } = await startOutLoud();
      hear('Walsh Plumbing');
      await nameSettles();
      hear('plumbing');
      hear("I'll type it");
      expect(screen.getByLabelText('Your cell')).toHaveFocus();
      await userEvent.type(screen.getByLabelText('Your cell'), '2165550142');
      act(() => screen.getByLabelText('Your cell').blur());
      expect(transcript()).toHaveTextContent('Walsh Plumbing, plumbing, and your cell is 2 1 6, 5 5 5, 0 1 4 2.');
      await flush();
      open();
      hear('show me my shop');
      expect(onSubmit).toHaveBeenCalledWith({ packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '2165550142' });
    });

    it('a pause inside a name or a cell does not split the answer', async () => {
      await startOutLoud();
      hear('Walsh');
      hear('Plumbing');
      await nameSettles();
      expect(nameField()).toHaveValue('Walsh Plumbing');
      expect(screen.getAllByRole('button', { pressed: true })).toEqual([mic()]);
      expect(transcript()).toHaveTextContent("I've got Walsh Plumbing.");
      hear('plumbing');
      hear('216 555');
      expect(transcript()).toHaveTextContent(NOT_A_US_CELL);
      hear('0142');
      expect(screen.getByLabelText('Your cell')).toHaveValue('(216) 555-0142');
    });

    it('names that sound like commands or questions are names', async () => {
      await startOutLoud();
      hear('Go Ahead Plumbing');
      await nameSettles();
      expect(nameField()).toHaveValue('Go Ahead Plumbing');
      hear('change the name');
      // Not on the check yet: the name step's own words only.
      expect(nameField()).toHaveValue('Go Ahead Plumbing');
      cleanup();
      await startOutLoud();
      hear('Come Again Cleaning');
      await nameSettles();
      expect(nameField()).toHaveValue('Come Again Cleaning');
    });

    it('corrections: "no, it\'s …" over the read-back fixes the name; "no, change the number" on the check changes it', async () => {
      await startOutLoud();
      hear('Welsh Plumbing');
      await nameSettles();
      hear("No, it's Walsh Plumbing");
      expect(nameField()).toHaveValue('Walsh Plumbing');
      expect(screen.getAllByRole('button', { pressed: true })).toEqual([mic()]);
      hear('plumbing');
      hear('216 555 0142');
      hear('no, change the number');
      expect(transcript()).toHaveTextContent("What's your cell number, with the area code?");
    });

    it('a refused microphone says so and leaves the form to type', async () => {
      micAnswer = 'denied';
      render(
        <Voice>
          <AnswerAsScreen onSubmit={vi.fn()} />
        </Voice>,
      );
      fireEvent.click(mic()!);
      await flush();
      expect(mic()).not.toBeInTheDocument();
      expect(transcript()).toHaveTextContent("I can't hear you on this device, so type your answers below.");
      await flush();
      // Said aloud too, not only shown.
      expect(said()).toContain("I can't hear you on this device, so type your answers below.");
    });

    it('coming back with the microphone on after the API refused the cell: the reason is said, then the cell is asked for', async () => {
      const onSubmit = vi.fn();
      // The microphone is held when the form opens: the owner answered out loud, then the API refused the cell.
      function Held({ children }: { children: ReactNode }) {
        const voice = useRivetVoice({ funnel: { tenantId: 't', userId: 'u' } });
        const [shown, setShown] = useState(false);
        return (
          <RivetVoiceContext.Provider value={voice}>
            <button
              type="button"
              onClick={() => {
                voice.unlock('start');
                voice.openMic();
              }}
            >
              Earlier tap
            </button>
            <button type="button" onClick={() => setShown(true)}>
              Open form
            </button>
            {shown ? children : null}
          </RivetVoiceContext.Provider>
        );
      }
      render(
        <Held>
          <AnswerAsScreen
            onSubmit={onSubmit}
            initial={{ packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '2165550142' }}
            cellProblem={REFUSED}
          />
        </Held>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Earlier tap' }));
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Open form' }));
      await flush();
      expect(transcript()).toHaveTextContent(`${REFUSED} What's your cell number, with the area code?`);
      expect(said()).toContain(REFUSED);
      open();
      // The same refused number, said in another shape, is still refused.
      hear('two one six five five five zero one four two');
      expect(transcript()).toHaveTextContent(`${REFUSED} What's your cell number, with the area code?`);
      hear('216 555 0199');
      expect(transcript()).toHaveTextContent('Walsh Plumbing, plumbing, and your cell is 2 1 6, 5 5 5, 0 1 9 9.');
      hear('looks good');
      expect(onSubmit).toHaveBeenCalledWith({ packId: 'plumbing', businessName: 'Walsh Plumbing', phone: '(216) 555-0199' });
    });
  });
});
