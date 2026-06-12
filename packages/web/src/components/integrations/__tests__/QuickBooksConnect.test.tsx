import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuickBooksConnect } from '../QuickBooksConnect';

vi.mock('../../../api/integrations', () => ({
  connectQuickBooks: vi.fn(async () => 'https://intuit.example/oauth'),
  fetchQuickBooksStatus: vi.fn(async () => null),
  disconnectQuickBooks: vi.fn(async () => undefined),
  triggerQuickBooksSync: vi.fn(async () => undefined),
}));

import * as integrationsApi from '../../../api/integrations';

describe('QuickBooksConnect (P15-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Connect button kicks off OAuth URL fetch', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<QuickBooksConnect />);
    fireEvent.click(screen.getByRole('button', { name: /connect quickbooks/i }));
    await waitFor(() => {
      expect(integrationsApi.connectQuickBooks).toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledWith('https://intuit.example/oauth', '_self');
    });
    openSpy.mockRestore();
  });
});
