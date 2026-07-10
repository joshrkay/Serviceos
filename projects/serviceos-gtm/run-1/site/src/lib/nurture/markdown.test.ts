import { describe, it, expect } from 'vitest';
import { markdownBodyToHtml, markdownBodyToText } from './markdown';

describe('markdownBodyToHtml', () => {
  it('wraps paragraphs in <p>', () => {
    const html = markdownBodyToHtml('Hello {{first_name}},\n\nSecond paragraph.');
    expect(html).toBe('<p>Hello {{first_name}},</p>\n<p>Second paragraph.</p>');
  });

  it('renders an ordered list block as <ol><li>', () => {
    const html = markdownBodyToHtml('1. First step.\n2. Second step.');
    expect(html).toBe('<ol><li>First step.</li><li>Second step.</li></ol>');
  });

  it('renders an unordered list block as <ul><li>', () => {
    const html = markdownBodyToHtml('- Item one.\n- Item two.');
    expect(html).toBe('<ul><li>Item one.</li><li>Item two.</li></ul>');
  });

  it('passes an embedded <a href> paragraph through untouched', () => {
    const html = markdownBodyToHtml('<a href="{{app_url}}">Open the app</a>');
    expect(html).toBe('<p><a href="{{app_url}}">Open the app</a></p>');
  });

  it('converts **bold** to <strong>', () => {
    const html = markdownBodyToHtml('This is **important** text.');
    expect(html).toBe('<p>This is <strong>important</strong> text.</p>');
  });
});

describe('markdownBodyToText', () => {
  it('converts an embedded <a href> into "text (url)"', () => {
    const text = markdownBodyToText('<a href="{{app_url}}">Open the app</a>');
    expect(text).toBe('Open the app ({{app_url}})');
  });

  it('strips bold markers', () => {
    const text = markdownBodyToText('This is **important** text.');
    expect(text).toBe('This is important text.');
  });

  it('collapses 3+ newlines down to a blank line', () => {
    const text = markdownBodyToText('Para one.\n\n\n\nPara two.');
    expect(text).toBe('Para one.\n\nPara two.');
  });
});
