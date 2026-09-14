/**
 * #1173 — resolve the photos an operator attached to an Assistant chat turn
 * (`attachments: [{ fileId }]` on POST /api/assistant/chat, #1144) into
 * presigned image URLs a drafting task can hand the gateway.
 *
 * TENANT-SCOPED by construction: every id is looked up through
 * `FileRepository.findById(tenantId, id)` (tenant predicate + RLS), so a fileId
 * that belongs to another tenant is indistinguishable from one that does not
 * exist — it comes back `refused`, and its storage key is never presigned. The
 * same store → presign handoff `sms/customer-mms/customer-mms-intake.ts` gives
 * `MmsEstimateTaskHandler`, minus the fetch (the bytes were uploaded directly).
 *
 * Nothing here throws: a lookup error, a non-image file, or a malformed id is
 * a refusal the caller answers honestly, never a silent text-only draft that
 * pretends it saw the photo.
 */
import {
  normalizeContentType,
  type FileRepository,
  type StorageProvider,
} from './file-service';
import type { TaskImage } from '../ai/tasks/task-handlers';

export interface ChatImageAttachmentDeps {
  fileRepo: Pick<FileRepository, 'findById'>;
  storage: Pick<StorageProvider, 'generateDownloadUrl'>;
}

/**
 * The image types a vision model accepts — the same set the customer-MMS
 * photo quote stores (customer-mms-intake.ts EXTENSION_BY_TYPE).
 */
export const CHAT_IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Photos per turn handed to the model — bounds vision spend on one request. */
export const MAX_CHAT_IMAGES = 4;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatImageResolution {
  images: TaskImage[];
  /** fileIds that could not be used: absent in this tenant, not an image, or unreadable. */
  refused: string[];
}

export async function resolveChatImageAttachments(
  deps: ChatImageAttachmentDeps,
  tenantId: string,
  attachments: ReadonlyArray<{ fileId: string }>,
): Promise<ChatImageResolution> {
  const images: TaskImage[] = [];
  const refused: string[] = [];
  const fileIds = [...new Set(attachments.map((a) => a.fileId.trim()))];
  for (const fileId of fileIds) {
    if (images.length >= MAX_CHAT_IMAGES || !UUID_RE.test(fileId)) {
      refused.push(fileId);
      continue;
    }
    try {
      const record = await deps.fileRepo.findById(tenantId, fileId);
      const contentType = record ? normalizeContentType(record.contentType) : '';
      if (!record || record.tenantId !== tenantId || !CHAT_IMAGE_CONTENT_TYPES.has(contentType)) {
        refused.push(fileId);
        continue;
      }
      const url = await deps.storage.generateDownloadUrl(record.storageBucket, record.storageKey);
      images.push({ url, contentType, fileId: record.id });
    } catch {
      refused.push(fileId);
    }
  }
  return { images, refused };
}
