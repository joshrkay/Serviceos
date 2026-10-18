import { describe, expect, it } from 'vitest';
import { CONNECTION_ERROR, requestErrorCopy } from './connection-copy';

describe('connection copy', () => {
  it('says plainly that the server could not be reached', () => {
    expect(CONNECTION_ERROR).toBe("I couldn't reach the server. Check your connection and try again.");
  });

  it('tells a refused action from a server fault, and never repeats what the server said', () => {
    expect(requestErrorCopy(409)).toBe("That didn't go through. Try again.");
    expect(requestErrorCopy(403)).toBe("That didn't go through. Try again.");
    expect(requestErrorCopy(500)).toBe("That didn't go through. Wait a minute and try again.");
    expect(requestErrorCopy(503)).toBe("That didn't go through. Wait a minute and try again.");
  });
});
