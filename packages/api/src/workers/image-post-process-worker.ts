/**
 * RV-006 — Image post-process pipeline worker.
 *
 * Consumes `image_post_process` messages ({tenantId, fileId}) enqueued
 * after a successful attach. For image content types it:
 *
 *   1. strips EXIF/GPS metadata (preserving orientation by applying the
 *      EXIF rotation to the pixels),
 *   2. converts HEIC/HEIF/WEBP → JPEG in place (same storage key, files
 *      row content_type/size updated),
 *   3. generates a 480px-wide JPEG thumbnail at `<original-key>.thumb.jpg`,
 *   4. computes the SHA-256 content_hash of the FINAL stored object,
 *   5. stamps the files row (width/height/thumbnail_s3_key/exif_stripped/
 *      content_hash).
 *
 * Non-image kinds (documents/PDF) get content_hash only.
 *
 * Safety invariants:
 *   - The original object is NEVER corrupted: all processing happens on
 *     in-memory buffers and the stored object is only overwritten after
 *     the whole pipeline (including the thumbnail) succeeded.
 *   - Permanent vs transient failure: UnsupportedImageError (undecodable
 *     bytes / missing codec, e.g. HEVC HEIC on stock sharp builds) is
 *     deterministic for the same bytes, so the worker degrades gracefully —
 *     logs, stamps content_hash of the untouched original, and returns
 *     success so the queue does NOT retry. Anything else (storage I/O, DB)
 *     rethrows into the queue's retry/DLQ semantics.
 *   - Idempotent: content_hash is the last field stamped by every path, so
 *     a row that already has it is "processed" and redeliveries no-op.
 *   - Known window: if both putObject calls succeed but updatePipelineResults
 *     then fails, a redelivery will reprocess the already-converted JPEG —
 *     producing one extra q85 re-encode of a JPEG (no corruption, no data
 *     loss; the idempotency guard re-stamps identical values on the second
 *     run once the DB write eventually succeeds).
 */
import { createHash } from 'crypto';
import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { FileRepository, StorageProvider, normalizeContentType } from '../files/file-service';
import { ImageProcessor, ProcessedImage, UnsupportedImageError } from '../files/image-processor';

export const IMAGE_POST_PROCESS_TYPE = 'image_post_process';

/** Idempotency key for enqueue — one pipeline run per file. */
export function imagePostProcessIdempotencyKey(fileId: string): string {
  return `${IMAGE_POST_PROCESS_TYPE}:${fileId}`;
}

export interface ImagePostProcessPayload {
  tenantId: string;
  fileId: string;
}

export interface ImagePostProcessDeps {
  fileRepo: FileRepository;
  storage: StorageProvider;
  processor: ImageProcessor;
}

export function thumbnailKeyFor(storageKey: string): string {
  return `${storageKey}.thumb.jpg`;
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function createImagePostProcessWorker(
  deps: ImagePostProcessDeps
): WorkerHandler<ImagePostProcessPayload> {
  return {
    type: IMAGE_POST_PROCESS_TYPE,
    async handle(message: QueueMessage<ImagePostProcessPayload>, logger: Logger): Promise<void> {
      const { tenantId, fileId } = message.payload ?? ({} as ImagePostProcessPayload);
      if (!tenantId || !fileId) {
        // Malformed payload is permanent — drop instead of retrying.
        logger.warn('image-post-process: malformed payload; skipping', { tenantId, fileId });
        return;
      }

      const file = await deps.fileRepo.findById(tenantId, fileId);
      if (!file) {
        // Row deleted between enqueue and processing — permanent, drop.
        logger.warn('image-post-process: file row not found; skipping', { fileId });
        return;
      }

      if (file.contentHash) {
        // Already processed (full success, hash-only, or degraded) —
        // redelivery / duplicate enqueue is a no-op.
        logger.info('image-post-process: already processed; skipping', { fileId });
        return;
      }

      const original = await deps.storage.getObject(file.storageBucket, file.storageKey);
      if (original === null) {
        // Dev storage (discards bytes) or the object is missing. Nothing
        // to process; skipping avoids a retry storm against a 404.
        logger.warn('image-post-process: object bytes unavailable; skipping', {
          fileId,
          storageKey: file.storageKey,
        });
        return;
      }

      const isImage = normalizeContentType(file.contentType).startsWith('image/');
      if (!isImage) {
        // Documents/PDF/audio: content_hash only.
        await deps.fileRepo.updatePipelineResults(tenantId, fileId, {
          contentHash: sha256Hex(original),
        });
        logger.info('image-post-process: non-image hash-only path complete', { fileId });
        return;
      }

      // ── Process to buffers FIRST. Nothing is written until both the
      // re-encoded image and the thumbnail exist in memory.
      let processed: ProcessedImage;
      let thumbnail: Buffer;
      try {
        processed = await deps.processor.process(original, file.contentType);
        thumbnail = await deps.processor.thumbnail(processed.buffer);
      } catch (err) {
        if (err instanceof UnsupportedImageError) {
          // Permanent: same bytes will fail the same way on every retry
          // (e.g. HEIC without HEVC codec support). Graceful degradation —
          // original untouched, hash stamped so the file still dedupes and
          // the row stops being "unprocessed".
          logger.warn('image-post-process: unsupported image; storing hash only', {
            fileId,
            contentType: file.contentType,
            error: err.message,
          });
          await deps.fileRepo.updatePipelineResults(tenantId, fileId, {
            contentHash: sha256Hex(original),
          });
          return;
        }
        // Unexpected processor failure — let the queue retry/DLQ it. The
        // original object has not been touched.
        throw err;
      }

      // ── Only now overwrite. Thumbnail first: if the main overwrite then
      // fails, the original is still intact and a retry reprocesses cleanly
      // (the row has no content_hash yet).
      const thumbnailS3Key = thumbnailKeyFor(file.storageKey);
      await deps.storage.putObject(file.storageBucket, thumbnailS3Key, thumbnail, 'image/jpeg');
      await deps.storage.putObject(
        file.storageBucket,
        file.storageKey,
        processed.buffer,
        processed.contentType
      );

      await deps.fileRepo.updatePipelineResults(tenantId, fileId, {
        contentHash: sha256Hex(processed.buffer),
        width: processed.width,
        height: processed.height,
        thumbnailS3Key,
        exifStripped: true,
        contentType: processed.contentType,
        sizeBytes: processed.buffer.length,
      });

      logger.info('image-post-process: pipeline complete', {
        fileId,
        width: processed.width,
        height: processed.height,
        converted: processed.contentType !== file.contentType,
      });
    },
  };
}
