/**
 * P12-001 — JobPhotoGallery: per-job photo grid with category filter chips.
 *
 * Stateless: parent passes in photos + active filter; clicks on chips
 * raise onCategoryChange so the parent can re-fetch/filter. We keep
 * the optional onDelete callback pluggable so tests can assert it
 * fires without coupling the gallery to a specific delete client.
 */
import React from 'react';
import { JobPhoto, JobPhotoCategory, JOB_PHOTO_CATEGORIES } from '../../api/job-photos';

export interface JobPhotoGalleryProps {
  photos: JobPhoto[];
  activeCategory?: JobPhotoCategory | 'all';
  onCategoryChange?: (next: JobPhotoCategory | 'all') => void;
  onDelete?: (photo: JobPhoto) => void;
  loading?: boolean;
}

const CATEGORY_LABELS: Record<JobPhotoCategory | 'all', string> = {
  all: 'All',
  before: 'Before',
  after: 'After',
  problem: 'Problem',
  completion: 'Completion',
  other: 'Other',
};

export function JobPhotoGallery({
  photos,
  activeCategory = 'all',
  onCategoryChange,
  onDelete,
  loading = false,
}: JobPhotoGalleryProps) {
  const filtered =
    activeCategory === 'all'
      ? photos
      : photos.filter((p) => p.category === activeCategory);

  return (
    <div data-testid="job-photo-gallery">
      <div role="tablist" aria-label="Photo categories" className="flex flex-wrap gap-2 mb-4">
        {(['all', ...JOB_PHOTO_CATEGORIES] as const).map((cat) => {
          const active = cat === activeCategory;
          return (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`job-photo-chip-${cat}`}
              onClick={() => onCategoryChange?.(cat)}
              className={`px-3 py-1 rounded-full text-sm border ${
                active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700'
              }`}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          );
        })}
      </div>

      {loading ? (
        <p data-testid="job-photo-loading">Loading photos…</p>
      ) : filtered.length === 0 ? (
        <p data-testid="job-photo-empty" className="text-sm text-slate-500">
          No photos yet for this filter.
        </p>
      ) : (
        <div
          data-testid="job-photo-grid"
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
        >
          {filtered.map((photo) => (
            <figure
              key={photo.id}
              data-testid={`job-photo-card-${photo.id}`}
              className="border rounded overflow-hidden bg-white"
            >
              <img
                src={photo.downloadUrl}
                alt={photo.notes ?? `${photo.category} photo`}
                loading="lazy"
                className="w-full h-32 object-cover"
              />
              <figcaption className="p-2 text-xs text-slate-700">
                <div className="font-medium">{CATEGORY_LABELS[photo.category]}</div>
                {photo.notes ? <div className="truncate">{photo.notes}</div> : null}
                {onDelete ? (
                  <button
                    type="button"
                    data-testid={`job-photo-delete-${photo.id}`}
                    onClick={() => onDelete(photo)}
                    className="mt-1 text-red-600 underline"
                  >
                    Delete
                  </button>
                ) : null}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
