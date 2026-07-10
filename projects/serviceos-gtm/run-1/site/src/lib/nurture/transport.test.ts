import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { selectTransport, resendTransport, previewTransport, DEFAULT_FROM_ADDRESS } from './transport';
import { clearMailbox, getMailbox } from './mailbox';

const ORIGINAL_ENV = { ...process.env };

describe('transport selection', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('selects the preview transport when no RESEND_API_KEY is set', () => {
    delete process.env.RESEND_API_KEY;
    expect(selectTransport().name).toBe('preview');
  });

  it('selects the resend transport when RESEND_API_KEY is set', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    expect(selectTransport().name).toBe('resend');
  });
});

describe('DEFAULT_FROM_ADDRESS', () => {
  it('defaults to the configurable Josh-at-Rivet identity', () => {
    expect(DEFAULT_FROM_ADDRESS).toContain('Josh at Rivet');
    expect(DEFAULT_FROM_ADDRESS).toContain('josh@updates.rivet.example');
  });
});

describe('previewTransport', () => {
  beforeEach(() => {
    clearMailbox();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores the send in the in-memory mailbox and logs a structured line', async () => {
    const result = await previewTransport.send({
      to: 'test+rivet@example.com',
      from: DEFAULT_FROM_ADDRESS,
      subject: 'Test subject',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      emailId: 'welcome',
      previewText: 'preview',
    });

    expect(result.ok).toBe(true);
    expect(getMailbox()).toHaveLength(1);
    expect(getMailbox()[0]).toMatchObject({
      to: 'test+rivet@example.com',
      subject: 'Test subject',
      transport: 'preview',
    });
    expect(console.log).toHaveBeenCalled();
  });
});

describe('resendTransport', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('POSTs to api.resend.com/emails with the correct request shape', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'email_123' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resendTransport.send({
      to: 'test+rivet@example.com',
      from: DEFAULT_FROM_ADDRESS,
      subject: 'Subject',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      emailId: 'welcome',
      previewText: 'preview',
    });

    expect(result).toMatchObject({ ok: true, id: 'email_123' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer re_test_key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      from: DEFAULT_FROM_ADDRESS,
      to: ['test+rivet@example.com'],
      subject: 'Subject',
      html: '<p>hi</p>',
      text: 'hi',
    });

    vi.unstubAllGlobals();
  });

  it('returns ok:false when RESEND_API_KEY is not configured', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await resendTransport.send({
      to: 'test+rivet@example.com',
      from: DEFAULT_FROM_ADDRESS,
      subject: 'Subject',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      emailId: 'welcome',
      previewText: 'preview',
    });
    expect(result.ok).toBe(false);
  });
});
