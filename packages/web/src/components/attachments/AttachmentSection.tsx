import { useEffect, useState } from 'react';
import { Camera, Eye, ImageIcon } from 'lucide-react';
import {
  Attachment,
  AttachmentEntityType,
  listAttachments,
} from '../../api/attachments';
import { CaptureSheet } from './CaptureSheet';

interface AttachmentSectionProps {
  entityType: AttachmentEntityType;
  entityId: string;
}

function isArchived(attachment: Attachment): boolean {
  return Boolean(attachment.archivedAt ?? attachment.archived_at);
}

function isPortalVisible(attachment: Attachment): boolean {
  return Boolean(attachment.portalVisible ?? attachment.portal_visible);
}

export function AttachmentSection({ entityType, entityId }: AttachmentSectionProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const next = await listAttachments(entityType, entityId);
      setAttachments(next.filter((attachment) => !isArchived(attachment)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load attachments');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [entityType, entityId]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid={`${entityType}-attachments-section`}>
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <ImageIcon size={13} className="text-slate-400" />
        <p className="text-sm text-slate-700">Attachments</p>
        <span className="ml-auto text-xs text-slate-400">{attachments.length}</span>
      </div>

      <div className="px-4 py-4">
        {loading && <p className="text-sm text-slate-400">Loading attachments…</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {!loading && !error && attachments.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-200 px-3 py-5 text-center">
            <ImageIcon size={20} className="mx-auto text-slate-300" />
            <p className="mt-2 text-sm text-slate-500">No attachments yet</p>
          </div>
        )}
        {!loading && !error && attachments.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="attachment-grid">
            {attachments.map((attachment) => (
              <figure key={attachment.id} className="overflow-hidden rounded-xl border border-slate-100 bg-slate-50">
                <div className="relative aspect-square bg-slate-100">
                  {attachment.downloadUrl ? (
                    <img
                      src={attachment.downloadUrl}
                      alt={attachment.caption || attachment.filename || 'Attachment'}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <ImageIcon size={22} className="text-slate-300" />
                    </div>
                  )}
                  {isPortalVisible(attachment) && (
                    <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-white/95 px-2 py-1 text-[10px] text-slate-700 shadow-sm">
                      <Eye size={10} /> Visible to customer
                    </span>
                  )}
                </div>
                {(attachment.caption || attachment.category) && (
                  <figcaption className="px-2 py-2">
                    {attachment.caption && <p className="truncate text-xs text-slate-700">{attachment.caption}</p>}
                    {attachment.category && <p className="text-[10px] uppercase tracking-wide text-slate-400">{attachment.category}</p>}
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setCaptureOpen(true)}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-700 transition-colors hover:bg-slate-50"
        >
          <Camera size={14} className="text-blue-500" />
          Add photo
        </button>
      </div>

      {captureOpen && (
        <CaptureSheet
          entityType={entityType}
          entityId={entityId}
          onClose={() => setCaptureOpen(false)}
          onAttached={(attachment) => {
            setAttachments((prev) => [attachment, ...prev].filter((item) => !isArchived(item)));
          }}
        />
      )}
    </div>
  );
}
