/**
 * P12-001 — JobPhotos page.
 *
 * Composes the uploader + gallery and owns the data fetch lifecycle.
 * Wired into the router as a separate page so the per-job photo
 * surface can be deep-linked and tested in isolation; the integration
 * into the canonical job detail (`components/jobs/JobDetail.tsx`) is
 * intentionally deferred per the story's "do NOT touch JobDetail" constraint.
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
import {
  Attachment,
  AttachmentPairRole,
  PairAttachmentsResult,
  listAttachments,
  pairAttachments,
} from '../../api/attachments';

export interface JobPhotosProps {
  jobId: string;
  /** Test seam: lets unit tests inject deterministic data. */
  fetcher?: (jobId: string) => Promise<JobPhoto[]>;
  remover?: (jobId: string, photoId: string) => Promise<void>;
  /**
   * #1122 — job-photo uploads dual-write a shadow row into the generalized
   * `attachments` table (RV-005, same fileId); pairing lives there, so
   * pairing two JobPhoto rows means resolving each one's attachment id
   * first. Test seams mirror `fetcher`/`remover` above.
   */
  listAttachmentsFn?: (entityType: 'job', entityId: string) => Promise<Attachment[]>;
  pairFn?: (id: string, otherId: string, role: AttachmentPairRole) => Promise<PairAttachmentsResult>;
}

export function JobPhotos({
  jobId,
  fetcher = listJobPhotos,
  remover = deleteJobPhoto,
  listAttachmentsFn = listAttachments,
  pairFn = pairAttachments,
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

  // #1122 — resolve each JobPhoto's shadow attachment id by fileId, then
  // pair through the existing attachments endpoint. `role` is the role
  // assigned to `photo` itself; the API assigns the opposite to `other`.
  const handlePair = useCallback(
    async (photo: JobPhoto, other: JobPhoto) => {
      setError(null);
      try {
        const attachments = await listAttachmentsFn('job', jobId);
        const mine = attachments.find((a) => a.fileId === photo.fileId);
        const theirs = attachments.find((a) => a.fileId === other.fileId);
        if (!mine || !theirs) {
          throw new Error('Could not find a matching attachment to pair — try again after the upload finishes.');
        }
        const role: AttachmentPairRole = photo.category === 'before' ? 'before' : 'after';
        await pairFn(mine.id, theirs.id, role);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to pair photos');
      }
    },
    [listAttachmentsFn, pairFn, jobId]
  );

  return (
    <div data-testid="job-photos-page" className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">Job photos</h1>
      <JobPhotoUploader jobId={jobId} onUploaded={handleUploaded} />
      {error ? (
        <p data-testid="job-photos-error" role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <JobPhotoGallery
        photos={photos}
        loading={loading}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
        onDelete={handleDelete}
        onPair={handlePair}
      />
    </div>
  );
}
