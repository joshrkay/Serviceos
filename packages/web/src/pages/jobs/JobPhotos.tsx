/**
 * P12-001 — JobPhotos page.
 *
 * Composes the uploader + gallery and owns the data fetch lifecycle.
 * Wired into the router as a separate page so the per-job photo
 * surface can be deep-linked and tested in isolation; the integration
 * into JobDetail.tsx is intentionally deferred per the story's
 * "do NOT touch JobDetail" constraint.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { JobPhotoGallery } from '../../components/jobs/JobPhotoGallery';
import { JobPhotoUploader } from '../../components/jobs/JobPhotoUploader';
import {
  JobPhoto,
  JobPhotoCategory,
  deleteJobPhoto,
  listJobPhotos,
} from '../../api/job-photos';

export interface JobPhotosProps {
  jobId: string;
  /** Test seam: lets unit tests inject deterministic data. */
  fetcher?: (jobId: string) => Promise<JobPhoto[]>;
  remover?: (jobId: string, photoId: string) => Promise<void>;
}

export function JobPhotos({
  jobId,
  fetcher = listJobPhotos,
  remover = deleteJobPhoto,
}: JobPhotosProps) {
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
    [remover, jobId]
  );

  return (
    <div data-testid="job-photos-page" className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">Job photos</h1>
      <JobPhotoUploader jobId={jobId} onUploaded={handleUploaded} />
      {error ? (
        <p data-testid="job-photos-error" role="alert" className="text-red-600 text-sm">
          {error}
        </p>
      ) : null}
      <JobPhotoGallery
        photos={photos}
        loading={loading}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
        onDelete={handleDelete}
      />
    </div>
  );
}
