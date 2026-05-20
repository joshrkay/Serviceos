function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface VoicemailTwimlOptions {
  shopName: string;
  recordingStatusCallback: string;
  maxLengthSeconds?: number;
}

/**
 * TwiML for product voicemail — branded prompt + Record.
 * Twilio POSTs recording metadata to `recordingStatusCallback`.
 */
export function buildVoicemailTwiml(opts: VoicemailTwimlOptions): string {
  const safeName = xmlEscape(opts.shopName);
  const maxLen = opts.maxLengthSeconds ?? 120;
  const callback = xmlEscape(opts.recordingStatusCallback);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="Polly.Joanna">Thanks for calling ${safeName}. ` +
    `We're not available right now. Please leave a message after the tone.</Say>` +
    `<Record maxLength="${maxLen}" playBeep="true" recordingStatusCallback="${callback}" ` +
    `recordingStatusCallbackMethod="POST"/>` +
    `<Hangup/>` +
    `</Response>`
  );
}
