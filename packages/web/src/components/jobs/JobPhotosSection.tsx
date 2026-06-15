/**
 * Shared job photo surface — uploader + gallery with category filter.
 * Used on JobDetail (pages + components) and the standalone JobPhotos page.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { JobPhotoGallery } from './JobPhotoGallery';
import { JobPhotoUploader } from './JobPhotoUploader';
import {
  JobPhoto,
  JobPhotoCategory,
  deleteJobPhoto,
  listJobPhotos,
} from '../../api/job-photos';

export interface JobPhotosSectionProps {
  jobId: string;
  fetcher?: (jobId: string) => Promise<JobPhoto[]>;
  remover?: (jobId: string, photoId: string) => Promise<void>;
  /** Compact layout for embedded job detail panels. */
  compact?: boolean;
}

export function JobPhotosSection({
  jobId,
  fetcher = listJobPhotos,
  remover = deleteJobPhoto,
  compact = false,
}: JobPhotosSectionProps) {
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<JobPhotoCategory | 'all'>('all');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetcher(jobId);
      setPhotos(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load photos');
    } finally {
      setLoading(false);
    }
  }, [fetcher, jobId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUploaded = useCallback((photo: JobPhoto) => {
    setPhotos((prev) => [photo, ...prev]);
  }, []);

  const handleDelete = useCallback(
    async (photo: JobPhoto) => {
      try {
        await remover(jobId, photo.id);
        setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete photo');
      }
    },
    [remover, jobId],
  );

  return (
    <div
      data-testid="job-photos-section"
      className={compact ? 'space-y-3' : 'space-y-4'}
    >
      <JobPhotoUploader jobId={jobId} onUploaded={handleUploaded} />
      {error ? (
        <p data-testid="job-photos-error" role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <JobPhotoGallery
        jobId={jobId}
        photos={photos}
        loading={loading}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
        onDelete={handleDelete}
        onClientVisibleChange={(photo) => {
          setPhotos((prev) => prev.map((p) => (p.id === photo.id ? { ...p, ...photo } : p)));
        }}
      />
    </div>
  );
}
