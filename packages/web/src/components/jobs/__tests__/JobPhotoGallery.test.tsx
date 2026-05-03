import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { JobPhotoGallery } from '../JobPhotoGallery';
import type { JobPhoto } from '../../../api/job-photos';

function makePhoto(overrides: Partial<JobPhoto> = {}): JobPhoto {
  return {
    id: 'p1',
    tenantId: 't1',
    jobId: 'j1',
    uploadedByUserId: 'u1',
    fileId: 'f1',
    category: 'before',
    notes: 'water leak under sink',
    createdAt: '2026-05-03T00:00:00.000Z',
    downloadUrl: 'https://cdn.example/p1.jpg',
    filename: 'p1.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1234,
    ...overrides,
  };
}

describe('JobPhotoGallery (P12-001)', () => {
  it('renders an empty state when no photos match', () => {
    render(<JobPhotoGallery photos={[]} />);
    expect(screen.getByTestId('job-photo-empty')).toBeInTheDocument();
  });

  it('renders a card per photo with the download URL as the image src', () => {
    const photos = [
      makePhoto({ id: 'p1', category: 'before' }),
      makePhoto({ id: 'p2', category: 'after', downloadUrl: 'https://cdn.example/p2.jpg' }),
    ];
    render(<JobPhotoGallery photos={photos} />);
    expect(screen.getByTestId('job-photo-card-p1')).toBeInTheDocument();
    expect(screen.getByTestId('job-photo-card-p2')).toBeInTheDocument();
    const imgs = screen.getAllByRole('img') as HTMLImageElement[];
    expect(imgs.map((i) => i.src)).toEqual([
      'https://cdn.example/p1.jpg',
      'https://cdn.example/p2.jpg',
    ]);
  });

  it('filters by category when a chip is clicked', () => {
    const onChange = vi.fn();
    const photos = [
      makePhoto({ id: 'p1', category: 'before' }),
      makePhoto({ id: 'p2', category: 'after' }),
    ];
    render(
      <JobPhotoGallery
        photos={photos}
        activeCategory="before"
        onCategoryChange={onChange}
      />
    );
    expect(screen.getByTestId('job-photo-card-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('job-photo-card-p2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('job-photo-chip-after'));
    expect(onChange).toHaveBeenCalledWith('after');
  });

  it('invokes onDelete when the delete button is clicked', () => {
    const onDelete = vi.fn();
    const photo = makePhoto({ id: 'p1' });
    render(<JobPhotoGallery photos={[photo]} onDelete={onDelete} />);
    fireEvent.click(screen.getByTestId('job-photo-delete-p1'));
    expect(onDelete).toHaveBeenCalledWith(photo);
  });

  it('shows a loading indicator when loading', () => {
    render(<JobPhotoGallery photos={[]} loading />);
    expect(screen.getByTestId('job-photo-loading')).toBeInTheDocument();
  });
});
