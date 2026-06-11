import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Camera, CheckCircle2, RotateCcw, Send, X } from 'lucide-react';
import {
  ATTACHMENT_CATEGORIES,
  Attachment,
  AttachmentCategory,
  AttachmentEntityType,
  uploadAttachment,
} from '../../api/attachments';
import { CameraCapture, CapturedMedia } from '../shared/CameraCapture';

const LAST_CATEGORY_KEY = 'serviceos.attachments.lastCategory';

const CATEGORY_LABELS: Record<AttachmentCategory, string> = {
  before: 'Before',
  after: 'After',
  problem: 'Problem',
  completion: 'Completion',
  receipt: 'Receipt',
  other: 'Other',
};

type UploadState = 'ready' | 'uploading' | 'done' | 'error';

interface PendingCapture {
  media: CapturedMedia;
  state: UploadState;
  error?: string;
}

export interface CaptureSheetProps {
  entityType: AttachmentEntityType;
  entityId: string;
  onAttached?: (attachment: Attachment, previewUrl?: string) => void;
  defaultCategory?: AttachmentCategory;
  onClose?: () => void;
}

function readStoredCategory(): AttachmentCategory | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.localStorage?.getItem !== 'function') return null;
  const value = window.localStorage.getItem(LAST_CATEGORY_KEY);
  return ATTACHMENT_CATEGORIES.includes(value as AttachmentCategory)
    ? (value as AttachmentCategory)
    : null;
}

function dataUrlToFile(url: string, filename: string): File {
  const [meta, payload] = url.split(',');
  const contentType = meta.match(/data:([^;]+)/)?.[1] ?? 'image/jpeg';
  const binary = atob(payload ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: contentType });
}

function mediaToFile(media: CapturedMedia, index: number): File {
  const filename = `photo-${index + 1}-${Date.now()}.jpg`;
  if (media.url.startsWith('data:')) return dataUrlToFile(media.url, filename);
  return dataUrlToFile(media.url, filename);
}

export function CaptureSheet({
  entityType,
  entityId,
  onAttached,
  defaultCategory,
  onClose,
}: CaptureSheetProps) {
  const [capturing, setCapturing] = useState(true);
  const [items, setItems] = useState<PendingCapture[]>([]);
  const [caption, setCaption] = useState('');
  const [category, setCategory] = useState<AttachmentCategory>(
    readStoredCategory() ?? defaultCategory ?? 'other',
  );
  const titleRef = useRef<HTMLParagraphElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const uploadingRef = useRef(false);

  // Focus the sheet container on mount so keyboard users land inside
  useEffect(() => {
    if (!capturing) {
      titleRef.current?.focus();
    }
  }, [capturing]);

  // Escape key closes the sheet
  useEffect(() => {
    if (capturing) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [capturing, onClose]);

  const status = useMemo(() => {
    if (items.some((item) => item.state === 'uploading')) return 'uploading';
    if (items.some((item) => item.state === 'error')) return 'error';
    if (items.length > 0 && items.every((item) => item.state === 'done')) return 'done';
    return 'ready';
  }, [items]);

  async function uploadItems(indices?: number[]) {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    const targetIndices = indices ?? items.map((_, index) => index);
    setItems((prev) =>
      prev.map((item, index) =>
        targetIndices.includes(index) ? { ...item, state: 'uploading', error: undefined } : item,
      ),
    );

    await Promise.all(targetIndices.map(async (index) => {
      const item = items[index];
      if (!item) return;
      try {
        const attachment = await uploadAttachment(
          entityType,
          entityId,
          mediaToFile(item.media, index),
          category,
          caption,
        );
        onAttached?.(attachment, item.media.url);
        setItems((prev) => prev.map((entry, i) => (
          i === index ? { ...entry, state: 'done', error: undefined } : entry
        )));
      } catch (err) {
        setItems((prev) => prev.map((entry, i) => (
          i === index
            ? { ...entry, state: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
            : entry
        )));
      }
    }));
    uploadingRef.current = false;
  }

  if (capturing) {
    return (
      <CameraCapture
        onClose={(media) => {
          const photos = media.filter((item) => item.type === 'photo');
          if (photos.length === 0) {
            onClose?.();
            return;
          }
          setItems((prev) => [
            ...prev,
            ...photos.map((item) => ({ media: item, state: 'ready' as const })),
          ]);
          setCapturing(false);
        }}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[92vh] overflow-y-auto rounded-t-2xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <p id={titleId} ref={titleRef} tabIndex={-1} className="text-sm text-slate-900 outline-none">Attach photos</p>
            <p className="text-xs text-slate-400">{items.length} ready</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close capture"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl hover:bg-slate-100"
          >
            <X size={17} className="text-slate-500" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div className="grid grid-cols-3 gap-2" data-testid="capture-preview-grid">
            {items.map((item, index) => (
              <div key={item.media.id} className="relative aspect-square overflow-hidden rounded-xl bg-slate-100">
                <img
                  src={item.media.url}
                  alt={`Captured photo ${index + 1}`}
                  className="h-full w-full object-cover"
                />
                {item.state !== 'ready' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                    <span className="rounded-full bg-white px-2 py-1 text-xs text-slate-800">
                      {item.state === 'uploading' ? 'Uploading' : item.state === 'done' ? 'Attached' : 'Failed'}
                    </span>
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setCapturing(true)}
              className="flex min-h-11 aspect-square items-center justify-center rounded-xl border-2 border-dashed border-slate-200 hover:border-blue-300 hover:bg-blue-50"
              aria-label="Add another photo"
            >
              <Camera size={18} className="text-slate-400" />
            </button>
          </div>

          <div>
            <p className="mb-2 text-xs text-slate-400">Category</p>
            <div className="flex gap-2 overflow-x-auto pb-1" data-testid="capture-category-row">
              {ATTACHMENT_CATEGORIES.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={category === item}
                  onClick={() => {
                    setCategory(item);
                    if (typeof window.localStorage?.setItem === 'function') {
                      window.localStorage.setItem(LAST_CATEGORY_KEY, item);
                    }
                  }}
                  className={`min-h-11 shrink-0 rounded-full px-3 text-xs transition-colors ${
                    category === item
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {CATEGORY_LABELS[item]}
                </button>
              ))}
            </div>
          </div>

          <textarea
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            rows={2}
            placeholder="Caption (optional)"
            aria-label="Caption"
            className="w-full resize-none rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none focus:border-blue-400"
          />

          {status === 'error' && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-3">
              <p className="text-sm text-red-700">Some uploads failed.</p>
              <button
                type="button"
                onClick={() => uploadItems(items.flatMap((item, index) => item.state === 'error' ? [index] : []))}
                className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg bg-red-600 px-3 text-sm text-white"
              >
                <RotateCcw size={14} /> Retry failed
              </button>
            </div>
          )}

          {status === 'done' && (
            <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-700">
              <CheckCircle2 size={15} /> Photos attached
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              if (status === 'done') { onClose?.(); return; }
              // Only upload items that are not already done — prevents re-presign/PUT/attach for succeeded items
              const pendingIndices = items.flatMap((item, index) => item.state !== 'done' ? [index] : []);
              void uploadItems(pendingIndices);
            }}
            disabled={status === 'uploading' || items.length === 0}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            <Send size={14} />
            {status === 'uploading' ? 'Attaching…' : status === 'done' ? 'Done' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
