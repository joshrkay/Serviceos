// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PushStatusProvider, usePushStatus } from './pushStatusContext';

afterEach(() => cleanup());

function Probe() {
  const status = usePushStatus();
  return createElement('span', null, String(status));
}

describe('pushStatusContext', () => {
  it('defaults to null with no provider', () => {
    const { getByText } = render(createElement(Probe));
    expect(getByText('null')).toBeTruthy();
  });

  it('exposes the provided status to consumers', () => {
    const { getByText } = render(
      createElement(PushStatusProvider, { status: 'denied', children: createElement(Probe) }),
    );
    expect(getByText('denied')).toBeTruthy();
  });
});
