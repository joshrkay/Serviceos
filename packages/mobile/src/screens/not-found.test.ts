// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: h.replace }),
}));

// eslint-disable-next-line import/first
import NotFound from '../../app/+not-found';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('NotFound', () => {
  it('renders a not-found message with a way back home', () => {
    const { getByText } = render(createElement(NotFound));

    expect(getByText("That page doesn't exist")).toBeTruthy();
    expect(getByText('The link you followed is broken or out of date.')).toBeTruthy();

    fireEvent.click(getByText('Back to home'));
    expect(h.replace).toHaveBeenCalledWith('/');
  });
});
