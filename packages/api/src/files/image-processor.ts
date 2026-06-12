/**
 * RV-006 — Image processing abstraction over sharp.
 *
 * The image-post-process worker depends on this interface (not on sharp
 * directly) so tests can mock the codec-unavailable branches (HEIC on
 * machines without an HEVC-enabled libheif) deterministically.
 *
 * Capability note (honest): sharp's prebuilt binaries bundle libheif
 * compiled with the AV1 codec (AVIF) only — the HEVC codec that real
 * iPhone HEIC files use is patent-encumbered and NOT included. On such
 * machines `process()` throws UnsupportedImageError for HEIC input and
 * the worker takes the graceful-degradation path (hash-only, original
 * untouched). Deployments that need real HEIC decoding must provide a
 * custom libvips with HEVC support; nothing else changes.
 *
 * HEIC deferral: image/heic and image/heif are deliberately NOT in
 * ALLOWED_CONTENT_TYPES (file-service.ts) — the bundled libheif is
 * AV1-only, so HEVC iPhone HEIC cannot be decoded, and stored .heic
 * originals are unrenderable in browsers. The web CaptureSheet avoids
 * this by producing JPEG via canvas before upload. The HEIC branch in
 * process() below is therefore reachable only through direct DB/storage
 * seeding (tests, migrations) until a codec-capable libvips ships.
 */
import sharp from 'sharp';
import { normalizeContentType } from './file-service';

export const THUMBNAIL_WIDTH = 480;
const JPEG_QUALITY = 85;
const THUMBNAIL_JPEG_QUALITY = 80;
// 80 MP limit passed to every sharp() call — decompression-bomb guard.
// A 80 000 000-pixel image decoded to raw RGBA uses ~320 MB; anything
// larger is almost certainly an adversarial payload, not a real photo.
const SHARP_PIXEL_LIMIT = 80_000_000;

/**
 * Permanent, content-deterministic processing failure (undecodable bytes,
 * missing codec). Retrying the same bytes can never succeed, so the worker
 * must NOT rethrow this into the queue's retry/DLQ path.
 */
export class UnsupportedImageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'UnsupportedImageError';
  }
}

export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
}

export interface ImageProcessor {
  /**
   * Decode → apply EXIF orientation as a real rotation → strip all
   * metadata (EXIF/GPS) → re-encode. HEIC/HEIF/WEBP convert to JPEG;
   * other formats keep their content type. Throws UnsupportedImageError
   * when the bytes cannot be decoded/encoded.
   */
  process(input: Buffer, contentType: string): Promise<ProcessedImage>;
  /** 480px-wide JPEG thumbnail (no enlargement of smaller images). */
  thumbnail(input: Buffer): Promise<Buffer>;
}

function asUnsupported(err: unknown, what: string): UnsupportedImageError {
  const message = err instanceof Error ? err.message : String(err);
  return new UnsupportedImageError(`${what}: ${message}`, err);
}

export function createSharpImageProcessor(): ImageProcessor {
  return {
    async process(input: Buffer, contentType: string): Promise<ProcessedImage> {
      const normalized = normalizeContentType(contentType);
      try {
        if (normalized === 'image/gif') {
          // GIF: no EXIF to strip, and a re-encode would flatten animated
          // GIFs to their first frame. Pass the original through and only
          // read dimensions.
          const meta = await sharp(input, { limitInputPixels: SHARP_PIXEL_LIMIT }).metadata();
          return {
            buffer: input,
            contentType: normalized,
            width: meta.width ?? 0,
            height: meta.height ?? 0,
          };
        }

        // .rotate() with no args applies the EXIF orientation tag as a real
        // pixel rotation; sharp then drops all metadata (EXIF/GPS/orientation)
        // from the output unless .withMetadata() is requested — which is
        // exactly the strip-but-preserve-orientation semantics we want.
        const pipeline = sharp(input, { limitInputPixels: SHARP_PIXEL_LIMIT }).rotate();
        // PNG keeps its lossless format; everything else — JPEG (re-encode
        // strips EXIF), HEIC/HEIF/WEBP (in-place conversion), unknown
        // image/* — encodes to JPEG.
        const toJpeg = normalized !== 'image/png';
        const encoded = toJpeg
          ? pipeline.jpeg({ quality: JPEG_QUALITY })
          : pipeline.png();
        const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
        return {
          buffer: data,
          contentType: toJpeg ? 'image/jpeg' : 'image/png',
          width: info.width,
          height: info.height,
        };
      } catch (err) {
        if (err instanceof UnsupportedImageError) throw err;
        throw asUnsupported(err, `image decode/encode failed (${normalized})`);
      }
    },

    async thumbnail(input: Buffer): Promise<Buffer> {
      try {
        return await sharp(input, { limitInputPixels: SHARP_PIXEL_LIMIT })
          .rotate()
          .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
          .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
          .toBuffer();
      } catch (err) {
        throw asUnsupported(err, 'thumbnail generation failed');
      }
    },
  };
}
