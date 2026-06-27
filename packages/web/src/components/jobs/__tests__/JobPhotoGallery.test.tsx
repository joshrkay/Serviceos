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

  it('renders a <video> for video/* content (not an <img>)', () => {
    const photos = [
      makePhoto({
        id: 'v1',
        category: 'other',
        contentType: 'video/webm',
        downloadUrl: 'https://cdn.example/v1.webm',
        filename: 'v1.webm',
      }),
    ];
    const { container } = render(<JobPhotoGallery photos={photos} />);
    const video = screen.getByTestId('job-photo-video-v1') as HTMLVideoElement;
    expect(video.tagName.toLowerCase()).toBe('video');
    expect(video).toHaveAttribute('src', 'https://cdn.example/v1.webm');
    expect(video.controls).toBe(true);
    // No <img> is rendered for the video tile.
    expect(container.querySelector('img')).toBeNull();
  });

  it('still renders an <img> for image/* content', () => {
    const photos = [makePhoto({ id: 'p1', contentType: 'image/jpeg' })];
    render(<JobPhotoGallery photos={photos} />);
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.queryByTestId('job-photo-video-p1')).not.toBeInTheDocument();
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
