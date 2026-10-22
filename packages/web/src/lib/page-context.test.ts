import { describe, it, expect } from 'vitest';
import {
  assistantHandoffUrl,
  decodePageContext,
  encodePageContext,
  pageContextChipLabel,
  pageContextFromPath,
} from './page-context';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('pageContextFromPath', () => {
  it.each([
    [`/jobs/${ID}`, 'job'],
    [`/jobs/${ID}/photos`, 'job'],
    [`/customers/${ID}/edit`, 'customer'],
    [`/estimates/${ID}`, 'estimate'],
    [`/invoices/${ID}`, 'invoice'],
    [`/appointments/${ID}/edit`, 'appointment'],
  ])('%s is a %s page', (path, entityType) => {
    expect(pageContextFromPath(path)).toEqual({ entityType, entityId: ID });
  });

  it.each(['/', '/jobs', '/jobs/new', '/customers/new', '/assistant', `/settings/${ID}`])(
    '%s has no record',
    (path) => {
      expect(pageContextFromPath(path)).toBeNull();
    },
  );
});

describe('the ?ctx= hand-off', () => {
  it('round-trips', () => {
    const ctx = { entityType: 'invoice' as const, entityId: ID };
    expect(decodePageContext(encodePageContext(ctx))).toEqual(ctx);
  });

  it.each([null, '', 'job', `lead:${ID}`, 'job:not-a-uuid', `job:${ID}:extra/x`])('rejects %j', (value) => {
    expect(decodePageContext(value)).toBeNull();
  });

  it('builds the assistant URL with the text, the record and the spoken flag', () => {
    const url = assistantHandoffUrl('add a note: gate code 4471', { entityType: 'job', entityId: ID }, { spoken: true });
    const params = new URL(url, 'https://x').searchParams;
    expect(url.startsWith('/assistant?')).toBe(true);
    expect(params.get('q')).toBe('add a note: gate code 4471');
    expect(params.get('ctx')).toBe(`job:${ID}`);
    expect(params.get('via')).toBe('voice');
    expect(assistantHandoffUrl('hi', null)).toBe('/assistant?q=hi');
  });

  it('labels the chip by record type', () => {
    expect(pageContextChipLabel({ entityType: 'customer', entityId: ID })).toBe(
      'About the customer you were viewing',
    );
  });
});
