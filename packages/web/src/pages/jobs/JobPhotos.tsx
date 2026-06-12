/**
 * P12-001 — JobPhotos page (deep-linkable photo surface).
 */
import React from 'react';
import { JobPhotosSection } from '../../components/jobs/JobPhotosSection';

export interface JobPhotosProps {
  jobId: string;
}

export function JobPhotos({ jobId }: JobPhotosProps) {
  return (
    <div data-testid="job-photos-page" className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">Job photos</h1>
      <JobPhotosSection jobId={jobId} />
    </div>
  );
}
