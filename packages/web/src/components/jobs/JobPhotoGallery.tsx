/**
 * P12-001 — JobPhotoGallery: per-job photo grid with category filter chips.
 *
 * Stateless: parent passes in photos + active filter; clicks on chips
 * raise onCategoryChange so the parent can re-fetch/filter. We keep
 * the optional onDelete callback pluggable so tests can assert it
 * fires without coupling the gallery to a specific delete client.
 */
import React, { useState } from 'react';
import { JobPhoto, JobPhotoCategory, JOB_PHOTO_CATEGORIES } from '../../api/job-photos';

export interface JobPhotoGalleryProps {
  photos: JobPhoto[];
  activeCategory?: JobPhotoCategory | 'all';
  onCategoryChange?: (next: JobPhotoCategory | 'all') => void;
  onDelete?: (photo: JobPhoto) => void;
  /**
   * #1122 — before/after pairing (RV-005's `pair_group_id`/`pair_role` was
   * previously reachable by API only). Offered only on 'before'/'after'
   * photos when an opposite-category candidate exists; the caller resolves
   * the underlying attachment ids and calls the pair endpoint.
   */
  onPair?: (photo: JobPhoto, otherPhoto: JobPhoto) => void;
  loading?: boolean;
}

/** The category a 'before'/'after' photo can pair against; null otherwise. */
function oppositePairCategory(category: JobPhotoCategory): JobPhotoCategory | null {
  if (category === 'before') return 'after';
  if (category === 'after') return 'before';
  return null;
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
  onPair,
  loading = false,
}: JobPhotoGalleryProps) {
  const filtered =
    activeCategory === 'all'
      ? photos
      : photos.filter((p) => p.category === activeCategory);

  // #1122 — per-card "pair with…" selection, keyed by photo id.
  const [pairSelections, setPairSelections] = useState<Record<string, string>>({});

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
                active ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-foreground'
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
        <p data-testid="job-photo-empty" className="text-sm text-muted-foreground">
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
              className="border rounded overflow-hidden bg-card"
            >
              {/* Sweep-2 S2: never dereference contentType blindly — an
                  optimistically-appended row from an older/partial API
                  response (or an orphaned file placeholder from the list
                  endpoint) may lack contentType/downloadUrl. Fall back to a
                  generic tile instead of crashing the whole page. */}
              {!photo.downloadUrl ? (
                <div
                  data-testid={`job-photo-placeholder-${photo.id}`}
                  aria-label={photo.notes ?? `${photo.category} attachment`}
                  className="flex w-full h-32 items-center justify-center bg-muted text-xs text-muted-foreground"
                >
                  Preview unavailable
                </div>
              ) : typeof photo.contentType === 'string' &&
                photo.contentType.startsWith('video/') ? (
                <video
                  data-testid={`job-photo-video-${photo.id}`}
                  src={photo.downloadUrl}
                  controls
                  preload="metadata"
                  aria-label={photo.notes ?? `${photo.category} video`}
                  className="w-full h-32 object-cover bg-black"
                >
                  Your browser does not support the video tag.
                </video>
              ) : (
                <img
                  src={photo.downloadUrl}
                  alt={photo.notes ?? `${photo.category} photo`}
                  loading="lazy"
                  className="w-full h-32 object-cover"
                />
              )}
              <figcaption className="p-2 text-xs text-foreground">
                <div className="font-medium">{CATEGORY_LABELS[photo.category]}</div>
                {photo.notes ? <div className="truncate">{photo.notes}</div> : null}
                {onDelete ? (
                  <button
                    type="button"
                    data-testid={`job-photo-delete-${photo.id}`}
                    onClick={() => onDelete(photo)}
                    className="mt-1 text-destructive underline"
                  >
                    Delete
                  </button>
                ) : null}
                {(() => {
                  if (!onPair) return null;
                  const opposite = oppositePairCategory(photo.category);
                  if (!opposite) return null;
                  const candidates = photos.filter(
                    (p) => p.category === opposite && p.id !== photo.id,
                  );
                  if (candidates.length === 0) return null;
                  const selectedId = pairSelections[photo.id] ?? '';
                  return (
                    <div className="mt-1.5 flex items-center gap-1">
                      <select
                        data-testid={`job-photo-pair-select-${photo.id}`}
                        aria-label={`Pair ${CATEGORY_LABELS[photo.category]} photo with`}
                        value={selectedId}
                        onChange={(e) =>
                          setPairSelections((prev) => ({ ...prev, [photo.id]: e.target.value }))
                        }
                        className="min-h-11 flex-1 min-w-0 rounded border px-1 text-xs"
                      >
                        <option value="">Pair with…</option>
                        {candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {CATEGORY_LABELS[c.category]}
                            {c.notes ? ` · ${c.notes}` : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        data-testid={`job-photo-pair-button-${photo.id}`}
                        disabled={!selectedId}
                        onClick={() => {
                          const other = candidates.find((c) => c.id === selectedId);
                          if (other) onPair(photo, other);
                        }}
                        className="min-h-11 shrink-0 rounded border px-2 text-xs text-primary disabled:opacity-40"
                      >
                        Pair
                      </button>
                    </div>
                  );
                })()}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
