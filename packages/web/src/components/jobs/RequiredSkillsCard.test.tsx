import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetcher = vi.fn();
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/apiClient')>();
  return { ...actual, useApiClient: () => fetcher };
});

import { RequiredSkillsCard } from './RequiredSkillsCard';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

describe('RequiredSkillsCard (Dispatch FR-2 phase 2)', () => {
  beforeEach(() => fetcher.mockReset());

  it('says any technician can take a job with no required skills', () => {
    render(<RequiredSkillsCard jobId="j-1" requiredSkills={[]} canEdit onSaved={() => {}} />);
    expect(screen.getByText(/Any technician can take this job/)).toBeInTheDocument();
  });

  it('lists the required skills and hides editing without jobs:assign', () => {
    render(<RequiredSkillsCard jobId="j-1" requiredSkills={['gas_certified']} canEdit={false} onSaved={() => {}} />);
    expect(screen.getByTestId('job-required-skills-list')).toHaveTextContent('gas_certified');
    expect(screen.queryByTestId('job-required-skills-edit')).not.toBeInTheDocument();
  });

  it('saves through PUT /api/jobs/:id and reports back', async () => {
    fetcher.mockResolvedValue(jsonResponse({ id: 'j-1', requiredSkills: ['gas_certified'] }));
    const onSaved = vi.fn();
    render(<RequiredSkillsCard jobId="j-1" requiredSkills={[]} canEdit onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('job-required-skills-edit'));
    fireEvent.change(screen.getByTestId('job-required-skills-input'), { target: { value: 'Gas Certified' } });
    fireEvent.click(screen.getByTestId('job-required-skills-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledWith('/api/jobs/j-1', {
      method: 'PUT',
      body: JSON.stringify({ requiredSkills: ['gas_certified'] }),
    });
    expect(screen.queryByTestId('job-required-skills-editor')).not.toBeInTheDocument();
  });

  it('keeps the editor open and shows the server message when the save is refused', async () => {
    fetcher.mockResolvedValue(jsonResponse({ message: "Only owners and dispatchers can change a job's required skills" }, 403));
    const onSaved = vi.fn();
    render(<RequiredSkillsCard jobId="j-1" requiredSkills={[]} canEdit onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('job-required-skills-edit'));
    fireEvent.change(screen.getByTestId('job-required-skills-input'), { target: { value: 'hvac' } });
    fireEvent.click(screen.getByTestId('job-required-skills-save'));
    expect(await screen.findByText(/Only owners and dispatchers/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId('job-required-skills-editor')).toBeInTheDocument();
  });

  it('the edit control is a ≥44px tap target', () => {
    render(<RequiredSkillsCard jobId="j-1" requiredSkills={[]} canEdit onSaved={() => {}} />);
    expect(screen.getByTestId('job-required-skills-edit').className).toContain('size-11');
  });
});
