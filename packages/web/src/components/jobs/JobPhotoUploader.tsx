/**
 * P12-001 — JobPhotoUploader.
 *
 * Camera-aware file input. The `capture="environment"` attribute
 * prompts iOS / Android to open the rear camera directly when the
 * user taps the button — and falls back to the system file picker
 * on desktop. We keep the upload pipeline pluggable through the
 * `uploader` prop so unit tests can stub it without going near
 * fetch/S3.
 */
import React, { useRef, useState } from 'react';
import {
  JobPhoto,
  JobPhotoCategory,
  JOB_PHOTO_CATEGORIES,
  uploadJobPhoto,
} from '../../api/job-photos';
import {
  enqueueOfflinePhoto,
  fileToBase64,
} from '../../lib/offline-photo-queue';

export interface JobPhotoUploaderProps {
  jobId: string;
  defaultCategory?: JobPhotoCategory;
  onUploaded?: (photo: JobPhoto) => void;
  /** Override for tests; defaults to the real S3 pipeline. */
  uploader?: (
    jobId: string,
    file: File,
    category: JobPhotoCategory,
    notes?: string,
    takenAt?: string
  ) => Promise<JobPhoto>;
}

const CATEGORY_LABELS: Record<JobPhotoCategory, string> = {
  before: 'Before',
  after: 'After',
  problem: 'Problem',
  completion: 'Completion',
  other: 'Other',
};

export function JobPhotoUploader({
  jobId,
  defaultCategory = 'before',
  onUploaded,
  uploader = uploadJobPhoto,
}: JobPhotoUploaderProps) {
  const [category, setCategory] = useState<JobPhotoCategory>(defaultCategory);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      if (!navigator.onLine) {
        const base64 = await fileToBase64(file);
        await enqueueOfflinePhoto({
          id: crypto.randomUUID(),
          jobId,
          fileName: file.name,
          contentType: file.type || 'image/jpeg',
          base64,
          category,
          notes: notes.trim() || undefined,
          createdAt: new Date().toISOString(),
        });
        setNotes('');
        setError('Saved offline — will upload when back online.');
        return;
      }
      const photo = await uploader(
        jobId,
        file,
        category,
        notes.trim() || undefined,
        new Date().toISOString()
      );
      setNotes('');
      onUploaded?.(photo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div data-testid="job-photo-uploader" className="border rounded p-3 bg-white">
      <label className="block text-sm font-medium mb-1" htmlFor="job-photo-category">
        Category
      </label>
      <select
        id="job-photo-category"
        data-testid="job-photo-category-select"
        value={category}
        onChange={(e) => setCategory(e.target.value as JobPhotoCategory)}
        disabled={busy}
        className="border rounded px-2 py-1 mb-2"
      >
        {JOB_PHOTO_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>

      <label className="block text-sm font-medium mb-1" htmlFor="job-photo-notes">
        Notes
      </label>
      <input
        id="job-photo-notes"
        data-testid="job-photo-notes-input"
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        disabled={busy}
        placeholder="Optional"
        className="border rounded px-2 py-1 mb-2 w-full"
      />

      <input
        ref={inputRef}
        data-testid="job-photo-file-input"
        type="file"
        accept="image/*"
        capture="environment"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      {busy ? (
        <p data-testid="job-photo-uploading" className="text-sm text-slate-500 mt-2">
          Uploading…
        </p>
      ) : null}
      {error ? (
        <p data-testid="job-photo-error" role="alert" className="text-sm text-red-600 mt-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}
