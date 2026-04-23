import React from 'react';
import { apiFetch } from '../../utils/api-fetch';

interface PhotoBucketProps {
  jobId: string;
  category: 'before' | 'after';
}

interface StoredPhoto {
  id: string;
  url: string;
  uploadedAt: string;
}

interface JobMediaPayload {
  beforePhotos?: StoredPhoto[];
  afterPhotos?: StoredPhoto[];
}

const LABELS: Record<PhotoBucketProps['category'], string> = {
  before: 'Before Photos',
  after: 'After Photos',
};

export function PhotoBucket({ jobId, category }: PhotoBucketProps) {
  const [photos, setPhotos] = React.useState<StoredPhoto[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const field = category === 'before' ? 'beforePhotos' : 'afterPhotos';

  const loadPhotos = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/jobs/${jobId}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const job = await response.json() as JobMediaPayload;
      setPhotos(job[field] ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load photos');
    } finally {
      setIsLoading(false);
    }
  }, [field, jobId]);

  React.useEffect(() => {
    loadPhotos();
  }, [loadPhotos]);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    setIsSaving(true);
    setError(null);
    try {
      const encoded = await Promise.all(files.map(async (file) => {
        const dataUrl = await readAsDataUrl(file);
        return {
          id: `photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          url: dataUrl,
          uploadedAt: new Date().toISOString(),
        };
      }));

      const response = await apiFetch(`/api/jobs/${jobId}`, {
        method: 'PUT',
        body: JSON.stringify({ [field]: [...photos, ...encoded] }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadPhotos();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save photos');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" data-job-id={jobId} data-category={category}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-700">{LABELS[category]}</h3>
        <label className="cursor-pointer rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-700">
          {isSaving ? 'Saving…' : 'Add Photos'}
          <input type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} disabled={isSaving} />
        </label>
      </div>

      {isLoading && <p className="mt-2 text-sm text-slate-500">Loading {category} photos…</p>}
      {!isLoading && photos.length === 0 && <p className="mt-2 text-sm text-slate-500">No {category} photos yet.</p>}
      {error && <p className="mt-2 text-sm text-red-600">Unable to save to this job: {error}</p>}

      {photos.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((photo) => (
            <img key={photo.id} src={photo.url} alt={`${category} job photo`} className="aspect-square w-full rounded-md border border-slate-200 object-cover" />
          ))}
        </div>
      )}
    </section>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });
}
